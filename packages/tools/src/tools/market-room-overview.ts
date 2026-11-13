import {
  type AShareSentimentSnapshot,
  buildMarketRoomEmptyOverview,
  buildMarketRoomOverview,
  buildMarketRoomReplayOverview,
  dateInShanghai,
  type IndexQuote,
  type LimitUpLadderSample,
  MARKET_ROOM_COMPARE_TOLERANCE_MS,
  MarketRoomOverviewSchema,
  type MarketSnapshotBatch,
  marketRoomCompareTarget,
  marketRoomEmptyReason,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  MARKET_ROOM_COVERAGE,
  MARKET_ROOM_LIMIT_UP_SOURCE,
} from '../internal/market-room-anchor.js';

/**
 * 作战室总览（ticket #36）：只读最近一个已发布批次，按维度组合既有事实。
 *
 * - 只读：读取不发布批次，刷新页面不产生新采集；
 * - 宽度 / 中位数 / 量能由 core 从批次 items 派生，昨日同时点对比按容差查上一交易日批次；
 * - 封板 / 炸板 / 最高连板复用既有 A 股情绪契约，不在此重算；
 * - 每个维度独立降级：任一维度失败只影响该维度，不整体报错、不写 0。
 */

export const GetMarketRoomOverviewInput = z.object({
  /** 回放时点：给定则只读该时点及之前最近的已发布批次，缺省读最近批次。 */
  at: z.coerce.date().optional(),
});

export const GetMarketRoomOverviewOutput = z.object({
  overview: MarketRoomOverviewSchema,
});
export type GetMarketRoomOverviewOutputT = z.infer<typeof GetMarketRoomOverviewOutput>;

export const getMarketRoomOverviewTool = defineTool({
  name: 'get_market_room_overview',
  description:
    '读取沪深全市场已发布批次的作战室总览：覆盖与更新时间、指数对照、涨跌平与个股涨幅中位数、累计成交额与昨日同时点对比、封板/炸板/最高连板；给定 at 时取该时点及之前最近的已发布批次，只返回当时已知的内容（回放不读实时指数与情绪，指数与炸板数没有历史快照时标注缺失、不补零）；各维度独立标注完整性与缺失原因，只读不采集',
  sideEffect: 'external',
  requiredCapabilities: ['external'],
  input: GetMarketRoomOverviewInput,
  output: GetMarketRoomOverviewOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    if (input.at !== undefined) return replayOverview(input.at, ctx);
    const latest = await ctx.repos.marketSnapshotBatch.findLatest({
      coverage: MARKET_ROOM_COVERAGE,
    });
    if (latest === null) {
      return { overview: buildMarketRoomEmptyOverview({ now, latest: null, reason: 'no_batch' }) };
    }
    const emptyReason = marketRoomEmptyReason(now, latest);
    if (emptyReason !== null) {
      return { overview: buildMarketRoomEmptyOverview({ now, latest, reason: emptyReason }) };
    }

    const target = marketRoomCompareTarget(latest.sampledAt);
    const previous = await ctx.repos.marketSnapshotBatch.findNearestAt({
      coverage: MARKET_ROOM_COVERAGE,
      tradingDate: target.tradingDate,
      sampledAt: target.sampledAt,
      toleranceMs: MARKET_ROOM_COMPARE_TOLERANCE_MS,
    });
    const quotes = await readIndexQuotes(ctx);
    const limitUp = await readSentimentLimitUp(ctx, latest.tradingDate);
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

/**
 * 回放：行情只用该时点及之前最近的已发布批次，昨日同时点对比也只用当时已发布的批次；
 * 不读实时指数与情绪，避免把之后才知道的信息带回更早时点。
 */
const replayOverview = async (at: Date, ctx: ToolContext) => {
  const anchor = await ctx.repos.marketSnapshotBatch.findAtOrBefore({
    coverage: MARKET_ROOM_COVERAGE,
    tradingDate: dateInShanghai(at),
    sampledAt: at,
  });
  if (anchor === null) {
    return {
      overview: buildMarketRoomEmptyOverview({
        now: ctx.clock(),
        latest: null,
        reason: 'no_batch',
        asOf: at,
      }),
    };
  }
  const target = marketRoomCompareTarget(anchor.sampledAt);
  const previous = await ctx.repos.marketSnapshotBatch.findNearestAt({
    coverage: MARKET_ROOM_COVERAGE,
    tradingDate: target.tradingDate,
    sampledAt: target.sampledAt,
    toleranceMs: MARKET_ROOM_COMPARE_TOLERANCE_MS,
  });
  const limitUpSample = await readLadderSampleAt(ctx, anchor);
  return {
    overview: buildMarketRoomReplayOverview({
      asOf: at,
      anchor,
      previous,
      limitUpSample,
    }),
  };
};

/** 只用与锚点批次同一采样时点的天梯样本；时间不对齐时按缺失返回，不拿更早样本冒充。 */
const readLadderSampleAt = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
): Promise<LimitUpLadderSample | null> => {
  try {
    const sample = await ctx.repos.limitUpLadderSample.findAtOrBefore({
      tradingDate: anchor.tradingDate,
      source: MARKET_ROOM_LIMIT_UP_SOURCE,
      sampledAt: anchor.sampledAt,
    });
    return sample !== null && sample.sampledAt.getTime() === anchor.sampledAt.getTime()
      ? sample
      : null;
  } catch {
    return null;
  }
};

const readIndexQuotes = async (
  ctx: ToolContext,
): Promise<{ readonly quotes: readonly IndexQuote[] | null; readonly error: string | null }> => {
  try {
    return { quotes: await ctx.adapters.market.fetchIndexQuotes(), error: null };
  } catch (error) {
    return { quotes: null, error: error instanceof Error ? error.message : String(error) };
  }
};

const readSentimentLimitUp = async (
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
    const result = await manager.fetch({ date, coverage: MARKET_ROOM_COVERAGE });
    if (!result.ok) return { dimension: null, error: result.error.message };
    return { dimension: result.data.limitUp, error: null };
  } catch (error) {
    return { dimension: null, error: error instanceof Error ? error.message : String(error) };
  }
};
