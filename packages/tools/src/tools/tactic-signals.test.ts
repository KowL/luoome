import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { tacticSignalsByStockTool } from './tactic-signals-by-stock.js';
import { tacticSignalsByTacticTool } from './tactic-signals-by-tactic.js';

describe('tool/tactic_signals', () => {
  it('按 stock 查询：空集合', async () => {
    const ctx = await buildMockContext();
    const r = await tacticSignalsByStockTool.execute({ stockId: '002594.SZ', limit: 50 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.signals).toEqual([]);
  });

  it('按 tactic 查询：空集合', async () => {
    const ctx = await buildMockContext();
    const r = await tacticSignalsByTacticTool.execute(
      { tacticId: 'breakout-volume', limit: 50 },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.signals).toEqual([]);
  });
});
