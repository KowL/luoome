import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { runTacticTool } from './run-tactic.js';

describe('tool/run_tactic', () => {
  it('战法不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await runTacticTool.execute(
      { tacticId: 'nope', scope: 'holdings', lookbackDays: 120 },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('跑内置战法：返回 signals 数组（可为空）', async () => {
    const ctx = await buildMockContext();
    const r = await runTacticTool.execute(
      { tacticId: 'breakout-volume', scope: 'holdings', lookbackDays: 120 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tacticId).toBe('breakout-volume');
    expect(Array.isArray(r.data.signals)).toBe(true);
    expect(typeof r.data.evaluatedStocks).toBe('number');
    expect(typeof r.data.triggeredCount).toBe('number');
  });
});
