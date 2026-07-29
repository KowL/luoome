import { assertWatchTriggerInvariants, WatchTriggerSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  observationsForWatchTrigger,
  saveObservationCandidates,
} from '../internal/signal-observation.js';

export const SaveWatchTriggerInput = WatchTriggerSchema;

export const SaveWatchTriggerOutput = z.object({
  trigger: WatchTriggerSchema,
});

/**
 * 落库 watch 触发（v0.6 起，write，workflow 内部使用）。
 *
 * 为什么走 tool：ARCHITECTURE §4.6「workflow 不直连 repo，持久化走专用 tool」。
 * 实际触发者只有 intraday-watch workflow；MCP 暴露面默认 opt-in（write 类），
 * 由 LUOOME_EXPOSE_WRITE 控制。
 */
export const saveWatchTriggerTool = defineTool({
  name: 'save_watch_trigger',
  description: '落库一次 watch 触发（write，workflow 内部使用）',
  sideEffect: 'write',
  input: SaveWatchTriggerInput,
  output: SaveWatchTriggerOutput,
  handler: async (input, ctx) => {
    const trigger = WatchTriggerSchema.parse(input);
    assertWatchTriggerInvariants(trigger);
    await ctx.repos.watchTrigger.save(trigger);
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
