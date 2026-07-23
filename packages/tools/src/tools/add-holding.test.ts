import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { addHoldingTool } from './add-holding.js';

describe('add_holding', () => {
  it('直录新持仓：availableQuantity 缺省 = quantity + 自动补 stock stub', async () => {
    const ctx = await buildTestContext();
    const result = await addHoldingTool.execute(
      { stockId: '601398.SH', quantity: 500, avgCost: 70.25 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.quantity).toBe(500);
    expect(result.data.holding.availableQuantity).toBe(500);
    expect(result.data.holding.avgCost).toBe(70.25);
    expect(result.data.holding.closedAt).toBeNull();

    const stock = await ctx.repos.stock.findById('601398.SH');
    expect(stock?.name).toBe('601398');
  });

  it('同 (accountId, stockId) 已有活跃持仓 → invalid_input', async () => {
    const ctx = await buildTestContext();
    // fixtures: test-holding-002594 活跃
    const result = await addHoldingTool.execute(
      { stockId: '002594.SZ', quantity: 100, avgCost: 100 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('availableQuantity > quantity → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await addHoldingTool.execute(
      { stockId: '601398.SH', quantity: 100, avgCost: 70, availableQuantity: 200 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('账户不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const result = await addHoldingTool.execute(
      { stockId: '601398.SH', quantity: 100, avgCost: 70, accountId: 'no-such' },
      ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'no-such' },
    });
  });
});
