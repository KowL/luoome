import {
  type AdviceOutcome,
  money,
  type PortfolioPerformanceSnapshot,
  replayAccountLedger,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  accountAdviceOutcomes,
  accountScopedAdvices,
} from '../internal/account-advice-outcomes.js';
import {
  ADVICE_ATTRIBUTION_METRIC_VERSION,
  ADVICE_ATTRIBUTION_SCHEMA_VERSION,
  type AttributionSnapshot,
  buildAdviceAttribution,
  GetAdviceAttributionOutput,
  RECONCILIATION_TOLERANCE,
} from '../internal/advice-attribution.js';
import { rejectNonPitObservations } from '../internal/observation-vintage.js';

/**
 * 单条建议事后归因（REQ-M3-14 / S3）。
 *
 * **`sideEffect: 'read'` 是诚实的**：零 adapter 调用、零写库，只读已落库的
 * 建议 / 回填 / 成交 / 现金流 / 观察 / 绩效快照。要刷新快照由用户在 external 面显式
 * 运行 `get_account_performance`——与 M3-06 R3 同一条理由（错数字比 unavailable 危险）。
 *
 * 重放基座与账户层绩效**共用 core 的 `replayAccountLedger`**（S1），所以逐股贡献与
 * `calculatePortfolioPerformance` 同源，等式才有意义。
 */

const DAY_MS = 86_400_000;
/** 归因窗口的自然日回看：覆盖「自第一笔成交起」的账本重建。 */
const ATTRIBUTION_LOOKBACK_DAYS = 3_660;

export const GetAdviceAttributionInput = z
  .object({
    accountId: z.string().min(1).optional(),
    /** 单条聚焦：给了就只返回该行。 */
    adviceId: z.string().min(1).optional(),
    stockId: z.string().min(1).optional(),
    /** 归因截止（含）。缺省 = 最近一张快照的 to / 当前时钟。 */
    to: z.coerce.date().optional(),
    /** 账户层对账的快照区间下界；缺省 = 选中快照的 from。 */
    from: z.coerce.date().optional(),
    /** 回填来源口径：只作用于三态判定的 `reason`，不作用于成交链接与金额。 */
    originFilter: z.enum(['user', 'all']).default('user'),
    includeObservations: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict()
  .superRefine((input, issue) => {
    if (input.from !== undefined && input.to !== undefined && input.from > input.to)
      issue.addIssue({ code: 'custom', path: ['to'], message: 'to 必须不早于 from' });
  });

export const GetAdviceAttributionToolOutput = GetAdviceAttributionOutput;

const asSnapshot = (snapshot: PortfolioPerformanceSnapshot): AttributionSnapshot => ({
  id: snapshot.id,
  from: snapshot.from,
  to: snapshot.to,
  inputFingerprint: snapshot.inputFingerprint,
  calculatedAt: snapshot.calculatedAt,
  ...(snapshot.dataAsOf === undefined ? {} : { dataAsOf: snapshot.dataAsOf }),
  ...(snapshot.performance.totalPnl === undefined
    ? {}
    : { totalPnl: snapshot.performance.totalPnl }),
  contributions: snapshot.performance.contributions,
});

export const getAdviceAttributionTool = defineTool({
  name: 'get_advice_attribution',
  description:
    '按 Advice 关联的成交给出单条贡献度（金额与占比），区分已成交 / 无成交事实 / 未回填三态，' +
    '并与账户层绩效快照做三条等式对账（逐股 / 账户闭合 / 头条）；' +
    '观察只作旁证且不折算金额；残差不摊派；只读已落库事实，不刷新快照',
  sideEffect: 'read',
  input: GetAdviceAttributionInput,
  output: GetAdviceAttributionToolOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (accountId.length === 0) return errInvalidInput('缺少 accountId');
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const now = ctx.clock();
    const [allAdvices, outcomes, trades, reviews, holdings, cashFlows, snapshots] =
      await Promise.all([
        ctx.repos.advice.query({ includeExpired: true, limit: 10_000 }),
        accountAdviceOutcomes(ctx, accountId),
        ctx.repos.trade.listByAccount(accountId),
        ctx.repos.decisionReview.list({ accountId, subjectKind: 'advice', limit: 10_000 }),
        ctx.repos.holding.listByAccount(accountId),
        ctx.repos.portfolioCashFlow.listByAccount(accountId),
        ctx.repos.portfolioPerformanceSnapshot.listByAccount(accountId, 50),
      ]);

    // 账户归属过滤只在 advices 上（与 get_advice / list_advices 同一实现）。
    const scoped = await accountScopedAdvices(ctx, accountId, allAdvices);
    const selected =
      input.adviceId === undefined
        ? scoped
        : scoped.filter((advice) => advice.id === input.adviceId);
    if (input.adviceId !== undefined && selected.length === 0)
      return errNotFound('Advice', input.adviceId);
    const filtered =
      input.stockId === undefined
        ? selected
        : selected.filter((advice) => advice.subjectId === input.stockId);

    const to = input.to ?? snapshots[0]?.to ?? now;
    const snapshotRaw =
      snapshots.find((item) => item.to.getTime() <= to.getTime()) ?? snapshots[0] ?? undefined;
    const snapshot = snapshotRaw === undefined ? undefined : asSnapshot(snapshotRaw);
    const from =
      input.from ?? snapshot?.from ?? new Date(to.getTime() - ATTRIBUTION_LOOKBACK_DAYS * DAY_MS);

    // 双链：review.tradeIds + Trade.adviceId —— 后者由 buildAdviceAttribution 直接读 trades。
    const reviewTradeIds = new Map<string, readonly string[]>(
      reviews.map(({ review, revision }) => [review.subject.id, revision.content.tradeIds]),
    );

    // 观察：按建议的 signalIds 取，并过 H8 的 pit 守卫。
    const signalIds = [
      ...new Set(filtered.flatMap((advice) => [...(advice.basedOn.strategy?.signalIds ?? [])])),
    ];
    const observations = input.includeObservations
      ? signalIds.length === 0
        ? []
        : await ctx.repos.signalObservation.listBySources({
            sourceKind: 'strategy-signal',
            sourceIds: signalIds,
          })
      : [];
    // restated / legacy 观察不得进陈述面：**拒绝**而不是静默过滤（H8 冻结口径）。
    const rejected = rejectNonPitObservations(observations, 'Advice 证据链');
    if (rejected !== null) return rejected;

    // 重放基座：与账户层绩效同一份实现（core `replayAccountLedger`）。
    const replayWindowStart = new Date(
      Math.min(
        from.getTime(),
        ...trades.map((trade) => trade.executedAt.getTime()),
        from.getTime(),
      ) - DAY_MS,
    );
    const barsByStock = new Map(
      await Promise.all(
        [...new Set(trades.map((trade) => trade.stockId))].map(async (stockId) => {
          const bars = await ctx.repos.dailyBar.findInRange(stockId, replayWindowStart, to);
          return [stockId, bars] as const;
        }),
      ),
    );
    const replay = replayAccountLedger({
      initialCapital: account.initialCapital,
      from: replayWindowStart,
      to,
      trades,
      initialHoldings: holdings.filter((holding) => holding.quantity > 0),
      cashFlows,
      corporateActions: await ctx.repos.portfolioCorporateAction.listByAccount(accountId),
      barsByStock,
    });

    // 残差项：从现金流独立重算（裁定 T3，不改 core 快照 schema）。
    const relevantFlows = cashFlows.filter((flow) => flow.occurredAt.getTime() <= to.getTime());
    const unallocatedDividends = relevantFlows
      .filter((flow) => flow.kind === 'dividend' && flow.stockId === undefined)
      .reduce((sum, flow) => sum + flow.amount, 0);
    const cashCosts = relevantFlows
      .filter((flow) => flow.kind === 'fee' || flow.kind === 'tax')
      .reduce((sum, flow) => sum + flow.amount, 0);

    // 当前价：用最新一条已落库日线的收盘（read 不取外部行情）。
    const priceByStock = new Map<string, number>();
    for (const [stockId, bars] of barsByStock) {
      const last = [...bars]
        .sort((left, right) => left.date.getTime() - right.date.getTime())
        .at(-1);
      if (last !== undefined) priceByStock.set(stockId, last.close);
    }

    const output = buildAdviceAttribution({
      accountId,
      currency: account.currency,
      asOf: now,
      window: { from, to },
      advices: filtered
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, input.limit),
      outcomes: outcomes as ReadonlyMap<string, AdviceOutcome>,
      trades,
      reviewTradeIds,
      observations,
      ...(snapshot === undefined ? {} : { snapshot }),
      unallocatedDividends: money(unallocatedDividends),
      cashCosts: money(cashCosts),
      replay: { positions: replay.positions, facts: replay.facts },
      priceOf: (stockId) => priceByStock.get(stockId),
      originFilter: input.originFilter,
    });
    return GetAdviceAttributionToolOutput.parse(output);
  },
});

/** 供装配/文档复用：本工具声明的口径版本与容差。 */
export const ADVICE_ATTRIBUTION_TOOL_VERSIONS = Object.freeze({
  schemaVersion: ADVICE_ATTRIBUTION_SCHEMA_VERSION,
  metricVersion: ADVICE_ATTRIBUTION_METRIC_VERSION,
  tolerance: RECONCILIATION_TOLERANCE,
});
