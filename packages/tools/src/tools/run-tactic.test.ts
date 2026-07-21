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

describe('run_tactic persistSignals 选项（v0.6 起）', () => {
  it('persistSignals=false 时不写 tactic_signals 表', async () => {
    const ctx = await buildMockContext();
    const before = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    const r = await runTacticTool.execute(
      {
        tacticId: 'breakout-volume',
        scope: 'holdings',
        lookbackDays: 120,
        persistSignals: false,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    expect(after).toBe(before);
  });

  it('persistSignals=true（默认）落库', async () => {
    const ctx = await buildMockContext();
    const before = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    const r = await runTacticTool.execute(
      {
        tacticId: 'breakout-volume',
        scope: 'holdings',
        lookbackDays: 120,
        // persistSignals omitted → default true
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await ctx.repos.tactic.signalsByTactic('breakout-volume')).length;
    // 可能多 0 / 1 / 多条（mock adapter 不确定）—— 只断言 ≥ before 且与 triggeredCount 一致
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBe(r.data.triggeredCount);
  });
});
