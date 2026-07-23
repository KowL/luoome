import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { addTradeTool } from './add-trade.js';
import { listTradesTool } from './list-trades.js';

describe('list_trades', () => {
  it('按当前账户和股票筛选，按成交时间倒序返回并保留总数', async () => {
    const clock = () => new Date('2026-07-23T10:00:00.000Z');
    const ctx = await buildTestContext({ clock });
    const added = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 100,
        price: 106,
        executedAt: new Date('2026-07-23T02:00:00.000Z'),
      },
      ctx,
    );
    expect(added.ok).toBe(true);

    const result = await listTradesTool.execute(
      { stockId: '002594.SZ', since: new Date('2026-01-01T00:00:00.000Z'), limit: 2 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBeGreaterThanOrEqual(2);
    expect(result.data.trades).toHaveLength(2);
    expect(result.data.trades.every((trade) => trade.stockId === '002594.SZ')).toBe(true);
    expect(result.data.trades[0]?.executedAt.getTime()).toBeGreaterThanOrEqual(
      result.data.trades[1]?.executedAt.getTime() ?? 0,
    );
  });

  it('until 与 side 过滤在 limit 前生效', async () => {
    const ctx = await buildTestContext();
    const result = await listTradesTool.execute(
      {
        side: 'buy',
        until: new Date('2026-07-01T00:00:00.000Z'),
        limit: 1,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.trades).toHaveLength(1);
    expect(result.data.trades[0]?.side).toBe('buy');
    expect(result.data.total).toBeGreaterThanOrEqual(1);
  });
});
