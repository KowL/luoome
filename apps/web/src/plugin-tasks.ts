import {
  type ManagedPluginId,
  PluginExecutionDenied,
  type PluginPermit,
  type ToolContext,
} from '@luoome/core';

import type { PluginTaskDefinition } from '@luoome/tools';

export type { PluginTaskActivation, PluginTaskDefinition } from '@luoome/tools';

interface Activation {
  readonly permits: readonly PluginPermit[];
  readonly abort: AbortController;
  readonly pending: Set<Promise<void>>;
  resource?: { stop(): void };
  stopped: boolean;
  stoppedAt?: number;
  teardownFailed?: boolean;
}
export interface PluginTaskStatus {
  readonly id: ManagedPluginId;
  readonly phase: 'disabled' | 'blocked' | 'ready' | 'draining' | 'failed';
  readonly inFlight: number;
  readonly drainTimedOut: boolean;
}

/** 一个宿主只登记一次资源；轮询只观察策略，不执行业务任务。 */
export class PluginTasks {
  private readonly active = new Map<ManagedPluginId, Activation>();
  private readonly failed = new Map<ManagedPluginId, string>();
  private readonly monitor: ReturnType<typeof setInterval>;
  private stopped = false;
  private reconciling = false;
  private stopping: Promise<{ drained: boolean }> | undefined;

  constructor(
    private readonly ctx: ToolContext,
    private readonly definitions: readonly PluginTaskDefinition[],
    private readonly options: { pollMs?: number; drainMs?: number; clock?: () => number } = {},
  ) {
    if (new Set(definitions.map((def) => def.id)).size !== definitions.length)
      throw new Error('duplicate plugin task');
    for (const value of [options.pollMs ?? 250, options.drainMs ?? 5000])
      if (!Number.isFinite(value) || value <= 0) throw new Error('invalid plugin task interval');
    this.reconcile();
    this.monitor = setInterval(() => this.reconcile(), options.pollMs ?? 250);
    this.monitor.unref();
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }
  private valid(activation: Activation): boolean {
    return (
      !activation.stopped &&
      activation.permits.every((permit) => this.ctx.executionPolicy?.valid(permit))
    );
  }
  private retire(activation: Activation): void {
    if (activation.stopped) return;
    activation.stopped = true;
    activation.stoppedAt = this.now();
    activation.abort.abort();
    try {
      activation.resource?.stop();
    } catch {
      activation.teardownFailed = true;
      this.ctx.logger.error('插件任务资源卸载失败');
    }
  }

  reconcile(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const definition of this.definitions) {
        let current = this.active.get(definition.id);
        if (current !== undefined && (this.stopped || !this.valid(current))) this.retire(current);
        if (current?.stopped) {
          if (current.pending.size > 0 || current.teardownFailed) continue;
          this.active.delete(definition.id);
          current = undefined;
        }
        if (this.stopped || current !== undefined) continue;
        const admissions = [definition.id, ...(definition.requires ?? [])].map((id) =>
          this.ctx.executionPolicy?.acquire(id),
        );
        if (admissions.some((admission) => !admission?.ok)) continue;
        const permits = admissions.flatMap((admission) =>
          admission?.ok ? [admission.permit] : [],
        );
        const key = JSON.stringify(permits);
        if (this.failed.get(definition.id) === key) continue;
        const activation: Activation = {
          permits,
          abort: new AbortController(),
          pending: new Set(),
          stopped: false,
        };
        const check = () => {
          this.ctx.executionGuard?.();
          if (!this.valid(activation)) throw new PluginExecutionDenied(`plugin:${definition.id}`);
        };
        const bound: ToolContext = {
          ...this.ctx,
          executionGuard: check,
          abortSignal:
            this.ctx.abortSignal === undefined
              ? activation.abort.signal
              : AbortSignal.any([this.ctx.abortSignal, activation.abort.signal]),
          ...(this.ctx.executionPolicy === undefined
            ? {}
            : { executionPolicy: this.ctx.executionPolicy.bind() }),
        };
        this.active.set(definition.id, activation);
        try {
          activation.resource = definition.start({
            ctx: bound,
            run: async (operation) => {
              if (!this.valid(activation) || activation.pending.size > 0) {
                this.reconcile();
                return;
              }
              const pending = Promise.resolve().then(() => {
                check();
                return operation();
              });
              activation.pending.add(pending);
              try {
                await pending;
              } catch (error) {
                if (!(error instanceof PluginExecutionDenied))
                  this.ctx.logger.error('插件任务执行失败', { id: definition.id });
              } finally {
                activation.pending.delete(pending);
                this.reconcile();
              }
            },
          });
          check();
          this.failed.delete(definition.id);
        } catch {
          this.failed.set(definition.id, key);
          this.retire(activation);
          this.ctx.logger.error('插件任务激活失败', { id: definition.id });
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  status(): readonly PluginTaskStatus[] {
    this.reconcile();
    return this.definitions.map((definition) => {
      const active = this.active.get(definition.id);
      const enabled = this.ctx.executionPolicy?.acquire(definition.id).ok === true;
      const blocked =
        definition.requires?.some((id) => !this.ctx.executionPolicy?.acquire(id).ok) ?? false;
      return {
        id: definition.id,
        phase: active?.teardownFailed
          ? 'failed'
          : active?.stopped
            ? 'draining'
            : active
              ? 'ready'
              : !enabled
                ? 'disabled'
                : !blocked && this.failed.has(definition.id)
                  ? 'failed'
                  : 'blocked',
        inFlight: active?.pending.size ?? 0,
        drainTimedOut:
          active?.stoppedAt !== undefined &&
          this.now() - active.stoppedAt >= (this.options.drainMs ?? 5000),
      };
    });
  }

  stop(): Promise<{ drained: boolean }> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    clearInterval(this.monitor);
    this.reconcile();
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.allSettled(
            [...this.active.values()].flatMap((active) => [...active.pending]),
          ).then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), this.options.drainMs ?? 5000);
          }),
        ]);
        this.reconcile();
        return {
          drained: drained && ![...this.active.values()].some((active) => active.teardownFailed),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.stopping;
  }
}
