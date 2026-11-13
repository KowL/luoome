import {
  type AShareSentimentSnapshot,
  buildMarketRoomEmptyOverview,
  buildMarketRoomOverview,
  type IndexQuote,
  MARKET_ROOM_COMPARE_TOLERANCE_MS,
  MarketRoomOverviewSchema,
  marketRoomCompareTarget,
  marketRoomEmptyReason,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 作战室总览（ticket #36）：只读最近一个已发布批次，按维度组合既有事实。
 *
 * - 只读：读取不发布批次，刷新页面不产生新采集；
 * - 宽度 / 中位数 / 量能由 core 从批次 items 派生，昨日同时点对比按容差查上一交易日批次；
 * - 封板 / 炸板 / 最高连板复用既有 A 股情绪契约，不在此重算；
 * - 每个维度独立降级：任一维度失败只影响该维度，不整体报错、不写 0。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

export const GetMarketRoomOverviewInput = z.object({});

export const GetMarketRoomOverviewOutput = z.object({
  overview: MarketRoomOverviewSchema,
});
export type GetMarketRoomOverviewOutputT = z.infer<typeof GetMarketRoomOverviewOutput>;

export const getMarketRoomOverviewTool = defineTool({
  name: 'get_market_room_overview',
  description:
    '读取最近已发布沪深全市场批次的作战室总览：覆盖与更新时间、指数对照、涨跌平与个股涨幅中位数、累计成交额与昨日同时点对比、封板/炸板/最高连板；各维度独立标注完整性与缺失原因，只读不采集',
  sideEffect: 'external',
  requiredCapabilities: ['external'],
  input: GetMarketRoomOverviewInput,
  output: GetMarketRoomOverviewOutput,
  handler: async (_input, ctx) => {
    const now = ctx.clock();
    const latest = await ctx.repos.marketSnapshotBatch.findLatest({ coverage: COVERAGE });
    if (latest === null) {
      return { overview: buildMarketRoomEmptyOverview({ now, latest: null, reason: 'no_batch' }) };
    }
    const emptyReason = marketRoomEmptyReason(now, latest);
    if (emptyReason !== null) {
      return { overview: buildMarketRoomEmptyOverview({ now, latest, reason: emptyReason }) };
    }

    const target = marketRoomCompareTarget(latest.sampledAt);
    const previous = await ctx.repos.marketSnapshotBatch.findNearestAt({
      coverage: COVERAGE,
      tradingDate: target.tradingDate,
      sampledAt: target.sampledAt,
      toleranceMs: MARKET_ROOM_COMPARE_TOLERANCE_MS,
    });
    const quotes = await readIndexQuotes(ctx);
    const limitUp = await readLimitUp(ctx, latest.tradingDate);
    return {
      overview: buildMarketRoomOverview({
        now,
        latest,
        previous,
        indexQuotes: quotes.quotes,
        indexError: quotes.error,
        limitUp: limitUp.dimension,
        limitUpError: limitUp.error,
      }),
    };
  },
});

const readIndexQuotes = async (
  ctx: ToolContext,
): Promise<{ readonly quotes: readonly IndexQuote[] | null; readonly error: string | null }> => {
  try {
    return { quotes: await ctx.adapters.market.fetchIndexQuotes(), error: null };
  } catch (error) {
    return { quotes: null, error: error instanceof Error ? error.message : String(error) };
  }
};

const readLimitUp = async (
  ctx: ToolContext,
  date: string,
): Promise<{
  readonly dimension: AShareSentimentSnapshot['limitUp'] | null;
  readonly error: string | null;
}> => {
  const manager = ctx.adapters.marketIntel?.ashareSentiment;
  if (manager === undefined) {
    return { dimension: null, error: 'A 股情绪 manager 未注入' };
  }
  try {
    const result = await manager.fetch({ date, coverage: COVERAGE });
    if (!result.ok) return { dimension: null, error: result.error.message };
    return { dimension: result.data.limitUp, error: null };
  } catch (error) {
    return { dimension: null, error: error instanceof Error ? error.message : String(error) };
  }
};
