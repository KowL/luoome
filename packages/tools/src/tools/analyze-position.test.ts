import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { analyzePositionTool } from './analyze-position.js';

describe('analyze_position', () => {
  it('正常路径：产出 position 维度 Advice 并持久化', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await analyzePositionTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { advice, evidence } = result.data;
    expect(advice.subjectKind).toBe('position');
    expect(advice.subjectId).toBe('test-holding-002594');
    expect(advice.sourceTool).toBe('analyze_position');
    expect(advice.confidence).toBeGreaterThanOrEqual(0);
    expect(advice.confidence).toBeLessThanOrEqual(100);
    expect(advice.validUntil.getTime()).toBeGreaterThan(advice.validFrom.getTime());
    expect(advice.reasoning.premise.length).toBeGreaterThan(0);

    expect(advice.disclaimers.length).toBeGreaterThanOrEqual(3);
    for (const required of STANDARD_DISCLAIMERS) {
      expect(advice.disclaimers).toContain(required);
    }

    expect(evidence.quotes?.['002594.SZ']?.close).toBe(105.8);
    expect(evidence.indicators?.['002594.SZ']).toBeDefined();

    const queried = await ctx.repos.advice.query({ subjectId: 'test-holding-002594' });
    expect(queried.some((a) => a.id === advice.id)).toBe(true);
  });

  it('正常路径：持仓上下文影响 LLM 输出（确定性 mock）', async () => {
    const ctx = await buildTestContext({ advices: [] });
    // 002594.SZ 浮盈 +7.4%，不到 ±阈值 → decision 由 hash 决定但必为合法枚举值。
    const result = await analyzePositionTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(['buy', 'sell', 'hold', 'watch', 'avoid']).toContain(result.data.advice.decision);
  });

  it('价位自相矛盾时带原因重试一次，第二次合格则照常落库', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const systems: string[] = [];
    let call = 0;
    const flaky = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: ctx.adapters.llm.name,
          generate: async (request: { system: string }) => {
            systems.push(request.system);
            call += 1;
            return call === 1
              ? {
                  // 买点落在区间外（100 不在 110-120）→ 触发不变量，需要重试
                  decision: 'hold' as const,
                  confidence: 60,
                  horizon: 'short' as const,
                  entryPrice: 100,
                  entryPriceLow: 110,
                  entryPriceHigh: 120,
                  targetPrice: 130,
                  stopLoss: 95,
                  reasoning: {
                    premise: '回调后趋势仍在',
                    evidence: ['收盘价高于 MA20'],
                    counterEvidence: ['成交量可能不足'],
                  },
                  risks: ['波动可能放大'],
                }
              : {
                  decision: 'hold' as const,
                  confidence: 60,
                  horizon: 'short' as const,
                  entryPrice: 115,
                  entryPriceLow: 110,
                  entryPriceHigh: 120,
                  targetPrice: 130,
                  stopLoss: 95,
                  reasoning: {
                    premise: '回调后趋势仍在',
                    evidence: ['收盘价高于 MA20'],
                    counterEvidence: ['成交量可能不足'],
                  },
                  risks: ['波动可能放大'],
                };
          },
        },
      },
    } as typeof ctx;

    const result = await analyzePositionTool.execute({ holdingId: 'test-holding-002594' }, flaky);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advice.entryPrice).toBe(115);
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain('entryPrice must lie inside the entry price range');
  });

  it('错误路径：持仓不存在 → not_found', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await analyzePositionTool.execute({ holdingId: 'no-such-holding' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Holding', id: 'no-such-holding' },
    });
  });

  it('错误路径：缺 holdingId → invalid_input', async () => {
    const ctx = await buildTestContext({ advices: [] });
    const result = await analyzePositionTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
