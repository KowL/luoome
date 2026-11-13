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
  readonly boardHistory: Record<string, unknown> & { readonly status: string };
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
  description: '交易日盘后同步股票目录、全市场原始日线与复权因子（fuyao dump）并汇总数据健康状态',
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
          boardHistory: { status: 'skipped' },
          universeStatus: { status: 'skipped' },
        };
      }

      const universeResult = await ctx.tools.sync_stock_universe.execute({
        force: input.forceUniverse,
      });
      // 日线与复权因子统一走 fuyao 全市场 dump：10 交易日增量 + 全量因子事件。
      const dailyBarsResult = await ctx.tools.sync_market_dump.execute({ kind: 'auto' });
      // 炸板/断板事实与天梯同源（fuyao 涨停池/炸板池），在盘后一并固化 PIT。
      const boardHistoryResult = await ctx.tools.sync_limit_up_board_history.execute({
        date: tradingDate,
      });
      const statusResult = await ctx.tools.get_stock_universe_status.execute({});

      const universe = universeResult.ok ? universeResult.data : failed(universeResult.error);
      const dailyBars = dailyBarsResult.ok
        ? { status: 'succeeded', ...dailyBarsResult.data }
        : failed(dailyBarsResult.error);
      const boardHistory = boardHistoryResult.ok
        ? { ...boardHistoryResult.data }
        : failed(boardHistoryResult.error);
      const universeStatus = statusResult.ok
        ? { status: 'succeeded', ...statusResult.data }
        : failed(statusResult.error);
      const outcomes = [
        universe.status === 'failed' ? 'failed' : 'succeeded',
        dailyBars.status === 'failed' ? 'failed' : 'succeeded',
        boardHistory.status === 'failed' || boardHistory.status === 'unavailable'
          ? 'failed'
          : 'succeeded',
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
        boardHistory,
        universeStatus,
      };
    },
  ],
});
