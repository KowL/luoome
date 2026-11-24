import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  ReportSchema,
  AccountReportScopeSchema as ReportScopeSchema,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';

import { defineOperation, type WorkflowContext } from './define-workflow.js';
import { executeReportWorkflow, type ReportSectionPiece } from './internal/report-runner.js';
import {
  DAY_MS,
  localEvidence,
  missing,
  shanghaiDate,
  unavailableSection,
} from './report-shared.js';

/**
 * 唯一的周期报告：每周一次的建议成绩单。
 *
 * 只回答一个问题——过去这段时间给的建议对不对。命中率、对沪深300 的超额、
 * 按 confidence 分组的表现，以及是否达到验收门禁；不重复生成行情、板块、策略
 * 这些每天都能看到的快照。
 */

export const WeeklyReportInput = z.object({
  periodEnd: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});

export const WeeklyReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type WeeklyInput = z.output<typeof WeeklyReportInput>;
type WeeklyOutput = z.output<typeof WeeklyReportOutput>;

const SCORECARD_DAYS = 30;
const SCORECARD_HORIZON = 5;

/** 周一生成时回顾上一周（周五为周期终点），其它日期回看所在周。 */
const weekAnchor = (periodEnd: string): string => {
  const weekday = new Date(`${periodEnd}T00:00:00.000Z`).getUTCDay();
  if (weekday !== 1) return periodEnd;
  return dateInShanghai(new Date(shanghaiDate(periodEnd).getTime() - 3 * DAY_MS));
};

const tradingDaysOfWeek = (anchorDate: string): string[] => {
  const end = shanghaiDate(anchorDate);
  const weekday = new Date(`${anchorDate}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(end.getTime() - daysSinceMonday * DAY_MS);
  const dates: string[] = [];
  for (
    let candidate = monday;
    candidate.getTime() <= end.getTime();
    candidate = new Date(candidate.getTime() + DAY_MS)
  ) {
    if (!isWeekend(candidate) && !isHoliday(candidate)) dates.push(dateInShanghai(candidate));
  }
  return dates;
};

const pct = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10000) / 100;

const scorecardSection = async (ctx: WorkflowContext, now: Date): Promise<ReportSectionPiece> => {
  // 结算先跑一遍，避免成绩单统计到上一周还没结算的样本。
  const settled = await ctx.tools.settle_advices.execute({ asOf: now });
  const scorecard = await ctx.tools.get_advice_scorecard.execute({
    days: SCORECARD_DAYS,
    horizonDays: SCORECARD_HORIZON,
  });
  if (!scorecard.ok) {
    return unavailableSection(
      'advice-scorecard',
      '建议成绩单',
      true,
      now,
      'advice-scorecard.settlement',
      scorecard.error.kind,
    );
  }
  const data = scorecard.data;
  const evidence = localEvidence(
    'advice-scorecard:0',
    'advice-scorecard.settlement',
    now,
    'local/settlement',
  );
  const settleNote = settled.ok
    ? `本次结算扫描 ${settled.data.scanned} 条、写入 ${settled.data.settled} 条、跳过 ${settled.data.skipped} 条`
    : `结算未执行（${settled.error.kind}），成绩单沿用既有结算结果`;
  const gate = data.gate.passed ? '门禁通过' : `门禁未通过 · ${data.gate.reasons.join('；')}`;
  if (data.samples === 0) {
    // 不可用 section 只允许 warning 文本，metrics/table 会破坏报告不变量。
    return {
      section: {
        key: 'advice-scorecard',
        title: '建议成绩单',
        required: true,
        status: 'unavailable',
        dataAsOf: now,
        blocks: [{ kind: 'text', text: `成绩单暂不可用 · ${gate}`, tone: 'warning' }],
        evidenceIds: [evidence.id],
        missingDimensions: [
          missing('advice-scorecard.settlement', '窗口内没有已结算的建议样本', 'no_data'),
        ],
      },
      evidence: [evidence],
    };
  }
  return {
    section: {
      key: 'advice-scorecard',
      title: '建议成绩单',
      required: true,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'samples', label: '已结算样本', value: data.samples },
            { key: 'hitRate', label: '命中率', value: pct(data.hitRate), unit: 'pct' },
            { key: 'avgExcessPct', label: '平均超额', value: data.avgExcessPct, unit: 'pct' },
            { key: 'horizonDays', label: '口径', value: `T+${data.horizonDays}` },
            { key: 'benchmark', label: '基准', value: data.benchmark },
            { key: 'windowDays', label: '窗口', value: `${SCORECARD_DAYS} 天` },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'bucket', label: 'confidence' },
            { key: 'samples', label: '样本' },
            { key: 'hitRate', label: '命中率' },
            { key: 'avgExcessPct', label: '平均超额' },
          ],
          rows: data.groups.map((group) => ({
            bucket: group.bucket,
            samples: group.samples,
            hitRate: pct(group.hitRate),
            avgExcessPct: group.avgExcessPct,
          })),
        },
        { kind: 'text', text: gate, tone: data.gate.passed ? 'factual' : 'warning' },
        { kind: 'text', text: settleNote, tone: 'factual' },
      ],
      evidenceIds: [evidence.id],
      missingDimensions: [],
    },
    evidence: [evidence],
  };
};

/** 新增「个股观察成绩」section；与既有「建议成绩单」并存，不改其语义。 */
const STOCK_BRIEF_SCORE_KEY = 'stock-brief-score';
const STOCK_BRIEF_SCORE_DISCLAIMER =
  '本内容仅技术研究，不构成投资建议；观察与信号不等于收益概率，规则观察不计入命中率分母。';

const stockBriefScoreSection = async (
  ctx: WorkflowContext,
  now: Date,
): Promise<ReportSectionPiece> => {
  const scorecard = await ctx.tools.get_advice_scorecard.execute({
    days: SCORECARD_DAYS,
    horizonDays: SCORECARD_HORIZON,
  });
  if (!scorecard.ok) {
    return unavailableSection(
      STOCK_BRIEF_SCORE_KEY,
      '个股观察成绩',
      false,
      now,
      `${STOCK_BRIEF_SCORE_KEY}.settlement`,
      scorecard.error.kind,
    );
  }
  const data = scorecard.data;
  const evidence = localEvidence(
    `${STOCK_BRIEF_SCORE_KEY}:0`,
    `${STOCK_BRIEF_SCORE_KEY}.settlement`,
    now,
    'local/settlement',
  );
  const ruleNote = `规则观察（低置信）${data.ruleFallbackSamples} 条：单列，不计入命中率分母`;
  if (data.samples === 0) {
    return {
      section: {
        key: STOCK_BRIEF_SCORE_KEY,
        title: '个股观察成绩',
        required: false,
        status: 'unavailable',
        dataAsOf: now,
        blocks: [
          {
            kind: 'text',
            text:
              '个股观察成绩暂不可用 · 窗口内没有已结算的观察样本' +
              `（规则观察 ${data.ruleFallbackSamples} 条不计入命中率分母）。` +
              STOCK_BRIEF_SCORE_DISCLAIMER,
            tone: 'warning',
          },
        ],
        evidenceIds: [evidence.id],
        missingDimensions: [
          missing(
            `${STOCK_BRIEF_SCORE_KEY}.settlement`,
            '窗口内没有已结算的观察样本（规则观察不计入分母）',
            'no_data',
          ),
        ],
      },
      evidence: [evidence],
    };
  }
  return {
    section: {
      key: STOCK_BRIEF_SCORE_KEY,
      title: '个股观察成绩',
      required: false,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'samples', label: '已结算观察', value: data.samples },
            { key: 'hitRate', label: '命中率', value: pct(data.hitRate), unit: 'pct' },
            { key: 'avgExcessPct', label: '平均超额', value: data.avgExcessPct, unit: 'pct' },
            { key: 'ruleFallbackSamples', label: '规则观察', value: data.ruleFallbackSamples },
            { key: 'horizonDays', label: '口径', value: `T+${data.horizonDays}` },
            { key: 'benchmark', label: '基准', value: data.benchmark },
            { key: 'windowDays', label: '窗口', value: `${SCORECARD_DAYS} 天` },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'bucket', label: 'confidence' },
            { key: 'samples', label: '样本' },
            { key: 'hitRate', label: '命中率' },
            { key: 'avgExcessPct', label: '平均超额' },
          ],
          rows: data.groups.map((group) => ({
            bucket: group.bucket,
            samples: group.samples,
            hitRate: pct(group.hitRate),
            avgExcessPct: group.avgExcessPct,
          })),
        },
        { kind: 'text', text: ruleNote, tone: 'factual' },
        { kind: 'text', text: STOCK_BRIEF_SCORE_DISCLAIMER, tone: 'factual' },
      ],
      evidenceIds: [evidence.id],
      missingDimensions: [],
    },
    evidence: [evidence],
  };
};

const adviceWeekSection = async (
  periodStart: string,
  periodEnd: string,
  ctx: WorkflowContext,
  now: Date,
): Promise<ReportSectionPiece> => {
  const since = new Date(`${periodStart}T00:00:00+08:00`);
  const until = new Date(`${periodEnd}T23:59:59+08:00`);
  const stats = await ctx.tools.get_advice_stats.execute({ since, until });
  if (!stats.ok) {
    return unavailableSection(
      'advice-week',
      '本周建议',
      false,
      now,
      'advice-week.stats',
      stats.error.kind,
    );
  }
  const counts = stats.data.byDecision;
  const evidence = localEvidence('advice-week:0', 'advice-week.stats', now, 'local/advice');
  if (stats.data.totalAdvices === 0) {
    return {
      section: {
        key: 'advice-week',
        title: '本周建议',
        required: false,
        status: 'unavailable',
        dataAsOf: now,
        blocks: [{ kind: 'text', text: '本周没有生成建议', tone: 'warning' }],
        evidenceIds: [evidence.id],
        missingDimensions: [missing('advice-week.stats', '本周没有生成建议', 'no_data')],
      },
      evidence: [evidence],
    };
  }
  return {
    section: {
      key: 'advice-week',
      title: '本周建议',
      required: false,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'total', label: '建议条数', value: stats.data.totalAdvices },
            { key: 'avgConfidence', label: '平均信心度', value: stats.data.avgConfidence },
            { key: 'buy', label: 'buy', value: counts.buy.totalAdvices },
            { key: 'watch', label: 'watch', value: counts.watch.totalAdvices },
            { key: 'hold', label: 'hold', value: counts.hold.totalAdvices },
            { key: 'sell', label: 'sell', value: counts.sell.totalAdvices },
            { key: 'avoid', label: 'avoid', value: counts.avoid.totalAdvices },
          ],
        },
      ],
      evidenceIds: [evidence.id],
      missingDimensions: [],
    },
    evidence: [evidence],
  };
};

const feedbackSection = async (ctx: WorkflowContext, now: Date): Promise<ReportSectionPiece> => {
  const feedback = await ctx.tools.list_advice_feedback.execute({ limit: 500 });
  if (!feedback.ok) {
    return unavailableSection(
      'advice-feedback',
      '反馈覆盖',
      false,
      now,
      'advice-feedback.coverage',
      feedback.error.kind,
    );
  }
  const count = (action: 'done' | 'skipped' | 'later'): number =>
    feedback.data.feedbacks.filter((item) => item.action === action).length;
  const evidence = localEvidence(
    'advice-feedback:0',
    'advice-feedback.coverage',
    now,
    'local/feedback',
  );
  return {
    section: {
      key: 'advice-feedback',
      title: '反馈覆盖',
      required: false,
      status: 'complete',
      dataAsOf: now,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'total', label: '已反馈', value: feedback.data.feedbacks.length },
            { key: 'done', label: '做了', value: count('done') },
            { key: 'skipped', label: '没做', value: count('skipped') },
            { key: 'later', label: '再等等', value: count('later') },
          ],
        },
      ],
      evidenceIds: [evidence.id],
      missingDimensions: [],
    },
    evidence: [evidence],
  };
};

const runWeeklyReport = async (
  input: WeeklyInput,
  ctx: WorkflowContext,
): Promise<WeeklyOutput | ToolResult<never>> => {
  const periodEnd = input.periodEnd ?? dateInShanghai(ctx.clock());
  const requested = shanghaiDate(periodEnd);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${periodEnd} 不是 A 股交易日`, issues: [] },
    };
  }
  const anchor = weekAnchor(periodEnd);
  const dates = tradingDaysOfWeek(anchor);
  const periodStart = dates[0];
  const periodEndResolved = dates[dates.length - 1] ?? anchor;
  if (periodStart === undefined) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${periodEnd} 所在周无可确认交易日`, issues: [] },
    };
  }
  const result = await executeReportWorkflow(
    {
      workflowName: 'weekly-report',
      kind: 'weekly',
      template: 'weekly-scorecard-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart,
      periodEnd: periodEndResolved,
      title: `${periodStart} 至 ${periodEndResolved} 建议成绩单`,
      inputSummary: { marketDates: dates, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) =>
        await Promise.all([
          scorecardSection(ctx, generatedAt),
          stockBriefScoreSection(ctx, generatedAt),
          adviceWeekSection(periodStart, periodEnd, ctx, generatedAt),
          feedbackSection(ctx, generatedAt),
        ]),
    },
    ctx,
  );
  return 'ok' in result ? result : WeeklyReportOutput.parse(result);
};

export const weeklyReportOperation = defineOperation<WeeklyInput, WeeklyOutput>({
  requiredPlugins: ['business.report'],
  name: 'weekly-report',
  description: '生成每周建议成绩单：命中率、超额、分组表现与验收门禁',
  input: WeeklyReportInput,
  steps: [(prev, ctx) => runWeeklyReport(prev as WeeklyInput, ctx)],
});
