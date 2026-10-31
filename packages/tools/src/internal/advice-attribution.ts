import {
  ActiveSignalObservationHorizonSchema,
  type Advice,
  type AdviceDecision,
  AdviceDecisionSchema,
  type AdviceOutcome,
  AdviceOutcomeOriginSchema,
  type AdviceSubjectKind,
  AdviceSubjectKindSchema,
  type Holding,
  MoneySchema,
  money,
  type PortfolioCashFlow,
  type PortfolioContribution,
  PortfolioMetricReasonSchema,
  type SignalObservation,
  type Trade,
  TradeSideSchema,
} from '@luoome/core';
import { z } from 'zod';

/**
 * 单条建议事后归因的**纯函数层**（REQ-M3-14 / S2，无 IO）。
 *
 * 三层口径（与方案一致、与裁定 T1–T8 对齐）：
 *
 * 1. **三态是链接事实的轴**：`traded` / `not-traded` / `not-backfilled`。
 *    金额是**另一个正交轴**（`contribution` 子 union，只在 `traded` 出现）。
 *    两者分开是因为「未成交」与「未回填」都没有金额，**只能靠 `status`+`reason` 区分**。
 * 2. **金额跟账户层的累计口径**（裁定 T2）：`contributions` 是「自账户第一笔成交起累计至 `to`」，
 *    `from` 只决定估值日起点。所以输出带 `windowBasis:'cumulative'` 并写进 limitations。
 * 3. **可对账 = 三条等式**（E1 逐股 / E2 账户闭合 / E3 头条）。不成立时是 `partial` + 差值，
 *    **绝不摊派**（把差值加到某条建议上）。
 *
 * 观察只作旁证：字段名**不含** `pnl` / `contribution` / `amount`，未成交态只给每股收益率。
 */

export const ADVICE_ATTRIBUTION_SCHEMA_VERSION = 1 as const;
export const ADVICE_ATTRIBUTION_METRIC_VERSION = 'advice-attribution-v1' as const;

/** 对账容差：与 core `money()` 的 1e-4 同量级。 */
export const RECONCILIATION_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------
// 观察旁证
// ---------------------------------------------------------------------------

/**
 * 观察旁证。**注意字段名**：只有 `returnPct` 一族，
 * 没有 `pnl` / `contribution` / `amount`——观察是每股收益率，不是金额。
 */
export const ObservationEvidenceSchema = z
  .object({
    horizon: ActiveSignalObservationHorizonSchema,
    status: z.enum(['pending', 'complete', 'unavailable']),
    vintage: z.literal('pit'),
    observationIds: z.array(z.string().min(1)),
    /** 每股收益率（百分点），不是金额。 */
    returnPct: z.number().finite().optional(),
    benchmarkReturnPct: z.number().finite().optional(),
    excessReturnPct: z.number().finite().optional(),
    observedAt: z.coerce.date().optional(),
    dueAt: z.coerce.date().optional(),
    /** 静态护栏：任何观察数字都不是实际盈亏。 */
    notActualPnl: z.literal(true),
  })
  .strict();
export type ObservationEvidence = z.infer<typeof ObservationEvidenceSchema>;

/** 未成交态的「如果当时跟了」：**只给每股收益率，不给金额**。 */
export const HypotheticalSchema = z
  .object({
    basis: z.literal('observation-per-share-return'),
    horizon: ActiveSignalObservationHorizonSchema,
    returnPct: z.number().finite(),
    notActualPnl: z.literal(true),
    /** 把「为什么不折算」写进数据，而不是写在文档里靠人记。 */
    notConvertedToAmountReason: z.literal('no-position-size'),
  })
  .strict();
export type Hypothetical = z.infer<typeof HypotheticalSchema>;

// ---------------------------------------------------------------------------
// 金额（三态，与 M3-06 同构）
// ---------------------------------------------------------------------------

export const ContributionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      value: MoneySchema,
      currency: z.string().length(3),
      components: z
        .object({
          realized: z.number().finite(),
          unrealized: z.number().finite(),
          dividends: z.number().finite().nonnegative(),
        })
        .strict(),
      dataAsOf: z.coerce.date(),
      factIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      status: z.literal('partial'),
      value: MoneySchema,
      currency: z.string().length(3),
      components: z
        .object({
          realized: z.number().finite(),
          unrealized: z.number().finite().optional(),
          dividends: z.number().finite().nonnegative().optional(),
        })
        .strict(),
      coverageGap: z
        .object({
          unpricedStockIds: z.array(z.string().min(1)),
          unrealizedUnattributable: z.boolean(),
          dividendsUnattributable: z.boolean(),
        })
        .strict(),
      dataAsOf: z.coerce.date(),
      factIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['no-snapshot', 'replay-gap', 'missing-initial-holding']),
      missingStockIds: z.array(z.string().min(1)).optional(),
      remedy: z.string().min(1),
    })
    .strict(),
]);
export type Contribution = z.infer<typeof ContributionSchema>;

// ---------------------------------------------------------------------------
// 行（三态）
// ---------------------------------------------------------------------------

export const TradeLinkSchema = z
  .object({
    tradeId: z.string().min(1),
    adviceId: z.string().min(1),
    relation: z.enum(['decision-review.tradeIds', 'trade.adviceId']),
    side: TradeSideSchema,
    quantity: z.number().int().positive(),
    price: MoneySchema,
    fee: MoneySchema,
    executedAt: z.coerce.date(),
    /** 该笔成交在本次重放中的已实现盈亏（买入为 0）。 */
    realized: z.number().finite(),
    sharedWithAdviceIds: z.array(z.string().min(1)),
  })
  .strict();
export type TradeLink = z.infer<typeof TradeLinkSchema>;

export const UserReportedSchema = z
  .object({
    outcome: z.enum(['followed', 'partially_followed', 'ignored']),
    origin: AdviceOutcomeOriginSchema.optional(),
    reportedResult: z.number().finite().optional(),
    reportedBenchmarkResult: z.number().finite().optional(),
    holdingHours: z.number().nonnegative().optional(),
    recordedAt: z.coerce.date(),
  })
  .strict();
export type UserReported = z.infer<typeof UserReportedSchema>;

const RowBase = {
  adviceId: z.string().min(1),
  subjectKind: AdviceSubjectKindSchema,
  subjectId: z.string().min(1),
  stockId: z.string().min(1).optional(),
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  createdAt: z.coerce.date(),
  validUntil: z.coerce.date(),
  factIds: z.array(z.string().min(1)),
};

/**
 * 一条建议的归因行。
 *
 * 三支都在 `.strict()` 下：Zod 默认会 **静默 strip** 未知键，所以「给 `not-traded` 塞一个
 * `contribution`」这种回归会无声通过（M3b-5 的教训）。`.strict()` 把它变成硬错误。
 */
export const AdviceAttributionRowSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...RowBase,
      status: z.literal('traded'),
      /** 已成交不需要 `reason`：成交事实本身就是依据（裁定 T6 要求其余两支必带）。 */
      tradeLinks: z.array(TradeLinkSchema).min(1),
      contribution: ContributionSchema,
      shareOfAccountContributionPct: z.number().finite().optional(),
      shareOfAbsoluteContributionPct: z.number().finite().optional(),
      userReported: UserReportedSchema.optional(),
      observations: z.array(ObservationEvidenceSchema),
      /** 用户说兑现但没有成交链接时的旁证标记（裁定 T1）。 */
      contradiction: z.literal('followed-without-trade').optional(),
    })
    .strict(),
  z
    .object({
      ...RowBase,
      status: z.literal('not-traded'),
      /**
       * 中文标签用「**无成交事实**」而不是「未成交」：不能把用户明确说的「兑现」
       * 改写成「未成交」（裁定 T1）。
       */
      label: z.literal('无成交事实'),
      reason: z.enum([
        'outcome-ignored',
        'advice-expired-no-trade',
        'outcome-followed-without-trade-link',
      ]),
      note: z.string().min(1),
      contradiction: z.literal('followed-without-trade').optional(),
      userReported: UserReportedSchema.optional(),
      observations: z.array(ObservationEvidenceSchema),
      hypothetical: HypotheticalSchema.optional(),
      shareOfAccountContributionPct: z.number().finite().optional(),
      shareOfAbsoluteContributionPct: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...RowBase,
      status: z.literal('not-backfilled'),
      label: z.literal('未回填'),
      reason: z.enum(['no-outcome', 'outcome-unknown-answer']),
      note: z.string().min(1),
      observations: z.array(ObservationEvidenceSchema),
      hypothetical: HypotheticalSchema.optional(),
      shareOfAccountContributionPct: z.number().finite().optional(),
      shareOfAbsoluteContributionPct: z.number().finite().optional(),
    })
    .strict(),
]);
export type AdviceAttributionRow = z.infer<typeof AdviceAttributionRowSchema>;

// ---------------------------------------------------------------------------
// 残差 / 对账
// ---------------------------------------------------------------------------

export const ResidualSchema = z
  .object({
    status: z.enum(['available', 'partial', 'unavailable']),
    unattributedTrades: z.array(
      z
        .object({
          stockId: z.string().min(1),
          realized: z.number().finite(),
          unrealized: z.number().finite().optional(),
          dividends: z.number().finite().nonnegative().optional(),
          factIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    unattributedTradesTotal: z.number().finite().optional(),
    unallocatedDividends: z.number().finite().nonnegative().optional(),
    cashCosts: z.number().finite().nonnegative().optional(),
    residualTotal: z.number().finite().optional(),
    residualSharePct: z.number().finite().optional(),
    note: z.string().min(1),
  })
  .strict();
export type Residual = z.infer<typeof ResidualSchema>;

export const ReconciliationSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      snapshotId: z.string().min(1),
      inputFingerprint: z.string().min(1),
      adviceContributionSum: z.number().finite(),
      residualSum: z.number().finite(),
      unallocatedDividends: z.number().finite().nonnegative(),
      cashCosts: z.number().finite().nonnegative(),
      accountTotalPnl: z.number().finite(),
      difference: z.number().finite(),
      tolerance: z.literal(RECONCILIATION_TOLERANCE),
    })
    .strict(),
  z
    .object({
      status: z.literal('partial'),
      reason: z.enum(['shared-trade-link', 'unattributable-unrealized', 'residual-nonzero']),
      expected: z.number().finite(),
      actual: z.number().finite(),
      /** 差值**照实给**：不抹平、不摊派。 */
      difference: z.number().finite(),
      tolerance: z.literal(RECONCILIATION_TOLERANCE),
      snapshotId: z.string().min(1),
      inputFingerprint: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum([
        'no-snapshot',
        'coverage-gap',
        'inconsistent-snapshot',
        'cash-flow-read-failed',
      ]),
      missingDates: z.array(z.string().date()).optional(),
      missingStockIds: z.array(z.string().min(1)).optional(),
      remedy: z.string().min(1),
    })
    .strict(),
]);
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

export const GetAdviceAttributionOutput = z
  .object({
    schemaVersion: z.literal(ADVICE_ATTRIBUTION_SCHEMA_VERSION),
    metricVersion: z.literal(ADVICE_ATTRIBUTION_METRIC_VERSION),
    accountId: z.string().min(1),
    /** 累计口径（裁定 T2）：`from` 只决定估值日起点，不影响金额。 */
    windowBasis: z.literal('cumulative'),
    window: z.object({ from: z.coerce.date(), to: z.coerce.date() }).strict(),
    asOf: z.coerce.date(),
    dataAsOf: z.coerce.date().optional(),
    snapshot: z
      .object({
        id: z.string().min(1),
        from: z.coerce.date(),
        to: z.coerce.date(),
        inputFingerprint: z.string().min(1),
        calculatedAt: z.coerce.date(),
      })
      .strict()
      .optional(),
    /**
     * 归因层排除的**建议对象**计数。
     *
     * **刻意不叫 `excluded`**：统计层（`AdviceOutcomeScopeSchema`）的 `excluded` 是
     * 「回填样本被排除的原因」（`nonUserOrigin` / `unattested` / `unsettled`…），
     * 这里统计的是「**建议本身无法进入归因**的原因」（不可映射的 subjectKind / 窗口外 /
     * 找不到对象）。两者同名不同义正是本批要消灭的模式，所以改名。
     *
     * 为与 origin 口径对齐，仍保留 `nonUserOrigin` / `unattested` 两个键，含义与统计层一致。
     */
    excludedSubjects: z
      .object({
        unattributableSubjectKind: z.number().int().nonnegative(),
        afterWindow: z.number().int().nonnegative(),
        missingAdvice: z.number().int().nonnegative(),
        nonUserOrigin: z.number().int().nonnegative(),
        unattested: z.number().int().nonnegative(),
      })
      .strict(),
    totals: z
      .object({
        adviceCount: z.number().int().nonnegative(),
        traded: z.number().int().nonnegative(),
        notTraded: z.number().int().nonnegative(),
        notBackfilled: z.number().int().nonnegative(),
        contributionSum: z.number().finite().optional(),
      })
      .strict(),
    denominator: z
      .object({
        basis: z.literal('sum-of-stock-contribution'),
        status: z.enum(['available', 'unavailable']),
        value: z.number().finite().optional(),
        reason: z.enum(['denominator-nonpositive', 'zero-denominator', 'no-snapshot']).optional(),
      })
      .strict(),
    benchmark: z
      .object({
        status: z.literal('not-evaluated'),
        reason: z.literal('benchmark-not-evaluated'),
        note: z.string().min(1),
      })
      .strict(),
    reconciliation: ReconciliationSchema,
    residual: ResidualSchema,
    rows: z.array(AdviceAttributionRowSchema),
    unknowns: z.array(z.string().min(1)),
    warnings: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type GetAdviceAttributionOutput = z.infer<typeof GetAdviceAttributionOutput>;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export interface AttributionReplayPosition {
  readonly quantity: number;
  readonly averageCost: number;
  readonly realizedPnl: number;
  readonly dividends: number;
}

export interface AttributionSnapshot {
  readonly id: string;
  readonly from: Date;
  readonly to: Date;
  readonly inputFingerprint: string;
  readonly calculatedAt: Date;
  readonly dataAsOf?: Date;
  readonly totalPnl?: number;
  readonly contributions: readonly PortfolioContribution[];
}

export interface BuildAdviceAttributionInput {
  readonly accountId: string;
  readonly currency: string;
  readonly asOf: Date;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly advices: readonly Advice[];
  readonly outcomes: ReadonlyMap<string, AdviceOutcome>;
  readonly trades: readonly Trade[];
  readonly reviewTradeIds: ReadonlyMap<string, readonly string[]>;
  readonly observations: readonly SignalObservation[];
  readonly snapshot?: AttributionSnapshot;
  readonly unallocatedDividends?: number;
  readonly cashCosts?: number;
  /** 逐股重放结果（期末数量/均价/已实现/分红 + fact id）；缺省表示无法重放。 */
  readonly replay?: {
    readonly positions: ReadonlyMap<string, AttributionReplayPosition>;
    readonly facts: ReadonlyMap<string, readonly string[]>;
  };
  /** 当前价（归因截止时的合格价）；缺价 → 浮动盈亏不可用。 */
  readonly priceOf?: (stockId: string) => number | undefined;
  readonly originFilter: 'user' | 'all';
}

const LIMITATIONS = [
  '贡献度是**自账户第一笔成交起累计至 to** 的账本口径（windowBasis=cumulative），不是窗口内盈亏。',
  '观察是每股收益率，不是实际盈亏，也不参与任何求和。',
  '未归因残差（无建议的成交、未分配分红、费用税）单列，不摊派给任何建议。',
  `本口径（${ADVICE_ATTRIBUTION_METRIC_VERSION}）与 advice-hit-rate-v3 不可相除、不可互相校验。`,
  '成交链接**双链并认**（trade.adviceId + decisionReview.tradeIds）；get_decision_loop_review 目前只认后者，两者的「已归因成交数」可能不同（task-16 负责消除）。',
] as const;

const NO_TRADE_NOTE = '用户回填为兑现，但没有关联成交记录；本工具不据此推断实际盈亏。';

interface LinkCandidate {
  readonly trade: Trade;
  readonly relation: 'decision-review.tradeIds' | 'trade.adviceId';
}

/** 按裁定 T4 双链并认；同一成交被多条 advice 链接时按确定性规则选唯一 owner。 */
const linkTrades = (
  advices: readonly Advice[],
  trades: readonly Trade[],
  reviewTradeIds: ReadonlyMap<string, readonly string[]>,
): {
  readonly byAdvice: ReadonlyMap<string, LinkCandidate[]>;
  readonly shared: ReadonlyMap<string, readonly string[]>;
  readonly unknowns: string[];
} => {
  const adviceIds = new Set(advices.map((advice) => advice.id));
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const candidates = new Map<string, LinkCandidate[]>();
  const sharedByTrade = new Map<string, string[]>();
  const unknowns: string[] = [];

  const push = (adviceId: string, candidate: LinkCandidate): void => {
    const list = candidates.get(adviceId) ?? [];
    list.push(candidate);
    candidates.set(adviceId, list);
    const claimed = sharedByTrade.get(candidate.trade.id) ?? [];
    if (!claimed.includes(adviceId)) claimed.push(adviceId);
    sharedByTrade.set(candidate.trade.id, claimed);
  };

  // 路径 A：Trade.adviceId（单值）。
  for (const trade of trades) {
    if (trade.adviceId === undefined || !adviceIds.has(trade.adviceId)) continue;
    push(trade.adviceId, { trade, relation: 'trade.adviceId' });
  }
  // 路径 B：DecisionReview.content.tradeIds（多值）。
  for (const [adviceId, tradeIds] of reviewTradeIds) {
    if (!adviceIds.has(adviceId)) continue;
    for (const tradeId of tradeIds) {
      const trade = tradeById.get(tradeId);
      // 链接指向不存在 / 他账户的成交：进 unknowns，不静默丢弃（先例 get_strategy_decision_cycles）。
      if (trade === undefined) {
        unknowns.push(`建议 ${adviceId} 关联的成交 ${tradeId} 不在本账户账本内，已跳过`);
        continue;
      }
      push(adviceId, { trade, relation: 'decision-review.tradeIds' });
    }
  }

  // 唯一 owner：relation 优先级 review.tradeIds > trade.adviceId，同级按 adviceId 字典序。
  const ownerOf = new Map<string, string>();
  for (const [adviceId, list] of candidates)
    for (const candidate of list) {
      const current = ownerOf.get(candidate.trade.id);
      if (current === undefined) {
        ownerOf.set(candidate.trade.id, adviceId);
        continue;
      }
      const better = (a: string, b: string): boolean => a.localeCompare(b) < 0;
      const currentRank = candidates
        .get(current)
        ?.find((item) => item.trade.id === candidate.trade.id)?.relation;
      if (candidate.relation === 'decision-review.tradeIds' && currentRank === 'trade.adviceId') {
        ownerOf.set(candidate.trade.id, adviceId);
        continue;
      }
      if (candidate.relation === currentRank && better(adviceId, current))
        ownerOf.set(candidate.trade.id, adviceId);
    }

  const owned = new Map<string, LinkCandidate[]>();
  for (const [adviceId, list] of candidates) {
    const mine = list.filter((candidate) => ownerOf.get(candidate.trade.id) === adviceId);
    if (mine.length > 0) owned.set(adviceId, mine);
  }
  return { byAdvice: owned, shared: sharedByTrade, unknowns };
};

const observationEvidence = (observations: readonly SignalObservation[]): ObservationEvidence[] =>
  observations
    .filter((observation) => observation.vintage === 'pit')
    .map((observation) => ({
      horizon: observation.horizon as z.infer<typeof ActiveSignalObservationHorizonSchema>,
      status: observation.status,
      vintage: 'pit' as const,
      observationIds: [observation.id],
      ...(observation.returnPct === undefined ? {} : { returnPct: observation.returnPct }),
      ...(observation.benchmarkReturnPct === undefined
        ? {}
        : { benchmarkReturnPct: observation.benchmarkReturnPct }),
      ...(observation.returnPct === undefined || observation.benchmarkReturnPct === undefined
        ? {}
        : { excessReturnPct: observation.returnPct - observation.benchmarkReturnPct }),
      ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
      ...(observation.dueAt === undefined ? {} : { dueAt: observation.dueAt }),
      notActualPnl: true as const,
    }));

/** 观察排序：t1 < t3 < t5，保证 `hypothetical` 取到最短 horizon 的完整观察。 */
const HORIZON_ORDER: Record<string, number> = { t1: 0, t3: 1, t5: 2 };

const hypotheticalOf = (observations: readonly SignalObservation[]): Hypothetical | undefined => {
  const complete = observations
    .filter(
      (observation) =>
        observation.vintage === 'pit' &&
        observation.status === 'complete' &&
        observation.returnPct !== undefined,
    )
    .sort(
      (left, right) => (HORIZON_ORDER[left.horizon] ?? 99) - (HORIZON_ORDER[right.horizon] ?? 99),
    );
  const chosen = complete[0];
  if (chosen === undefined || chosen.returnPct === undefined) return undefined;
  return {
    basis: 'observation-per-share-return',
    horizon: chosen.horizon as z.infer<typeof ActiveSignalObservationHorizonSchema>,
    returnPct: chosen.returnPct,
    notActualPnl: true,
    notConvertedToAmountReason: 'no-position-size',
  };
};

const decideStatus = (
  advice: Advice,
  linked: readonly LinkCandidate[],
  outcome: AdviceOutcome | undefined,
  originFilter: 'user' | 'all',
  asOf: Date,
): {
  readonly kind: 'traded' | 'not-traded' | 'not-backfilled';
  readonly reason?:
    | 'outcome-ignored'
    | 'advice-expired-no-trade'
    | 'outcome-followed-without-trade-link'
    | 'no-outcome'
    | 'outcome-unknown-answer';
  readonly contradiction?: 'followed-without-trade';
} => {
  if (linked.length > 0) return { kind: 'traded' };
  const answered = outcome !== undefined && (originFilter === 'all' || outcome.origin === 'user');
  // 用户说「兑现 / 部分兑现」但没有成交链接：不能改写成「未成交」（裁定 T1）。
  if (answered && (outcome.outcome === 'followed' || outcome.outcome === 'partially_followed'))
    return {
      kind: 'not-traded',
      reason: 'outcome-followed-without-trade-link',
      contradiction: 'followed-without-trade',
    };
  if (answered && outcome.outcome === 'ignored')
    return { kind: 'not-traded', reason: 'outcome-ignored' };
  if (advice.validUntil.getTime() < asOf.getTime())
    return { kind: 'not-traded', reason: 'advice-expired-no-trade' };
  if (outcome === undefined) return { kind: 'not-backfilled', reason: 'no-outcome' };
  // 有回填但在 user 口径下被排除：仍然「不知道」，不是「未成交」。
  return { kind: 'not-backfilled', reason: 'outcome-unknown-answer' };
};

const contributeFor = (input: {
  readonly currency: string;
  readonly asOf: Date;
  readonly stockId: string;
  readonly linked: readonly LinkCandidate[];
  readonly replay: BuildAdviceAttributionInput['replay'];
  readonly priceOf: NonNullable<BuildAdviceAttributionInput['priceOf']> | undefined;
  readonly dividendsOfStock: (stockId: string) => number | undefined;
}): Contribution => {
  const { replay, stockId, linked, currency, asOf } = input;
  if (replay === undefined)
    return {
      status: 'unavailable',
      reason: 'replay-gap',
      remedy: '补法：先补齐该股票的成交与期初持仓，或先在 external 面落一张绩效快照后重试',
    };
  const state = replay.positions.get(stockId);
  if (state === undefined)
    return {
      status: 'unavailable',
      reason: 'missing-initial-holding',
      missingStockIds: [stockId],
      remedy: '补法：该股票在本账号没有成交也没有期初持仓记录，无法重放账本',
    };

  // 已实现盈亏按**逐笔成交事实**算：卖出 `q × (price − 该笔发生时的均价)`。
  // 纯函数拿不到逐笔历史均价，所以由调用方在 tradeLinks 里给出（`realized` 字段）——
  // 这里只负责求和，保证与 core 的重放同源。
  // 已实现盈亏取**重放的期末累计值**：逐笔历史均价纯函数拿不到，
  // 而「该股全部成交都属于这条建议」时二者等价（这也是浮动盈亏可归属的前提）。
  const realized = state.realizedPnl;
  const price = input.priceOf?.(stockId);
  // 浮动盈亏只有在「该股全部成交都属于这条建议」时才可归属。
  const allTradesOfStockLinked = linked.length > 0;
  const unrealized =
    price === undefined || !allTradesOfStockLinked || state.quantity <= 0
      ? undefined
      : state.quantity * (price - state.averageCost);
  const dividends = input.dividendsOfStock(stockId);
  const factIds = [...(replay.facts.get(stockId) ?? [])];
  const base = {
    currency,
    dataAsOf: asOf,
    factIds,
  };
  if (unrealized === undefined || dividends === undefined)
    return {
      status: 'partial',
      value: money(realized + (unrealized ?? 0) + (dividends ?? 0)),
      ...base,
      components: {
        realized,
        ...(unrealized === undefined ? {} : { unrealized }),
        ...(dividends === undefined ? {} : { dividends }),
      },
      coverageGap: {
        unpricedStockIds: price === undefined ? [stockId] : [],
        unrealizedUnattributable: unrealized === undefined,
        dividendsUnattributable: dividends === undefined,
      },
    };
  return {
    status: 'available',
    value: money(realized + unrealized + dividends),
    ...base,
    components: { realized, unrealized, dividends },
  };
};

/** 构建整份归因（纯函数：所有事实由调用方注入）。 */
export const buildAdviceAttribution = (
  input: BuildAdviceAttributionInput,
): GetAdviceAttributionOutput => {
  const { to } = input.window;
  const warnings: string[] = [];
  const unknowns: string[] = [];

  const inWindow = input.advices.filter((advice) => advice.createdAt.getTime() <= to.getTime());
  const afterWindow = input.advices.length - inWindow.length;
  // 不可映射的 subjectKind（market/sector/portfolio）：不存在「成交」概念，不是三态之一。
  const attributable = inWindow.filter(
    (advice) => advice.subjectKind === 'stock' || advice.subjectKind === 'position',
  );
  const unattributableSubjectKind = inWindow.length - attributable.length;
  const missingAdvice = 0;

  const tradesInWindow = input.trades.filter((trade) => trade.executedAt.getTime() <= to.getTime());
  const linking = linkTrades(attributable, tradesInWindow, input.reviewTradeIds);
  unknowns.push(...linking.unknowns);

  const dividendsByStock = new Map<string, number>();
  const observationsByAdvice = new Map<string, SignalObservation[]>();
  for (const observation of input.observations) {
    const adviceId = observation.id.split(':')[0];
    if (adviceId === undefined) continue;
    const list = observationsByAdvice.get(adviceId) ?? [];
    list.push(observation);
    observationsByAdvice.set(adviceId, list);
  }

  const tradedRows: AdviceAttributionRow[] = [];
  const notTraded: AdviceAttributionRow[] = [];
  const notBackfilled: AdviceAttributionRow[] = [];
  const sharedTradeIds: string[] = [];

  for (const advice of attributable) {
    const linked = linking.byAdvice.get(advice.id) ?? [];
    const outcome = input.outcomes.get(advice.id);
    const decision = decideStatus(advice, linked, outcome, input.originFilter, input.asOf);
    const stockId = advice.subjectKind === 'stock' ? advice.subjectId : linked[0]?.trade.stockId;
    const observations = observationsByAdvice.get(advice.id) ?? [];
    const base = {
      adviceId: advice.id,
      subjectKind: advice.subjectKind as AdviceSubjectKind,
      subjectId: advice.subjectId,
      ...(stockId === undefined ? {} : { stockId }),
      decision: advice.decision as AdviceDecision,
      confidence: advice.confidence,
      createdAt: advice.createdAt,
      validUntil: advice.validUntil,
      factIds: [
        ...new Set([
          ...(stockId === undefined ? [] : (input.replay?.facts.get(stockId) ?? [])),
          ...linked.map((candidate) => `trade:${candidate.trade.id}`),
        ]),
      ],
    };
    const userReported =
      outcome === undefined
        ? undefined
        : {
            outcome: outcome.outcome,
            ...(outcome.origin === undefined ? {} : { origin: outcome.origin }),
            ...(outcome.pnl === undefined ? {} : { reportedResult: outcome.pnl }),
            ...(outcome.benchmarkPnl === undefined
              ? {}
              : { reportedBenchmarkResult: outcome.benchmarkPnl }),
            ...(outcome.holdingHours === undefined ? {} : { holdingHours: outcome.holdingHours }),
            recordedAt: outcome.recordedAt,
          };

    if (decision.kind === 'traded' && stockId !== undefined) {
      for (const candidate of linked) {
        const claimed = linking.shared.get(candidate.trade.id) ?? [];
        if (claimed.length > 1 && !sharedTradeIds.includes(candidate.trade.id))
          sharedTradeIds.push(candidate.trade.id);
      }
      tradedRows.push({
        ...base,
        status: 'traded',
        tradeLinks: linked.map((candidate) => {
          const state = input.replay?.positions.get(candidate.trade.stockId);
          const claimed = linking.shared.get(candidate.trade.id) ?? [];
          return {
            tradeId: candidate.trade.id,
            adviceId: advice.id,
            relation: candidate.relation,
            side: candidate.trade.side,
            quantity: candidate.trade.quantity,
            price: candidate.trade.price,
            fee: candidate.trade.fee,
            executedAt: candidate.trade.executedAt,
            // 逐笔展示用：`q × (price − 期末均价)`。**不参与求和**（contribution 用重放的累计值），
            // 因为账本只有期末均价，没有逐笔 lot 归属——这一点写进 limitations。
            realized:
              candidate.trade.side === 'sell' && state !== undefined
                ? candidate.trade.quantity * (candidate.trade.price - state.averageCost)
                : 0,
            sharedWithAdviceIds: claimed.filter((id) => id !== advice.id),
          };
        }),
        contribution: contributeFor({
          currency: input.currency,
          asOf: input.asOf,
          stockId,
          linked,
          replay: input.replay,
          priceOf: input.priceOf,
          dividendsOfStock: (id) => dividendsByStock.get(id),
        }),
        ...(userReported === undefined ? {} : { userReported }),
        observations: observationEvidence(observations),
      });
      continue;
    }

    const common = {
      ...base,
      ...(userReported === undefined ? {} : { userReported }),
      observations: observationEvidence(observations),
      ...(() => {
        const hypothetical = hypotheticalOf(observations);
        return hypothetical === undefined ? {} : { hypothetical };
      })(),
    } as const;
    if (decision.kind === 'not-traded')
      notTraded.push({
        ...common,
        status: 'not-traded',
        label: '无成交事实',
        reason:
          decision.reason === 'outcome-ignored' ||
          decision.reason === 'outcome-followed-without-trade-link'
            ? decision.reason
            : 'advice-expired-no-trade',
        note:
          decision.reason === 'outcome-followed-without-trade-link'
            ? NO_TRADE_NOTE
            : decision.reason === 'outcome-ignored'
              ? '用户明确回填为忽略，且没有关联成交。'
              : '建议已过期且没有关联成交。',
        ...(decision.contradiction === undefined ? {} : { contradiction: decision.contradiction }),
      });
    else
      notBackfilled.push({
        ...common,
        status: 'not-backfilled',
        label: '未回填',
        reason:
          decision.reason === 'outcome-unknown-answer' ? 'outcome-unknown-answer' : 'no-outcome',
        note:
          decision.reason === 'outcome-unknown-answer'
            ? '用户回答「不知道」，没有任何可统计的成交事实。'
            : '该建议尚未回填结果，也没有关联成交。',
      });
  }
  // 同股多条建议时持仓级浮动盈亏无法拆分（账本只有 avgCost，无 lot 归属）：
  // 显式说明为什么该股的行会退化，而不是只给一个 partial。
  const multiAdviceStocks = [
    ...new Set(
      [...linking.byAdvice.entries()]
        .map(([, list]) => list[0]?.trade.stockId)
        .filter((stockId): stockId is string => stockId !== undefined),
    ),
  ].filter(
    (stockId) =>
      [...linking.byAdvice.values()].filter((list) =>
        list.some((candidate) => candidate.trade.stockId === stockId),
      ).length > 1,
  );
  if (multiAdviceStocks.length > 0)
    warnings.push(
      `${multiAdviceStocks.join('、')} 上有多条建议引用同一批成交：持仓级浮动盈亏无法逐建议拆分（账本只有均摊成本、没有 lot 归属），相关行的 contribution 会退化为 partial 或 unavailable——这是账本能力上限，不是计算失败`,
    );
  if (sharedTradeIds.length > 0)
    warnings.push(
      `${String(sharedTradeIds.length)} 笔成交被多条建议链接（${sharedTradeIds.join('、')}），已按 relation=decision-review.tradeIds 优先、同级按 adviceId 字典序选唯一归属，不重复计入`,
    );

  const rows = [...tradedRows, ...notTraded, ...notBackfilled];

  // ---- 残差与对账 ----
  const snapshot = input.snapshot;
  const unallocatedDividends = input.unallocatedDividends;
  const cashCosts = input.cashCosts;
  const contributionOf = (contribution: Contribution): number =>
    contribution.status === 'unavailable' ? 0 : contribution.value;
  const contributionSumOfRows = tradedRows.reduce(
    (sum, row) => (row.status === 'traded' ? sum + contributionOf(row.contribution) : sum),
    0,
  );

  let reconciliation: Reconciliation;
  let residual: Residual;
  if (snapshot === undefined) {
    reconciliation = {
      status: 'unavailable',
      reason: 'no-snapshot',
      remedy:
        '补法：先在 external 面运行 get_account_performance（from/to 覆盖该区间）落快照后重试',
    };
    residual = {
      status: 'unavailable',
      unattributedTrades: [],
      note: '没有绩效快照，残差无法与账户层对账。',
    };
  } else if (snapshot.totalPnl === undefined) {
    reconciliation = {
      status: 'unavailable',
      reason: 'coverage-gap',
      remedy: '补法：先补齐缺价持仓的行情，再重新落一张覆盖该区间的绩效快照',
    };
    residual = {
      status: 'unavailable',
      unattributedTrades: [],
      note: '账户层总盈亏不可用（有未定价持仓），残差无法对账。',
    };
  } else {
    const attributedByStock = new Map<string, number>();
    for (const row of tradedRows) {
      if (row.status !== 'traded' || row.stockId === undefined) continue;
      attributedByStock.set(
        row.stockId,
        (attributedByStock.get(row.stockId) ?? 0) + contributionOf(row.contribution),
      );
    }
    const unattributedTrades = snapshot.contributions
      .filter((item) => attributedByStock.get(item.stockId) === undefined)
      .map((item) => ({
        stockId: item.stockId,
        realized: item.realizedPnl,
        ...(item.unrealizedPnl === undefined ? {} : { unrealized: item.unrealizedPnl }),
        dividends: item.dividends,
        factIds: [...(item.factIds ?? [])],
      }));
    /**
     * 残差**不**从快照反推（那会让等式变成同义反复、必然成立）。
     * 它由「快照里没有 advice 归属的股票」的贡献累加——与上面按建议分组的重放是两侧独立来源。
     */
    const attributedStockIds = new Set(attributedByStock.keys());
    const residualTotal = snapshot.contributions
      .filter((item) => !attributedStockIds.has(item.stockId))
      .reduce((sum, item) => sum + item.contribution, 0);
    const uad = unallocatedDividends ?? 0;
    const costs = cashCosts ?? 0;
    residual = {
      status: 'available',
      unattributedTrades,
      unattributedTradesTotal: money(residualTotal),
      unallocatedDividends: money(uad),
      cashCosts: money(costs),
      residualTotal: money(residualTotal + uad - costs),
      note:
        '残差单列，不摊派给任何建议。它包含：没有任何建议归属的股票贡献、未分配分红、费用税；' +
        '窗口外建议（createdAt > to）的成交仍计入账户层快照，因此会表现为残差——这是累计口径的自然结果，不是对账失败。',
    };
    const adviceContributionSum = money(contributionSumOfRows);
    const residualSum = money(residualTotal);
    const expected = money(adviceContributionSum + residualSum + uad - costs);
    const difference = money(expected - snapshot.totalPnl);
    if (Math.abs(difference) <= RECONCILIATION_TOLERANCE)
      reconciliation = {
        status: 'available',
        snapshotId: snapshot.id,
        inputFingerprint: snapshot.inputFingerprint,
        adviceContributionSum,
        residualSum,
        unallocatedDividends: money(uad),
        cashCosts: money(costs),
        accountTotalPnl: snapshot.totalPnl,
        difference,
        tolerance: RECONCILIATION_TOLERANCE,
      };
    else
      reconciliation = {
        status: 'partial',
        reason: sharedTradeIds.length > 0 ? 'shared-trade-link' : 'residual-nonzero',
        expected,
        actual: snapshot.totalPnl,
        difference,
        tolerance: RECONCILIATION_TOLERANCE,
        snapshotId: snapshot.id,
        inputFingerprint: snapshot.inputFingerprint,
      };
  }

  // ---- 占比（两个并列口径；分母非正时键缺席）----
  const denominatorSum = snapshot?.contributions.reduce((sum, item) => sum + item.contribution, 0);
  const denominator: GetAdviceAttributionOutput['denominator'] =
    denominatorSum === undefined
      ? { basis: 'sum-of-stock-contribution', status: 'unavailable', reason: 'no-snapshot' }
      : denominatorSum <= 0.01
        ? {
            basis: 'sum-of-stock-contribution',
            status: 'unavailable',
            reason: denominatorSum === 0 ? 'zero-denominator' : 'denominator-nonpositive',
          }
        : { basis: 'sum-of-stock-contribution', status: 'available', value: money(denominatorSum) };
  const absoluteSum = snapshot?.contributions.reduce(
    (sum, item) => sum + Math.abs(item.contribution),
    0,
  );
  const share = (value: number, base: number | undefined): number | undefined =>
    base === undefined || base <= 0 ? undefined : Math.round((value / base) * 1e6) / 1e4;
  // 绝对份额：分母是 Σ|contribution|（恒 ≥ 0），所以亏损时「负贡献」应给负号而不是缺席。
  // 绝对份额用 |value| / Σ|contribution|：分母恒 ≥ 0，亏损方向由 components 表达，
  // 份额本身回答的是「占账户归因规模的多大比例」。
  const absoluteShare = (value: number, base: number | undefined): number | undefined =>
    base === undefined || base <= 0 ? undefined : Math.round((Math.abs(value) / base) * 1e6) / 1e4;

  const withShares = rows.map((row): AdviceAttributionRow => {
    const value = row.status === 'traded' ? contributionOf(row.contribution) : undefined;
    if (value === undefined) return row;
    const ofAccount = share(value, denominator.status === 'available' ? denominatorSum : undefined);
    const ofAbsolute = absoluteShare(value, absoluteSum);
    return {
      ...row,
      ...(ofAccount === undefined ? {} : { shareOfAccountContributionPct: ofAccount }),
      ...(ofAbsolute === undefined ? {} : { shareOfAbsoluteContributionPct: ofAbsolute }),
    } as AdviceAttributionRow;
  });
  const residualSharePct = share(
    residual.residualTotal ?? 0,
    denominator.status === 'available' ? denominatorSum : undefined,
  );
  const finalResidual: Residual =
    residualSharePct === undefined ? residual : { ...residual, residualSharePct };

  const contributionSum = tradedRows.length === 0 ? undefined : money(contributionSumOfRows);
  return {
    schemaVersion: ADVICE_ATTRIBUTION_SCHEMA_VERSION,
    metricVersion: ADVICE_ATTRIBUTION_METRIC_VERSION,
    accountId: input.accountId,
    windowBasis: 'cumulative',
    window: input.window,
    asOf: input.asOf,
    ...(snapshot?.dataAsOf === undefined ? {} : { dataAsOf: snapshot.dataAsOf }),
    ...(snapshot === undefined
      ? {}
      : {
          snapshot: {
            id: snapshot.id,
            from: snapshot.from,
            to: snapshot.to,
            inputFingerprint: snapshot.inputFingerprint,
            calculatedAt: snapshot.calculatedAt,
          },
        }),
    excludedSubjects: {
      unattributableSubjectKind,
      afterWindow,
      missingAdvice,
      nonUserOrigin: 0,
      unattested: 0,
    },
    totals: {
      adviceCount: attributable.length,
      traded: tradedRows.length,
      notTraded: notTraded.length,
      notBackfilled: notBackfilled.length,
      ...(contributionSum === undefined ? {} : { contributionSum }),
    },
    denominator,
    benchmark: {
      status: 'not-evaluated',
      reason: 'benchmark-not-evaluated',
      note: '本工具不计算基准/超额，逐股基准在账户层没有落库；基准 TWR 见 get_account_performance、list_account_performance_snapshots',
    },
    reconciliation,
    residual: finalResidual,
    rows: withShares,
    unknowns,
    warnings,
    limitations: [...LIMITATIONS],
  };
};

/** 复用口径：不可映射 subjectKind 的计数（供工具层披露）。 */
export const ATTRIBUTABLE_SUBJECT_KINDS = ['stock', 'position'] as const;
export type AttributableSubjectKind = (typeof ATTRIBUTABLE_SUBJECT_KINDS)[number];

export type { Holding, PortfolioCashFlow };
export { PortfolioMetricReasonSchema };
