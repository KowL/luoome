import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedPluginId } from '@luoome/core';
import { buildTestContext, createTestPluginControl } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { type PluginTaskActivation, PluginTasks } from './plugin-tasks.js';
import { startClosingReportScheduler, startStrategyScheduler } from './strategy-scheduler.js';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-p3-task-'));
  const { store, executionPolicy } = createTestPluginControl(home);
  const ctx = await buildTestContext({ executionPolicy });
  const set = (id: ManagedPluginId, enabled: boolean) => {
    const read = store.read();
    if (!read.ok) throw new Error('missing');
    store.set(id, enabled, read.config);
  };
  return { ctx, set, clean: () => rmSync(home, { recursive: true, force: true }) };
};
const id = 'task.strategy-schedules' as const;
const requires = ['business.strategy-execution'] as const;

describe('plugin task resources', () => {
  it('owns one real strategy timer, removes it on disable, and keeps cutoff independent', async () => {
    const { ctx, set, clean } = await setup();
    set(id, false);
    let starts = 0,
      stops = 0,
      calls = 0,
      cutoffs = 0;
    let scheduler: ReturnType<typeof startStrategyScheduler> | undefined;
    const cutoff = startClosingReportScheduler(ctx, {
      startImmediately: false,
      runCutoff: async () => {
        cutoffs++;
        return { ok: true, data: { date: '2026-11-16', created: [], failed: [] } };
      },
    });
    const host = new PluginTasks(ctx, [
      {
        id,
        requires,
        start: (scope) => {
          starts++;
          const handle = startStrategyScheduler(scope.ctx, {
            startImmediately: false,
            dispatch: (operation) => scope.run(operation),
            run: async () => {
              calls++;
              return { ok: true, data: { items: [], ran: 0, partial: 0, skipped: 0, failed: 0 } };
            },
          });
          scheduler = handle;
          return {
            stop: () => {
              stops++;
              handle.stop();
            },
          };
        },
      },
    ]);
    try {
      expect(starts).toBe(0);
      set(id, true);
      host.reconcile();
      host.reconcile();
      expect(starts).toBe(1);
      if (!scheduler) throw new Error('missing timer');
      const old = scheduler;
      await old.tick();
      expect(calls).toBe(1);
      set('business.strategy-execution', false);
      host.reconcile();
      expect(stops).toBe(1);
      await old.tick();
      expect(calls).toBe(1);
      await cutoff.tick();
      expect(cutoffs).toBe(1);
      set('business.strategy-execution', true);
      host.reconcile();
      host.reconcile();
      expect(starts).toBe(2);
      await old.tick();
      expect(calls).toBe(1);
      await scheduler.tick();
      expect(calls).toBe(2);
    } finally {
      await host.stop();
      cutoff.stop();
      clean();
    }
    expect(stops).toBe(2);
  });

  it('reports bounded drain, defers new registration until old work ends, and revokes saved contexts', async () => {
    const { ctx, set, clean } = await setup();
    const started = deferred(),
      release = deferred();
    let now = 0,
      starts = 0,
      stops = 0;
    let scope: PluginTaskActivation | undefined;
    const host = new PluginTasks(
      ctx,
      [
        {
          id,
          requires,
          start: (activation) => {
            starts++;
            scope = activation;
            return {
              stop: () => {
                stops++;
              },
            };
          },
        },
      ],
      { clock: () => now, drainMs: 50 },
    );
    try {
      if (!scope) throw new Error('missing activation');
      const old = scope;
      const active = old.run(async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      set(id, false);
      host.reconcile();
      expect(old.ctx.abortSignal?.aborted).toBe(true);
      expect(stops).toBe(1);
      expect(host.status()[0]).toMatchObject({
        phase: 'draining',
        inFlight: 1,
        drainTimedOut: false,
      });
      set(id, true);
      now = 51;
      host.reconcile();
      expect(starts).toBe(1);
      expect(host.status()[0]).toMatchObject({ phase: 'draining', drainTimedOut: true });
      expect(() => old.ctx.executionGuard?.()).toThrow();
      release.resolve();
      await active;
      host.reconcile();
      host.reconcile();
      expect(starts).toBe(2);
      let staleCalls = 0;
      await old.run(async () => {
        staleCalls++;
      });
      expect(staleCalls).toBe(0);
      expect(host.status()[0]).toMatchObject({ phase: 'ready', inFlight: 0 });
    } finally {
      release.resolve();
      await host.stop();
      clean();
    }
  });

  it('shutdown times out truthfully and never restarts after draining', async () => {
    const { ctx, clean } = await setup();
    const started = deferred(),
      release = deferred();
    let scope: PluginTaskActivation | undefined;
    let starts = 0;
    const host = new PluginTasks(
      ctx,
      [
        {
          id,
          requires,
          start: (activation) => {
            scope = activation;
            starts++;
            return { stop() {} };
          },
        },
      ],
      { drainMs: 5 },
    );
    try {
      if (!scope) throw new Error('missing activation');
      const active = scope.run(async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      const stopping = host.stop();
      expect(host.stop()).toBe(stopping);
      expect(await stopping).toEqual({ drained: false });
      release.resolve();
      await active;
      host.reconcile();
      expect(starts).toBe(1);
    } finally {
      release.resolve();
      await host.stop();
      clean();
    }
  });

  it('does not publish a resource revoked during creation or revive one whose teardown failed', async () => {
    const { ctx, set, clean } = await setup();
    let stops = 0,
      starts = 0;
    const host = new PluginTasks(ctx, [
      {
        id,
        requires,
        start: () => {
          starts++;
          set(id, false);
          return {
            stop: () => {
              stops++;
            },
          };
        },
      },
    ]);
    try {
      expect(starts).toBe(1);
      expect(stops).toBe(1);
      expect(host.status()[0]?.phase).toBe('disabled');
    } finally {
      await host.stop();
    }
    set(id, true);
    const failed = new PluginTasks(ctx, [
      {
        id,
        requires,
        start: () => {
          starts++;
          return {
            stop: () => {
              throw new Error('fixture teardown');
            },
          };
        },
      },
    ]);
    try {
      set(id, false);
      failed.reconcile();
      set(id, true);
      failed.reconcile();
      expect(starts).toBe(2);
      expect(failed.status()[0]?.phase).toBe('failed');
      expect(await failed.stop()).toEqual({ drained: false });
    } finally {
      await failed.stop();
      clean();
    }
  });
});
