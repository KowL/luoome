import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type Account,
  isHoliday,
  isWeekend,
  money,
  type PortfolioPerformanceSnapshot,
  type ToolContext,
  TradingPlanSchema,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  assertSurfaceSelection,
  capabilitiesOf,
  exposureCriteria,
  selectExposedTools,
} from '../exposure.js';
import { toolRegistry } from '../registry.js';
import {
  getPortfolioRiskTool,
  herfindahlIndex,
  historicalVaR95Pct,
  LIMIT_BREACH_TOLERANCE,
  lowerTailQuantile,
  RiskMetricSchema,
  VAR_MIN_RETURNS,
  VAR_REQUIRED_RETURNS,
} from './portfolio-risk.js';

// ---------------------------------------------------------------------------
// fixtures：账户 / 持仓 / 报价 / 交易计划 / 绩效快照，全部直接落库（只读工具不写库）
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-17T07:00:00.000Z'); // 15:00 Asia/Shanghai，周五，收盘时刻

const seedAccount = async (
  ctx: ToolContext,
  input: { readonly id: string; readonly cashBalance: number },
): Promise<Account> => {
  const account: Account = {
    id: input.id,
    name: `fixture-${input.id}`,
    kind: 'real',
    currency: 'CNY',
    initialCapital: money(input.cashBalance),
    cashBalance: money(input.cashBalance),
    createdAt: new Date('2026-01-05T01:00:00.000Z'),
  };
  await ctx.repos.account.save(account);
  return account;
};

const seedHolding = async (
  ctx: ToolContext,
  input: {
    readonly accountId: string;
    readonly stockId: string;
    readonly quantity: number;
    readonly avgCost: number;
  },
): Promise<void> => {
  await ctx.repos.holding.save({
    id: `holding-${input.accountId}-${input.stockId}`,
    accountId: input.accountId,
    stockId: input.stockId,
    quantity: input.quantity,
    availableQuantity: input.quantity,
    avgCost: money(input.avgCost),
    openedAt: new Date('2026-06-01T01:00:00.000Z'),
    closedAt: null,
  });
};

/** 落一条「合格」报价：观察时间距 now 60 秒、源时间 upstream、当日。 */
const seedQualifiedQuote = async (
  ctx: ToolContext,
  input: { readonly stockId: string; readonly price: number; readonly now?: Date },
): Promise<void> => {
  const now = input.now ?? ctx.clock();
  const observedAt = new Date(now.getTime() - 60_000);
  await ctx.repos.quote.save({
    stockId: input.stockId,
    observedAt,
    fetchedAt: now,
    timestampSource: 'upstream',
    ts: observedAt,
    open: money(input.price),
    high: money(input.price),
    low: money(input.price),
    close: money(input.price),
    volume: 1000,
    source: 'test',
  });
};

/** 落一条「非合格但仍在 30 天窗口内」的参考报价。 */
const seedReferenceQuote = async (
  ctx: ToolContext,
  input: { readonly stockId: string; readonly price: number },
): Promise<void> => {
  const observedAt = new Date(ctx.clock().getTime() - 20 * 86_400_000);
  await ctx.repos.quote.save({
    stockId: input.stockId,
    observedAt,
    fetchedAt: observedAt,
    timestampSource: 'upstream',
    ts: observedAt,
    open: money(input.price),
    high: money(input.price),
    low: money(input.price),
    close: money(input.price),
    volume: 1000,
    source: 'test',
  });
};

const makePlan = (input: {
  readonly accountId: string;
  readonly stockId: string;
  readonly maxPct: number | null;
  readonly status?: 'active' | 'superseded' | 'revoked';
  readonly version?: number;
  /** `observe` 允许没有目标区间；`enter`/`add` 的 active 计划必须有区间。 */
  readonly action?: 'enter' | 'observe';
}) =>
  TradingPlanSchema.parse({
    id: `account:${input.accountId}:stock:${input.stockId}`,
    version: input.version ?? 1,
    accountId: input.accountId,
    stockId: input.stockId,
    stockName: input.stockId,
    status: input.status ?? 'active',
    action: input.action ?? 'enter',
    entryPriceLow: 10,
    entryPriceHigh: 12,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPctRange: input.maxPct === null ? null : { min: input.maxPct, max: input.maxPct },
      appliedPct: input.maxPct,
      fallbackPct: input.maxPct,
      rangePick: input.maxPct === null ? null : { ruleId: 'lower-bound' },
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: new Date('2026-07-30T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], canSellNow: false },
    validFrom: new Date('2026-07-01T00:00:00.000Z'),
    validUntil: new Date('2026-07-31T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    invalidationRules: [
      {
        id: 'invalidate-stop',
        kind: 'price-threshold',
        phase: 'risk',
        metric: 'price',
        comparator: 'lte',
        value: 6,
        description: '跌破止损',
      },
    ],
    accountFactsAsOf: new Date('2026-07-01T00:00:00.000Z'),
    accountFactsDigest: `digest-${input.accountId}`,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: new Date('2026-07-01T02:00:00.000Z'),
  });

const isTradingDay = (date: Date): boolean => !isWeekend(date) && !isHoliday(date);

/** 以 `anchor` 当日在内的 `count` 个连续交易日（升序，UTC 零点）。 */
const tradingDaysEndingAt = (anchor: Date, count: number): Date[] => {
  const days: Date[] = [];
  let cursor = new Date(`${anchor.toISOString().slice(0, 10)}T00:00:00.000Z`);
  while (days.length < count) {
    if (isTradingDay(cursor)) days.push(new Date(cursor));
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return days.reverse();
};

/**
 * 落一条绩效快照。`returns` 是逐日 TWR 收益率（百分点）；第一天没有收益率
 * （与 `calculatePortfolioPerformance` 的语义一致：首日没有前值）。
 */
const seedSnapshot = async (
  ctx: ToolContext,
  input: {
    readonly accountId: string;
    readonly returnsPct: readonly number[];
    readonly anchor?: Date;
  },
): Promise<void> => {
  const anchor = input.anchor ?? ctx.clock();
  const days = tradingDaysEndingAt(anchor, input.returnsPct.length + 1);
  const valuation = days.map((date, index) => ({
    date,
    cash: 100_000,
    holdingsValue: 100_000,
    totalValue: 100_000,
    completeness: 'complete' as const,
    missingStockIds: [],
    externalCashFlow: 0,
    ...(index === 0 ? {} : { twrReturnPct: input.returnsPct[index - 1] ?? 0 }),
    cumulativeTwrPct: 0,
    drawdownPct: 0,
  }));
  const snapshot: PortfolioPerformanceSnapshot = {
    id: `snapshot-${input.accountId}`,
    accountId: input.accountId,
    from: days[0] ?? anchor,
    to: anchor,
    currency: 'CNY',
    inputFingerprint: `fingerprint-${input.accountId}`,
    calculatedAt: new Date(anchor.getTime() - 60_000),
    performance: {
      accountId: input.accountId,
      from: days[0] ?? anchor,
      to: anchor,
      currency: 'CNY',
      completeness: 'complete',
      cashFlowComplete: true,
      benchmarkStatus: 'unavailable',
      realizedPnl: 0,
      valuation,
      contributions: [],
      warnings: [],
    },
  };
  await ctx.repos.portfolioPerformanceSnapshot.save(snapshot);
};

const execute = async (ctx: ToolContext, input: Record<string, unknown> = {}) => {
  const result = await getPortfolioRiskTool.execute(input, ctx);
  if (!result.ok) throw new Error(`get_portfolio_risk failed: ${JSON.stringify(result.error)}`);
  return result.data;
};

const metricNamed = (data: Awaited<ReturnType<typeof execute>>, name: string) => {
  const metric = data.metrics.find((item) => item.name === name);
  if (metric === undefined) throw new Error(`metric ${name} missing`);
  return metric;
};

// ---------------------------------------------------------------------------
// A. 缺价 → unavailable（不是 0、不是 null），且绝不用 avgCost 顶替
// ---------------------------------------------------------------------------

describe('A 缺价：不给数字，也不用成本价伪造分母', () => {
  const ACCOUNT = 'acct-risk-gap';

  const buildGapContext = async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAccount(ctx, { id: ACCOUNT, cashBalance: 50_000 });
    await seedHolding(ctx, {
      accountId: ACCOUNT,
      stockId: '600519.SH',
      quantity: 100,
      avgCost: 800,
    });
    // 另一只持仓有合格报价；600519.SH 没有任何报价。
    await seedHolding(ctx, {
      accountId: ACCOUNT,
      stockId: '601398.SH',
      quantity: 1000,
      avgCost: 10,
    });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });
    return ctx;
  };

  it('A1 全部持仓都缺价 → 分母与集中度都是 unavailable / coverage-gap，并点名缺失标的', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-unpriced';
    await seedAccount(ctx, { id: accountId, cashBalance: 50_000 });
    await seedHolding(ctx, { accountId, stockId: '600519.SH', quantity: 100, avgCost: 800 });
    await seedHolding(ctx, { accountId, stockId: '601398.SH', quantity: 1000, avgCost: 10 });

    const data = await execute(ctx, { accountId });

    expect(data.valuation.holdingsValue).toMatchObject({
      status: 'unavailable',
      basis: 'holdings-value',
      reason: 'coverage-gap',
    });
    expect(data.valuation.holdingsValue).not.toHaveProperty('value');
    if (data.valuation.holdingsValue.status !== 'unavailable')
      throw new Error('expected unavailable');
    expect(data.valuation.holdingsValue.missingStockIds).toEqual(['600519.SH', '601398.SH']);

    const hhi = metricNamed(data, 'concentration_hhi');
    expect(hhi).toMatchObject({ status: 'unavailable', reason: 'coverage-gap' });
    if (hhi.status !== 'unavailable') throw new Error('expected unavailable');
    expect(hhi.missingStockIds).toEqual(['600519.SH', '601398.SH']);

    expect(data.coverage).toMatchObject({
      holdingsCount: 2,
      pricedCount: 0,
      unpricedCount: 2,
      pricedRatioPct: 0,
      unpricedStockIds: ['600519.SH', '601398.SH'],
    });
  });

  it('A1b 部分缺价 → 集中度降为 partial，数字只在已定价子集上成立且披露覆盖率', async () => {
    const ctx = await buildGapContext();
    const data = await execute(ctx, { accountId: ACCOUNT });

    const hhi = metricNamed(data, 'concentration_hhi');
    expect(hhi).toMatchObject({ status: 'partial' });
    if (hhi.status !== 'partial') return;
    expect(hhi.coverageGap).toEqual({
      holdingsCount: 2,
      pricedCount: 1,
      unpricedStockIds: ['600519.SH'],
    });
    expect(hhi.note).toContain('仅覆盖 1/2 只已定价持仓');
    // 已定价子集只有一只票 → 权重重归一后和为 1，HHI=1（这是「子集」口径，不是全组合口径）。
    expect(hhi.value).toBeCloseTo(1, 6);
    // 有数字、无结论：子集集中度不能当成组合集中度的风险等级。
    expect('level' in hhi).toBe(false);
    expect(hhi.note).toContain('已定价子集内');
    expect(hhi.note).toContain('不给风险等级');
    // 同一条补法文案与 VaR 的「点名补法」同一标准。
    expect(hhi.note).toContain('batch_quote');
    expect(data.valuation.holdingsValue).toMatchObject({ status: 'partial' });
    // 总资产分母不完整时不给仓位百分比、不做超限判定（错数字比 unavailable 危险）。
    expect(data.positions[0]).not.toHaveProperty('weightOfTotalAssetsPct');
    expect(data.limitCheck.status).toBe('not-evaluated');
  });

  it('A2 缺价指标没有 value 键（不是 0、也不是 null），且不会以 avgCost 计价', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-unpriced-2';
    await seedAccount(ctx, { id: accountId, cashBalance: 50_000 });
    await seedHolding(ctx, { accountId, stockId: '600519.SH', quantity: 100, avgCost: 800 });

    const data = await execute(ctx, { accountId });

    for (const name of ['concentration_hhi', 'concentration_top1', 'concentration_topN']) {
      const metric = metricNamed(data, name);
      expect('value' in metric, `${name} 不该有 value 键`).toBe(false);
      expect('level' in metric, `${name} 不该把可用性塞进 level`).toBe(false);
    }
    // 若实现回退 avgCost（800 × 100 = 80_000），分母会「看起来有数」。
    expect(JSON.stringify(data)).not.toContain('"value":0');
    expect(JSON.stringify(data)).not.toContain('80000');
    // 缺价的 note 与 VaR 那条同一标准：点名补法，而不是只说「不可用」。
    expect(metricNamed(data, 'concentration_hhi').note).toContain('batch_quote');
    expect(data.schemaVersion).toBe(1);
    const unpricedPosition = data.positions.find((item) => item.stockId === '600519.SH');
    expect(unpricedPosition).toMatchObject({ priceStatus: 'missing', limitSource: 'none' });
    expect(unpricedPosition).not.toHaveProperty('price');
    expect(unpricedPosition).not.toHaveProperty('marketValue');
    expect(unpricedPosition).not.toHaveProperty('weightOfHoldingsPct');
  });

  it('A3 参考报价（非合格）如实标注日期，价格仍来自真实报价而非成本价', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-reference';
    await seedAccount(ctx, { id: accountId, cashBalance: 10_000 });
    await seedHolding(ctx, { accountId, stockId: '600519.SH', quantity: 100, avgCost: 800 });
    await seedReferenceQuote(ctx, { stockId: '600519.SH', price: 1234.5 });

    const data = await execute(ctx, { accountId });
    const position = data.positions.find((item) => item.stockId === '600519.SH');
    expect(position).toMatchObject({ priceStatus: 'reference', price: money(1234.5) });
    expect(position?.price).not.toBe(money(800));
    expect(data.warnings.join('；')).toContain('参考报价');
    expect(data.warnings.join('；')).toContain('2026-06-27');
    // 同一标准：参考价也要点名补法，不只说「非合格」。
    expect(data.warnings.join('；')).toContain('batch_quote');
  });

  it('A4 全部有合格报价且现金为 0 → holdingsValue 与 totalAssets 数值相等', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-all-priced';
    await seedAccount(ctx, { id: accountId, cashBalance: 0 });
    await seedHolding(ctx, { accountId, stockId: '601398.SH', quantity: 1000, avgCost: 10 });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });

    const data = await execute(ctx, { accountId });
    expect(data.valuation.holdingsValue.status).toBe('available');
    expect(data.valuation.totalAssets.status).toBe('available');
    if (data.valuation.holdingsValue.status !== 'available') return;
    if (data.valuation.totalAssets.status !== 'available') return;
    expect(data.valuation.holdingsValue.value).toBeCloseTo(data.valuation.totalAssets.value, 6);
    expect(data.valuation.holdingsValue.value).toBeCloseTo(12_000, 6);
  });

  it('A5 空仓 → unavailable / no-holdings，不是 HHI=0', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-empty';
    await seedAccount(ctx, { id: accountId, cashBalance: 100_000 });

    const data = await execute(ctx, { accountId });
    const hhi = metricNamed(data, 'concentration_hhi');
    expect(hhi).toMatchObject({ status: 'unavailable', reason: 'no-holdings' });
    expect('value' in hhi).toBe(false);
    expect(data.coverage.holdingsCount).toBe(0);
    expect(data.limitCheck).toMatchObject({ status: 'not-evaluated', evaluated: 0 });
  });
});

// ---------------------------------------------------------------------------
// B. 输出必带 asOf / 窗口 / denominator(basis) / 覆盖率 / 基准身份
// ---------------------------------------------------------------------------

describe('B 口径披露：asOf、窗口、两个 basis、覆盖率、基准身份', () => {
  const ACCOUNT = 'acct-risk-b';

  const buildContext = async (options: { readonly benchmark?: boolean } = {}) => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      ...(options.benchmark === true
        ? { portfolioBenchmark: { stockId: '000300.SH', name: '沪深300' } }
        : {}),
    });
    await seedAccount(ctx, { id: ACCOUNT, cashBalance: 40_000 });
    await seedHolding(ctx, {
      accountId: ACCOUNT,
      stockId: '601398.SH',
      quantity: 1000,
      avgCost: 10,
    });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });
    await seedSnapshot(ctx, {
      accountId: ACCOUNT,
      returnsPct: Array.from({ length: 20 }, () => -1),
    });
    return ctx;
  };

  it('B1 available 指标必带 dataAsOf 与完整窗口字段', async () => {
    const ctx = await buildContext();
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.asOf).toEqual(NOW);

    for (const metric of data.metrics) {
      if (metric.status !== 'available') continue;
      expect(metric.dataAsOf).toBeInstanceOf(Date);
      expect(metric.window.from).toBeInstanceOf(Date);
      expect(metric.window.to).toBeInstanceOf(Date);
      expect(metric.window.requiredReturns).toBeGreaterThanOrEqual(0);
      expect(metric.window.minReturns).toBeGreaterThanOrEqual(0);
    }
    const var95Pct = metricNamed(data, 'var95Pct');
    expect(var95Pct.status).toBe('available');
    if (var95Pct.status !== 'available') return;
    expect(var95Pct.window).toMatchObject({
      kind: 'returns',
      requiredReturns: VAR_REQUIRED_RETURNS,
      minReturns: VAR_MIN_RETURNS,
      returnsCount: 20,
      gapTradingDays: 0,
    });
  });

  it('B2 两个 basis 都在，且现金 > 0 时数值不等', async () => {
    const ctx = await buildContext();
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.valuation.holdingsValue.basis).toBe('holdings-value');
    expect(data.valuation.totalAssets.basis).toBe('total-assets');
    if (data.valuation.holdingsValue.status !== 'available') throw new Error('expected available');
    if (data.valuation.totalAssets.status !== 'available') throw new Error('expected available');
    expect(data.valuation.holdingsValue.value).toBeCloseTo(12_000, 6);
    expect(data.valuation.totalAssets.value).toBeCloseTo(52_000, 6);
  });

  it('B3 生产装配注入基准 → 只声明身份，不重复计算', async () => {
    const ctx = await buildContext({ benchmark: true });
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.benchmark).toMatchObject({
      stockId: '000300.SH',
      name: '沪深300',
      status: 'not-evaluated',
    });
    expect(data.benchmark.note).toContain('get_account_performance');
  });

  it('B4 测试上下文不注入基准 → unavailable / benchmark-not-configured，不抛错', async () => {
    const ctx = await buildContext();
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.benchmark).toMatchObject({
      status: 'unavailable',
      reason: 'benchmark-not-configured',
    });
  });

  it('B5 顶层 dataAsOf 取参与序列里最早的最新日期，而不是 asOf', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-dataasof';
    await seedAccount(ctx, { id: accountId, cashBalance: 10_000 });
    await seedHolding(ctx, { accountId, stockId: '601398.SH', quantity: 1000, avgCost: 10 });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });
    // 快照右端点是 2026-07-15，早于报价观察时间 2026-07-17。
    await seedSnapshot(ctx, {
      accountId,
      returnsPct: Array.from({ length: 20 }, () => -1),
      anchor: new Date('2026-07-15T00:00:00.000Z'),
    });

    const data = await execute(ctx, { accountId });
    expect(data.dataAsOf?.toISOString().slice(0, 10)).toBe('2026-07-15');
    expect(data.dataAsOf?.getTime()).not.toBe(data.asOf.getTime());
  });
});

// ---------------------------------------------------------------------------
// C. 与 targetPctRange.max 同口径（百分点），无依据 ≠ 合规
// ---------------------------------------------------------------------------

describe('C 上限判定：weightPct > max + 1e-6，无计划持仓跳过而非判合规', () => {
  const ACCOUNT = 'acct-risk-limit';

  const buildContext = async (input: {
    readonly cash: number;
    readonly price: number;
    readonly maxPct: number | null;
    readonly planStatus?: 'active' | 'superseded' | 'revoked';
    readonly skipPlan?: boolean;
  }) => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAccount(ctx, { id: ACCOUNT, cashBalance: input.cash });
    await seedHolding(ctx, {
      accountId: ACCOUNT,
      stockId: '601398.SH',
      quantity: 1000,
      avgCost: 5,
    });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: input.price });
    if (input.skipPlan !== true) {
      await ctx.repos.tradingPlan.save(
        makePlan({
          accountId: ACCOUNT,
          stockId: '601398.SH',
          maxPct: input.maxPct,
          // 没有目标区间的计划只能是 observe（enter/add 的 active 计划必须有区间）。
          ...(input.maxPct === null ? { action: 'observe' as const } : {}),
          ...(input.planStatus === undefined ? {} : { status: input.planStatus }),
        }),
      );
    }
    return ctx;
  };

  it('C1 市值 12_000 / 总资产 100_000 / max 10 → 权重 12%，超限且 excessPct=2', async () => {
    const ctx = await buildContext({ cash: 88_000, price: 12, maxPct: 10 });
    const data = await execute(ctx, { accountId: ACCOUNT });
    const position = data.positions[0];
    expect(position?.weightOfTotalAssetsPct).toBeCloseTo(12, 6);
    expect(position?.limitMaxPct).toBe(10);
    expect(position?.breach).toBe(true);
    expect(position?.excessPct).toBeCloseTo(2, 6);
    expect(data.limitCheck).toMatchObject({ status: 'evaluated', evaluated: 1, skippedNoPlan: 0 });
    expect(data.limitCheck.breaches).toEqual([
      { stockId: '601398.SH', weightPct: 12, maxPct: 10, excessPct: 2, planVersion: 1 },
    ]);
  });

  it('C2 权重恰好等于 max 不算超限，excessPct 缺席', async () => {
    const ctx = await buildContext({ cash: 90_000, price: 10, maxPct: 10 });
    const data = await execute(ctx, { accountId: ACCOUNT });
    const position = data.positions[0];
    expect(position?.weightOfTotalAssetsPct).toBeCloseTo(10, 6);
    expect(position?.breach).toBe(false);
    expect(position).not.toHaveProperty('excessPct');
    expect(data.limitCheck.breaches).toEqual([]);
  });

  it('C3 量纲负例：max 是百分点（10），不是比例（0.10）', async () => {
    const ctx = await buildContext({ cash: 88_000, price: 12, maxPct: 10 });
    const data = await execute(ctx, { accountId: ACCOUNT });
    const position = data.positions[0];
    // 若实现把 max 当比例（0.12 vs 10）比较，永远不会超限；这里必须超限。
    expect(position?.limitMaxPct).toBe(10);
    expect(position?.breach).toBe(true);
    // 权重与 max 同量纲：12（百分点）而非 0.12（比例）。
    expect(position?.weightOfTotalAssetsPct).toBeGreaterThan(1);
    // 容差边界：10 + 1e-6 以内不算超限。
    expect(10 + LIMIT_BREACH_TOLERANCE).toBeGreaterThan(10);
  });

  it('C4 无 active TradingPlan → limitMaxPct 缺席、skippedNoPlan=1、无 breach', async () => {
    const ctx = await buildContext({ cash: 88_000, price: 12, maxPct: 10, skipPlan: true });
    const data = await execute(ctx, { accountId: ACCOUNT });
    const position = data.positions[0];
    expect(position?.limitSource).toBe('none');
    expect(position).not.toHaveProperty('limitMaxPct');
    expect(position).not.toHaveProperty('breach');
    expect(data.limitCheck).toMatchObject({ status: 'no-basis', evaluated: 0, skippedNoPlan: 1 });
    expect(data.limitCheck.breaches).toEqual([]);
    expect(data.limitCheck.note).toContain('不是合规');
  });

  it('C6 非 active（superseded）计划不参与判定', async () => {
    const ctx = await buildContext({
      cash: 88_000,
      price: 12,
      maxPct: 10,
      planStatus: 'superseded',
    });
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.limitCheck).toMatchObject({ status: 'no-basis', skippedNoPlan: 1 });
    expect(data.positions[0]).not.toHaveProperty('limitMaxPct');
  });

  it('C7 targetPctRange 为 null 的计划不计为 max=0 的超限', async () => {
    const ctx = await buildContext({ cash: 88_000, price: 12, maxPct: null });
    const data = await execute(ctx, { accountId: ACCOUNT });
    expect(data.limitCheck).toMatchObject({ status: 'no-basis', evaluated: 0, skippedNoPlan: 1 });
    expect(data.limitCheck.breaches).toEqual([]);
    expect(data.positions[0]).not.toHaveProperty('limitMaxPct');
  });
});

// ---------------------------------------------------------------------------
// D. VaR：样本门槛（≥20）、0 是合法值、缺快照点名补法、手算锚点
// ---------------------------------------------------------------------------

describe('D VaR：样本门槛与手算对账', () => {
  const ACCOUNT = 'acct-risk-var';

  const buildContext = async (returnsPct: readonly number[] | null) => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAccount(ctx, { id: ACCOUNT, cashBalance: 40_000 });
    await seedHolding(ctx, {
      accountId: ACCOUNT,
      stockId: '601398.SH',
      quantity: 1000,
      avgCost: 10,
    });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });
    if (returnsPct !== null) await seedSnapshot(ctx, { accountId: ACCOUNT, returnsPct });
    return ctx;
  };

  it('D1 19 个收益率（20 个估值日）→ insufficient / sample-too-small，且没有 value 键', async () => {
    const ctx = await buildContext(Array.from({ length: 19 }, () => -1));
    const data = await execute(ctx, { accountId: ACCOUNT });
    const var95Pct = metricNamed(data, 'var95Pct');
    expect(var95Pct).toMatchObject({ status: 'insufficient', reason: 'sample-too-small' });
    expect('value' in var95Pct).toBe(false);
    if (var95Pct.status !== 'insufficient') return;
    expect(var95Pct.window?.returnsCount).toBe(19);
    expect(var95Pct.window?.minReturns).toBe(VAR_MIN_RETURNS);
  });

  it('D2 20 个收益率 → available，VaR 百分点与手算 5% 分位差 < 1e-6', async () => {
    // 20 个样本升序后 5% 分位位置 = (20-1)*0.05 = 0.95 → -5 + (-4 - -5)*0.95 = -4.05
    const returns = [-5, -4, -3, -2, -1, ...Array.from({ length: 15 }, () => 0)];
    const ctx = await buildContext(returns);
    const data = await execute(ctx, { accountId: ACCOUNT });
    const var95Pct = metricNamed(data, 'var95Pct');
    expect(var95Pct.status).toBe('available');
    if (var95Pct.status !== 'available') return;
    expect(var95Pct.value).toBeCloseTo(4.05, 6);
    expect(var95Pct.unit).toBe('pct-point');
    expect(var95Pct.window.returnsCount).toBe(20);
    // 金额口径是派生量：4.05% × 52_000 = 2106
    const var95Cny = metricNamed(data, 'var95Cny');
    expect(var95Cny.status).toBe('available');
    if (var95Cny.status !== 'available') return;
    expect(var95Cny.value).toBeCloseTo(2106, 6);
  });

  it('D2b 达到门槛后 VaR=0 是合法值（样本里没有亏损尾部），不是 insufficient', async () => {
    const ctx = await buildContext(Array.from({ length: 20 }, () => 1));
    const data = await execute(ctx, { accountId: ACCOUNT });
    const var95Pct = metricNamed(data, 'var95Pct');
    expect(var95Pct.status).toBe('available');
    if (var95Pct.status !== 'available') return;
    expect(var95Pct.value).toBe(0);
    expect(var95Pct.level).toBe('low');
  });

  it('D3 没有任何绩效快照 → unavailable / no-valuation-day，note 点名缺什么与怎么补', async () => {
    const ctx = await buildContext(null);
    const data = await execute(ctx, { accountId: ACCOUNT });
    const var95Pct = metricNamed(data, 'var95Pct');
    expect(var95Pct).toMatchObject({ status: 'unavailable', reason: 'no-valuation-day' });
    expect('value' in var95Pct).toBe(false);
    expect(var95Pct.note).toContain('get_account_performance');
    expect(var95Pct.note).toContain('snapshot-account-performance');
    // 互不连坐：集中度仍然可用。
    expect(metricNamed(data, 'concentration_hhi').status).toBe('available');
  });

  it('D5 总资产分母不可用（有未定价持仓）→ var95Cny 缺席，var95Pct 仍可用', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-var-partial';
    await seedAccount(ctx, { id: accountId, cashBalance: 40_000 });
    await seedHolding(ctx, { accountId, stockId: '601398.SH', quantity: 1000, avgCost: 10 });
    await seedHolding(ctx, { accountId, stockId: '600519.SH', quantity: 10, avgCost: 800 });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 12 });
    await seedSnapshot(ctx, { accountId, returnsPct: Array.from({ length: 20 }, () => -1) });

    const data = await execute(ctx, { accountId });
    expect(metricNamed(data, 'var95Pct').status).toBe('available');
    const var95Cny = metricNamed(data, 'var95Cny');
    expect(var95Cny).toMatchObject({ status: 'unavailable', reason: 'coverage-gap' });
    expect('value' in var95Cny).toBe(false);
    // 总资产分母不完整 → 拒绝给超限判定（错数字比 unavailable 危险）
    expect(data.limitCheck.status).toBe('not-evaluated');
  });

  it('D4 手算锚点：HHI 与 topN 与逐票权重一致（1e-6）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const accountId = 'acct-risk-handcalc';
    await seedAccount(ctx, { id: accountId, cashBalance: 0 });
    await seedHolding(ctx, { accountId, stockId: '601398.SH', quantity: 3000, avgCost: 1 });
    await seedHolding(ctx, { accountId, stockId: '600519.SH', quantity: 1000, avgCost: 1 });
    await seedQualifiedQuote(ctx, { stockId: '601398.SH', price: 10 });
    await seedQualifiedQuote(ctx, { stockId: '600519.SH', price: 10 });

    const data = await execute(ctx, { accountId });
    // 权重 0.75 / 0.25
    const hhi = metricNamed(data, 'concentration_hhi');
    const top1 = metricNamed(data, 'concentration_top1');
    const topN = metricNamed(data, 'concentration_topN');
    expect(hhi.status).toBe('available');
    if (hhi.status !== 'available') return;
    if (top1.status !== 'available') return;
    if (topN.status !== 'available') return;
    expect(hhi.value).toBeCloseTo(0.75 ** 2 + 0.25 ** 2, 6);
    expect(top1.value).toBeCloseTo(0.75, 6);
    expect(topN.value).toBeCloseTo(1, 6);
    expect(herfindahlIndex([0.75, 0.25])).toBeCloseTo(hhi.value, 6);
  });
});

// ---------------------------------------------------------------------------
// 纯数学单元（从 workflows/risk-report 下沉后的唯一实现）
// ---------------------------------------------------------------------------

describe('纯数学：唯一实现', () => {
  it('分位用线性插值，且与旧实现的 5% 分位一致', () => {
    const sorted = [-4, -2, -1, 0, 1];
    expect(lowerTailQuantile(sorted, 0.05)).toBeCloseTo(-3.6, 8);
    expect(lowerTailQuantile([], 0.05)).toBeUndefined();
  });

  it('VaR 达到门槛才给数字：5 个样本默认门槛下为 undefined', () => {
    expect(historicalVaR95Pct([-1, -2, 0, 1, -4])).toBeUndefined();
    // 显式降低门槛后同一分位口径可复现旧断言（3.6 百分点）。
    expect(historicalVaR95Pct([-1, -2, 0, 1, -4], 5)).toBeCloseTo(3.6, 8);
    expect(historicalVaR95Pct([], 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E. 暴露面与声明
// ---------------------------------------------------------------------------

describe('E 暴露面：read 声明 + read allowlist 装配期硬校验', () => {
  it('E1 sideEffect 是 read，能力集合只有 read，assertSurfaceSelection 通过', () => {
    const tool = toolRegistry.get('get_portfolio_risk');
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    expect(tool.sideEffect).toBe('read');
    expect(capabilitiesOf(tool)).toEqual(['read']);
    expect(() =>
      assertSurfaceSelection(['get_portfolio_risk'], toolRegistry.all(), 'read', {
        label: 'read tool',
      }),
    ).not.toThrow();
  });

  it('E2 read 面暴露集包含 get_portfolio_risk', () => {
    const selected = selectExposedTools(
      toolRegistry.all(),
      exposureCriteria({ allowedSideEffects: ['read'], allowlist: ['get_portfolio_risk'] }),
    );
    expect(selected.map((tool) => tool.name)).toEqual(['get_portfolio_risk']);
  });

  it('E4 静态守卫：实现里不碰 adapter、不写库（read 声明的名实一致性）', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'portfolio-risk.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['ctx.adapters', 'resolveQuotes', 'enrichHolding']) {
      expect(code, `get_portfolio_risk 不该出现 ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).not.toMatch(/\.save(Many)?\(/);
  });

  it('E5 四个分支全部 strict：多出未声明键直接报错（Zod 默认会静默 strip）', () => {
    const window = {
      kind: 'point-in-time' as const,
      from: NOW,
      to: NOW,
      returnsCount: 0,
      requiredReturns: 0,
      minReturns: 0,
      gapTradingDays: 0,
    };
    const branches = [
      {
        status: 'available' as const,
        value: 0.1,
        unit: 'fraction' as const,
        level: 'low' as const,
        dataAsOf: NOW,
        window,
      },
      {
        status: 'partial' as const,
        value: 0.1,
        unit: 'fraction' as const,
        dataAsOf: NOW,
        window,
        coverageGap: { holdingsCount: 1, pricedCount: 1, unpricedStockIds: [] },
      },
      { status: 'insufficient' as const, reason: 'sample-too-small' as const },
      { status: 'unavailable' as const, reason: 'no-holdings' as const },
    ];
    for (const branch of branches) {
      const declared = { name: 'concentration_hhi' as const, note: 'x', ...branch };
      expect(
        RiskMetricSchema.safeParse(declared).success,
        `${branch.status} 声明形状必须能解析`,
      ).toBe(true);
      expect(
        RiskMetricSchema.safeParse({ ...declared, unexpectedKey: 1 }).success,
        `${branch.status} 多出未声明键必须报错（不许静默 strip）`,
      ).toBe(false);
    }
    // `level` 只属于 available：三个非 available 分支带上它都必须报错。
    for (const branch of branches.slice(1)) {
      const declared = { name: 'concentration_hhi' as const, note: 'x', ...branch };
      expect(
        RiskMetricSchema.safeParse({ ...declared, level: 'low' }).success,
        `${branch.status} 不该接受 level`,
      ).toBe(false);
    }
  });

  it('E3 反向守卫：若声明成 external，read 面装配必须失败', () => {
    const tool = toolRegistry.get('get_portfolio_risk');
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    const misdeclared = { ...tool, sideEffect: 'external' as const };
    expect(() =>
      assertSurfaceSelection(['get_portfolio_risk'], [misdeclared], 'read', {
        label: 'read tool',
      }),
    ).toThrow(/not read-only/);
  });
});
