import { createHash } from 'node:crypto';
import {
  assertInvestmentConsensusInvariants,
  getStrategyRunDataHealth,
  type InvestmentConsensus,
  InvestmentConsensusSchema,
  InvestmentDiscussionSourceSchema,
  InvestmentRecentIntentSchema,
  InvestmentResearchSchema,
  type InvestmentSelection,
  type InvestmentTracking,
  InvestmentTrackingSchema,
  InvestmentUnmappedDirectionSchema,
  type InvestmentWorkspaceOwner,
  investmentConsensusState,
  investmentDirectionIdentity,
  isInvestmentEvidenceCurrent,
  isPublishableOperationalRun,
  type Strategy,
  type StrategyRun,
  type StrategyVersion,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { unsubscribeStrategyFromWatchlistTool } from './strategy-watchlist-subscription.js';
import { syncWatchlistSourceTool } from './watchlist.js';

const Id = z.string().min(1).max(200);
const Text = z.string().trim().min(1).max(2000);
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const newId = (prefix: string): string => `${prefix}-${globalThis.crypto.randomUUID()}`;
const ownerOf = (ctx: ToolContext): InvestmentWorkspaceOwner => ({
  ownerUserId: ctx.user.id,
  accountId: ctx.user.defaultAccountId,
});
const denied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'current-account-discussion' },
});
const LIMITATIONS = [
  '方向只解释明确覆盖的市场事实或已发布策略，不代表全市场个股机会排序或收益概率。',
  '未核验完整公告、新闻与真实财务PIT；缺失维度不能作为支持理由。',
  '账户登记完整性与实时资金尚未核验；方向仅供研究，不含仓位、买卖授权或自动交易。',
  '事实时点与研究生成时间分开；盘后事实不能当作实时行动条件。',
];

const resolveSource = async (
  input: z.infer<typeof InvestmentDiscussionSourceSchema>,
  ctx: ToolContext,
): Promise<z.infer<typeof InvestmentDiscussionSourceSchema> | null> => {
  if (input.sessionId === undefined && input.messageId === undefined) return input;
  if (input.sessionId === undefined || input.messageId === undefined) return null;
  const session = await ctx.repos.chat.findSessionById(input.sessionId);
  if (session?.accountId !== ctx.user.defaultAccountId) return null;
  const message = await ctx.repos.chat.findMessageById(input.sessionId, input.messageId);
  if (message?.role !== 'user') return null;
  const userText = message.parts
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
    .trim();
  if (userText !== input.userText) return null;
  return { ...input, userText };
};

const currentConsensus = async (ctx: ToolContext): Promise<InvestmentConsensus | null> =>
  (await ctx.repos.investmentWorkspace.listConsensus({ ...ownerOf(ctx), limit: 1 }))[0] ?? null;

const effectiveIntent = (consensus: InvestmentConsensus | null, now: Date) => {
  if (
    consensus === null ||
    ['expired', 'revoked'].includes(investmentConsensusState(consensus, now))
  )
    return null;
  const intent = consensus.recentIntent;
  return intent !== null && intent.startsAt <= now && now < intent.reviewAt ? intent : null;
};

const loadPublished = async (
  strategyId: string,
  ctx: ToolContext,
): Promise<{
  strategy: Strategy;
  version: StrategyVersion;
  run: StrategyRun;
} | null> => {
  const strategy = await ctx.repos.strategy.findById(strategyId);
  if (strategy?.status !== 'active') return null;
  const run = await ctx.repos.strategyRun.findLatestPublishedRun(strategyId);
  if (
    run === null ||
    !isPublishableOperationalRun(run) ||
    run.strategyVersionId !== strategy.currentVersionId ||
    !isInvestmentEvidenceCurrent(run.dataAsOf, ctx.clock()) ||
    getStrategyRunDataHealth(run) === 'unavailable'
  )
    return null;
  const version = await ctx.repos.strategy.findVersionById(run.strategyVersionId);
  if (
    version === null ||
    version.strategyId !== strategy.id ||
    version.publishedAt === undefined ||
    version.validationStatus !== 'valid'
  )
    return null;
  return { strategy, version, run };
};

export const GetInvestmentWorkspaceInput = z.object({
  researchId: Id.optional(),
  historyLimit: z.number().int().min(1).max(50).default(10),
});
export const GetInvestmentWorkspaceOutput = z.object({
  research: InvestmentResearchSchema.nullable(),
  consensus: InvestmentConsensusSchema.nullable(),
  consensusState: z.enum(['none', 'confirmed', 'revoked', 'expired', 'review-required']),
  effectiveIntent: InvestmentRecentIntentSchema.nullable(),
  history: z.array(InvestmentConsensusSchema),
  tracking: InvestmentTrackingSchema.nullable(),
  limitations: z.array(z.string()),
  trackingEligibility: z.object({
    eligible: z.boolean(),
    reason: Text,
    mappedDirectionIds: z.array(Id),
    unmappedDirections: z.array(InvestmentUnmappedDirectionSchema),
  }),
});

export const getInvestmentWorkspaceTool = defineTool({
  name: 'get_investment_workspace',
  description: '读取当前账户方向研究、共识版本、近期意愿和独立跟踪状态；跨日恢复不依赖聊天记录',
  sideEffect: 'read',
  input: GetInvestmentWorkspaceInput,
  output: GetInvestmentWorkspaceOutput,
  handler: async (input, ctx) => {
    const owner = ownerOf(ctx);
    const research =
      input.researchId === undefined
        ? ((await ctx.repos.investmentWorkspace.listResearch({ ...owner, limit: 1 }))[0] ?? null)
        : await ctx.repos.investmentWorkspace.findResearch({ ...owner, id: input.researchId });
    if (input.researchId !== undefined && research === null)
      return errNotFound('InvestmentResearch', input.researchId);
    const history = [
      ...(await ctx.repos.investmentWorkspace.listConsensus({
        ...owner,
        limit: input.historyLimit,
      })),
    ];
    const consensus = history[0] ?? null;
    const limitations = [...LIMITATIONS];
    let state =
      consensus === null ? ('none' as const) : investmentConsensusState(consensus, ctx.clock());
    if (consensus !== null && state === 'confirmed') {
      for (const selection of consensus.selections.filter(
        (selection) => selection.role !== 'avoid',
      )) {
        if (selection.direction.opportunityType === 'market-participation') {
          if (selection.direction.validUntil <= ctx.clock()) {
            state = 'review-required';
            limitations.push(
              `${selection.direction.name}：原市场事实已到期，保存的共识仍可回看，需要新证据复核。`,
            );
          }
          continue;
        }
        const published = await loadPublished(selection.direction.strategyId, ctx);
        if (published === null || published.version.id !== selection.direction.strategyVersionId) {
          state = 'review-required';
          limitations.push(
            `${selection.direction.name}：策略版本已变更或当前事实不可用，请复核原共识。`,
          );
        } else if (getStrategyRunDataHealth(published.run) === 'partial') {
          limitations.push(
            `${selection.direction.name}：当前运行仅有部分数据，保留可用事实，不代表已完成完整市场检查。`,
          );
        }
      }
    }
    let tracking = (await ctx.repos.investmentWorkspace.listTracking(owner))[0] ?? null;
    if (tracking !== null && (tracking.status === 'tracking' || tracking.status === 'partial')) {
      const items = await Promise.all(
        tracking.items.map(async (item) => {
          if (item.status !== 'tracking') return item;
          const subscription =
            item.subscriptionId === null
              ? null
              : await ctx.repos.strategyWatchlistSubscription.findById(item.subscriptionId);
          const watchlist = await ctx.repos.watchlist.findById(item.watchlistId);
          const schedule = await ctx.repos.strategySchedule.findByStrategyId(item.strategyId);
          const strategy = await ctx.repos.strategy.findById(item.strategyId);
          if (
            subscription?.status !== 'active' ||
            watchlist?.enabled !== true ||
            state !== 'confirmed' ||
            consensus?.version !== tracking?.consensusVersion ||
            effectiveIntent(consensus, ctx.clock())?.mode === 'pause-new-opportunities' ||
            strategy?.currentVersionId !== subscription.investmentBinding?.strategyVersionId
          ) {
            return {
              ...item,
              status: 'paused' as const,
              reason: '当前订阅已暂停、授权到期、策略换版或需复核；这不是正在运行的跟踪。',
            };
          }
          return {
            ...item,
            reason:
              schedule?.enabled === true
                ? '订阅与策略调度当前已配置；实际检查仍须核对后台运行审计。'
                : '订阅已保存，但自动调度未开启，不能声称后台正在运行。',
          };
        }),
      );
      const schedules = await Promise.all(
        items
          .filter((item) => item.status === 'tracking')
          .map((item) => ctx.repos.strategySchedule.findByStrategyId(item.strategyId)),
      );
      tracking = {
        ...tracking,
        items,
        status: items.every((item) => item.status === 'paused')
          ? 'paused'
          : (tracking.unmappedDirections?.length ?? 0) > 0 ||
              items.some((item) => item.status !== 'tracking') ||
              schedules.some((schedule) => schedule?.enabled !== true)
            ? 'partial'
            : 'tracking',
      };
    }
    if (tracking?.status === 'starting')
      limitations.push('跟踪仍在启动或上次执行中断；先核对已有订阅，不应重复执行。');
    if (tracking !== null && tracking.consensusVersion !== consensus?.version)
      limitations.push('已有跟踪记录属于旧共识版本，不能表示新共识已执行。');
    const selected = consensus?.selections.filter((selection) => selection.role !== 'avoid') ?? [];
    const unmappedDirections = selected.flatMap((selection) =>
      selection.direction.opportunityType === 'market-participation'
        ? [{ directionId: selection.directionId, reason: selection.direction.tracking.reason }]
        : [],
    );
    const mappedDirectionIds = selected
      .filter((selection) => selection.direction.opportunityType === 'strategy-selection')
      .map((selection) => selection.directionId);
    const pausedNewOpportunities =
      effectiveIntent(consensus, ctx.clock())?.mode === 'pause-new-opportunities';
    return {
      research,
      consensus,
      consensusState: state,
      effectiveIntent: effectiveIntent(consensus, ctx.clock()),
      history,
      tracking,
      limitations,
      trackingEligibility: {
        eligible: state === 'confirmed' && !pausedNewOpportunities && mappedDirectionIds.length > 0,
        mappedDirectionIds,
        unmappedDirections,
        reason: pausedNewOpportunities
          ? '近期意愿已暂停新机会，不能开启候选跟踪。'
          : mappedDirectionIds.length === 0
            ? '当前选择没有真实策略与股票候选映射；共识可保存，暂不能开启个股跟踪。'
            : state !== 'confirmed'
              ? '当前共识需复核或已失效，不能开启候选跟踪。'
              : unmappedDirections.length > 0
                ? '只能开启已映射的策略方向；市场方向暂不能个股跟踪。'
                : '可独立确认连接策略候选；实际启动结果另行核对。',
      },
    };
  },
});

export const SaveInvestmentConsensusInput = z.object({
  requestId: Id,
  expectedVersion: z.number().int().nonnegative(),
  changes: z
    .object({
      selections: z
        .array(
          z.object({
            researchId: Id,
            directionId: Id,
            role: z.enum(['primary', 'observe', 'avoid']),
            userReason: Text,
          }),
        )
        .max(3)
        .optional(),
      constraints: z.array(Text).max(20).optional(),
      recentIntent: InvestmentRecentIntentSchema.nullable().optional(),
    })
    .strict(),
  status: z.enum(['confirmed', 'revoked']).default('confirmed'),
  source: InvestmentDiscussionSourceSchema,
  changeNote: Text,
  reviewAt: z.coerce.date(),
  validUntil: z.coerce.date(),
});
export const SaveInvestmentConsensusOutput = z.object({
  consensus: InvestmentConsensusSchema,
  replayed: z.boolean(),
  tracking: InvestmentTrackingSchema.nullable(),
});

export const saveInvestmentConsensusTool = defineTool({
  name: 'save_investment_consensus',
  description:
    '确认或修订方向、约束与近期意愿；遗漏字段保留旧值，版本冲突须刷新重确认；修订暂停本功能旧候选同步，已有持仓风险跟踪不变',
  sideEffect: 'write',
  input: SaveInvestmentConsensusInput,
  output: SaveInvestmentConsensusOutput,
  handler: async (input, ctx) => {
    const owner = ownerOf(ctx);
    if ((await ctx.repos.account.findById(owner.accountId)) === null)
      return errNotFound('Account', owner.accountId);
    const requestHash = digest(input);
    const receipt = await ctx.repos.investmentWorkspace.findConsensusReceipt({
      ...owner,
      requestId: input.requestId,
    });
    if (receipt !== null) {
      if (receipt.requestHash !== requestHash) return errInvalidInput('request_id_conflict');
      return {
        consensus: receipt.consensus,
        replayed: true,
        tracking: (await ctx.repos.investmentWorkspace.listTracking(owner))[0] ?? null,
      };
    }
    const source = await resolveSource(input.source, ctx);
    if (source === null) return denied();
    const previous = await currentConsensus(ctx);
    if ((previous?.version ?? 0) !== input.expectedVersion)
      return {
        ok: false,
        error: {
          kind: 'invariant_violation',
          message: 'consensus_version_conflict: 请读取最新共识并重新确认。',
        },
      };
    const selections: InvestmentSelection[] = [];
    for (const selection of input.changes.selections ?? []) {
      const research = await ctx.repos.investmentWorkspace.findResearch({
        ...owner,
        id: selection.researchId,
      });
      if (research === null) return errNotFound('InvestmentResearch', selection.researchId);
      const direction = research.directions.find(
        (direction) => direction.id === selection.directionId,
      );
      if (direction === undefined) return errNotFound('InvestmentDirection', selection.directionId);
      if (direction.validUntil <= ctx.clock())
        return errInvalidInput('方向依据已过期，请重新研究后确认。');
      selections.push({ ...selection, direction });
    }
    const now = ctx.clock();
    const consensus: InvestmentConsensus = {
      id: newId('investment-consensus'),
      ...owner,
      version: input.expectedVersion + 1,
      supersedesId: previous?.id ?? null,
      status: input.status,
      selections:
        input.changes.selections === undefined ? (previous?.selections ?? []) : selections,
      constraints: input.changes.constraints ?? previous?.constraints ?? [],
      recentIntent:
        input.changes.recentIntent === undefined
          ? (previous?.recentIntent ?? null)
          : input.changes.recentIntent,
      source,
      changeNote: input.changeNote,
      effectScope: 'future-research-only',
      reviewAt: input.reviewAt,
      validUntil: input.validUntil,
      createdAt: now,
    };
    assertInvestmentConsensusInvariants(consensus);
    const saved = await ctx.repos.investmentWorkspace.commitConsensus({
      consensus,
      expectedVersion: input.expectedVersion,
      requestId: input.requestId,
      requestHash,
    });
    const trackingHistory = await ctx.repos.investmentWorkspace.listTracking(owner);
    if (saved.replayed || trackingHistory.length === 0)
      return { ...saved, tracking: trackingHistory[0] ?? null };
    const paused = await setInvestmentTrackingTool.execute(
      {
        requestId: `revision-pause:${consensus.id}`,
        expectedVersion: consensus.version,
        action: 'pause',
      },
      ctx,
    );
    return {
      ...saved,
      tracking: paused.ok
        ? paused.data.tracking
        : ((await ctx.repos.investmentWorkspace.listTracking(owner))[0] ?? null),
    };
  },
});

export const SetInvestmentTrackingInput = z
  .object({
    requestId: Id,
    expectedVersion: z.number().int().positive(),
    action: z.enum(['start', 'pause']),
    recoverAttemptId: Id.optional(),
  })
  .refine(
    (input) => input.recoverAttemptId === undefined || input.action === 'pause',
    '中断恢复只能显式暂停，不能自动重放开启',
  );
export const SetInvestmentTrackingOutput = z.object({
  tracking: InvestmentTrackingSchema,
  replayed: z.boolean(),
});
const watchlistIdFor = (owner: InvestmentWorkspaceOwner, strategyId: string): string =>
  `investment-${digest({ ...owner, strategyId }).slice(0, 28)}`;

export const setInvestmentTrackingTool = defineTool({
  name: 'set_investment_tracking',
  description:
    '独立确认开启/暂停方向专用 Watchlist 与 Strategy 订阅；不自动开启付费研究、策略调度或通知，不修改已有持仓风险计划',
  sideEffect: 'write',
  input: SetInvestmentTrackingInput,
  output: SetInvestmentTrackingOutput,
  handler: async (input, ctx) => {
    const owner = ownerOf(ctx);
    const requestHash = digest(input);
    const history = await ctx.repos.investmentWorkspace.listTracking(owner);
    const receipt = history.find((attempt) => attempt.requestId === input.requestId);
    if (receipt !== undefined)
      return receipt.requestHash === requestHash
        ? { tracking: receipt, replayed: true }
        : errInvalidInput('request_id_conflict');
    const consensus = await currentConsensus(ctx);
    if (consensus === null) return errNotFound('InvestmentConsensus', owner.accountId);
    if (consensus.version !== input.expectedVersion)
      return {
        ok: false,
        error: {
          kind: 'invariant_violation',
          message: 'consensus_version_conflict: 请读取最新共识后重新确认。',
        },
      };
    if (
      input.action === 'start' &&
      (investmentConsensusState(consensus, ctx.clock()) !== 'confirmed' ||
        effectiveIntent(consensus, ctx.clock())?.mode === 'pause-new-opportunities')
    )
      return errInvalidInput('共识需复核、已失效或已暂停新机会，不能开启候选同步。');
    if (
      input.action === 'start' &&
      !consensus.selections.some((selection) => selection.role !== 'avoid')
    ) {
      return errInvalidInput('尚未确认可跟踪方向；请先选择主方向或观察方向。');
    }
    const unmappedDirections = consensus.selections.flatMap((selection) =>
      selection.role !== 'avoid' && selection.direction.opportunityType === 'market-participation'
        ? [{ directionId: selection.directionId, reason: selection.direction.tracking.reason }]
        : [],
    );
    if (
      input.action === 'start' &&
      !consensus.selections.some(
        (selection) =>
          selection.role !== 'avoid' &&
          selection.direction.opportunityType === 'strategy-selection',
      )
    ) {
      return errInvalidInput(
        'unmapped_market_direction: 共识已保存，但当前市场方向尚无真实策略与股票候选映射，暂不能开启个股跟踪。不会自动创建或发布策略。',
      );
    }
    if (input.recoverAttemptId !== undefined) {
      const interrupted = history.find((item) => item.id === input.recoverAttemptId);
      if (
        interrupted?.status !== 'starting' ||
        interrupted.consensusVersion !== input.expectedVersion ||
        ctx.clock().getTime() - interrupted.startedAt.getTime() < 5 * 60_000
      ) {
        return errInvalidInput(
          '只能在核对实际订阅后，显式暂停至少五分钟前仍 starting 的本账户尝试。',
        );
      }
      await ctx.repos.investmentWorkspace.finishTracking({
        ...interrupted,
        status: 'failed',
        finishedAt: ctx.clock(),
      });
    }
    const attempt: InvestmentTracking = {
      id: newId('investment-tracking'),
      ...owner,
      consensusVersion: input.expectedVersion,
      requestId: input.requestId,
      requestHash,
      action: input.action,
      status: 'starting',
      items: [],
      startedAt: ctx.clock(),
      finishedAt: null,
      ...(unmappedDirections.length === 0 ? {} : { unmappedDirections }),
    };
    const claimed = await ctx.repos.investmentWorkspace.claimTracking(attempt);
    if (claimed.replayed) return claimed;
    const ownsClaim = async (): Promise<boolean> =>
      (await ctx.repos.investmentWorkspace.listTracking(owner)).some(
        (item) => item.id === attempt.id && item.status === 'starting',
      );
    const items: InvestmentTracking['items'] = [];
    // 专用列表只承载方向候选；暂停仅取消这些订阅，不触碰持仓或 AlertPlan。
    const revisions = await ctx.repos.investmentWorkspace.listConsensus({
      ...owner,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const strategyIds = new Set(
      revisions.flatMap((revision) =>
        revision.selections.flatMap((selection) =>
          selection.direction.opportunityType === 'strategy-selection'
            ? [selection.direction.strategyId]
            : [],
        ),
      ),
    );
    let pauseFailed = false;
    for (const strategyId of strategyIds) {
      const watchlistId = watchlistIdFor(owner, strategyId);
      try {
        const active = await ctx.repos.strategyWatchlistSubscription.findActive({
          strategyId,
          watchlistId,
        });
        if (active === null) continue;
        const result = await unsubscribeStrategyFromWatchlistTool.execute(
          { subscriptionId: active.id },
          ctx,
        );
        if (!result.ok) throw new Error('subscription pause failed');
        items.push({
          strategyId,
          directionId:
            consensus.selections.find(
              (selection) =>
                investmentDirectionIdentity(selection.direction) === `strategy:${strategyId}`,
            )?.directionId ?? 'previous-consensus',
          watchlistId,
          subscriptionId: active.id,
          syncRunId: null,
          status: 'paused',
          reason: '已暂停此方向的新候选同步；持仓风险计划不受影响。',
        });
      } catch {
        pauseFailed = true;
        items.push({
          strategyId,
          directionId: 'previous-consensus',
          watchlistId,
          subscriptionId: null,
          syncRunId: null,
          status: 'failed',
          reason: '旧方向订阅暂停失败；请核对后用新 requestId 重试。',
        });
      }
    }
    if (input.action === 'start' && !pauseFailed) {
      items.length = 0;
      for (const selection of consensus.selections.filter(
        (selection) => selection.role !== 'avoid',
      )) {
        if (selection.direction.opportunityType !== 'strategy-selection') continue;
        const strategyId = selection.direction.strategyId;
        const watchlistId = watchlistIdFor(owner, strategyId);
        let subscriptionId: string | null = null;
        try {
          const published = await loadPublished(strategyId, ctx);
          if (published === null || published.version.id !== selection.direction.strategyVersionId)
            throw new Error('current facts unavailable');
          const now = ctx.clock();
          const existing = await ctx.repos.watchlist.findById(watchlistId);
          if (!(await ownsClaim()))
            return errInvalidInput('tracking_claim_lost: 请读取恢复后的实际状态。');
          await ctx.repos.watchlist.save({
            id: watchlistId,
            name: `方向：${selection.direction.name}`.slice(0, 80),
            kind: 'personal',
            membershipPolicy: 'mixed',
            enabled: true,
            description:
              `共识 v${consensus.version} / ${selection.researchId} / ${selection.directionId}；只跟踪已确认的 Strategy 版本，换版、到期或意愿复核后停止新候选同步；不含付费研究或通知授权。`.slice(
                0,
                1000,
              ),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
          subscriptionId = newId('investment-subscription');
          if (!(await ownsClaim()))
            return errInvalidInput('tracking_claim_lost: 请读取恢复后的实际状态。');
          await ctx.repos.strategyWatchlistSubscription.save({
            id: subscriptionId,
            strategyId,
            watchlistId,
            sourceKey: `strategy:${strategyId}`,
            status: 'active',
            createdBy: ctx.user.id,
            createdAt: now,
            updatedAt: now,
            investmentBinding: {
              ...owner,
              consensusId: consensus.id,
              consensusVersion: consensus.version,
              strategyVersionId: published.version.id,
            },
          });
          const results = await ctx.repos.strategyRun.listResults(published.run.id);
          if (!(await ownsClaim())) {
            await unsubscribeStrategyFromWatchlistTool.execute({ subscriptionId }, ctx);
            return errInvalidInput('tracking_claim_lost: 已停止本次订阅，读取实际状态。');
          }
          const synced = await syncWatchlistSourceTool.execute(
            {
              watchlistId,
              sourceKind: 'strategy',
              sourceKey: `strategy:${strategyId}`,
              sourceId: strategyId,
              sourceVersionId: published.version.id,
              producerRunId: published.run.id,
              status:
                getStrategyRunDataHealth(published.run) === 'complete' ? 'complete' : 'partial',
              dataAsOf: published.run.dataAsOf,
              candidates: results
                .filter((result) => result.selected)
                .map((result) => ({
                  stockId: result.stockId,
                  reason: `共识 v${consensus.version} 的方向 ${selection.direction.name}，来自 ${published.run.id}`,
                  evidence: [...result.evidence, selection.researchId, selection.directionId],
                  dataAsOf: result.dataAsOf,
                  ...(result.score === undefined ? {} : { score: result.score }),
                  ...(result.rank === undefined ? {} : { rank: result.rank }),
                })),
            },
            ctx,
          );
          if (!synced.ok) throw new Error('candidate sync failed');
          const schedule = await ctx.repos.strategySchedule.findByStrategyId(strategyId);
          items.push({
            strategyId,
            directionId: selection.directionId,
            watchlistId,
            subscriptionId,
            syncRunId: synced.data.run.id,
            status: 'tracking',
            reason:
              schedule?.enabled === true
                ? '候选同步完成，已连接既有策略调度；后台是否运行需查看实际运行审计，未开启新通知。'
                : '候选同步完成，但策略自动调度未开启；后续同步须已有正式运行，不代表后台正在检查。',
          });
        } catch {
          items.push({
            strategyId,
            directionId: selection.directionId,
            watchlistId,
            subscriptionId,
            syncRunId: null,
            status: 'failed',
            reason:
              '方向跟踪启动失败，可能缺合格事实或写入失败；共识仍已保存。用新 requestId 重试会复用专用列表。',
          });
        }
      }
    }
    const currentItems = items.filter((item) => item.status !== 'paused');
    let status: InvestmentTracking['status'];
    if (input.action === 'pause') status = pauseFailed ? 'partial' : 'paused';
    else if (currentItems.length === 0 || currentItems.every((item) => item.status === 'failed'))
      status = 'failed';
    else {
      const schedules = await Promise.all(
        currentItems.map((item) => ctx.repos.strategySchedule.findByStrategyId(item.strategyId)),
      );
      status =
        unmappedDirections.length > 0 ||
        currentItems.some((item) => item.status === 'failed') ||
        schedules.some((schedule) => schedule?.enabled !== true)
          ? 'partial'
          : 'tracking';
    }
    const tracking: InvestmentTracking = { ...attempt, status, items, finishedAt: ctx.clock() };
    if (!(await ownsClaim()))
      return errInvalidInput('tracking_claim_lost: 请读取恢复后的实际状态。');
    await ctx.repos.investmentWorkspace.finishTracking(tracking);
    return { tracking, replayed: false };
  },
});

const CandidateDirectionSchema = z.object({
  researchId: Id,
  directionId: Id,
  consensusVersion: z.number().int().positive(),
  strategyId: Id,
  strategyVersionId: Id,
  runId: Id,
  evidenceIds: z.array(Id),
  researchInput: z.object({ strategyId: Id, runId: Id, stockId: Id }),
});
export const GetInvestmentCandidatesInput = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});
export const GetInvestmentCandidatesOutput = z.object({
  consensusVersion: z.number().int().positive().nullable(),
  candidates: z.array(z.object({ stockId: Id, directions: z.array(CandidateDirectionSchema) })),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});
export const getInvestmentCandidatesTool = defineTool({
  name: 'get_investment_candidates',
  description:
    '按已确认方向读取真实最新逐股结果，合并同股多方向证据；只输出候选与证据引用，不生成建议',
  sideEffect: 'read',
  input: GetInvestmentCandidatesInput,
  output: GetInvestmentCandidatesOutput,
  handler: async (input, ctx) => {
    const consensus = await currentConsensus(ctx);
    const empty = {
      consensusVersion: consensus?.version ?? null,
      candidates: [],
      total: 0,
      truncated: false,
      limitations: [...LIMITATIONS],
    };
    if (
      consensus === null ||
      investmentConsensusState(consensus, ctx.clock()) !== 'confirmed' ||
      effectiveIntent(consensus, ctx.clock())?.mode === 'pause-new-opportunities'
    )
      return {
        ...empty,
        limitations: [...empty.limitations, '没有有效共识、需要复核或已暂停新机会；不启动研究。'],
      };
    const byStock = new Map<
      string,
      z.infer<typeof GetInvestmentCandidatesOutput>['candidates'][number]
    >();
    const limitations = [...LIMITATIONS];
    for (const selection of consensus.selections.filter(
      (selection) => selection.role !== 'avoid',
    )) {
      if (selection.direction.opportunityType === 'market-participation') {
        limitations.push(`${selection.direction.name}：${selection.direction.tracking.reason}`);
        continue;
      }
      const published = await loadPublished(selection.direction.strategyId, ctx);
      if (published === null || published.version.id !== selection.direction.strategyVersionId) {
        limitations.push(`${selection.direction.name}：版本已变或事实不合格，未输出当前候选。`);
        continue;
      }
      const results = await ctx.repos.strategyRun.listResults(published.run.id);
      if (getStrategyRunDataHealth(published.run) !== 'complete')
        limitations.push(`${selection.direction.name}：运行仅有部分数据，候选不是完整覆盖结论。`);
      for (const result of results.filter((result) => result.selected)) {
        const candidate = byStock.get(result.stockId) ?? {
          stockId: result.stockId,
          directions: [],
        };
        candidate.directions.push({
          researchId: selection.researchId,
          directionId: selection.directionId,
          consensusVersion: consensus.version,
          strategyId: published.strategy.id,
          strategyVersionId: published.version.id,
          runId: published.run.id,
          evidenceIds: [`${result.runId}:result:${result.stockId}`],
          researchInput: {
            strategyId: published.strategy.id,
            runId: published.run.id,
            stockId: result.stockId,
          },
        });
        byStock.set(result.stockId, candidate);
      }
    }
    const holdingIds =
      effectiveIntent(consensus, ctx.clock())?.mode === 'holdings-first'
        ? new Set(
            (await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId))
              .filter((holding) => holding.quantity > 0)
              .map((holding) => holding.stockId),
          )
        : new Set<string>();
    const primaryIds = new Set(
      consensus.selections
        .filter((selection) => selection.role === 'primary')
        .map((selection) => selection.directionId),
    );
    const candidates = [...byStock.values()].sort(
      (a, b) =>
        Number(holdingIds.has(b.stockId)) - Number(holdingIds.has(a.stockId)) ||
        Number(b.directions.some((direction) => primaryIds.has(direction.directionId))) -
          Number(a.directions.some((direction) => primaryIds.has(direction.directionId))) ||
        a.stockId.localeCompare(b.stockId),
    );
    return {
      consensusVersion: consensus.version,
      candidates: candidates.slice(0, input.limit),
      total: candidates.length,
      truncated: candidates.length > input.limit,
      limitations,
    };
  },
});
