import { WatchRunSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const WatchHealthStateSchema = z.enum(['never', 'running', 'healthy', 'stale', 'failed']);

export const GetWatchStatusInput = z.object({
  expectedIntervalSeconds: z.number().int().min(60).max(86_400).default(60),
});

export const GetWatchStatusOutput = z.object({
  state: WatchHealthStateSchema,
  latest: WatchRunSchema.nullable(),
  staleAfterSeconds: z.number().int().positive(),
});

export const getWatchStatusTool = defineTool({
  name: 'get_watch_status',
  description: '查询 watch 最近运行与健康状态（无触发时也有心跳）',
  sideEffect: 'read',
  input: GetWatchStatusInput,
  output: GetWatchStatusOutput,
  handler: async (input, ctx) => {
    const staleAfterSeconds = Math.max(input.expectedIntervalSeconds * 3, 180);
    const latest = await ctx.repos.watchRun.latest();
    if (latest === null) return { state: 'never' as const, latest: null, staleAfterSeconds };
    if (latest.status === 'failed') {
      return { state: 'failed' as const, latest, staleAfterSeconds };
    }
    const heartbeatAt = latest.finishedAt ?? latest.startedAt;
    const stale = ctx.clock().getTime() - heartbeatAt.getTime() > staleAfterSeconds * 1000;
    if (stale) return { state: 'stale' as const, latest, staleAfterSeconds };
    return {
      state: latest.status === 'running' ? ('running' as const) : ('healthy' as const),
      latest,
      staleAfterSeconds,
    };
  },
});
