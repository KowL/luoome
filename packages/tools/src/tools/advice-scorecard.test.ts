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
    expect(result.data.hitRate).toBeCloseTo(2 / 3, 6);
    expect(result.data.avgExcessPct).toBeCloseTo((0.04 + 0.06 - 0.03) / 3, 6);
    const buckets = Object.fromEntries(result.data.groups.map((g) => [g.bucket, g]));
    expect(buckets['<50']?.hitRate).toBe(0);
    expect(buckets['>=70']?.hitRate).toBe(1);
    expect(result.data.gate.passed).toBe(false);
    expect(result.data.gate.reasons.join('；')).toContain('不足 50 条');
  });

  it('没有结算数据时不伪造命中率', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await getAdviceScorecardTool.execute({ days: 30, horizonDays: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.samples).toBe(0);
    expect(result.data.hitRate).toBeNull();
    expect(result.data.avgExcessPct).toBeNull();
    expect(result.data.gate.passed).toBe(false);
  });
});
