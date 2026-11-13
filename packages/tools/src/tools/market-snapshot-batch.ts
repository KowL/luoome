import {
  buildLimitUpLadderSample,
  buildMarketSnapshotBatch,
  isAshareTradingSession,
  LimitUpLadderQuerySchema,
  type MarketSnapshot,
  MarketSnapshotBatchSchema,
  marketSnapshotBatchId,
  marketSnapshotBatchSampledAt,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';
import { scanMarketRoomEvents } from './market-room-events.js';

/**
 * 盘中全市场批次（ticket #35）。
 *
 * - `collect_market_snapshot` 一次采集发布一个不可变批次；同采样时点重试复用已发布内容，
 *   不重复采集、不产生第二份；
 * - 采集失败按既有 `adapter_error` 返回，不写空批次、不把失败写成零值；
 * - 发布新批次后，在交易时段内顺带刷新当日连板天梯快照，并按批次采样时点保存一份
 *   天梯事实（ticket #41，开板 / 换位时间线的数据基础）；天梯或样本写入失败只进 warnings，
 *   不回滚已发布批次，也不把失败吞成成功；
 * - 批次发布后扫描当日最近样本，幂等写入扩散 / 分化 / 换位事件（ticket #42）；
 *   扫描失败同样只进 warnings；
 * - `get_market_snapshot_batch` 只读最近已发布批次，刷新与跨页读取不触发采集。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

/**
 * 当日连板天梯快照是 #38 板块封板数的数据来源；盘中只在交易时段写入，
 * 同一天同一来源按既有主键（date+source）覆盖为最新。同时按批次采样时点另存一份
 * 不可变天梯事实，供 #41 还原开板 / 换位时间线（失败只提示，不影响批次）。
 */
const refreshLimitUpLadder = async (
  ctx: ToolContext,
  tradingDate: string,
  sampledAt: Date,
): Promise<readonly string[]> => {
  if (!isAshareTradingSession(ctx.clock())) return [];
  const manager = ctx.adapters.marketIntel?.limitUpLadder;
  if (manager === undefined) {
    return ['limit_up_ladder_unavailable: 连板天梯 manager 未配置，当日封板数可能缺失'];
  }
  try {
    const result = await manager.fetchLadder(LimitUpLadderQuerySchema.parse({ date: tradingDate }));
    if (!result.ok || result.data === undefined) {
      const cause = result.error?.message ?? 'unknown error';
      return [`limit_up_ladder_refresh_failed: ${cause}`];
    }
    await ctx.repos.limitUpLadderSnapshot.save(result.data);
    try {
      await ctx.repos.limitUpLadderSample.save(
        buildLimitUpLadderSample({ ladder: result.data, sampledAt }),
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return [`limit_up_ladder_sample_failed: ${cause}`];
    }
    return [];
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return [`limit_up_ladder_refresh_failed: ${cause}`];
  }
};

export const CollectMarketSnapshotInput = z.object({});

export const CollectMarketSnapshotOutput = z.object({
  /** true 表示本次请求发布了新批次；false 表示同批次重试复用了已发布内容。 */
  created: z.boolean(),
  batch: MarketSnapshotBatchSchema,
  /** 批次已发布但附属动作未完成时的显式提示（如天梯刷新失败）；不改变批次有效性。 */
  warnings: z.array(z.string()),
});
export type CollectMarketSnapshotOutputT = z.infer<typeof CollectMarketSnapshotOutput>;

export const collectMarketSnapshotTool = defineTool({
  name: 'collect_market_snapshot',
  description:
    '采集一次沪深全市场盘中快照并发布为不可变批次（来源、行情时间、抓取时间、覆盖与缺口）；交易时段内同步刷新当日连板天梯快照，天梯失败只带 warning；同一批次重试复用已发布结果',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: CollectMarketSnapshotInput,
  output: CollectMarketSnapshotOutput,
  handler: async (_input, ctx) => {
    const sampledAt = marketSnapshotBatchSampledAt(ctx.clock());
    const batchId = marketSnapshotBatchId({ coverage: COVERAGE, sampledAt });
    const existing = await ctx.repos.marketSnapshotBatch.findById(batchId);
    if (existing !== null) return { created: false, batch: existing, warnings: [] };

    const market = ctx.adapters.market;
    if (market.fetchMarketSnapshotEnvelope === undefined) {
      return errAdapterError(
        'market-snapshot',
        'unsupported_capability: market-snapshot-envelope',
        false,
      );
    }
    let snapshot: MarketSnapshot;
    try {
      snapshot = await market.fetchMarketSnapshotEnvelope({ allowPartial: true });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return errAdapterError('market-snapshot', cause, true);
    }
    if (snapshot.coverage !== COVERAGE) {
      return errAdapterError(
        'market-snapshot',
        `coverage_mismatch: 上游返回 ${snapshot.coverage}`,
        false,
      );
    }
    if (snapshot.items.length === 0) {
      return errAdapterError('market-snapshot', 'no_data: 空快照不发布批次', true);
    }
    const published = await ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({ snapshot, sampledAt }),
    );
    const warnings = await refreshLimitUpLadder(
      ctx,
      published.batch.tradingDate,
      published.batch.sampledAt,
    );
    // 事件扫描在批次发布之后：失败只进 warnings，不回滚批次、不阻塞采集。
    const eventWarnings = await scanMarketRoomEvents(ctx, published.batch.tradingDate);
    return {
      created: published.created,
      batch: published.batch,
      warnings: [...warnings, ...eventWarnings],
    };
  },
});

export const GetMarketSnapshotBatchInput = z.object({});

export const GetMarketSnapshotBatchOutput = z.object({
  batch: MarketSnapshotBatchSchema.nullable(),
});

export const getMarketSnapshotBatchTool = defineTool({
  name: 'get_market_snapshot_batch',
  description: '读取最近一个已发布的沪深全市场盘中批次；只读，不触发采集',
  sideEffect: 'read',
  input: GetMarketSnapshotBatchInput,
  output: GetMarketSnapshotBatchOutput,
  handler: async (_input, ctx) => ({
    batch: await ctx.repos.marketSnapshotBatch.findLatest({ coverage: COVERAGE }),
  }),
});
