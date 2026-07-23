import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { updateHoldingTool } from './update-holding.js';

describe('update_holding', () => {
  it('只改传入字段：avgCost', async () => {
    const ctx = await buildTestContext();
    const result = await updateHoldingTool.execute(
      { holdingId: 'test-holding-002594', avgCost: 95.5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.avgCost).toBe(95.5);
    expect(result.data.holding.quantity).toBe(1000); // 未变
  });

  it('同时改 quantity + availableQuantity', async () => {
    const ctx = await buildTestContext();
    const result = await updateHoldingTool.execute(
      { holdingId: 'test-holding-002594', quantity: 800, availableQuantity: 700 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.quantity).toBe(800);
    expect(result.data.holding.availableQuantity).toBe(700);
  });

  it('空更新（无任何字段）→ invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await updateHoldingTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('合并后 availableQuantity > quantity → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await updateHoldingTool.execute(
      { holdingId: 'test-holding-002594', quantity: 100 },
      ctx,
    );
    // fixtures available=1000 > 新 quantity=100
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('持仓不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const result = await updateHoldingTool.execute({ holdingId: 'no-such', avgCost: 1 }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Holding', id: 'no-such' },
    });
  });
});
