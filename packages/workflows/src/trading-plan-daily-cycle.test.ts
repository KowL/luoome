import {
  AccountFactsSchema,
  type Advice,
  AdviceSchema,
  type DailyBar,
  isHoliday,
  isWeekend,
  money,
  STANDARD_DISCLAIMERS,
  tradingPlanExpiresAt,
} from '@luoome/core';
import { addHoldingTool, getDailyVolatilityTool, getTradingPlanTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildTradingPlanFromAdvice,
  tradingPlanDailyCycleWorkflow,
} from './trading-plan-daily-cycle.js';

const NOW = new Date('2026-07-17T07:00:00.000Z');
const STOCK_ID = '600519.SH';
const ACCOUNT_ID = 'account-1';
/** fixtures 的长期账户：无持仓，适合验证「以当前持仓为复核来源」。 */
const EMPTY_ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const candidateAdvice = (now: Date, overrides: Partial<Advice> = {}): Advice => ({
  id: `cycle-advice:${now.toISOString()}`,
  subjectKind: 'stock',
  subjectId: STOCK_ID,
  stockName: '贵州茅台',
  decision: 'buy',
  confidence: 75,
  horizon: 'short',
  entryPriceLow: money(100),
  entryPriceHigh: money(105),
  targetPositionPct: 10,
  stopLoss: money(95),
  targetPrice: money(120),
  reasoning: {
    premise: '回撤后等待区间确认',
    evidence: ['趋势结构保持'],
    counterEvidence: ['成交量不足'],
  },
  risks: ['波动风险'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_strategy_candidate',
  basedOn: {
    strategy: {
      strategyId: 'cycle-strategy',
      strategyVersionId: 'cycle-strategy-v1',
      runId: `cycle-run:${now.toISOString()}`,
      stockId: STOCK_ID,
      accountId: EMPTY_ACCOUNT_ID,
      resultEvidence: [],
      signalIds: [],
      observationIds: [],
      recommendationTrigger: 'run',
    },
    quotes: {
      [STOCK_ID]: {
        stockId: STOCK_ID,
        ts: new Date(now.getTime() - 60_000),
        observedAt: new Date(now.getTime() - 60_000),
        fetchedAt: now,
        timestampSource: 'upstream',
        open: money(101),
        high: money(103),
        low: money(99),
        close: money(102),
        volume: 1000,
        source: 'fixture',
      },
    },
    dataAsOf: now,
  },
  validFrom: now,
  validUntil: new Date(now.getTime() + 86_400_000),
  createdAt: now,
  ...overrides,
});

/**
 * 由日收益率序列构造 21 根 qfq 日线（20 个收益率 → 一个 20 日波动率窗口）。
 * 日期落在**连续交易日**上：`get_daily_volatility` 只认「相邻且正好差 1 个交易日」的 bar 对，
 * 用自然日排会跨周末，窗口就不再是 20 个日收益率。
 */
const dailyBarsFromReturns = (returns: readonly number[], end: Date = NOW): DailyBar[] => {
  const closes = [100];
  for (const value of returns) closes.push((closes.at(-1) as number) * (1 + value));
  const dates = tradingDaysBack(closes.length, { end });
  return closes.map((close, index) => ({
    stockId: STOCK_ID,
    date: dates[index] as Date,
    open: money(close),
    high: money(close),
    low: money(close),
    close: money(close),
    volume: 1_000_000,
    adjustment: 'qfq' as const,
    source: 'fixture',
  }));
};

/** 交替 ±3% 的 20 个收益率 → 已实现波动率 3.0%。 */
const THREE_PCT_VOLATILITY_RETURNS = Array.from({ length: 20 }, (_, index) =>
  index % 2 === 0 ? 0.03 : -0.03,
);

/** 21 根完全相同收盘价 → 20 个收益率全为 0（停牌 / 无成交的形态）。 */
const FLAT_PRICE_RETURNS = Array.from({ length: 20 }, () => 0);

/**
 * 从 `end` 往前取 `count` 个交易日（跳过周末与节假日），可指定在最新 `afterNewest` 根之后
 * 再跳过 `missing` 个交易日——模拟停牌期间不产生 bar。返回按时间升序的日期。
 */
const tradingDaysBack = (
  count: number,
  options: { readonly end?: Date; readonly afterNewest?: number; readonly missing?: number } = {},
): Date[] => {
  const end = options.end ?? NOW;
  const afterNewest = options.afterNewest ?? -1;
  let remainingMissing = options.missing ?? 0;
  const descending: Date[] = [];
  let cursor = end.getTime();
  while (descending.length < count) {
    const day = new Date(cursor);
    if (!isWeekend(day) && !isHoliday(day)) {
      if (descending.length === afterNewest && remainingMissing > 0) remainingMissing -= 1;
      else descending.push(day);
    }
    cursor -= 86_400_000;
  }
  return descending.reverse();
};

/** 按给定日期落位 21 根日线（价格沿用 `dailyBarsFromReturns` 的收益率序列）。 */
const dailyBarsAtDates = (returns: readonly number[], dates: readonly Date[]): DailyBar[] =>
  dailyBarsFromReturns(returns).map((bar, index) => ({ ...bar, date: dates[index] as Date }));

const volatilitySample = (
  volatilityPct: number,
  overrides: {
    readonly latestBarDate?: Date;
    readonly stalenessTradingDays?: number;
    readonly windowStart?: Date;
    readonly barsCount?: number;
    readonly maxGapTradingDays?: number;
  } = {},
) => {
  const latestBarDate = overrides.latestBarDate ?? NOW;
  return {
    status: 'available' as const,
    volatilityPct,
    latestBarDate,
    stalenessTradingDays: overrides.stalenessTradingDays ?? 0,
    windowStart: overrides.windowStart ?? new Date(latestBarDate.getTime() - 20 * 86_400_000),
    windowEnd: latestBarDate,
    barsCount: overrides.barsCount ?? 21,
    maxGapTradingDays: overrides.maxGapTradingDays ?? 0,
  };
};

/**
 * 波动率阈值的 env 出口（`trading-plan-daily-cycle` 的 `volatilityPolicyFromEnv` 读的就是这两个）。
 * 阈值优先级是「显式入参 > env > 默认值」，所以任何一条断言都可能被 CI 预设的 env 改写：
 * 这里每个用例开始前保存原值并清空，结束后恢复，断言只依赖用例自己设置的 env。
 */
const VOLATILITY_ENV_KEYS = [
  'LUOOME_TRADING_PLAN_VOLATILITY_MIN_PCT',
  'LUOOME_TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS',
] as const;

describe('trading plan daily cycle', () => {
  let savedVolatilityEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedVolatilityEnv = {};
    for (const key of VOLATILITY_ENV_KEYS) {
      savedVolatilityEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of VOLATILITY_ENV_KEYS) {
      const value = savedVolatilityEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('复核无变化时维持原版本与硬期限，新的 Advice 留在复核审计中', async () => {
    let now = NOW;
    const ctx = await buildTestContext({ clock: () => now, advices: [candidateAdvice(now)] });
    const first = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.createdPlans).toBe(1);
    expect(first.data.plans[0]?.validUntil).toEqual(new Date('2026-07-24T07:00:00Z'));
    now = new Date('2026-07-20T07:00:00Z');
    const reviewed = candidateAdvice(now);
    await ctx.repos.advice.save(reviewed);
    const second = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.createdPlans).toBe(0);
    expect(second.data.maintainedPlans).toBe(1);
    expect(second.data.plans[0]).toEqual(first.data.plans[0]);
    expect(second.data.reviews[0]).toMatchObject({
      outcome: 'maintained',
      adviceIds: [reviewed.id],
      reviewedAt: now,
    });
    expect(await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID })).toHaveLength(1);
    const audits = await ctx.repos.workflowRun.listRecent({
      workflowName: 'trading-plan-daily-cycle',
    });
    expect(audits.some((run) => run.outputSummary?.maintainedPlans === 1)).toBe(true);
    const review = second.data.reviews[0];
    if (review === undefined) throw new Error('review missing');
    const read = await getTradingPlanTool.execute({ versionId: review.versionId }, ctx);
    expect(read.ok && read.data.monitoring).toMatchObject({
      lastReviewedAt: now,
      nextReviewAt: new Date('2026-07-21T07:00:00Z'),
      expiresAt: first.data.plans[0]?.validUntil,
    });
  });

  it('T29 生产路径：Advice 区间 8–12 → 生成器 → 落库 TradingPlan 非退化区间', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    expect(plans[0]?.position.rangeAdjustment).toMatchObject({
      requested: { min: 8, max: 12 },
      applied: { min: 8.24, max: 11.77 },
      reason: 'h4-width-cap',
    });
  });

  it('价位改变或原计划到期时发布新版本，不能无证据自动续期', async () => {
    let now = NOW;
    const ctx = await buildTestContext({ clock: () => now, advices: [candidateAdvice(now)] });
    await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    now = new Date('2026-07-20T07:00:00Z');
    await ctx.repos.advice.save(candidateAdvice(now, { entryPriceHigh: money(106) }));
    const changed = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.data.plans[0]).toMatchObject({ version: 2, entryPriceHigh: 106 });
    now = changed.data.plans[0]?.validUntil ?? now;
    await ctx.repos.advice.save(candidateAdvice(now, { entryPriceHigh: money(106) }));
    const renewed = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.data.plans[0]?.version).toBe(3);
    expect(renewed.data.createdPlans).toBe(1);
  });

  it('相同受阻草案重复生成不续命，超过两个交易日后补齐才发布新版', async () => {
    let now = NOW;
    const fallback = (date: Date) =>
      candidateAdvice(date, {
        decision: 'watch',
        reasoning: {
          premise: 'LLM 推理不可用',
          evidence: ['使用规则 fallback'],
          counterEvidence: ['缺少 AI 研究'],
        },
      });
    const ctx = await buildTestContext({ clock: () => now, advices: [fallback(now)] });
    const first = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.status).toBe('partial');
    expect(first.data.draftPlans).toBe(1);
    const draft = first.data.plans[0];
    if (draft === undefined) throw new Error('draft missing');
    expect(tradingPlanExpiresAt(draft)).toEqual(new Date('2026-07-21T07:00:00Z'));
    now = new Date('2026-07-20T07:00:00Z');
    await ctx.repos.advice.save(fallback(now));
    const repeated = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(repeated.ok && repeated.data.reviews[0]?.outcome).toBe('unchanged-draft');
    now = new Date('2026-07-21T07:00:00Z');
    await ctx.repos.advice.save(fallback(now));
    const expired = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(expired.ok && expired.data.plans[0]).toEqual(draft);
    expect(await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID })).toHaveLength(1);
    now = new Date(now.getTime() + 1000);
    await ctx.repos.advice.save(candidateAdvice(now));
    const recovered = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(recovered.ok && recovered.data.plans[0]).toMatchObject({ version: 2, status: 'active' });
  });

  it('草案修订有实质变化时可以保留新版，但仍继承首次受阻的截止时间', async () => {
    let now = NOW;
    const fallback = (date: Date, risks = ['波动风险']) =>
      candidateAdvice(date, {
        decision: 'watch',
        risks,
        reasoning: {
          premise: 'LLM 推理不可用',
          evidence: ['使用规则 fallback'],
          counterEvidence: ['缺少 AI 研究'],
        },
      });
    const ctx = await buildTestContext({ clock: () => now, advices: [fallback(now)] });
    const first = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    now = new Date('2026-07-20T07:00:00Z');
    await ctx.repos.advice.save(fallback(now, ['波动风险', '新增风险']));
    const revised = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.data.plans[0]?.version).toBe(2);
    expect(revised.data.plans[0]?.validUntil).toEqual(first.data.plans[0]?.validUntil);
    expect(revised.data.createdPlans).toBe(1);
  });

  it('persists the AI entry range instead of collapsing it to the representative price', () => {
    const accountFacts = AccountFactsSchema.parse({
      accountId: ACCOUNT_ID,
      asOf: NOW,
      digest: 'daily-cycle-test-digest',
      cashBalance: 9000,
      stockMarketValue: 1000,
      totalAssets: 10000,
      status: 'complete',
      reasons: [],
      notes: [],
      positions: [
        {
          stockId: '000001.SZ',
          quantity: 100,
          availableQuantity: 100,
          marketValue: 1000,
          industry: '银行',
        },
      ],
    });
    const advice = AdviceSchema.parse({
      id: 'advice-1',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'buy',
      confidence: 78,
      horizon: 'short',
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      targetPrice: 120,
      stopLoss: 95,
      reasoning: {
        premise: '趋势与回撤结构一致',
        evidence: ['价格站上短期均线'],
        counterEvidence: ['市场宽度仍有限'],
      },
      risks: ['波动扩大'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date('2026-07-17T06:59:00.000Z'),
            fetchedAt: new Date('2026-07-17T06:59:30.000Z'),
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: new Date('2026-07-17T06:59:30.000Z'),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;

    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts,
      advice,
      previous: [],
      now: NOW,
    });

    expect(plan.status).toBe('active');
    expect(plan.entryPriceLow).toBe(100);
    expect(plan.entryPriceHigh).toBe(105);
    expect(plan.entryConditions[0]).toMatchObject({ value: 100, valueTo: 105 });
    // 旧单值 Advice 仍产退化区间 {t,t}，且没有收窄记录。
    expect(plan.position.targetPctRange).toEqual({ min: 10, max: 10 });
    expect(plan.position.rangeAdjustment).toBeUndefined();
  });

  it('T29：Advice 区间 8–12 经 H4 对称收窄为 8.24–11.77，并记录 requested/applied', () => {
    const accountFacts = AccountFactsSchema.parse({
      accountId: ACCOUNT_ID,
      asOf: NOW,
      digest: 'daily-cycle-test-digest',
      cashBalance: 9000,
      stockMarketValue: 1000,
      totalAssets: 10000,
      status: 'complete',
      reasons: [],
      notes: [],
      positions: [
        {
          stockId: '000001.SZ',
          quantity: 100,
          availableQuantity: 100,
          marketValue: 1000,
          industry: '银行',
        },
      ],
    });
    const advice = AdviceSchema.parse({
      id: 'advice-range-1',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'buy',
      confidence: 78,
      horizon: 'short',
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      targetPositionPctRange: { min: 8, max: 12 },
      targetPrice: 120,
      stopLoss: 95,
      reasoning: {
        premise: '趋势与回撤结构一致',
        evidence: ['价格站上短期均线'],
        counterEvidence: ['市场宽度仍有限'],
      },
      risks: ['波动扩大'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date('2026-07-17T06:59:00.000Z'),
            fetchedAt: new Date('2026-07-17T06:59:30.000Z'),
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: new Date('2026-07-17T06:59:30.000Z'),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;

    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts,
      advice,
      previous: [],
      now: NOW,
    });

    expect(plan.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.fallbackPct).toBe(8.24);
    expect(plan.position.rangeAdjustment).toEqual({
      requested: { min: 8, max: 12 },
      applied: { min: 8.24, max: 11.77 },
      reason: 'h4-width-cap',
      ruleVersion: 'trading-plan-h4-v1',
    });
    expect(plan.position.constraintReasons.join('；')).toContain('区间被 H4 收窄');
    expect(plan.position.constraintReasons.join('；')).toContain('8.24–11.77');
  });

  it('观察候选也带条件性价位、目标仓位与等待条件（watch ≠ 空白记录）', () => {
    const accountFacts = AccountFactsSchema.parse({
      accountId: ACCOUNT_ID,
      asOf: NOW,
      digest: 'daily-cycle-observe-digest',
      cashBalance: 10000,
      stockMarketValue: 0,
      totalAssets: 10000,
      status: 'complete',
      reasons: [],
      notes: [],
      positions: [],
    });
    const watchAdvice = AdviceSchema.parse({
      id: 'advice-watch-1',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'watch',
      confidence: 42,
      horizon: 'short',
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 6,
      targetPrice: 120,
      stopLoss: 95,
      reasoning: {
        premise: '策略已入选，但需等待回踩确认',
        evidence: ['量价配合尚未确认'],
        counterEvidence: ['市场宽度仍有限'],
      },
      risks: ['波动扩大'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date('2026-07-17T06:59:00.000Z'),
            fetchedAt: new Date('2026-07-17T06:59:30.000Z'),
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: new Date('2026-07-17T06:59:30.000Z'),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;

    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts,
      advice: watchAdvice,
      previous: [],
      now: NOW,
    });

    expect(plan.action).toBe('observe');
    expect(plan.entryPriceLow).toBe(100);
    expect(plan.entryPriceHigh).toBe(105);
    expect(plan.entryConditions[0]).toMatchObject({ value: 100, valueTo: 105, phase: 'entry' });
    expect(plan.position).toMatchObject({ currentPct: 0, targetPctRange: { min: 6, max: 6 } });
    expect(plan.exit).toMatchObject({ stopLoss: 95, takeProfit: 120 });
    expect(plan.position.prerequisiteActions).toEqual(['等待条件满足后重新评估，再决定是否建仓']);
    const incompleteAdvice = { ...watchAdvice };
    delete incompleteAdvice.entryPriceLow;
    delete incompleteAdvice.entryPriceHigh;
    const incomplete = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts,
      advice: incompleteAdvice,
      previous: [],
      now: NOW,
    });
    expect(incomplete.status).toBe('draft');
    expect(incomplete.explanation.unknowns).toContain('AI 未给出条件性价格计划，只能作为观察记录');
  });

  it('规则兜底建议只留草案并说明 AI 不可用，不会成为生效计划', () => {
    const accountFacts = AccountFactsSchema.parse({
      accountId: ACCOUNT_ID,
      asOf: NOW,
      digest: 'daily-cycle-fallback-digest',
      cashBalance: 10000,
      stockMarketValue: 0,
      totalAssets: 10000,
      status: 'complete',
      reasons: [],
      notes: [],
      positions: [],
    });
    const fallbackAdvice = AdviceSchema.parse({
      id: 'advice-fallback-1',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'watch',
      confidence: 20,
      horizon: 'short',
      reasoning: {
        premise: 'LLM 推理不可用，基于规则的保守判断',
        evidence: ['LLM 推理失败，使用规则 fallback（v0.2 LLMManager）'],
        counterEvidence: ['规则 fallback 不考虑基本面 / 新闻 / 战法信号，结果仅供参考'],
      },
      risks: ['规则 fallback 信心度低，不应据此下单'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date('2026-07-17T06:59:00.000Z'),
            fetchedAt: new Date('2026-07-17T06:59:30.000Z'),
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: new Date('2026-07-17T06:59:30.000Z'),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;

    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts,
      advice: fallbackAdvice,
      previous: [],
      now: NOW,
    });

    expect(plan.status).toBe('draft');
    expect(plan.explanation.unknowns).toContain(
      'AI 推理不可用（规则兜底建议），未给出可核验的价格计划',
    );
  });

  it('以当前持仓作为复核来源（现金来自账户字段）', async () => {
    const now = new Date('2026-07-17T07:00:00.000Z');
    const ctx = await buildTestContext({ advices: [], clock: () => now });
    const seeded = await addHoldingTool.execute(
      { accountId: EMPTY_ACCOUNT_ID, stockId: '000858.SZ', quantity: 100, avgCost: 100 },
      ctx,
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    // 内置 AI 已下线：持仓建议由外部消费者落库；这里直接持久化一条 analyze_position 建议。
    const holding = await ctx.repos.holding.findByAccountAndStock(EMPTY_ACCOUNT_ID, '000858.SZ');
    if (holding === null) throw new Error('holding fixture missing');
    await ctx.repos.advice.save(
      AdviceSchema.parse({
        id: 'position-review-advice',
        subjectKind: 'position',
        subjectId: holding.id,
        stockName: '五粮液',
        decision: 'hold',
        confidence: 60,
        horizon: 'short',
        entryPrice: 100,
        stopLoss: 95,
        targetPrice: 110,
        reasoning: {
          premise: '测试持仓复核',
          evidence: ['测试事实'],
          counterEvidence: ['仍需验证'],
        },
        risks: ['测试风险'],
        disclaimers: [...STANDARD_DISCLAIMERS],
        sourceTool: 'analyze_position',
        basedOn: { dataAsOf: now },
        validFrom: now,
        validUntil: new Date('2026-07-20T07:00:00.000Z'),
        createdAt: now,
      }) as Advice,
    );
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holdingReviews).toBe(1);
    expect(result.data.plans.some((plan) => plan.stockId === '000858.SZ')).toBe(true);
  });

  it('拒绝把其它账户的策略 Advice 变成目标账户的交易计划', async () => {
    const now = new Date('2026-07-17T07:00:00.000Z');
    const advice = AdviceSchema.parse({
      id: 'cross-account-advice',
      subjectKind: 'stock',
      subjectId: '000858.SZ',
      stockName: '五粮液',
      decision: 'watch',
      confidence: 80,
      horizon: 'short',
      reasoning: {
        premise: '跨账户测试候选',
        evidence: ['测试事实'],
        counterEvidence: ['仍需验证'],
      },
      risks: ['测试风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        strategy: {
          strategyId: 'strategy-default',
          strategyVersionId: 'strategy-default-v1',
          runId: 'run-default',
          stockId: '000858.SZ',
          accountId: 'default-account',
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
        dataAsOf: now,
      },
      validFrom: now,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: now,
    }) as Advice;
    const targetAccountId = 'a1b2c3d4-0001-4000-8000-000000000001';
    const ctx = await buildTestContext({ advices: [advice], clock: () => now });
    const result = await tradingPlanDailyCycleWorkflow.run(
      { accountId: targetAccountId, date: '2026-07-17' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidateReviews).toBe(0);
    expect(result.data.plans).toHaveLength(0);
  });

  it('retrieval 抓取时间略晚于工作流启动时钟时，不误判为未来时间而压成草案', async () => {
    const accountId = EMPTY_ACCOUNT_ID;
    const advice = AdviceSchema.parse({
      id: 'retrieval-clock-race-advice',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'buy',
      confidence: 70,
      horizon: 'short',
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      stopLoss: 95,
      reasoning: {
        premise: '盘后批次复核',
        evidence: ['收盘数据完整'],
        counterEvidence: ['仍需验证'],
      },
      risks: ['波动扩大'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        strategy: {
          strategyId: 'strategy-clock-race',
          strategyVersionId: 'strategy-clock-race-v1',
          runId: 'run-clock-race',
          stockId: STOCK_ID,
          accountId,
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date(NOW.getTime() + 1500),
            fetchedAt: new Date(NOW.getTime() + 1500),
            timestampSource: 'retrieval',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fuyao',
          },
        },
        dataAsOf: new Date(NOW.getTime() + 1500),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;
    // 工作流启动时取一次时钟；行情抓取与 AI 分析之后构建计划时再取一次，
    // retrieval 口径的抓取时间介于两者之间，不应被判成未来时间。
    let started = false;
    const ctx = await buildTestContext({
      advices: [advice],
      clock: () => {
        if (!started) {
          started = true;
          return NOW;
        }
        return new Date(NOW.getTime() + 2000);
      },
    });
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId, date: '2026-07-17' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans).toHaveLength(1);
    expect(result.data.plans[0]?.status).toBe('active');
  });

  it('同股策略证据合并；关键行动条件冲突时只生成待复核草案', async () => {
    const accountId = EMPTY_ACCOUNT_ID;
    const first = AdviceSchema.parse({
      id: 'same-stock-advice-a',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'buy',
      confidence: 80,
      horizon: 'short',
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      stopLoss: 95,
      reasoning: {
        premise: '策略 A 入选',
        evidence: ['策略 A 事实'],
        counterEvidence: ['策略 A 反证'],
      },
      risks: ['策略 A 风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        strategy: {
          strategyId: 'strategy-a',
          strategyVersionId: 'strategy-a-v1',
          runId: 'run-a',
          stockId: STOCK_ID,
          accountId,
          resultEvidence: [],
          signalIds: ['signal-a'],
          observationIds: [],
          recommendationTrigger: 'run',
        },
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date(NOW.getTime() - 60_000),
            fetchedAt: NOW,
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: NOW,
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;
    const second = AdviceSchema.parse({
      ...first,
      id: 'same-stock-advice-b',
      confidence: 70,
      reasoning: {
        premise: '策略 B 入选',
        evidence: ['策略 B 事实'],
        counterEvidence: ['策略 B 反证'],
      },
      risks: ['策略 B 风险'],
      basedOn: {
        ...first.basedOn,
        strategy: {
          ...first.basedOn.strategy,
          strategyId: 'strategy-b',
          strategyVersionId: 'strategy-b-v1',
          runId: 'run-b',
          signalIds: ['signal-b'],
        },
      },
    }) as Advice;
    const superseded = AdviceSchema.parse({
      ...first,
      id: 'same-stock-advice-old',
      decision: 'sell',
      targetPositionPct: 0,
      validFrom: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 60_000),
    }) as Advice;
    const ctx = await buildTestContext({ advices: [first, second, superseded], clock: () => NOW });
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidateReviews).toBe(1);
    expect(result.data.plans).toHaveLength(1);
    expect(result.data.plans[0]?.source).toMatchObject({
      strategyIds: ['strategy-a', 'strategy-b'],
      adviceIds: ['same-stock-advice-a', 'same-stock-advice-b'],
    });
    expect(result.data.plans[0]?.marketFacts.map((fact) => fact.id)).toEqual([
      `price:${STOCK_ID}:same-stock-advice-a`,
      `price:${STOCK_ID}:same-stock-advice-b`,
    ]);
    expect(
      result.data.plans[0]?.evidence.find((item) => item.id === 'advice:same-stock-advice-b'),
    ).toMatchObject({ factIds: [`price:${STOCK_ID}:same-stock-advice-b`] });
    expect(result.data.plans[0]?.explanation.counterEvidence).toEqual([
      '策略 A 反证',
      '策略 B 反证',
    ]);

    const conflicting = AdviceSchema.parse({
      ...second,
      decision: 'sell',
      targetPositionPct: 0,
    }) as Advice;
    const conflictCtx = await buildTestContext({
      advices: [first, conflicting],
      clock: () => NOW,
    });
    const conflict = await tradingPlanDailyCycleWorkflow.run({ accountId }, conflictCtx);
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    expect(conflict.data.plans[0]?.status).toBe('draft');
    expect(conflict.data.plans[0]?.position.constraintStatus).toBe('blocked');
    expect(conflict.data.plans[0]?.explanation.unknowns.join('；')).toContain('条件不一致');
  });
  it('T21 端到端：日线 → 波动率选点 → 落库 plan 的 appliedPct 高于下限', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 真实日线先进 daily_bars，再由 workflow 经 get_daily_volatility 读出 3.0% 的已实现波动率。
    const bars = dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS);
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    // H4 收窄后的区间 8.24–11.77；3.0% 落在 tiers 第三档（区间宽度的 33%）。
    expect(plan.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    expect(plan.position.rangePick).toMatchObject({
      ruleId: 'volatility-scaled',
      volatilityMetric: 'realized-vol-20d',
      volatilityPct: 3,
      // 窗口随计划落库：从计划本身就能回答「这个 σ 是哪 21 根 bar」。
      windowStart: bars[0]?.date,
      windowEnd: NOW,
      barsCount: 21,
      maxGapTradingDays: 0,
    });
    // 8.24 + (11.77 − 8.24) × 33% = 9.40：选点真的生效，不是退化成 min。
    expect(plan.position.appliedPct).toBe(9.4);
    expect(plan.position.appliedPct).not.toBe(plan.position.targetPctRange?.min);
    expect(plan.position.fallbackPct).toBe(8.24);
    // 读侧复用同一份 tiers 复算，写入值与读出值必须一致。
    const read = await getTradingPlanTool.execute(
      { versionId: `${plan.id}:v${plan.version}` },
      ctx,
    );
    expect(read.ok && read.data.plan.position.appliedPct).toBe(9.4);
  });

  it('T21 端到端：缺日线样本时降级 lower-bound 并在 constraintReasons 说明', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.fallbackPct).toBe(8.24);
    expect(plan.position.constraintReasons.join('；')).toContain('波动率不可用');
  });

  it('T21 端到端：21 根相同收盘价（停牌形态）取区间下限，不给区间上限', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 21 根完全相同的收盘价 → 20 个收益率全为 0：A 股里这几乎只可能是停牌或长期无成交。
    await ctx.repos.dailyBar.saveMany(dailyBarsFromReturns(FLAT_PRICE_RETURNS));

    const volatility = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(volatility.ok && volatility.data.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-volatility',
      volatilityPct: 0,
    });

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    expect(plan.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    // σ=0 是「没有有效价格」，不是「最安全」：落点必须是下限 8.24，绝不是上限 11.77。
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.appliedPct).toBe(plan.position.targetPctRange?.min);
    expect(plan.position.appliedPct).not.toBe(plan.position.targetPctRange?.max);
    expect(plan.position.constraintReasons.join('；')).toContain(
      '波动率异常低（可能停牌或无成交），按不可用处理，取区间下限',
    );
  });

  it('T21 端到端：低波动（1%）取区间上限——appliedPct 高于历史 lower-bound', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 交替 ±1% → σ ≈ 1.0%，落在第一档（≤1.5% → 区间宽度 100%）。
    await ctx.repos.dailyBar.saveMany(
      dailyBarsFromReturns(
        Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.01)),
      ),
    );

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    const pick = plan.position.rangePick;
    if (pick === null || pick.ruleId !== 'volatility-scaled')
      throw new Error('expected volatility-scaled');
    expect(pick.volatilityPct).toBeCloseTo(1, 1);
    // 行为变更：波动小到有效 → 用满区间，落点等于上限，高于此前恒取下限的 8.24。
    expect(plan.position.appliedPct).toBe(11.77);
    expect(plan.position.appliedPct).toBe(plan.position.targetPctRange?.max);
    expect(plan.position.appliedPct).toBeGreaterThan(plan.position.targetPctRange?.min ?? 0);
    // 降级值仍恒等于下限：降级路径的语义没变。
    expect(plan.position.fallbackPct).toBe(8.24);
  });

  it('T21 端到端：日线停更两个月按过期处理，降级下限并写明滞后交易日数', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 窗口本身是完整的 3.0%，但最后一根日线停在两个月前：那是「两个月前的波动率」。
    await ctx.repos.dailyBar.saveMany(
      dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS, new Date(NOW.getTime() - 60 * 86_400_000)),
    );

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    const reasons = plan.position.constraintReasons.join('；');
    expect(reasons).toContain('波动率样本已过期');
    expect(reasons).toMatch(/滞后 \d+ 个交易日/);
  });

  it('T21 端到端：停牌断档的窗口不算 20 日波动率，降级 lower-bound', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 最新 10 根之后停牌 12 个交易日：21 根 bar 里跨断档的那一对是多日收益，不是日收益。
    // 剔除它只剩 19 个有效收益率 < 20 → 样本不足，不是「3% 的 20 日波动率」。
    const dates = tradingDaysBack(21, { afterNewest: 10, missing: 12 });
    await ctx.repos.dailyBar.saveMany(dailyBarsAtDates(THREE_PCT_VOLATILITY_RETURNS, dates));

    const volatility = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(volatility.ok && volatility.data.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-volatility',
      barsCount: 21,
      returnsCount: 19,
      requiredReturns: 20,
      maxGapTradingDays: 12,
      zeroVolumeBars: 0,
    });

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    // 降级到下限：不再把「21 根 bar 的 σ」当成「20 个日收益率的 σ」。
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.appliedPct).toBe(plan.position.targetPctRange?.min);
    expect(plan.position.constraintReasons.join('；')).toContain('波动率样本不足');
  });

  it('T21 端到端：停牌期 provider 仍写 volume=0 的 bar 时降级 lower-bound，不给接近上限的仓位', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    // 「停牌不产生 bar」是 provider 行为，不是写入侧保证：这里模拟 provider 在停牌期也写 bar。
    // 21 根 bar 一路排到最新交易日（staleness=0，新鲜度闸门失效），volume=0，收盘价仍 ±3% 摆动。
    // 只看收盘价会得到 3% → 第三档 → 9.4（接近区间上限）。必须被零成交判据拦下。
    const bars = dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS).map((bar) => ({
      ...bar,
      volume: 0,
    }));
    await ctx.repos.dailyBar.saveMany(bars);

    const volatility = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(volatility.ok && volatility.data.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-volatility',
      returnsCount: 0,
      zeroVolumeBars: 21,
    });

    const result = await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    // 关键：不是 9.4（volatility-scaled 会给出的落点），也不是上限 11.77。
    expect(plan.position.appliedPct).not.toBe(9.4);
    expect(plan.position.appliedPct).not.toBe(plan.position.targetPctRange?.max);
    expect(plan.position.constraintReasons.join('；')).toContain('波动率样本不足');
  });

  it('T21 端到端：σ 下限可配置——调高后 3% 的样本被拒，降级下限', async () => {
    const ctx = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    await ctx.repos.dailyBar.saveMany(dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS));

    // 默认下限 0.1 放行 3%；把下限调到 5 就是「3% 也不算有效波动」。
    const result = await tradingPlanDailyCycleWorkflow.run(
      { accountId: EMPTY_ACCOUNT_ID, volatilityMinPct: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    const plans = await ctx.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID });
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.constraintReasons.join('；')).toContain('波动率异常低');
  });

  it('T21 端到端：阈值可由环境变量给（定时路径无入参），显式入参优先于 env', async () => {
    const fresh = async () => {
      const ctx = await buildTestContext({
        clock: () => NOW,
        advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
      });
      await ctx.repos.dailyBar.saveMany(dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS));
      return ctx;
    };

    // env 由本文件的 beforeEach/afterEach 统一隔离（先保存原值、清空，结束后恢复）。
    // 999 远离 3% 这个样本值：只要 env 生效，3% 的窗口必然被拒。
    process.env.LUOOME_TRADING_PLAN_VOLATILITY_MIN_PCT = '999';
    const fromEnv = await fresh();
    await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, fromEnv);
    const envPlan = (await fromEnv.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID }))[0];
    if (envPlan === undefined) throw new Error('plan missing');
    // 不传显式入参 → 走 env 的 999：3% 的样本被拒，降级下限。
    expect(envPlan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(envPlan.position.appliedPct).toBe(8.24);
    expect(envPlan.position.constraintReasons.join('；')).toContain('波动率异常低');

    // 显式入参优先：入参把下限降回 0.1，env 的 999 不再生效（否则这里仍是 lower-bound）。
    const overridden = await fresh();
    await tradingPlanDailyCycleWorkflow.run(
      { accountId: EMPTY_ACCOUNT_ID, volatilityMinPct: 0.1 },
      overridden,
    );
    const overriddenPlan = (
      await overridden.repos.tradingPlan.list({
        accountId: EMPTY_ACCOUNT_ID,
      })
    )[0];
    if (overriddenPlan === undefined) throw new Error('plan missing');
    expect(overriddenPlan.position.rangePick).toMatchObject({ ruleId: 'volatility-scaled' });
    expect(overriddenPlan.position.appliedPct).toBe(9.4);
  });

  it('T21 端到端：新鲜度阈值可配置——滞后 3 个交易日在默认 5 内可用，调到 2 即过期', async () => {
    // 最新 bar 停在 2026-07-14（周五 07-17 往前 3 个交易日）。
    const staleEnd = new Date('2026-07-14T07:00:00.000Z');
    const bars = dailyBarsFromReturns(THREE_PCT_VOLATILITY_RETURNS, staleEnd);
    const fresh = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    await fresh.repos.dailyBar.saveMany(bars);
    await tradingPlanDailyCycleWorkflow.run({ accountId: EMPTY_ACCOUNT_ID }, fresh);
    const freshPlan = (await fresh.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID }))[0];
    if (freshPlan === undefined) throw new Error('plan missing');
    // 默认阈值 5：滞后 3 个交易日仍算当前样本。
    expect(freshPlan.position.rangePick).toMatchObject({ ruleId: 'volatility-scaled' });
    expect(freshPlan.position.appliedPct).toBe(9.4);

    const strict = await buildTestContext({
      clock: () => NOW,
      advices: [candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } })],
    });
    await strict.repos.dailyBar.saveMany(bars);
    await tradingPlanDailyCycleWorkflow.run(
      { accountId: EMPTY_ACCOUNT_ID, volatilityMaxStalenessTradingDays: 2 },
      strict,
    );
    const strictPlan = (await strict.repos.tradingPlan.list({ accountId: EMPTY_ACCOUNT_ID }))[0];
    if (strictPlan === undefined) throw new Error('plan missing');
    expect(strictPlan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(strictPlan.position.appliedPct).toBe(8.24);
    // 降级文案写实际用的阈值，改阈值不会让历史计划变得不可解释。
    expect(strictPlan.position.constraintReasons.join('；')).toContain('滞后 3 个交易日，阈值 2');
  });

  it('非 UUID 账户键（如 default-account）不会触发 sync_quotes 的 Invalid UUID', async () => {
    const now = NOW;
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.account.save({
      id: 'default-account',
      name: '默认投资账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(0),
      cashBalance: money(0),
      createdAt: new Date('2026-01-05T01:00:00.000Z'),
    });
    const res = await tradingPlanDailyCycleWorkflow.run(
      { accountId: 'default-account', date: '2026-07-17', mode: 'scheduled' },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.errors.filter((error) => error.reason.includes('Invalid UUID'))).toEqual([]);
    const audits = await ctx.repos.workflowRun.listRecent({
      workflowName: 'trading-plan-daily-cycle',
    });
    expect(audits.filter((run) => (run.error ?? '').includes('Invalid UUID'))).toEqual([]);
  });
});

describe('T21 生成器：v2 区间/选点/失效规则与指纹重算', () => {
  const factsFor = (digest: string, currentPct: number) =>
    AccountFactsSchema.parse({
      accountId: ACCOUNT_ID,
      asOf: NOW,
      digest,
      cashBalance: money(1000 - currentPct * 10),
      stockMarketValue: money(currentPct * 10),
      totalAssets: money(1000),
      status: 'complete',
      reasons: [],
      notes: [],
      positions:
        currentPct === 0
          ? []
          : [
              {
                stockId: STOCK_ID,
                quantity: 10,
                availableQuantity: 10,
                marketValue: money(currentPct * 10),
              },
            ],
    });
  const holding = {
    holding: {
      id: 'holding-1',
      accountId: ACCOUNT_ID,
      stockId: STOCK_ID,
      quantity: 10,
      availableQuantity: 10,
      closedAt: null,
    },
    stockName: '贵州茅台',
  };

  it('落库为 v2 区间 + lower-bound 选点 + 结构化失效条件，不含 deltaPct', () => {
    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 10),
      advice: candidateAdvice(NOW, { decision: 'hold' }),
      holding,
      previous: [],
      now: NOW,
    });
    expect(plan.position.targetPctRange).toEqual({ min: 10, max: 10 });
    expect(plan.position.appliedPct).toBe(10);
    expect(plan.position.fallbackPct).toBe(10);
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.invalidationRules.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).not.toContain('"deltaPct"');
  });

  it('账户事实指纹变化后重新计算区间，不复制上一版', () => {
    const advice = candidateAdvice(NOW, { decision: 'hold' });
    const first = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 10),
      advice,
      holding,
      previous: [],
      now: NOW,
    });
    const next = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-b', 20),
      advice,
      holding,
      previous: [first],
      now: new Date(NOW.getTime() + 86_400_000),
    });
    expect(first.accountFactsDigest).toBe('facts-digest-a');
    expect(next.accountFactsDigest).toBe('facts-digest-b');
    expect(first.position.targetPctRange).toEqual({ min: 10, max: 10 });
    expect(next.position.targetPctRange).toEqual({ min: 20, max: 20 });
    expect(next.position.appliedPct).toBe(20);
    expect(next.version).toBe(2);
  });

  it('高波动标的压到区间下限，但仍留下可复算的 volatility-scaled 参数', () => {
    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
      volatility: volatilitySample(5),
    });
    expect(plan.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    expect(plan.position.rangePick).toMatchObject({
      ruleId: 'volatility-scaled',
      volatilityPct: 5,
    });
    // 5% 落在「≤6% → 区间宽度 0%」这一档：保守到下限，且 fallbackPct 仍等于 min。
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.fallbackPct).toBe(8.24);
    expect(plan.position.constraintReasons.join('；')).not.toContain('波动率不可用');
  });

  it('σ=0 的样本按不可用处理：落点是下限，不是上限', () => {
    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
      // 直接调用方绕过 tool 时同样不能把 σ=0 当「最安全」：第一档会给出区间上限。
      volatility: volatilitySample(0),
    });
    expect(plan.position.targetPctRange).toEqual({ min: 8.24, max: 11.77 });
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(8.24);
    expect(plan.position.appliedPct).toBe(plan.position.targetPctRange?.min);
    expect(plan.position.constraintReasons.join('；')).toContain(
      '波动率异常低（可能停牌或无成交），按不可用处理，取区间下限',
    );
  });

  it('样本过期降级下限并写明最新日线与滞后交易日数；临界 5 个交易日仍可用', () => {
    const stale = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
      volatility: volatilitySample(3, {
        latestBarDate: new Date('2026-05-18T00:00:00.000Z'),
        stalenessTradingDays: 42,
      }),
    });
    expect(stale.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(stale.position.appliedPct).toBe(8.24);
    expect(stale.position.constraintReasons.join('；')).toContain(
      '波动率样本已过期（最新日线 2026-05-18，滞后 42 个交易日，阈值 5）',
    );

    const fresh = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
      volatility: volatilitySample(3, { stalenessTradingDays: 5 }),
    });
    expect(fresh.position.rangePick).toMatchObject({
      ruleId: 'volatility-scaled',
      volatilityPct: 3,
    });
    expect(fresh.position.appliedPct).toBe(9.4);
  });

  it('生成器把波动率窗口写进 rangePick（σ 与窗口是同一类可复算事实）', () => {
    const windowStart = new Date('2026-07-01T00:00:00.000Z');
    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
      volatility: volatilitySample(3, { windowStart, maxGapTradingDays: 4 }),
    });
    expect(plan.position.rangePick).toMatchObject({
      ruleId: 'volatility-scaled',
      volatilityPct: 3,
      windowStart,
      windowEnd: NOW,
      barsCount: 21,
      // 窗口跨过停牌：断档天数一并落库，复盘能看出 σ 里有跨多日的收益率。
      maxGapTradingDays: 4,
    });
    // 窗口不影响落点：仍是 8.24 + (11.77 − 8.24) × 33% = 9.40。
    expect(plan.position.appliedPct).toBe(9.4);
  });

  it('生成器接受阈值覆盖：σ 下限调高即降级，新鲜度上限调高即放行', () => {
    const base = {
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 0),
      advice: candidateAdvice(NOW, { targetPositionPctRange: { min: 8, max: 12 } }),
      previous: [],
      now: NOW,
    };
    const strictFloor = buildTradingPlanFromAdvice({
      ...base,
      volatility: volatilitySample(3),
      volatilityPolicy: { minVolatilityPct: 5 },
    });
    expect(strictFloor.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(strictFloor.position.appliedPct).toBe(8.24);
    expect(strictFloor.position.constraintReasons.join('；')).toContain('波动率异常低');

    const looseFreshness = buildTradingPlanFromAdvice({
      ...base,
      volatility: volatilitySample(3, { stalenessTradingDays: 8 }),
      volatilityPolicy: { maxStalenessTradingDays: 10 },
    });
    expect(looseFreshness.position.rangePick).toMatchObject({ ruleId: 'volatility-scaled' });
    expect(looseFreshness.position.appliedPct).toBe(9.4);
  });

  it('退化区间（min === max）不声明 volatility-scaled，选点仍是 lower-bound', () => {
    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      accountFacts: factsFor('facts-digest-a', 10),
      advice: candidateAdvice(NOW, { decision: 'hold' }),
      holding: {
        holding: {
          id: 'holding-1',
          accountId: ACCOUNT_ID,
          stockId: STOCK_ID,
          quantity: 10,
          availableQuantity: 10,
          closedAt: null,
        },
        stockName: '贵州茅台',
      },
      previous: [],
      now: NOW,
      volatility: volatilitySample(3),
    });
    expect(plan.position.targetPctRange).toEqual({ min: 10, max: 10 });
    expect(plan.position.rangePick).toEqual({ ruleId: 'lower-bound' });
    expect(plan.position.appliedPct).toBe(10);
    expect(plan.position.fallbackPct).toBe(10);
  });
});
