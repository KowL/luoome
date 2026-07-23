import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getHoldingTool } from './get-holding.js';

describe('get_holding', () => {
  it('正常路径：返回持仓 + 现价盈亏', async () => {
    const ctx = await buildTestContext();
    const result = await getHoldingTool.execute({ holdingId: 'test-holding-002594' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holding.id).toBe('test-holding-002594');
    expect(result.data.holding.stockId).toBe('002594.SZ');
    expect(result.data.stockName).toBe('比亚迪');
    expect(result.data.currentPrice).toBe(105.8);
    expect(result.data.marketValue).toBe(105800);
    expect(result.data.cost).toBe(98500);
    expect(result.data.pnl).toBe(7300);
    expect(result.data.pnlPct).toBeCloseTo(7300 / 98500, 6);
  });

  it('错误路径：持仓不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const result = await getHoldingTool.execute({ holdingId: 'no-such-holding' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Holding', id: 'no-such-holding' },
    });
  });

  it('错误路径：缺 holdingId → invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await getHoldingTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
