import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  REPORT_ENVELOPE_SECTION_KEYS,
  type ReportBlock,
  type ReportEvidence,
  ReportSchema,
  type ReportScope,
  ReportScopeSchema,
  type ReportSection,
  reportStanceLabel,
  STANDARD_DISCLAIMERS,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import { executeReportWorkflow } from './internal/report-runner.js';

export const MorningBriefInput = z.object({
  date: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});

export const MorningBriefOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type BriefInput = z.output<typeof MorningBriefInput>;

/**
 * 六槽段键：**直接引用 core 的 `REPORT_ENVELOPE_SECTION_KEYS`**。
 *
 * 这里曾是全仓三份逐字相同副本中的一份（另两份在 `core/entity/report-document.ts` 与
 * `workflows/internal/report-envelope.ts`）。副本分叉时不会报错，只会让
 * `reportDocumentFromReport` 在**另一处**抛「缺少 envelope 槽」——极难定位。
 */
const ENVELOPE_SECTION_KEYS = REPORT_ENVELOPE_SECTION_KEYS;

const evidence = (id: string, dimension: string, now: Date, provider: string): ReportEvidence => ({
  id,
  dimension,
  provenance: { provider, observedAt: now, fetchedAt: now, freshness: 'unknown' },
});

const text = (value: string, tone: 'factual' | 'warning' = 'factual'): ReportBlock => ({
  kind: 'text',
  text: value,
  tone,
});

const list = (items: readonly { title: string; detail?: string }[]): ReportBlock => ({
  kind: 'list',
  items: items.map((item) => ({ ...item })),
});

/** 盘前窗口：报告期内当日 15:00（Asia/Shanghai）收盘即失效。 */
const premarketValidity = (date: string): Date => new Date(`${date}T15:00:00+08:00`);

const overnightIndexLines = (
  snapshot: readonly { name: string; changePct: number; source: string; ts: Date }[],
  now: Date,
) =>
  snapshot.filter(
    (quote) =>
      quote.ts.getTime() <= now.getTime() && dateInShanghai(quote.ts) < dateInShanghai(now),
  );

const buildSections = async (
  date: string,
  generatedAt: Date,
  ctx: WorkflowContext,
): Promise<{
  pieces: { section: ReportSection; evidence: ReportEvidence[] }[];
}> => {
  const accountId = ctx.user.defaultAccountId;
  /**
   * task-14：`list_holdings` 已改纯读。盘前简报需要「当日/最近」的持仓估值，所以**先显式刷新**。
   * 刷新失败**不阻断报告**：报告会照常生成，缺价的持仓按 `priceStatus: 'unpriced'` 如实披露
   * （而不是像旧实现那样静默用上次写库的旧价冒充现价）。
   */
  await ctx.tools.refresh_holdings_quotes.execute({ accountId });
  const [account, holdings, facts, indexes, events, plans, advices] = await Promise.all([
    ctx.tools.get_account.execute({ accountId }),
    ctx.tools.list_holdings.execute({ accountId }),
    ctx.tools.get_account_facts.execute({ accountId }),
    ctx.tools.fetch_index_quotes.execute({}),
    ctx.tools.list_stock_events.execute({
      from: new Date(`${date}T00:00:00+08:00`),
      to: new Date(generatedAt.getTime()),
      limit: 20,
    }),
    ctx.tools.list_alert_plans.execute({ enabledOnly: true }),
    ctx.tools.list_advices.execute({ accountId, includeExpired: false, limit: 10 }),
  ]);

  const availability: string[] = [];
  const counterEvidence: string[] = [];
  const risks: string[] = [];

  // ① 账户概览：可用性与数字一起披露，缺数据不写 0。
  const accountBlocks: ReportBlock[] = [];
  const holdingCount = holdings.ok ? holdings.data.holdings.length : null;
  // 缺价时 `totalValue` 字段缺席：显式披露，不填 0、不填 null 冒充数字。
  const totalValue = holdings.ok ? (holdings.data.totalValue ?? null) : null;
  const unpricedCount = holdings.ok ? holdings.data.unpricedCount : null;
  if (holdings.ok) {
    accountBlocks.push({
      kind: 'metrics',
      items: [
        { key: 'dataAsOf', label: '数据截止', value: generatedAt.toISOString() },
        { key: 'holdingCount', label: '持仓数', value: holdingCount },
        { key: 'totalValue', label: '持仓总市值', value: totalValue, unit: '元' },
        ...(unpricedCount !== null && unpricedCount > 0
          ? [{ key: 'unpricedCount', label: '缺价持仓数', value: unpricedCount }]
          : []),
        {
          key: 'todayPnL',
          label: '今日盈亏',
          value: holdings.data.totalTodayPnl,
          unit: '元',
        },
      ],
    });
  } else {
    availability.push(`持仓读取失败（${holdings.error.kind}）：市值与持仓数不可用，不按 0 处理。`);
    risks.push(`持仓数据不可用（${holdings.error.kind}），本报告无法评估仓位暴露`);
  }
  if (account.ok) {
    accountBlocks.push(text(`账户：${account.data.account.name}。`));
  } else {
    availability.push(`账户信息读取失败（${account.error.kind}）。`);
  }
  if (facts.ok) {
    availability.push(`账户事实摘要可用（${facts.data.facts.digest.slice(0, 12)}）。`);
  } else {
    availability.push(`账户事实摘要不可用（${facts.error.kind}）。`);
    counterEvidence.push('账户事实摘要不可用，仓位与盈亏口径缺少校验依据');
  }
  if (availability.length > 0) {
    accountBlocks.push(text(`可用性披露：${availability.join('；')}`, 'warning'));
  }
  if (holdings.ok && holdings.data.holdings.some((holding) => holding.marketValue === null)) {
    counterEvidence.push(
      `持仓中有 ${holdings.data.holdings.filter((holding) => holding.marketValue === null).length} 只缺少可用市值口径`,
    );
  }

  // ② 隔夜事实：每条带来源与观察时间；观察时间必须早于报告生成日（否则不是「隔夜」）。
  const overnight: { title: string; detail: string }[] = [];
  if (indexes.ok && indexes.data.unsupported !== true) {
    const overnightIndices = overnightIndexLines(
      indexes.data.indices.map((quote) => ({
        name: quote.name,
        changePct: quote.changePct,
        source: quote.source,
        ts: quote.ts,
      })),
      generatedAt,
    );
    for (const quote of overnightIndices.slice(0, 6)) {
      overnight.push({
        title: `${quote.name} ${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%`,
        detail: `来源 ${quote.source} · 观测于 ${quote.ts.toISOString()}`,
      });
    }
    if (overnightIndices.length === 0) {
      availability.push('指数行情没有早于本报告生成日的观测，隔夜指数不可用。');
    }
  } else {
    availability.push(
      indexes.ok ? '当前行情源不支持指数行情。' : `指数行情读取失败（${indexes.error.kind}）。`,
    );
  }
  if (events.ok) {
    for (const event of events.data.events.slice(0, 10)) {
      overnight.push({
        title: event.title,
        detail: `来源 ${event.source ?? 'local'} · 观察于 ${event.observedAt?.toISOString() ?? event.occursAt.toISOString()}`,
      });
    }
    if (events.data.events.length === 0) {
      availability.push('报告期内没有已保存的公司事件。');
      counterEvidence.push('隔夜事实只有指数、没有公司事件，事件面证据为空');
    } else {
      risks.push(
        `隔夜有 ${events.data.events.length} 条公司事件，事件驱动可能放大开盘波动，观察条件需按事件复核`,
      );
    }
  } else {
    availability.push(`公司事件读取失败（${events.error.kind}）。`);
  }
  if (overnight.length === 0) counterEvidence.push('隔夜事实为空，今日观察条件缺少外部参照');

  // ③ 既有建议与反证：来自 `list_advices`（账户归属与过期语义与 `get_advice` 同一实现）。
  const adviceItems: {
    title: string;
    detail: string;
    entityKind?: 'advice';
    entityId?: string;
    textOrigin?: 'advice';
  }[] = [];
  const missingCounterEvidence: string[] = [];
  if (advices.ok) {
    for (const advice of advices.data.advices) {
      const name = advice.stockName ?? advice.subjectId;
      adviceItems.push({
        title: `${name} · ${reportStanceLabel(advice.decision)}`,
        detail:
          `有效期至 ${advice.validUntil.toISOString()}` +
          ` · 反证：${advice.counterEvidence.join('；') || '未提供'}` +
          ` · 风险：${advice.risks.join('；') || '未提供'}`,
        entityKind: 'advice' as const,
        entityId: advice.id,
        // 建议正文是外部（模型）自由文本：渲染时按词面策略规范化，原文留在结构化投影里。
        textOrigin: 'advice',
      });
    }
    missingCounterEvidence.push(...advices.data.missingCounterEvidenceIds);
    if (advices.data.advices.length === 0) {
      availability.push('账户没有生效中的既有建议。');
    }
    if (missingCounterEvidence.length > 0) {
      counterEvidence.push(
        `有 ${missingCounterEvidence.length} 条既有建议没有提供反证（不补默认值）`,
      );
    }
  } else {
    availability.push(`既有建议读取失败（${advices.error.kind}）。`);
    counterEvidence.push('既有建议无法读取，本报告不包含既有建议的反证');
  }
  const adviceUnavailable = adviceItems.length === 0;

  // ④ 今日观察条件：只写数据里真实存在的触发价/条件；缺失效条件就披露，不补。
  const watchItems: { title: string; detail: string }[] = [];
  if (plans.ok) {
    for (const plan of plans.data.plans) {
      const rules = plan.rules
        .map((rule) =>
          rule.kind === 'price-level'
            ? `${rule.side === 'above' ? '高于' : '低于'} ${rule.level}`
            : rule.kind,
        )
        .join('、');
      watchItems.push({
        title: plan.name,
        detail: `条件：${rules} · 失效条件：规则未声明（不推断）`,
      });
    }
    if (plans.data.plans.length === 0) availability.push('当前没有启用的告警计划。');
  } else {
    availability.push(`告警计划读取失败（${plans.error.kind}）。`);
  }
  if (watchItems.length > 0) {
    risks.push('告警规则不含失效条件字段，触发后需人工复核退出条件');
  }

  const pieces: { section: ReportSection; evidence: ReportEvidence[] }[] = [
    {
      evidence: [
        evidence('morning-brief:account', 'account-overview.account', generatedAt, 'local/account'),
      ],
      section: {
        key: 'account-overview',
        title: '账户概览',
        required: true,
        status: holdings.ok && account.ok ? 'complete' : 'partial',
        dataAsOf: generatedAt,
        blocks: accountBlocks,
        evidenceIds: ['morning-brief:account'],
        missingDimensions:
          holdings.ok && account.ok
            ? []
            : [
                {
                  dimension: 'account-overview.account',
                  reason: '账户或持仓读取失败',
                  retryable: true,
                },
              ],
      },
    },
    {
      evidence: [
        evidence(
          'morning-brief:overnight',
          'overnight-facts.indexes',
          generatedAt,
          'local/overnight',
        ),
      ],
      section: {
        key: 'overnight-facts',
        title: '隔夜事实',
        required: true,
        status: overnight.length > 0 ? 'complete' : 'unavailable',
        dataAsOf: generatedAt,
        blocks:
          overnight.length > 0
            ? [list(overnight), text(`可用性披露：${availability.join('；') || '全部数据可用。'}`)]
            : [text(`隔夜事实不可用：${availability.join('；')}`, 'warning')],
        evidenceIds: ['morning-brief:overnight'],
        missingDimensions:
          overnight.length > 0
            ? []
            : [
                {
                  dimension: 'overnight-facts',
                  reason: '隔夜指数与公司事件均不可用',
                  retryable: true,
                },
              ],
      },
    },
    {
      evidence: [
        evidence('morning-brief:advice', 'existing-advice.list', generatedAt, 'local/advices'),
      ],
      section: {
        key: 'existing-advice',
        title: '既有建议与反证',
        required: true,
        status: adviceItems.length > 0 ? 'complete' : 'unavailable',
        dataAsOf: generatedAt,
        blocks:
          adviceItems.length > 0
            ? [
                list(adviceItems),
                text(
                  missingCounterEvidence.length === 0
                    ? '每条建议都带有效期、反证与风险。'
                    : `有 ${missingCounterEvidence.length} 条建议未提供反证：${missingCounterEvidence.join('、')}（不补默认值）。`,
                ),
              ]
            : [
                text(
                  '既有建议不可用：账户没有生效中的建议，或建议读取失败；本段不推断建议内容与有效期。',
                  'warning',
                ),
              ],
        evidenceIds: ['morning-brief:advice'],
        missingDimensions:
          adviceItems.length > 0
            ? []
            : [
                {
                  dimension: 'existing-advice',
                  reason: '账户没有生效中的既有建议',
                  retryable: true,
                },
              ],
      },
    },
    {
      evidence: [
        evidence('morning-brief:watch', 'watch-conditions.plans', generatedAt, 'local/alert-plans'),
      ],
      section: {
        key: 'watch-conditions',
        title: '今日观察条件',
        required: true,
        status: watchItems.length > 0 ? 'complete' : 'unavailable',
        dataAsOf: generatedAt,
        blocks:
          watchItems.length > 0
            ? [
                list(watchItems),
                text(
                  '告警规则不含失效条件字段；本段只写规则里真实存在的条件，缺失效条件按披露处理。',
                ),
              ]
            : [text('今日观察条件不可用：没有启用的告警计划。', 'warning')],
        evidenceIds: ['morning-brief:watch'],
        missingDimensions:
          watchItems.length > 0
            ? []
            : [{ dimension: 'watch-conditions', reason: '没有启用的告警计划', retryable: true }],
      },
    },
  ];

  const conclusion = `${date} 盘前：观察条件 ${watchItems.length} 条，隔夜事实 ${overnight.length} 条，${
    adviceUnavailable ? '既有建议不可用' : '既有建议已纳入'
  }。`;
  if (counterEvidence.length === 0) counterEvidence.push('本报告未发现可披露的反面事实');
  if (risks.length === 0) risks.push('本报告未发现可披露的风险项');
  const envelopePieces: { section: ReportSection; evidence: ReportEvidence[] }[] = [
    {
      evidence: [],
      section: {
        key: ENVELOPE_SECTION_KEYS.conclusion,
        title: '结论',
        required: false,
        status: 'complete',
        dataAsOf: generatedAt,
        blocks: [text(conclusion)],
        evidenceIds: [],
        missingDimensions: [],
      },
    },
    {
      evidence: [],
      section: {
        key: ENVELOPE_SECTION_KEYS.counterEvidence,
        title: '反证',
        required: false,
        status: 'complete',
        dataAsOf: generatedAt,
        blocks: [list(counterEvidence.map((item) => ({ title: item })))],
        evidenceIds: [],
        missingDimensions: [],
      },
    },
    {
      evidence: [],
      section: {
        key: ENVELOPE_SECTION_KEYS.risks,
        title: '风险',
        required: false,
        status: 'complete',
        dataAsOf: generatedAt,
        blocks: [list(risks.map((item) => ({ title: item })))],
        evidenceIds: [],
        missingDimensions: [],
      },
    },
    {
      evidence: [],
      section: {
        key: ENVELOPE_SECTION_KEYS.validity,
        title: '有效期',
        required: false,
        status: 'complete',
        dataAsOf: generatedAt,
        blocks: [
          {
            kind: 'metrics',
            items: [
              {
                key: 'validUntil',
                label: '有效期至',
                value: premarketValidity(date).toISOString(),
              },
              { key: 'basis', label: '依据', value: 'report-period' },
            ],
          },
        ],
        evidenceIds: [],
        missingDimensions: [],
      },
    },
    {
      evidence: [],
      section: {
        key: ENVELOPE_SECTION_KEYS.disclaimer,
        title: '免责',
        required: false,
        status: 'complete',
        dataAsOf: generatedAt,
        blocks: [list(STANDARD_DISCLAIMERS.map((item) => ({ title: item })))],
        evidenceIds: [],
        missingDimensions: [],
      },
    },
  ];
  return { pieces: [...pieces, ...envelopePieces] };
};

const runMorningBrief = async (
  input: BriefInput,
  ctx: WorkflowContext,
): Promise<
  | ToolResult<never>
  | { report: unknown; created: boolean; workflowRunId: string; notified: boolean }
> => {
  const date = input.date ?? dateInShanghai(ctx.clock());
  const requested = new Date(`${date}T12:00:00+08:00`);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${date} 不是 A 股交易日`, issues: [] },
    };
  }
  const result = await executeReportWorkflow(
    {
      workflowName: 'morning-brief',
      kind: 'morning-brief',
      template: 'morning-brief-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart: date,
      periodEnd: date,
      title: `${date} 盘前简报`,
      inputSummary: { notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const built = await buildSections(date, generatedAt, ctx);
        return built.pieces;
      },
    },
    ctx,
  );
  return result;
};

export const morningBriefWorkflow = defineWorkflow<BriefInput, z.output<typeof MorningBriefOutput>>(
  {
    name: 'morning-brief',
    description: '生成盘前简报（四段 + 六槽 envelope），可交付为文件',
    input: MorningBriefInput,
    steps: [(prev, ctx) => runMorningBrief(prev as BriefInput, ctx)],
  },
);

export type { ReportScope };
/** 供测试断言：盘前窗口结束时刻。 */
export { premarketValidity };
