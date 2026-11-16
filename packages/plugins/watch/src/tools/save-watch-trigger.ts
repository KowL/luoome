import { assertWatchTriggerInvariants, WatchTriggerSchema } from '@luoome/core';
import { defineTool } from '@luoome/toolkit';
import {
  observationsForWatchTrigger,
  saveObservationCandidates,
} from '@luoome/toolkit/internal/signal-observation.js';
import { assertWatchMonitoring } from '@luoome/toolkit/internal/watch-monitoring.js';
import { z } from 'zod';

export const SaveWatchTriggerInput = WatchTriggerSchema;

export const SaveWatchTriggerOutput = z.object({
  trigger: WatchTriggerSchema,
});

/**
 * 落库 watch 触发（v0.6 起，write，workflow 内部使用）。
 *
 * 为什么走 tool：ARCHITECTURE §4.6「workflow 不直连 repo，持久化走专用 tool」。
 * 内部写入口不进入公共 registry；盯盘插件与 write 授权分别校验。
 */
export const saveWatchTriggerTool = defineTool({
  name: 'save_watch_trigger',
  description: '落库一次 watch 触发（write，workflow 内部使用）',
  sideEffect: 'write',
  input: SaveWatchTriggerInput,
  output: SaveWatchTriggerOutput,
  handler: async (input, ctx) => {
    assertWatchMonitoring(ctx);
    const trigger = WatchTriggerSchema.parse(input);
    assertWatchTriggerInvariants(trigger);
    await ctx.repos.watchTrigger.save(trigger);
    assertWatchMonitoring(ctx);
    await saveObservationCandidates(
      observationsForWatchTrigger(trigger, {
        provider: trigger.quote === undefined ? 'watch-trigger' : 'quote',
        observedAt: trigger.createdAt,
        fetchedAt: ctx.clock(),
        freshness: trigger.quote === undefined ? 'unavailable' : 'fresh',
      }),
      ctx.repos.signalObservation,
    );
    return { trigger };
  },
});
