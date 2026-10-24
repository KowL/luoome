import { createHash } from 'node:crypto';
import {
  AlertPlanSchema,
  assertReportInvariants,
  dateInShanghai,
  evaluatePersonalPriceAlerts,
  InvariantError,
  PersonalAlertEvaluationDraftSchema,
  PersonalAlertEvaluationSchema,
  PersonalAlertPlanConfigSchema,
  PersonalAlertPlanMutationSchema,
  PersonalAlertPlanRemovalSchema,
  PersonalAlertPlanSchema,
  type PersonalAlertRequest,
  PersonalAlertRequestSchema,
  PersonalOperationReceiptSchema,
  PersonalWatchFeedbackSchema,
  parseWatchlistImport,
  personalAlertLeaseOwner,
  type Quote,
  QuoteSchema,
  type ReportEvidence,
  type ReportMissingDimension,
  ReportSchema,
  type ReportSection,
  StockSchema,
  type ToolContext,
  WatchlistImportPreviewSchema,
  WatchlistImportResultSchema,
  WatchlistImportSelectionSchema,
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistRemovalResultSchema,
  WatchlistSchema,
  watchlistRuleRevisionInput,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const personalRepository = (ctx: ToolContext) => {
  const repository = ctx.repos.personal;
  if (repository === undefined) throw new InvariantError('personal repository is not configured');
  return repository;
};

/** 个人自选事实报告提交结果：报告 + 本地幂等回执 + 是否重放。 */
export const PersonalFactsReportResultSchema = z.object({
  report: ReportSchema,
  receipt: PersonalOperationReceiptSchema,
  replayed: z.boolean(),
});
export type PersonalFactsReportResult = z.infer<typeof PersonalFactsReportResultSchema>;

/** 个人提醒正式评估提交结果：评估 + 本地幂等回执 + 是否重放。 */
export const PersonalAlertResultSchema = z.object({
  evaluation: PersonalAlertEvaluationSchema,
  receipt: PersonalOperationReceiptSchema,
  replayed: z.boolean(),
});
export type PersonalAlertResult = z.infer<typeof PersonalAlertResultSchema>;

export const PreviewWatchlistImportInput = z.object({
  watchlistId: z.string().min(1),
  content: z.string().min(1),
  format: z.enum(['text', 'csv']),
});
export const PreviewWatchlistImportOutput = z.object({ preview: WatchlistImportPreviewSchema });
export const previewWatchlistImportTool = defineTool({
  name: 'preview_watchlist_import',
  description: '预览最多 100 行、1 MiB 自选文本或 CSV；保存身份映射、重复与歧义，不建立持仓',
  sideEffect: 'write',
  input: PreviewWatchlistImportInput,
  output: PreviewWatchlistImportOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist?.kind !== 'personal' || !watchlist.enabled)
      return errNotFound('Watchlist', input.watchlistId);
    const repo = personalRepository(ctx);
    const catalog = await ctx.repos.stock.search('');
    const parsed = parseWatchlistImport(input.content, input.format, catalog);
    const preview = WatchlistImportPreviewSchema.parse({
      id: `preview-${globalThis.crypto.randomUUID()}`,
      watchlistId: input.watchlistId,
      ownerUserId: ctx.user.id,
      inputHash: hash(parsed.normalizedInput),
      watchlistRevision: await repo.getWatchlistRevision(input.watchlistId),
      mappingVersion: hash(catalog),
      rows: parsed.rows,
      ignoredColumns: parsed.ignoredColumns,
      createdAt: ctx.clock(),
    });
    await repo.putImportPreview(preview);
    return { preview };
  },
});
export const CommitWatchlistImportInput = z.object({
  previewId: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().min(1).max(120),
  selections: z.array(WatchlistImportSelectionSchema).min(1).max(100),
  excludedRows: z.array(z.number().int().positive()).max(100),
  acknowledgeExtraColumns: z.boolean().default(false),
  maxDistinctStocks: z.number().int().positive().max(1000),
});
export const CommitWatchlistImportOutput = z.object({ result: WatchlistImportResultSchema });
export const commitWatchlistImportTool = defineTool({
  name: 'commit_watchlist_import',
  description: '确认规范股票身份与明确排除项；原子提交 import 来源、批次与幂等回执',
  sideEffect: 'write',
  input: CommitWatchlistImportInput,
  output: CommitWatchlistImportOutput,
  handler: async (input, ctx) => ({
    result: await personalRepository(ctx).commitWatchlistImport({
      ...input,
      ownerUserId: ctx.user.id,
      now: ctx.clock(),
    }),
  }),
});
export const RemovePersonalWatchlistMembersInput = z.object({
  watchlistId: z.string().min(1),
  stockIds: z.array(z.string().min(1)).min(1).max(100),
  requestId: z.string().min(1).max(120),
});
export const RemovePersonalWatchlistMembersOutput = WatchlistRemovalResultSchema;
export const removePersonalWatchlistMembersTool = defineTool({
  name: 'remove_personal_watchlist_members',
  description: '结束本人 manual/import 来源；保留其它来源，只在没有有效来源时归档成员',
  sideEffect: 'write',
  input: RemovePersonalWatchlistMembersInput,
  output: RemovePersonalWatchlistMembersOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist?.kind !== 'personal') return errNotFound('Watchlist', input.watchlistId);
    return personalRepository(ctx).removePersonalMembers({
      ...input,
      ownerUserId: ctx.user.id,
      now: ctx.clock(),
    });
  },
});

export const RecordPersonalWatchFeedbackInput = z.object({
  triggerId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  rating: z.enum(['handled', 'useful', 'useless', 'ignored']),
  note: z.string().max(2000).default(''),
  requestId: z.string().min(1).max(120),
});
export const RecordPersonalWatchFeedbackOutput = z.object({
  feedback: PersonalWatchFeedbackSchema,
});
export const recordPersonalWatchFeedbackTool = defineTool({
  name: 'record_personal_watch_feedback',
  description: '无账户个人提醒反馈；冻结触发事实，按 expectedRevision 追加修订与请求回执',
  sideEffect: 'write',
  input: RecordPersonalWatchFeedbackInput,
  output: RecordPersonalWatchFeedbackOutput,
  handler: async (input, ctx) => {
    const previous = await personalRepository(ctx).listPersonalFeedback(input.triggerId);
    const trigger =
      previous.length > 0
        ? previous[0]?.triggerSnapshot
        : await ctx.repos.watchTrigger.findById(input.triggerId);
    if (
      trigger === null ||
      trigger === undefined ||
      trigger.direction !== 'watch' ||
      (trigger.ruleKind !== 'price-level' && trigger.ruleKind !== 'price-change')
    )
      return errNotFound('WatchTrigger', input.triggerId);
    return {
      feedback: await personalRepository(ctx).recordPersonalFeedback({
        ...input,
        inputHash: hash(input),
        now: ctx.clock(),
      }),
    };
  },
});
export const ListPersonalWatchFeedbackInput = z.object({ triggerId: z.string().min(1) });
export const ListPersonalWatchFeedbackOutput = z.object({
  revisions: z.array(PersonalWatchFeedbackSchema),
});
export const listPersonalWatchFeedbackTool = defineTool({
  name: 'list_personal_watch_feedback',
  description: '读取无账户个人提醒反馈的不可变修订，不混入账户复盘统计',
  sideEffect: 'read',
  input: ListPersonalWatchFeedbackInput,
  output: ListPersonalWatchFeedbackOutput,
  handler: async (input, ctx) => ({
    revisions: await personalRepository(ctx).listPersonalFeedback(input.triggerId),
  }),
});

export const PrepareWatchlistFactsRequestInput = z.object({
  watchlistId: z.string().min(1),
  period: z.string().date(),
  notificationPolicy: z.enum(['eligible', 'never']).default('never'),
});
export const PreparedWatchlistFactsInputSchema = PrepareWatchlistFactsRequestInput.extend({
  watchlistRevision: z.string().regex(/^[a-f0-9]{64}$/),
  ruleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  watchlist: WatchlistSchema,
  members: z.array(WatchlistMemberSchema),
  sources: z.array(WatchlistMemberSourceSchema),
  stocks: z.array(StockSchema),
  alertPlans: z.array(AlertPlanSchema),
});
export const PrepareWatchlistFactsRequestOutput = z.object({
  input: PreparedWatchlistFactsInputSchema,
});
export const prepareWatchlistFactsRequestTool = defineTool({
  name: 'prepare_watchlist_facts_request',
  description: '冻结事实报告的成员、规则和窗口输入；不访问供应商、不要求投资账户',
  sideEffect: 'read',
  input: PrepareWatchlistFactsRequestInput,
  output: PrepareWatchlistFactsRequestOutput,
  handler: async (input, ctx) => {
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist?.kind !== 'personal' || !watchlist.enabled)
      return errNotFound('Watchlist', input.watchlistId);
    if (input.period !== dateInShanghai(ctx.clock()))
      return errInvalidInput('事实摘要只接受当前上海自然日');
    const repo = personalRepository(ctx);
    const revision = await repo.getWatchlistRevision(watchlist.id);
    const candidates = await ctx.repos.watchlistMember.listMembers(watchlist.id);
    const sources = (
      await Promise.all(
        candidates.map((member) => ctx.repos.watchlistMember.listSources(member.id)),
      )
    )
      .flat()
      .sort((a, b) => a.id.localeCompare(b.id));
    const members = candidates
      .filter((member) =>
        sources.some((source) => source.memberId === member.id && source.status !== 'ended'),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (members.length === 0 || members.length > 100)
      return errInvalidInput('事实摘要要求 1 至 100 只有效自选');
    const stocks = (
      await Promise.all(members.map((member) => ctx.repos.stock.findById(member.stockId)))
    )
      .filter((stock) => stock !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const alertPlans = [...(await ctx.repos.alertPlan.list({ watchlistId: watchlist.id }))].sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    if (
      alertPlans.some((plan) =>
        plan.rules.some((rule) => rule.kind !== 'price-level' && rule.kind !== 'price-change'),
      )
    )
      return errInvalidInput('个人事实摘要只支持用户价格条件提醒');
    if ((await repo.getWatchlistRevision(watchlist.id)) !== revision)
      return errInvalidInput('自选已经变化，请重试');
    return {
      input: PreparedWatchlistFactsInputSchema.parse({
        ...input,
        watchlistRevision: revision,
        ruleFingerprint: hash(watchlistRuleRevisionInput(alertPlans)),
        watchlist,
        members,
        sources,
        stocks,
        alertPlans,
      }),
    };
  },
});

export const BuildWatchlistFactsInput = z.object({
  operationId: z.string().min(1),
  request: PreparedWatchlistFactsInputSchema,
});
export const BuildWatchlistFactsOutput = z.object({ report: ReportSchema });
export const buildWatchlistFactsTool = defineTool({
  name: 'build_watchlist_facts',
  description: '从冻结输入生成确定性自选事实报告；保留真实行情时间、缺数据及未配置来源，不调用 AI',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: BuildWatchlistFactsInput,
  output: BuildWatchlistFactsOutput,
  handler: async (input, ctx) => {
    const repo = personalRepository(ctx);
    const frozen = input.request;
    if (
      (await repo.getWatchlistRevision(frozen.watchlistId)) !== frozen.watchlistRevision ||
      hash(
        watchlistRuleRevisionInput(
          await ctx.repos.alertPlan.list({ watchlistId: frozen.watchlistId }),
        ),
      ) !== frozen.ruleFingerprint
    )
      return errInvalidInput('自选或规则已经变化，请重新提交事实摘要');
    const now = ctx.clock();
    const stockIds = frozen.members.map((member) => member.stockId).sort();
    const items = await resolveQuotes(ctx, stockIds, { context: 'display' });
    const gaps: ReportMissingDimension[] = [];
    const evidence: ReportEvidence[] = [];
    const marketRows = stockIds.map((stockId) => {
      const item = items.find((entry) => entry.stockId === stockId);
      const name = frozen.stocks.find((stock) => stock.id === stockId)?.name ?? stockId;
      if (
        item?.status !== 'ok' ||
        item.quote.observedAt > now ||
        dateInShanghai(item.quote.observedAt) !== frozen.period
      ) {
        gaps.push({
          dimension: `quote:${stockId}`,
          reason: item?.status === 'ok' ? '行情不属于本报告日期或时点无效' : '未取得可用行情',
          errorKind: 'unavailable',
          retryable: true,
        });
        return {
          stockId,
          name,
          close: null,
          changePct: null,
          dataAsOf: null,
          source: null,
          status: 'unavailable',
        };
      }
      const quote = item.quote;
      const trustedTime = quote.timestampSource === 'upstream';
      const freshness = trustedTime ? item.freshness : 'unknown';
      if (!trustedTime || freshness === 'stale')
        gaps.push({
          dimension: `quote-time:${stockId}`,
          reason: trustedTime
            ? '行情已陈旧；展示保留的真实市场时点'
            : '供应商只提供获取时间，市场事实时点未知',
          errorKind: trustedTime ? 'stale' : 'unknown',
          retryable: true,
        });
      if (quote.prevClose === undefined || Number(quote.prevClose) <= 0)
        gaps.push({
          dimension: `price-change:${stockId}`,
          reason: '缺少有效昨收，无法计算涨跌幅',
          errorKind: 'unavailable',
          retryable: true,
        });
      evidence.push({
        id: `quote:${stockId}`,
        dimension: `quote:${stockId}`,
        provenance: {
          provider: quote.source,
          observedAt: quote.observedAt,
          fetchedAt: quote.fetchedAt,
          freshness,
        },
      });
      return {
        stockId,
        name,
        close: Number(quote.close),
        changePct:
          quote.prevClose === undefined || Number(quote.prevClose) <= 0
            ? null
            : (Number(quote.close) / Number(quote.prevClose) - 1) * 100,
        dataAsOf: trustedTime ? quote.observedAt.toISOString() : null,
        source: quote.source,
        status: freshness,
      };
    });
    const start = new Date(`${frozen.period}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 86_400_000);
    const triggers = (
      await Promise.all(
        frozen.alertPlans.map((plan) =>
          ctx.repos.watchTrigger.listByPool(plan.id, { since: start, limit: 1000 }),
        ),
      )
    )
      .flat()
      .filter(
        (trigger) =>
          trigger.createdAt < end &&
          trigger.direction === 'watch' &&
          (trigger.ruleKind === 'price-level' || trigger.ruleKind === 'price-change'),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const sourceGaps: ReportMissingDimension[] = [
      {
        dimension: 'events',
        reason: '事件来源未配置，不代表没有事件；现有索引不代表完整市场覆盖',
        errorKind: 'not-configured',
        retryable: false,
      },
      {
        dimension: 'financial-reports',
        reason: '财报来源未配置，不代表没有财报披露',
        errorKind: 'not-configured',
        retryable: false,
      },
    ];
    const fingerprint = hash({
      frozen: { ...frozen, notificationPolicy: undefined },
      marketRows,
      triggers: triggers.map((trigger) => ({
        id: trigger.id,
        stockId: trigger.stockId,
        ruleId: trigger.ruleId,
        ruleKind: trigger.ruleKind,
        evidence: trigger.evidence,
        quote: trigger.quote,
        evalSnapshot: trigger.evalSnapshot,
        createdAt: trigger.createdAt,
      })),
      rendererVersion: 'facts-v1',
      sourceGaps,
    });
    const sections: ReportSection[] = [
      {
        key: 'watchlist',
        title: '当前自选与成员来源',
        required: true,
        status: 'complete',
        dataAsOf: frozen.watchlist.updatedAt,
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'stockId', label: '证券代码' },
              { key: 'name', label: '名称' },
              { key: 'stage', label: '关注状态' },
              { key: 'sources', label: '来源' },
              { key: 'addedAt', label: '加入时间' },
            ],
            rows: frozen.members.map((member) => ({
              stockId: member.stockId,
              name:
                frozen.stocks.find((stock) => stock.id === member.stockId)?.name ?? member.stockId,
              stage: member.stage,
              sources: frozen.sources
                .filter((source) => source.memberId === member.id)
                .map((source) => source.kind)
                .join('、'),
              addedAt: member.firstAddedAt.toISOString(),
            })),
          },
        ],
      },
      {
        key: 'market',
        title: '已取得的行情事实',
        required: true,
        status:
          gaps.length === 0
            ? 'complete'
            : marketRows.some((row) => row.close !== null)
              ? 'partial'
              : 'unavailable',
        evidenceIds: evidence.map((item) => item.id),
        missingDimensions: gaps,
        blocks: marketRows.some((row) => row.close !== null)
          ? [
              {
                kind: 'table',
                columns: [
                  { key: 'stockId', label: '证券代码' },
                  { key: 'name', label: '名称' },
                  { key: 'close', label: '最新价（元）' },
                  { key: 'changePct', label: '涨跌幅（%）' },
                  { key: 'dataAsOf', label: '市场时点' },
                  { key: 'source', label: '来源' },
                  { key: 'status', label: '数据状态' },
                ],
                rows: marketRows,
              },
            ]
          : [
              {
                kind: 'text',
                text: '本次未取得可用行情；自选已经保存，缺口不表示价格为零。',
                tone: 'warning',
              },
            ],
      },
      {
        key: 'rules',
        title: '用户设置的价格条件与触发',
        required: true,
        status: 'complete',
        evidenceIds: [],
        missingDimensions: [],
        blocks: [
          {
            kind: 'list',
            items: frozen.alertPlans.map((plan) => ({
              title: `${plan.name}（${plan.enabled ? '已启用' : '未启用'}）`,
              detail: plan.rules
                .flatMap((rule) =>
                  rule.kind === 'price-level'
                    ? [
                        `价格${rule.side === 'above' ? '达到或高于' : '达到或低于'} ${rule.level} 元`,
                      ]
                    : rule.kind === 'price-change'
                      ? [
                          `日${rule.direction === 'up' ? '涨幅' : rule.direction === 'down' ? '跌幅' : '涨跌幅绝对值'}达到 ${(rule.pct * 100).toFixed(2)}%`,
                        ]
                      : [],
                )
                .join('；'),
              entityKind: 'alert-plan',
              entityId: plan.id,
            })),
          },
          {
            kind: 'list',
            items: triggers.map((trigger) => ({
              title: `${trigger.stockId} ${trigger.reason}`,
              detail: trigger.evidence.join('；'),
              entityKind: 'watch-trigger',
              entityId: trigger.id,
            })),
          },
        ],
      },
      {
        key: 'sources',
        title: '事件与财报覆盖',
        required: true,
        status: 'unavailable',
        evidenceIds: [],
        missingDimensions: sourceGaps,
        blocks: [
          {
            kind: 'text',
            text: '事件与财报来源未配置。不能据此判断“无事件”或“无财报”。',
            tone: 'warning',
          },
        ],
      },
    ];
    const trustedTimes = items.flatMap((item) =>
      item.status === 'ok' &&
      item.quote.timestampSource === 'upstream' &&
      item.quote.observedAt <= now &&
      dateInShanghai(item.quote.observedAt) === frozen.period
        ? [item.quote.observedAt.getTime()]
        : [],
    );
    const dataAsOf = new Date(
      trustedTimes.length === 0
        ? Math.min(frozen.watchlist.updatedAt.getTime(), now.getTime())
        : Math.min(...trustedTimes),
    );
    const report = ReportSchema.parse({
      id: `facts-${hash([frozen.watchlistId, frozen.period, fingerprint]).slice(0, 32)}`,
      version: 1,
      kind: 'watchlist-facts',
      scope: { kind: 'watchlist', watchlistId: frozen.watchlistId },
      periodStart: frozen.period,
      periodEnd: frozen.period,
      title: `${frozen.watchlist.name} · 自选事实摘要`,
      generatedAt: now,
      dataAsOf,
      status: 'partial',
      sections,
      evidence,
      missingDimensions: [...gaps, ...sourceGaps],
      deliveryStatus: 'not-requested',
      notificationPolicy: frozen.notificationPolicy,
      watchlistFactsSnapshot: {
        schemaVersion: 1,
        watchlistRevision: frozen.watchlistRevision,
        ruleFingerprint: frozen.ruleFingerprint,
        inputFingerprint: fingerprint,
        rendererVersion: 'facts-v1',
        frozenInput: frozen,
      },
      workflowRunId: input.operationId,
      createdAt: now,
      updatedAt: now,
    });
    assertReportInvariants(report);
    return { report };
  },
});

export const CommitWatchlistFactsInput = z.object({
  operationId: z.string().min(1),
  report: ReportSchema,
});
export const CommitWatchlistFactsOutput = PersonalFactsReportResultSchema;
export const commitWatchlistFactsTool = defineTool({
  name: 'commit_watchlist_facts',
  description: '在本地事务内核对冻结输入，原子写事实报告与提交回执',
  sideEffect: 'write',
  input: CommitWatchlistFactsInput,
  output: CommitWatchlistFactsOutput,
  handler: async (input, ctx) => {
    const snapshot = input.report.watchlistFactsSnapshot;
    if (snapshot === undefined) return errInvalidInput('事实报告缺少冻结输入');
    return personalRepository(ctx).commitFactsReport({
      operationId: input.operationId,
      inputHash: snapshot.inputFingerprint,
      notificationPolicy: input.report.notificationPolicy === 'eligible' ? 'eligible' : 'never',
      now: ctx.clock(),
      report: input.report,
    });
  },
});
export const GetWatchlistFactsReportInput = z.object({
  watchlistId: z.string().min(1),
  reportId: z.string().min(1),
});
export const GetWatchlistFactsReportOutput = z.object({ report: ReportSchema });
export const getWatchlistFactsReportTool = defineTool({
  name: 'get_watchlist_facts_report',
  description: '读取当前个人自选范围内的已保存事实摘要，不刷新外部数据',
  sideEffect: 'read',
  input: GetWatchlistFactsReportInput,
  output: GetWatchlistFactsReportOutput,
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.reportId);
    return report?.kind === 'watchlist-facts' &&
      report.scope.kind === 'watchlist' &&
      report.scope.watchlistId === input.watchlistId
      ? { report }
      : errNotFound('Report', input.reportId);
  },
});
export const ListWatchlistFactsReportsInput = z.object({
  watchlistId: z.string().min(1),
  limit: z.number().int().positive().max(100).default(30),
});
export const ListWatchlistFactsReportsOutput = z.object({ reports: z.array(ReportSchema) });
export const listWatchlistFactsReportsTool = defineTool({
  name: 'list_watchlist_facts_reports',
  description: '读取个人自选事实摘要历史，按 watchlist-facts kind 与范围限定，不产生供应商成本',
  sideEffect: 'read',
  input: ListWatchlistFactsReportsInput,
  output: ListWatchlistFactsReportsOutput,
  handler: async (input, ctx) => ({
    reports: await ctx.repos.report.list({
      kind: 'watchlist-facts',
      scopeKey: `watchlist:${input.watchlistId}`,
      limit: input.limit,
    }),
  }),
});

export const SavePersonalAlertPlanInput = z.object({
  plan: PersonalAlertPlanConfigSchema,
  expectedPlanRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  requestId: z.string().min(1).max(120),
  enableConfirmed: z.boolean().default(false),
  maxEnabledRules: z.number().int().min(0).max(1000),
  maxDailyNotifications: z.number().int().min(1).max(100),
  minCooldownMinutes: z.number().int().min(0).max(1440),
});
export const SavePersonalAlertPlanOutput = PersonalAlertPlanMutationSchema;
export const savePersonalAlertPlanTool = defineTool({
  name: 'save_personal_alert_plan',
  description: '保存或暂停用户价格条件；按租户原子检查启用规则额度，启用必须显式确认',
  sideEffect: 'write',
  input: SavePersonalAlertPlanInput,
  output: SavePersonalAlertPlanOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    return personalRepository(ctx).savePersonalAlertPlan({
      ...input,
      plan: PersonalAlertPlanSchema.parse({ ...input.plan, createdAt: now, updatedAt: now }),
      now,
    });
  },
});
export const RemovePersonalAlertPlanInput = z.object({
  alertPlanId: z.string().min(1),
  expectedPlanRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().min(1).max(120),
});
export const RemovePersonalAlertPlanOutput = PersonalAlertPlanRemovalSchema;
export const removePersonalAlertPlanTool = defineTool({
  name: 'remove_personal_alert_plan',
  description: '按修订与 requestId 删除个人价格条件；保留触发历史并取消待送达事实',
  sideEffect: 'write',
  input: RemovePersonalAlertPlanInput,
  output: RemovePersonalAlertPlanOutput,
  handler: async (input, ctx) =>
    personalRepository(ctx).removePersonalAlertPlan({ ...input, now: ctx.clock() }),
});
export const pausePersonalAlertPlanTool = defineTool({
  name: 'pause_personal_alert_plan',
  description: '按当前修订暂停本人条件，到期后仍允许停止自动服务',
  sideEffect: 'write',
  input: RemovePersonalAlertPlanInput.strict(),
  output: PersonalAlertPlanMutationSchema,
  handler: async (input, ctx) => {
    const current = await ctx.repos.alertPlan.findById(input.alertPlanId);
    const parsed = PersonalAlertPlanSchema.safeParse(current);
    if (
      !parsed.success ||
      (await ctx.repos.watchlist.findById(parsed.data.watchlistId))?.kind !== 'personal'
    )
      return errNotFound('AlertPlan', input.alertPlanId);
    return personalRepository(ctx).savePersonalAlertPlan({
      plan: { ...parsed.data, enabled: false },
      expectedPlanRevision: input.expectedPlanRevision,
      requestId: input.requestId,
      enableConfirmed: false,
      maxEnabledRules: 0,
      maxDailyNotifications: 20,
      minCooldownMinutes: 15,
      now: ctx.clock(),
    });
  },
});
export const ListPersonalAlertPlansInput = z.object({ watchlistId: z.string().min(1).optional() });
export const ListPersonalAlertPlansOutput = z.object({
  plans: z.array(
    z.object({ plan: PersonalAlertPlanSchema, planRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});
export const listPersonalAlertPlansTool = defineTool({
  name: 'list_personal_alert_plans',
  description: '读取个人价格条件与可用于编辑的修订身份，不读取持仓成本或策略规则',
  sideEffect: 'read',
  input: ListPersonalAlertPlansInput,
  output: ListPersonalAlertPlansOutput,
  handler: async (input, ctx) => {
    const lists = await ctx.repos.watchlist.list();
    const personalIds = new Set(
      lists.filter((list) => list.kind === 'personal').map((list) => list.id),
    );
    const plans = await ctx.repos.alertPlan.list(
      input.watchlistId === undefined ? {} : { watchlistId: input.watchlistId },
    );
    return {
      plans: plans
        .filter(
          (plan) =>
            personalIds.has(plan.watchlistId) && PersonalAlertPlanSchema.safeParse(plan).success,
        )
        .map((plan) => ({ plan: PersonalAlertPlanSchema.parse(plan), planRevision: hash(plan) })),
    };
  },
});

const personalAlertSnapshot = async (
  ctx: ToolContext,
  input: { watchlistId: string; period: string; maxDailyNotifications: number },
  plans?: PersonalAlertRequest['alertPlans'],
): Promise<PersonalAlertRequest> => {
  const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
  if (watchlist?.kind !== 'personal' || !watchlist.enabled)
    throw new InvariantError('启用的个人自选不存在');
  if (input.period !== dateInShanghai(ctx.clock()))
    throw new InvariantError('个人价格条件只接受当前上海自然日');
  const repo = personalRepository(ctx);
  const watchlistRevision = await repo.getWatchlistRevision(watchlist.id);
  const candidates = await ctx.repos.watchlistMember.listMembers(watchlist.id);
  const sources = (
    await Promise.all(candidates.map((member) => ctx.repos.watchlistMember.listSources(member.id)))
  )
    .flat()
    .sort((a, b) => a.id.localeCompare(b.id));
  const members = candidates
    .filter((member) =>
      sources.some((source) => source.memberId === member.id && source.status !== 'ended'),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const stocks = (
    await Promise.all(members.map((member) => ctx.repos.stock.findById(member.stockId)))
  )
    .filter((stock) => stock !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const alertPlans =
    plans ??
    (await ctx.repos.alertPlan.list({ watchlistId: watchlist.id, enabledOnly: true })).map((plan) =>
      PersonalAlertPlanSchema.parse(plan),
    );
  if (alertPlans.some((plan) => plan.watchlistId !== input.watchlistId))
    throw new InvariantError('个人价格条件范围不匹配');
  if ((await repo.getWatchlistRevision(watchlist.id)) !== watchlistRevision)
    throw new InvariantError('自选已经变化，请重试');
  return PersonalAlertRequestSchema.parse({
    ...input,
    notificationPolicy: 'never',
    watchlistRevision,
    ruleFingerprint: hash(watchlistRuleRevisionInput(alertPlans)),
    watchlist,
    members,
    sources,
    stocks,
    alertPlans,
  });
};

const readPersonalAlertQuotes = async (ctx: ToolContext, stockIds: readonly string[]) => {
  const quotes: Quote[] = [];
  const quoteErrors: { stockId: string; reason: string }[] = [];
  if (stockIds.length === 0) return { quotes, quoteErrors };
  let market: Map<string, Quote>;
  try {
    market = await ctx.adapters.market.batchQuote(stockIds);
  } catch {
    return {
      quotes,
      quoteErrors: stockIds.map((stockId) => ({ stockId, reason: '行情供应商暂不可用' })),
    };
  }
  for (const stockId of stockIds) {
    const raw = market.get(stockId);
    const parsed = QuoteSchema.safeParse(raw);
    if (!parsed.success || parsed.data.stockId !== stockId)
      quoteErrors.push({ stockId, reason: '未取得匹配规范股票身份的有效行情' });
    else quotes.push(parsed.data);
  }
  return { quotes, quoteErrors };
};
const personalAlertStockIds = (request: PersonalAlertRequest): string[] =>
  [
    ...new Set(
      request.members
        .filter((member) =>
          request.stocks.some(
            (stock) => stock.id === member.stockId && ['SH', 'SZ', 'BJ'].includes(stock.exchange),
          ),
        )
        .map((member) => member.stockId),
    ),
  ].sort();

export const PreviewPersonalAlertPlanInput = z.object({ plan: PersonalAlertPlanConfigSchema });
export const PreviewPersonalAlertPlanOutput = z.object({
  evaluation: PersonalAlertEvaluationSchema,
});
export const previewPersonalAlertPlanTool = defineTool({
  name: 'preview_personal_alert_plan',
  description: '直接读取行情试算用户价格条件；不写行情缓存、正式触发、边沿、回执或通知意图',
  sideEffect: 'external',
  input: PreviewPersonalAlertPlanInput,
  output: PreviewPersonalAlertPlanOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const plan = PersonalAlertPlanSchema.parse({
      ...input.plan,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const request = await personalAlertSnapshot(
      ctx,
      { watchlistId: plan.watchlistId, period: dateInShanghai(now), maxDailyNotifications: 100 },
      [plan],
    );
    const market = await readPersonalAlertQuotes(ctx, personalAlertStockIds(request));
    const { evaluation } = evaluatePersonalPriceAlerts({
      operationId: 'preview',
      mode: 'preview',
      request,
      ...market,
      states: [],
      priorTriggers: [],
      now: ctx.clock(),
    });
    return { evaluation };
  },
});
export const PreparePersonalAlertRequestInput = z.object({
  watchlistId: z.string().min(1),
  period: z.string().date(),
  maxDailyNotifications: z.number().int().min(1).max(100),
});
export const PreparePersonalAlertRequestOutput = z.object({ input: PersonalAlertRequestSchema });
export const preparePersonalAlertRequestTool = defineTool({
  name: 'prepare_personal_alert_request',
  description: '供 worker 冻结当前启用的价格条件、有效自选与上海日期，不访问供应商或读取账户',
  sideEffect: 'read',
  input: PreparePersonalAlertRequestInput,
  output: PreparePersonalAlertRequestOutput,
  handler: async (input, ctx) => ({
    input: await personalAlertSnapshot(ctx, input),
  }),
});
export const BuildPersonalAlertEvaluationInput = z.object({
  operationId: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
  request: PersonalAlertRequestSchema,
});
export const BuildPersonalAlertEvaluationOutput = z.object({
  draft: PersonalAlertEvaluationDraftSchema.optional(),
  evaluation: PersonalAlertEvaluationSchema.optional(),
});
export const buildPersonalAlertEvaluationTool = defineTool({
  name: 'build_personal_alert_evaluation',
  description: '读取冻结请求，在领域执行租约内取得行情；业务写入由原子 commit 完成',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: BuildPersonalAlertEvaluationInput,
  output: BuildPersonalAlertEvaluationOutput,
  handler: async (input, ctx) => {
    const repo = personalRepository(ctx);
    const frozen = input.request;
    const currentPlans = await ctx.repos.alertPlan.list({
      watchlistId: frozen.watchlistId,
      enabledOnly: true,
    });
    if (
      frozen.period !== dateInShanghai(ctx.clock()) ||
      (await repo.getWatchlistRevision(frozen.watchlistId)) !== frozen.watchlistRevision ||
      hash(watchlistRuleRevisionInput(currentPlans)) !== frozen.ruleFingerprint
    )
      return errInvalidInput('自选或启用条件已经变化，请重新提交评估');
    const now = ctx.clock();
    const domainLeaseOwner = personalAlertLeaseOwner(
      input.operationId,
      input.attemptId,
      input.fence,
    );
    if (
      !(await ctx.repos.watchTrigger.acquireExecution(
        domainLeaseOwner,
        now,
        new Date(now.getTime() + 120_000),
      ))
    )
      return {
        ok: false,
        error: { kind: 'lease_lost_before_commit', message: 'watch execution lease is busy' },
      };
    try {
      const market = await readPersonalAlertQuotes(ctx, personalAlertStockIds(frozen));
      return { draft: { domainLeaseOwner, evaluatedAt: ctx.clock(), ...market } };
    } catch (cause) {
      await ctx.repos.watchTrigger.releaseExecution(domainLeaseOwner);
      throw cause;
    }
  },
});
export const CommitPersonalAlertEvaluationInput = BuildPersonalAlertEvaluationInput.extend({
  draft: PersonalAlertEvaluationDraftSchema.optional(),
});
export const CommitPersonalAlertEvaluationOutput = PersonalAlertResultSchema;
export const commitPersonalAlertEvaluationTool = defineTool({
  name: 'commit_personal_alert_evaluation',
  description: '核对本地 fence 和领域 lease，原子重算边沿并提交 Trigger、状态与提交回执',
  sideEffect: 'write',
  input: CommitPersonalAlertEvaluationInput,
  output: CommitPersonalAlertEvaluationOutput,
  handler: async (input, ctx) => {
    const owner = personalAlertLeaseOwner(input.operationId, input.attemptId, input.fence);
    try {
      return await personalRepository(ctx).commitPersonalAlertEvaluation({
        operationId: input.operationId,
        inputHash: hash(input.request),
        attemptId: input.attemptId,
        fence: input.fence,
        request: input.request,
        ...(input.draft === undefined ? {} : { draft: input.draft }),
        now: ctx.clock(),
      });
    } finally {
      if (input.draft?.domainLeaseOwner === owner)
        await ctx.repos.watchTrigger.releaseExecution(owner);
    }
  },
});
export const GetPersonalAlertEvaluationInput = z.object({
  resultRef: z.string().min(1),
  watchlistId: z.string().min(1),
});
export const GetPersonalAlertEvaluationOutput = z.object({
  evaluation: PersonalAlertEvaluationSchema,
});
export const getPersonalAlertEvaluationTool = defineTool({
  name: 'get_personal_alert_evaluation',
  description: '读取已保存的个人价格条件正式评估，不刷新行情或触发通知',
  sideEffect: 'read',
  input: GetPersonalAlertEvaluationInput,
  output: GetPersonalAlertEvaluationOutput,
  handler: async (input, ctx) => {
    const evaluation = await personalRepository(ctx).getPersonalAlertEvaluation(input.resultRef);
    return evaluation?.watchlistId === input.watchlistId
      ? { evaluation }
      : errNotFound('PersonalAlertEvaluation', input.resultRef);
  },
});

export const personalTools = [
  previewWatchlistImportTool,
  commitWatchlistImportTool,
  removePersonalWatchlistMembersTool,
  recordPersonalWatchFeedbackTool,
  listPersonalWatchFeedbackTool,
  prepareWatchlistFactsRequestTool,
  getWatchlistFactsReportTool,
  listWatchlistFactsReportsTool,
  savePersonalAlertPlanTool,
  removePersonalAlertPlanTool,
  pausePersonalAlertPlanTool,
  listPersonalAlertPlansTool,
  previewPersonalAlertPlanTool,
  preparePersonalAlertRequestTool,
  getPersonalAlertEvaluationTool,
] as const;
