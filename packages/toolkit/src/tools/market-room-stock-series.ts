import {
  buildStockIntradaySeries,
  buildStockIntradaySeriesEmpty,
  StockIntradaySeriesSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  readMarketRoomStockUniverse,
  resolveMarketRoomAnchor,
} from '../internal/market-room-anchor.js';

/**
 * 作战室股票弹窗的 1 分钟价格与成交额序列。
 *
 * - 只读本地已发布 market_snapshot_batches，不请求另一个实时行情源；
 * - 最新模式跟随当前锚点批次；给定 at 时截断到该时点，不用之后的数据污染回放；
 * - 缺口断线不插值；成交额差分为负修正或缺字段时按缺失说明，不补 0；
 * - 中文名只取 stockUniverse。
 */

export const GetMarketRoomStockSeriesInput = z.object({
  stockId: z.string().trim().min(1),
  /** 与主流题材响应同一 anchor 的采样时点；缺省取当前最近批次。 */
  at: z.coerce.date().optional(),
});
export type GetMarketRoomStockSeriesInputT = z.infer<typeof GetMarketRoomStockSeriesInput>;

export const GetMarketRoomStockSeriesOutput = z.object({
  series: StockIntradaySeriesSchema,
});
export type GetMarketRoomStockSeriesOutputT = z.infer<typeof GetMarketRoomStockSeriesOutput>;

export const getMarketRoomStockSeriesTool = defineTool({
  name: 'get_market_room_stock_series',
  description:
    '读取作战室股票弹窗的当日 1 分钟价格与成交额序列：只从本地已发布 market_snapshot_batches 提取该股票的 close 与累计 amount 差分，不请求另一个实时行情源；最新模式跟随当前锚点批次，给定 at 时只返回截至该时点的数据；缺口断线不插值，成交额差分无效或负修正按缺失说明，不补 0；中文名只取 stockUniverse；只读不采集',
  sideEffect: 'read',
  input: GetMarketRoomStockSeriesInput,
  output: GetMarketRoomStockSeriesOutput,
  handler: async (input, ctx): Promise<GetMarketRoomStockSeriesOutputT> => {
    const anchorResult = await resolveMarketRoomAnchor(ctx, input.at);
    const universe = await readMarketRoomStockUniverse(ctx, input.at);
    const name = universe.find((entry) => entry.stockId === input.stockId)?.name ?? null;
    if (anchorResult.kind === 'empty') {
      return {
        series: buildStockIntradaySeriesEmpty({
          stockId: input.stockId,
          reason: anchorResult.reason,
          latest: anchorResult.latest,
          name,
        }),
      };
    }
    const { anchor } = anchorResult;
    const batches = await ctx.repos.marketSnapshotBatch.listByTradingDate({
      coverage: 'CN_A_SHARES_SH_SZ',
      tradingDate: anchor.tradingDate,
    });
    return {
      series: buildStockIntradaySeries({
        stockId: input.stockId,
        anchor,
        batches,
        name,
      }),
    };
  },
});
