import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-cmdline';
import type { ToolContext } from '@luoome/core';
import { getAnalysisMetricsTool } from '@luoome/tools';
import { z } from 'zod';
import { createReadSurface } from './read-surface.js';

export type QueuePreflight = { state: 'ready' | 'empty' | 'error'; exitCode: 0 | 1 | 2 };
const metrics = z.object({
  readyPending: z.number().int().nonnegative(),
  claimExpiredNotRecycled: z.object({ count: z.number().int().nonnegative() }),
});

export const runQueuePreflight = async (options: {
  context: () => ToolContext | Promise<ToolContext>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<QueuePreflight> => {
  const surface = createReadSurface({
    config: { allowlist: [getAnalysisMetricsTool.name] },
    tools: [getAnalysisMetricsTool],
    context: options.context,
  });
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
  let stop = () => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new Error('Preflight cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      stop = () => signal.removeEventListener('abort', cancel);
      if (signal.aborted) cancel();
    });
    const result = await Promise.race([
      surface.invoke(getAnalysisMetricsTool.name, {}, signal),
      cancelled,
    ]);
    const parsed = result.ok ? metrics.safeParse(result.data) : null;
    if (!parsed?.success) return { state: 'error', exitCode: 2 };
    const ready = parsed.data.readyPending > 0 || parsed.data.claimExpiredNotRecycled.count > 0;
    return ready ? { state: 'ready', exitCode: 0 } : { state: 'empty', exitCode: 1 };
  } catch {
    return { state: 'error', exitCode: 2 };
  } finally {
    clearTimeout(timer);
    stop();
    surface.dispose();
  }
};

export const installWorkerPreflight = (
  ctx: Context,
  options: {
    context: () => ToolContext | Promise<ToolContext>;
    ownsAgent: (agent: Agent) => boolean;
    report: (result: QueuePreflight) => void;
    timeoutMs?: number;
  },
) => {
  const turns = new WeakMap<Agent, number>();
  const lifetime = new AbortController();
  const remove = ctx.on('agent/pre-step', async (payload, next) => {
    if (!options.ownsAgent(payload.agent)) return next();
    // Probe once per turn; a consumer's own later steps may have drained the queue.
    if (turns.get(payload.agent) === payload.turn) return next();
    const result = await runQueuePreflight({
      ...options,
      signal: AbortSignal.any([payload.signal, lifetime.signal]),
    });
    options.report(result);
    if (result.state !== 'ready' || lifetime.signal.aborted) return { kind: 'reject' };
    turns.set(payload.agent, payload.turn);
    return next();
  });
  const dispose = () => {
    lifetime.abort();
    remove();
  };
  ctx.effect(() => dispose);
  return dispose;
};

export const installQueueProbe = (
  ctx: Context,
  options: {
    context: () => ToolContext | Promise<ToolContext>;
    report: (result: QueuePreflight) => void;
    timeoutMs?: number;
  },
) => {
  const ready = ctx.get('appReady');
  const exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('Queue probe requires the DSH application lifecycle');
  const lifetime = new AbortController();
  const remove = ready.onReady(() => {
    void runQueuePreflight({ ...options, signal: lifetime.signal }).then((result) => {
      if (lifetime.signal.aborted) return;
      options.report(result);
      exit(result.exitCode);
    });
  });
  ctx.effect(() => () => {
    lifetime.abort();
    remove();
  });
};
