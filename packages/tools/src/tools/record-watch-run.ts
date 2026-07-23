import { assertWatchRunInvariants, WatchRunSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const RecordWatchRunInput = WatchRunSchema;
export const RecordWatchRunOutput = z.object({ run: WatchRunSchema });

export const recordWatchRunTool = defineTool({
  name: 'record_watch_run',
  description: '记录 watch 单轮运行状态（write，workflow/runner 内部使用）',
  sideEffect: 'write',
  input: RecordWatchRunInput,
  output: RecordWatchRunOutput,
  handler: async (input, ctx) => {
    const run = WatchRunSchema.parse(input);
    assertWatchRunInvariants(run);
    await ctx.repos.watchRun.save(run);
    return { run };
  },
});
