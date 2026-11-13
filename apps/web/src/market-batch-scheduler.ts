import { isAshareTradingSession, type ToolContext, type ToolResult } from '@luoome/core';
import { type CollectMarketSnapshotOutputT, collectMarketSnapshotTool } from '@luoome/tools';

export const MARKET_BATCH_SCHEDULER_INTERVAL_MS = 60_000;

/** 盘中批次采集只在连续竞价时段运行。 */
export const isMarketBatchSession = isAshareTradingSession;

export interface MarketBatchSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartMarketBatchSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  /**
   * 外部访问的显式 opt-in：只有同时开启 write 与 external 才启动定时采集。
   * 未开启时返回空 handle，不注册定时器、不访问外部行情。
   */
  readonly enabled?: boolean;
  readonly collect?: () => Promise<ToolResult<CollectMarketSnapshotOutputT>>;
}

/**
 * Web 进程内的盘中全市场批次采集调度：每个 tick 在交易时段采集一次。
 * 同一采样时点的重复 tick 由 `collect_market_snapshot` 按批次去重，不产生第二份发布。
 */
export const startMarketBatchScheduler = (
  ctx: ToolContext,
  options: StartMarketBatchSchedulerOptions = {},
): MarketBatchSchedulerHandle => {
  if (options.enabled !== true) {
    return { tick: async () => {}, stop: () => {} };
  }
  const intervalMs = options.intervalMs ?? MARKET_BATCH_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`盘中批次调度间隔必须为正数: ${intervalMs}`);
  }
  const collect = options.collect ?? (() => collectMarketSnapshotTool.execute({}, ctx));
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running || !isMarketBatchSession(ctx.clock())) return;
    running = true;
    try {
      const result = await collect();
      if (!result.ok) {
        ctx.logger.error('盘中批次采集失败', { error: result.error });
      }
    } catch (error) {
      ctx.logger.error('盘中批次采集异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  if (options.startImmediately !== false) void tick();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
