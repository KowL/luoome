import { money } from '@luoome/core';
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

  it('游标固定筛选与事实快照，成交变化后要求刷新', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-09-01T00:00:00Z') });
    const first = await listTradesTool.execute({ stockId: '002594.SZ', limit: 1 }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok || first.data.nextCursor === null) return;
    const second = await listTradesTool.execute(
      {
        stockId: '002594.SZ',
        limit: 1,
        cursor: first.data.nextCursor,
        asOf: first.data.asOf,
      },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.trades[0]?.id).not.toBe(first.data.trades[0]?.id);
    const wrongFilter = await listTradesTool.execute(
      {
        stockId: '600519.SH',
        limit: 1,
        cursor: first.data.nextCursor,
      },
      ctx,
    );
    expect(wrongFilter).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    const trade = first.data.trades[0];
    if (!trade) throw new Error('trade fixture missing');
    const { adviceId, researchHypothesisVersionId, strategyVersionId, ...baseTrade } = trade;
    await ctx.repos.trade.save({
      ...baseTrade,
      ...(adviceId ? { adviceId } : {}),
      ...(researchHypothesisVersionId ? { researchHypothesisVersionId } : {}),
      ...(strategyVersionId ? { strategyVersionId } : {}),
      price: money(trade.price + 1),
    });
    const changed = await listTradesTool.execute(
      {
        stockId: '002594.SZ',
        limit: 1,
        cursor: first.data.nextCursor,
      },
      ctx,
    );
    expect(changed).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
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
