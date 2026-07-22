import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { createStockPoolTool } from './create-stock-pool.js';

describe('create_stock_pool', () => {
  it('建 manual 池：合法路径 → 落库 + 字段一致', async () => {
    const ctx = await buildMockContext();
    const r = await createStockPoolTool.execute(
      {
        id: 'manual-pool',
        name: '手动池',
        source: { kind: 'manual', stockIds: ['002594.SZ'] },
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.id).toBe('manual-pool');
    expect(r.data.pool.enabled).toBe(true);
    expect(r.data.pool.cooldownMinutes).toBe(30);

    const found = await ctx.repos.stockPool.findById('manual-pool');
    expect(found?.id).toBe('manual-pool');
  });

  it('同 id 重复 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const input = {
      id: 'dup',
      name: 'x',
      source: { kind: 'manual', stockIds: ['002594.SZ'] as string[] },
      rules: [{ kind: 'price-change', pct: 0.05 }],
    };
    await createStockPoolTool.execute(input, ctx);
    const r2 = await createStockPoolTool.execute(input, ctx);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('invalid_input');
  });

  it('holdings source 的 accountId 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await createStockPoolTool.execute(
      {
        id: 'h-bad',
        name: 'x',
        source: { kind: 'holdings', accountId: 'no-such-acc' },
        rules: [{ kind: 'cost-threshold', stopLossPct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('tactic source 引用不存在的 tactic → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await createStockPoolTool.execute(
      {
        id: 't-bad',
        name: 'x',
        source: { kind: 'tactic', tacticId: 'no-such', lookbackDays: 5 },
        rules: [{ kind: 'tactic', tacticId: 'no-such', minScore: 60 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('id 含大写 → invalid_input（zod parse）', async () => {
    const ctx = await buildMockContext();
    const r = await createStockPoolTool.execute(
      {
        id: 'BadID',
        name: 'x',
        source: { kind: 'manual', stockIds: ['002594.SZ'] },
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rules 为空 → invalid_input', async () => {
    const ctx = await buildMockContext();
    const r = await createStockPoolTool.execute(
      {
        id: 'no-rules',
        name: 'x',
        source: { kind: 'manual', stockIds: ['002594.SZ'] },
        rules: [],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
