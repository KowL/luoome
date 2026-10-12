import type { TenantFactsReportResultSchema, ToolResult } from '@luoome/core';
import { BuildWatchlistFactsInput, CommitWatchlistFactsInput } from '@luoome/tools';
import { z } from 'zod';
import { defineWorkflow } from './define-workflow.js';

export const WatchlistFactsInput = BuildWatchlistFactsInput.extend({
  fence: z.number().int().positive(),
  attemptId: z.string().min(1),
});
export type WatchlistFactsOutput = z.infer<typeof TenantFactsReportResultSchema>;

export const watchlistFactsWorkflow = defineWorkflow<
  z.infer<typeof WatchlistFactsInput>,
  WatchlistFactsOutput
>({
  name: 'watchlist-facts',
  description: '无投资账户的个人自选事实摘要；使用持久输入、确定性事实模板与租户事务回执',
  input: WatchlistFactsInput,
  steps: [
    async (raw, ctx) => {
      const input = WatchlistFactsInput.parse(raw);
      const built = await ctx.tools.build_watchlist_facts.execute(input);
      if (!built.ok) return built;
      return { ...input, report: built.data.report };
    },
    async (raw, ctx): Promise<ToolResult<WatchlistFactsOutput>> => {
      const input = CommitWatchlistFactsInput.parse(raw);
      return ctx.tools.commit_watchlist_facts.execute(input);
    },
  ],
});
