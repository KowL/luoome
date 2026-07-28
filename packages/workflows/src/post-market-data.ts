import { dateInShanghai, isHoliday, isWeekend } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

export const PostMarketDataInput = z.object({
  forceUniverse: z.boolean().default(false),
  correctionWindowDays: z.number().int().min(5).max(60).default(15),
});

export interface PostMarketDataOutput {
  readonly status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  readonly tradingDate: string;
  readonly universe: Record<string, unknown> & { readonly status: string };
  readonly dailyBars: Record<string, unknown> & { readonly status: string };
  readonly universeStatus: Record<string, unknown> & { readonly status: string };
}

const failed = (error: unknown): { status: 'failed'; error: unknown } => ({
  status: 'failed',
  error,
});

export const postMarketDataWorkflow = defineWorkflow<
  z.output<typeof PostMarketDataInput>,
  PostMarketDataOutput
>({
  name: 'post-market-data',
  description: '交易日盘后同步股票目录、相关股票前复权日线并汇总数据健康状态',
  input: PostMarketDataInput,
  steps: [
    async (prev, ctx) => {
      const input = prev as z.output<typeof PostMarketDataInput>;
      const now = ctx.clock();
      const tradingDate = dateInShanghai(now);
      if (isWeekend(now) || isHoliday(now)) {
        return {
          status: 'skipped' as const,
          tradingDate,
          universe: { status: 'skipped' },
          dailyBars: { status: 'skipped' },
          universeStatus: { status: 'skipped' },
        };
      }

      const universeResult = await ctx.tools.sync_stock_universe.execute({
        force: input.forceUniverse,
      });
      const dailyBarsResult = await ctx.tools.sync_daily_bars.execute({
        scope: 'relevant',
        correctionWindowDays: input.correctionWindowDays,
      });
      const statusResult = await ctx.tools.get_stock_universe_status.execute({});

      const universe = universeResult.ok ? universeResult.data : failed(universeResult.error);
      const dailyBars = dailyBarsResult.ok ? dailyBarsResult.data : failed(dailyBarsResult.error);
      const universeStatus = statusResult.ok
        ? { status: 'succeeded', ...statusResult.data }
        : failed(statusResult.error);
      const outcomes = [
        universe.status === 'failed' ? 'failed' : 'succeeded',
        dailyBars.status === 'failed' ? 'failed' : 'succeeded',
        universeStatus.status,
      ];
      const failures = outcomes.filter((status) => status === 'failed').length;
      return {
        status:
          failures === 0
            ? ('succeeded' as const)
            : failures === outcomes.length
              ? ('failed' as const)
              : ('partial' as const),
        tradingDate,
        universe,
        dailyBars,
        universeStatus,
      };
    },
  ],
});
