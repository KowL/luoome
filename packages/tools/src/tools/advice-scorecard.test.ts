import { type Advice, AdviceSettlementSchema, money, STANDARD_DISCLAIMERS } from '@luoome/core';
import { getAdviceScorecardTool } from '@luoome/toolkit/tools/advice-scorecard.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

const makeAdvice = (id: string, confidence: number, createdAt: Date): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '002594.SZ',
  decision: 'buy',
  confidence,
  horizon: 'short',
  entryPriceLow: money(99),
  entryPriceHigh: money(101),
  reasoning: { premise: 'premise', evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: { dataAsOf: createdAt },
  validFrom: createdAt,
  validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
  createdAt,
});

const settlement = (adviceId: string, hit: boolean, excessPct: number, evaluatedAt: Date) =>
  AdviceSettlementSchema.parse({
    adviceId,
    horizonDays: 5,
    assumedEntryPrice: money(100),
    exitPrice: money(hit ? 105 : 98),
    returnPct: hit ? 0.05 : -0.02,
    benchmarkReturnPct: 0.01,
    excessPct,
    hit,
    evaluatedAt,
  });

const fallback = (advice: Advice): Advice => ({
  ...advice,
  confidence: 30,
  reasoning: {
    premise: 'LLM 推理不可用，基于规则的保守判断',
    evidence: ['规则 fallback：测试夹具'],
    counterEvidence: [],
  },
});

const withoutEntry = (advice: Advice): Advice => {
  const { entryPriceLow: _low, entryPriceHigh: _high, ...rest } = advice;
  return rest;
};

describe('get_advice_scorecard', () => {
  it('按 T+5 汇总命中率、平均超额与 confidence 分组，并给出未达样本量门禁的原因', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const evaluatedAt = ctx.clock();
    const createdAt = new Date(evaluatedAt.getTime() - 2 * 86_400_000);
    await ctx.repos.advice.save(makeAdvice('sc-low', 40, createdAt));
    await ctx.repos.advice.save(makeAdvice('sc-mid', 60, createdAt));
    await ctx.repos.advice.save(makeAdvice('sc-high', 80, createdAt));
    await ctx.repos.adviceTracking.saveSettlement(settlement('sc-low', false, -0.03, evaluatedAt));
    await ctx.repos.adviceTracking.saveSettlement(settlement('sc-mid', true, 0.04, evaluatedAt));
    await ctx.repos.adviceTracking.saveSettlement(settlement('sc-high', true, 0.06, evaluatedAt));

    const result = await getAdviceScorecardTool.execute({ days: 30, horizonDays: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.samples).toBe(3);
    expect(result.data.eligible).toBe(3);
    expect(result.data.settledEligible).toBe(3);
    expect(result.data.coverage).toBe(1);
    expect(result.data.groups.reduce((sum, group) => sum + group.samples, 0)).toBe(3);
    expect(result.data.hitRate).toBeCloseTo(2 / 3, 6);
    expect(result.data.avgExcessPct).toBeCloseTo((0.04 + 0.06 - 0.03) / 3, 6);
    const buckets = Object.fromEntries(result.data.groups.map((g) => [g.bucket, g]));
    expect(buckets['<50']?.hitRate).toBe(0);
    expect(buckets['>=70']?.hitRate).toBe(1);
    expect(result.data.gate.passed).toBe(false);
    expect(result.data.gate.reasons.join('；')).toContain('不足 50 条');
  });

  it('规则观察不进命中率分母，单独列出已结算条数', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const evaluatedAt = ctx.clock();
    const createdAt = new Date(evaluatedAt.getTime() - 2 * 86_400_000);
    const normal = makeAdvice('sc-normal', 70, createdAt);
    const fallback: Advice = {
      ...makeAdvice('sc-fallback', 30, createdAt),
      reasoning: {
        premise: 'LLM 推理不可用，基于规则的保守判断',
        evidence: ['规则 fallback：测试夹具'],
        counterEvidence: [],
      },
    };
    await ctx.repos.advice.save(normal);
    await ctx.repos.advice.save(fallback);
    await ctx.repos.adviceTracking.saveSettlement(
      settlement('sc-normal', false, -0.03, evaluatedAt),
    );
    await ctx.repos.adviceTracking.saveSettlement(
      settlement('sc-fallback', true, 0.06, evaluatedAt),
    );

    const result = await getAdviceScorecardTool.execute({ days: 30, horizonDays: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 只有 AI 建议计入分母；规则观察单列，不把命中率抬高。
    expect(result.data.samples).toBe(1);
    expect(result.data.hitRate).toBe(0);
    expect(result.data.ruleFallbackSamples).toBe(1);
    expect(result.data.ruleFallbackTotal).toBe(1);
    expect(result.data.eligible).toBe(1);
    expect(result.data.settledEligible).toBe(1);
    expect(result.data.coverage).toBe(1);
    expect(result.data.groups.reduce((sum, group) => sum + group.samples, 0)).toBe(1);
  });

  it('覆盖率与对账：应结算 / 已结算 / 规则观察可与同窗口 advice.query 对上', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const windowEnd = ctx.clock();
    const settledCreatedAt = new Date(windowEnd.getTime() - 10 * 86_400_000);
    const notDueCreatedAt = new Date(windowEnd.getTime() - 2 * 86_400_000);
    await ctx.repos.advice.save(makeAdvice('sc-ai-buy', 70, settledCreatedAt));
    await ctx.repos.advice.save({
      ...makeAdvice('sc-ai-sell', 60, settledCreatedAt),
      decision: 'sell',
    });
    await ctx.repos.advice.save(makeAdvice('sc-ai-missing-bars', 55, settledCreatedAt));
    await ctx.repos.advice.save(
      withoutEntry(makeAdvice('sc-ai-missing-entry', 65, settledCreatedAt)),
    );
    await ctx.repos.advice.save(fallback(makeAdvice('sc-fallback-due', 30, settledCreatedAt)));
    await ctx.repos.advice.save({
      ...makeAdvice('sc-hold', 65, settledCreatedAt),
      decision: 'hold',
    });
    await ctx.repos.advice.save(makeAdvice('sc-not-due', 75, notDueCreatedAt));
    await ctx.repos.advice.save({
      ...makeAdvice('sc-sector', 70, settledCreatedAt),
      subjectKind: 'sector',
      subjectId: 'sector-ai',
    });
    await ctx.repos.adviceTracking.saveSettlement(settlement('sc-ai-buy', true, 0.04, windowEnd));
    await ctx.repos.adviceTracking.saveSettlement(
      settlement('sc-ai-sell', false, -0.02, windowEnd),
    );
    await ctx.repos.adviceTracking.saveSettlement(
      settlement('sc-fallback-due', true, 0.06, windowEnd),
    );
    await ctx.repos.adviceTracking.saveSettlement(settlement('sc-hold', true, 0.01, windowEnd));

    const result = await getAdviceScorecardTool.execute({ days: 30, horizonDays: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    expect(data.eligible).toBe(4);
    expect(data.settledEligible).toBe(2);
    expect(data.coverage).toBe(0.5);
    expect(data.uncovered).toEqual({ missingEntry: 1, missingBars: 1 });
    expect(data.ruleFallbackTotal).toBe(1);
    expect(data.ruleFallbackSamples).toBe(1);
    expect(data.reconciliation).toEqual({
      windowAdvices: 8,
      buySellStock: 6,
      ruleFallback: 1,
      notDue: 1,
      otherDecisions: 1,
      nonStock: 1,
    });

    // 三边对账：advices 总数 = 应结算 + 规则观察 + 未到期 + 明确排除的其它。
    expect(data.reconciliation.buySellStock).toBe(
      data.eligible + data.reconciliation.notDue + data.reconciliation.ruleFallback,
    );
    expect(data.reconciliation.windowAdvices).toBe(
      data.reconciliation.buySellStock +
        data.reconciliation.otherDecisions +
        data.reconciliation.nonStock,
    );
    const windowAdvices = await ctx.repos.advice.query({
      includeExpired: true,
      since: new Date(windowEnd.getTime() - 30 * 86_400_000),
      until: windowEnd,
    });
    expect(data.reconciliation.windowAdvices).toBe(windowAdvices.length);
  });

  it('没有结算数据时不伪造命中率', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await getAdviceScorecardTool.execute({ days: 30, horizonDays: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.samples).toBe(0);
    expect(result.data.ruleFallbackSamples).toBe(0);
    expect(result.data.ruleFallbackTotal).toBe(0);
    expect(result.data.eligible).toBe(0);
    expect(result.data.coverage).toBeNull();
    expect(result.data.uncovered).toEqual({ missingEntry: 0, missingBars: 0 });
    expect(result.data.reconciliation.windowAdvices).toBe(0);
    expect(result.data.hitRate).toBeNull();
    expect(result.data.avgExcessPct).toBeNull();
    expect(result.data.gate.passed).toBe(false);
  });
});
