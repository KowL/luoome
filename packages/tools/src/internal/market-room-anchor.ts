import {
  dateInShanghai,
  type LimitUpLadder,
  ladderOfSample,
  type MarketSnapshotBatch,
  marketRoomEmptyReason,
  type SectorRankingEmptyReason,
  type SectorWindowKey,
  sectorWindowTarget,
  type ToolContext,
} from '@luoome/core';

/**
 * 作战室工具的共用取数口径与常量（总览 / 板块榜 / 成交分布 / 核心股 / 板块详情 / 事件）。
 *
 * 锚点、窗口起点与天梯函数只读本地已发布事实，不触发采集；四个视图共用同一口径，
 * 避免各 tool 各写一套取数逻辑后产生「同一时点、不同结果」。
 */

/** 作战室只处理沪深全市场批次（与盘中采集同一 coverage）。 */
export const MARKET_ROOM_COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

/** 天梯事实来源与 `limit_up_ladder` tool 的默认源一致。 */
export const MARKET_ROOM_LIMIT_UP_SOURCE = 'eastmoney';

export type MarketRoomAnchor =
  | {
      readonly kind: 'empty';
      readonly reason: SectorRankingEmptyReason;
      readonly latest: MarketSnapshotBatch | null;
    }
  | { readonly kind: 'ready'; readonly anchor: MarketSnapshotBatch };

/**
 * 锚点批次：缺省读最近一批，并按总览的空态口径判定（非交易日 / 盘前 / 当日无批次都不拿旧批次
 * 当当日盘面）；给定 `at` 时取该时点及之前最近的批次。
 */
export const resolveMarketRoomAnchor = async (
  ctx: ToolContext,
  at: Date | undefined,
): Promise<MarketRoomAnchor> => {
  if (at === undefined) {
    const latest = await ctx.repos.marketSnapshotBatch.findLatest({
      coverage: MARKET_ROOM_COVERAGE,
    });
    if (latest === null) return { kind: 'empty', reason: 'no_batch', latest: null };
    const reason = marketRoomEmptyReason(ctx.clock(), latest);
    if (reason !== null) return { kind: 'empty', reason, latest };
    return { kind: 'ready', anchor: latest };
  }
  const anchor = await ctx.repos.marketSnapshotBatch.findAtOrBefore({
    coverage: MARKET_ROOM_COVERAGE,
    tradingDate: dateInShanghai(at),
    sampledAt: at,
  });
  if (anchor === null) return { kind: 'empty', reason: 'no_batch', latest: null };
  return { kind: 'ready', anchor };
};

const readWindowStart = (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
  target: Date,
): Promise<MarketSnapshotBatch | null> =>
  ctx.repos.marketSnapshotBatch.findAtOrBefore({
    coverage: MARKET_ROOM_COVERAGE,
    tradingDate: anchor.tradingDate,
    sampledAt: target,
  });

/** 各窗口起点批次（锚点 − 窗口分钟）；缺批次返回 null，不拿更早批次冒充。 */
export const resolveMarketRoomWindowStarts = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
): Promise<Record<SectorWindowKey, MarketSnapshotBatch | null>> => ({
  w5: await readWindowStart(ctx, anchor, sectorWindowTarget(anchor.sampledAt, 'w5')),
  w15: await readWindowStart(ctx, anchor, sectorWindowTarget(anchor.sampledAt, 'w15')),
});

/** 当前窗口起点 = 锚点 − 窗口分钟；上一窗口起点再往前一个窗口。 */
export const resolveMarketRoomWindowChain = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
  window: SectorWindowKey,
): Promise<{
  readonly currentStart: MarketSnapshotBatch | null;
  readonly previousStart: MarketSnapshotBatch | null;
}> => {
  const currentTarget = sectorWindowTarget(anchor.sampledAt, window);
  return {
    currentStart: await readWindowStart(ctx, anchor, currentTarget),
    previousStart: await readWindowStart(ctx, anchor, sectorWindowTarget(currentTarget, window)),
  };
};

/**
 * 已加载批次里的窗口起点：回放只使用给定样本（该时点及之前已发布的批次），不再查库。
 * 调用方保证 `batches` 已按采样时点升序。
 */
export const marketRoomWindowStartsFromBatches = (
  batches: readonly MarketSnapshotBatch[],
  anchor: MarketSnapshotBatch,
): Record<SectorWindowKey, MarketSnapshotBatch | null> => {
  const find = (key: SectorWindowKey): MarketSnapshotBatch | null => {
    const target = sectorWindowTarget(anchor.sampledAt, key);
    return (
      [...batches].reverse().find((batch) => batch.sampledAt.getTime() <= target.getTime()) ?? null
    );
  };
  return { w5: find('w5'), w15: find('w15') };
};

/**
 * 天梯事实：最新模式沿用当日快照；回放只用锚点批次时点及之前的天梯样本，
 * 不拿之后才采集的那一份冒充当时状态。
 */
export const readMarketRoomLimitUp = async (
  ctx: ToolContext,
  anchor: MarketSnapshotBatch,
  asOf: Date | undefined,
): Promise<{ readonly ladder: LimitUpLadder | null; readonly error: string | null }> => {
  try {
    if (asOf === undefined) {
      const ladder = await ctx.repos.limitUpLadderSnapshot.findByDate({
        date: anchor.tradingDate,
        source: MARKET_ROOM_LIMIT_UP_SOURCE,
      });
      return { ladder, error: null };
    }
    const sample = await ctx.repos.limitUpLadderSample.findAtOrBefore({
      tradingDate: anchor.tradingDate,
      source: MARKET_ROOM_LIMIT_UP_SOURCE,
      sampledAt: anchor.sampledAt,
    });
    const aligned =
      sample !== null && sample.sampledAt.getTime() === anchor.sampledAt.getTime()
        ? ladderOfSample(sample)
        : null;
    return { ladder: aligned, error: null };
  } catch (error) {
    return { ladder: null, error: error instanceof Error ? error.message : String(error) };
  }
};
