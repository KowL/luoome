import { accountSnapshotPositionId, STANDARD_DISCLAIMERS } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { saveAccountSnapshotTool } from './account-snapshot.js';
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

  it('快照中存在但没有 legacy Holding 时仍可分析，且不伪造成本价', async () => {
    const ctx = await buildTestContext({
      advices: [],
      clock: () => new Date('2026-07-17T07:00:00.000Z'),
    });
    const snapshot = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        cashBalance: 900_000,
        positions: [
          {
            stockId: '000858.SZ',
            quantity: 100,
            availableQuantity: 100,
            marketValue: 10_000,
          },
        ],
      },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
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
            observedHolding = (request.data as { holding: Record<string, unknown> }).holding;
            return llm.generate<T>(request);
          },
        },
      },
    };
    const result = await analyzePositionTool.execute(
      { holdingId: accountSnapshotPositionId(ctx.user.defaultAccountId, '000858.SZ') },
      observedCtx,
    );
    expect(result.ok).toBe(true);
    expect(observedHolding).toMatchObject({ quantity: 100, availableQuantity: 100 });
    expect(observedHolding).not.toHaveProperty('avgCost');
  });
});
