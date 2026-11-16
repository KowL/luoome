import { MarketSnapshotBatchSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

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
