import { z } from 'zod';

import { defineOperation } from './define-workflow.js';

/**
 * 全市场 dump 同步 workflow。
 *
 * 日常增量走 `kind=auto`（最近 10 个交易日日 K + 全量复权因子）；
 * 首次建库或需要重建 10 年历史时用 `kind=daily-k` 全量拉一次。
 */
export const SyncMarketDumpInput = z.object({
  kind: z.enum(['auto', 'daily-k', 'daily-k-10d', 'adjustment-factors']).default('auto'),
});

export type SyncMarketDumpInputT = z.infer<typeof SyncMarketDumpInput>;

export const SyncMarketDumpOutput = z.object({
  kinds: z.array(z.enum(['daily-k', 'daily-k-10d', 'adjustment-factors'])),
  artifacts: z.array(
    z.object({
      kind: z.enum(['daily-k', 'daily-k-10d', 'adjustment-factors']),
      dumpId: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      bars: z.number().int().nonnegative(),
      factors: z.number().int().nonnegative(),
    }),
  ),
  bars: z.number().int().nonnegative(),
  factors: z.number().int().nonnegative(),
  warnings: z.array(z.string().min(1).max(300)).max(8),
});

export type SyncMarketDumpOutputT = z.infer<typeof SyncMarketDumpOutput>;

export const syncMarketDumpOperation = defineOperation<SyncMarketDumpInputT, SyncMarketDumpOutputT>(
  {
    name: 'sync-market-dump',
    description: '用 fuyao 全市场 Parquet dump 同步原始日线与复权因子',
    input: SyncMarketDumpInput,
    steps: [
      (prev, ctx) => {
        const input = prev as SyncMarketDumpInputT;
        return ctx.tools.sync_market_dump.execute({ kind: input.kind });
      },
    ],
  },
);
