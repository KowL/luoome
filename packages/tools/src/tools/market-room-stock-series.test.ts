import { MARKET_DAY_POINTS, marketDayItems } from '@luoome/adapters/testing';
import { buildMarketSnapshotBatch, type MarketSnapshotItem, type ToolContext } from '@luoome/core';
import {
  type GetMarketRoomStockSeriesInputT,
  getMarketRoomStockSeriesTool,
} from '@luoome/toolkit/tools/market-room-stock-series.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('10:17');
const STOCK_ID = marketDayItems(0)[0]?.id as string;

const batchOf = (time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: at(time),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'market-day-fixture',
      fetchedAt: at(time),
      items: [...items],
      completeness: {
        expectedCount: items.length,
        receivedCount: items.length,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    },
  });

const execute = async (ctx: ToolContext, input: GetMarketRoomStockSeriesInputT) => {
  const result = await getMarketRoomStockSeriesTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.series;
};

describe('get_market_room_stock_series', () => {
  it('没有已发布批次时返回 no_batch 空态，不触发采集', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    const series = await execute(ctx, { stockId: STOCK_ID });
    expect(series.state).toBe('empty');
    expect(series.emptyReason).toBe('no_batch');
    expect(series.points).toEqual([]);
    expect(series.anchor).toBeNull();
  });

  it('只取 anchor 及之前批次，缺口断线与负修正按缺失说明', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedTestStockUniverse(ctx);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:12', marketDayItems(1)));
    // 10:13 的累计成交额向下修正：差分缺失，不补 0。
    const corrected = marketDayItems(1).map((item) =>
      item.id === STOCK_ID && item.amount !== undefined
        ? { ...item, amount: item.amount * 0.5 }
        : item,
    );
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:13', corrected));
    // 10:14 缺批次：10:15 断线，不插值。
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:16', marketDayItems(3)));

    const series = await execute(ctx, { stockId: STOCK_ID, at: at('10:15') });
    expect(series.state).toBe('ready');
    expect(series.anchor?.sampledAt).toEqual(at('10:15'));
    expect(series.name).toBe('贵州茅台');
    expect(series.nameSource).toBe('stock_universe');
    expect(series.points.map((point) => point.close)).toEqual(
      [1, 1, 2].flatMap((index) => {
        const close = marketDayItems(index).find((item) => item.id === STOCK_ID)?.close;
        return close === undefined ? [] : [close];
      }),
    );
    expect(series.points[0]?.amountDelta).toBeNull();
    expect(series.points[0]?.amountReason).toContain('first_point');
    expect(series.points[1]?.amountDelta).toBeNull();
    expect(series.points[1]?.amountReason).toContain('negative_correction');
    expect(series.points[2]?.gapBefore).toBe(true);
    expect(series.points[2]?.amountDelta).toBeNull();
    expect(series.points[2]?.amountReason).toContain('gap_before');
    expect(series.coverage).toMatchObject({
      batchCount: 3,
      pointCount: 3,
      gapCount: 1,
      negativeCorrectionCount: 1,
    });
  });

  it('最新模式跟随最近批次，回放不读取之后的数据', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedTestStockUniverse(ctx);
    for (const [index, point] of MARKET_DAY_POINTS.entries()) {
      if (index > 2) break;
      const shanghai = new Date(point.at.getTime() + 8 * 60 * 60 * 1000);
      const time = `${String(shanghai.getUTCHours()).padStart(2, '0')}:${String(
        shanghai.getUTCMinutes(),
      ).padStart(2, '0')}`;
      await ctx.repos.marketSnapshotBatch.publish(batchOf(time, marketDayItems(index)));
    }

    const latest = await execute(ctx, { stockId: STOCK_ID });
    expect(latest.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[2]?.at);
    expect(latest.points).toHaveLength(3);

    const replay = await execute(ctx, { stockId: STOCK_ID, at: MARKET_DAY_POINTS[1]?.at });
    expect(replay.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[1]?.at);
    expect(replay.points).toHaveLength(2);
  });

  it('参数校验走既有 invalid_input 协议', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    const emptyId = await getMarketRoomStockSeriesTool.execute({ stockId: '   ' }, ctx);
    expect(emptyId.ok).toBe(false);
    expect(emptyId.ok ? null : emptyId.error.kind).toBe('invalid_input');

    const badAt = await getMarketRoomStockSeriesTool.execute(
      { stockId: STOCK_ID, at: 'not-a-date' },
      ctx,
    );
    expect(badAt.ok).toBe(false);
    expect(badAt.ok ? null : badAt.error.kind).toBe('invalid_input');
  });
});
