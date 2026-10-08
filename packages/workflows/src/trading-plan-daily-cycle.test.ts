import {
  AccountFactsSchema,
  type Advice,
  AdviceSchema,
  money,
  STANDARD_DISCLAIMERS,
  tradingPlanExpiresAt,
} from '@luoome/core';
import { addHoldingTool, getTradingPlanTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

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

describe('trading plan daily cycle', () => {
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
    expect(plan.position).toMatchObject({ currentPct: 0, targetPct: 6, deltaPct: 6 });
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
    let positionCalls = 0;
    let observedHolding: Record<string, unknown> | undefined;
    const llm = ctx.adapters.llm;
    const observedCtx = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: llm.name,
          generate: async <T = unknown>(
            request: Parameters<typeof llm.generate>[0],
          ): Promise<T> => {
            if (request.system === 'analyze_position') {
              positionCalls += 1;
              observedHolding = (request.data as { holding: Record<string, unknown> }).holding;
            }
            return llm.generate<T>(request);
          },
        },
      },
    };
    const result = await tradingPlanDailyCycleWorkflow.run(
      { accountId: EMPTY_ACCOUNT_ID },
      observedCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holdingReviews).toBe(1);
    expect(positionCalls).toBe(1);
    expect(observedHolding).toMatchObject({ quantity: 100 });
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
});
