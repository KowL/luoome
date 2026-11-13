import {
  buildMarketSnapshotBatch,
  type MarketSnapshot,
  MarketSnapshotBatchSchema,
  marketSnapshotBatchId,
  marketSnapshotBatchSampledAt,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

/**
 * 盘中全市场批次（ticket #35）。
 *
 * - `collect_market_snapshot` 一次采集发布一个不可变批次；同采样时点重试复用已发布内容，
 *   不重复采集、不产生第二份；
 * - 采集失败按既有 `adapter_error` 返回，不写空批次、不把失败写成零值；
 * - `get_market_snapshot_batch` 只读最近已发布批次，刷新与跨页读取不触发采集。
 */

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

export const CollectMarketSnapshotInput = z.object({});

export const CollectMarketSnapshotOutput = z.object({
  /** true 表示本次请求发布了新批次；false 表示同批次重试复用了已发布内容。 */
  created: z.boolean(),
  batch: MarketSnapshotBatchSchema,
});
export type CollectMarketSnapshotOutputT = z.infer<typeof CollectMarketSnapshotOutput>;

export const collectMarketSnapshotTool = defineTool({
  name: 'collect_market_snapshot',
  description:
    '采集一次沪深全市场盘中快照并发布为不可变批次（来源、行情时间、抓取时间、覆盖与缺口）；同一批次重试复用已发布结果',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: CollectMarketSnapshotInput,
  output: CollectMarketSnapshotOutput,
  handler: async (_input, ctx) => {
    const sampledAt = marketSnapshotBatchSampledAt(ctx.clock());
    const batchId = marketSnapshotBatchId({ coverage: COVERAGE, sampledAt });
    const existing = await ctx.repos.marketSnapshotBatch.findById(batchId);
    if (existing !== null) return { created: false, batch: existing };

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
    return { created: published.created, batch: published.batch };
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
