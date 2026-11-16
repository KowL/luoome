import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedPluginId } from '@luoome/core';
import { type BuiltinPluginOperations, createBuiltinPluginResources } from '@luoome/tools';
import { buildTestContext, createTestPluginControl } from '@luoome/tools/testing';
import { buildWorkflowTools } from '@luoome/workflows';
import { describe, expect, it } from 'vitest';
import { PluginTasks } from './plugin-tasks.js';

interface TickHandle {
  tick(): Promise<void>;
  stop(): void;
}
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-plugin-assembly-'));
  const { store, executionPolicy } = createTestPluginControl(home);
  const ctx = await buildTestContext({
    executionPolicy,
    clock: () => new Date('2026-11-16T09:00:00Z'),
  });
  const set = (id: ManagedPluginId, enabled: boolean) => {
    const read = store.read();
    if (!read.ok) throw new Error('missing fixture config');
    store.set(id, enabled, read.config);
  };
  const starts = new Map<ManagedPluginId, number>();
  const stops = new Map<ManagedPluginId, number>();
  const handles = new Map<ManagedPluginId, TickHandle>();
  const assemble = (operations: BuiltinPluginOperations) =>
    createBuiltinPluginResources(operations).map((definition) => ({
      ...definition,
      start(scope: Parameters<typeof definition.start>[0]) {
        starts.set(definition.id, (starts.get(definition.id) ?? 0) + 1);
        const handle = definition.start(scope) as TickHandle;
        handles.set(definition.id, handle);
        return {
          stop() {
            stops.set(definition.id, (stops.get(definition.id) ?? 0) + 1);
            handle.stop();
          },
        };
      },
    }));
  const operations: BuiltinPluginOperations = {
    strategy: {
      run: async () => ({
        ok: true,
        data: { items: [], ran: 0, partial: 0, skipped: 0, failed: 0 },
      }),
    },
    report: { run: async () => ({ ok: true, data: { failed: [] } }) },
    performance: {
      run: async () => ({
        ok: true,
        data: {
          status: 'succeeded',
          requestedAccounts: 0,
          completedAccounts: 0,
          partialAccounts: 0,
          failedAccounts: 0,
          createdSnapshots: 0,
          reusedSnapshots: 0,
          durationMs: 0,
        },
      }),
    },
    watch: { runAccount: async () => ({ ok: true, data: { status: 'complete', errors: [] } }) },
  };
  return {
    ctx,
    set,
    starts,
    stops,
    handles,
    assemble,
    operations,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
};

describe('assembled plugin resource lifecycle', () => {
  it('drains the actual packaged performance resource, rejects old tools and reactivates once without restarting peers', async () => {
    const f = await setup();
    const started = deferred(),
      release = deferred();
    let calls = 0;
    const operations: BuiltinPluginOperations = {
      ...f.operations,
      performance: {
        run: async (ctx, date) => {
          calls++;
          if (calls === 1) {
            started.resolve();
            await release.promise;
          }
          ctx.executionGuard?.();
          return f.operations.performance.run(ctx, date);
        },
      },
    };
    const host = new PluginTasks(f.ctx, f.assemble(operations));
    const id = 'task.snapshot-account-performance';
    const old = f.handles.get(id);
    if (!old) throw new Error('packaged performance resource was not registered');
    const oldTool = buildWorkflowTools(f.ctx).snapshot_account_performance;
    let pending: Promise<void> | undefined;
    try {
      expect(f.starts.size).toBe(5);
      pending = old.tick();
      await started.promise;
      expect(host.status().find((resource) => resource.id === id)).toMatchObject({
        phase: 'ready',
        inFlight: 1,
      });
      f.set(id, false);
      host.reconcile();
      expect(host.status().find((resource) => resource.id === id)).toMatchObject({
        phase: 'draining',
        inFlight: 1,
      });
      expect(f.stops.get(id)).toBe(1);
      f.set(id, true);
      host.reconcile();
      host.reconcile();
      expect(f.starts.get(id)).toBe(1);
      const input = {
        accountId: f.ctx.user.defaultAccountId,
        from: '2026-06-01',
        to: '2026-06-30',
      };
      expect(await oldTool.execute(input)).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
      release.resolve();
      await pending;
      host.reconcile();
      host.reconcile();
      expect(f.starts.get(id)).toBe(2);
      await old.tick();
      expect(calls).toBe(1);
      const fresh = f.handles.get(id);
      if (!fresh) throw new Error('missing new resource');
      await Promise.all([fresh.tick(), fresh.tick()]);
      await fresh.tick();
      expect(calls).toBe(2);
      for (const peer of [
        'business.report',
        'business.watch-monitoring',
        'task.strategy-schedules',
        'task.collect-market-snapshot',
      ] as const) {
        expect(f.starts.get(peer)).toBe(1);
        expect(f.stops.get(peer) ?? 0).toBe(0);
      }
      const history = await buildWorkflowTools(f.ctx).list_account_performance_snapshots.execute({
        accountId: f.ctx.user.defaultAccountId,
      });
      expect(history.ok).toBe(true);
    } finally {
      release.resolve();
      await pending;
      await host.stop();
      f.clean();
    }
  });

  it('derives the strategy schedule dependency from its package and leaves report resources independent', async () => {
    const f = await setup();
    f.set('business.strategy-execution', false);
    const host = new PluginTasks(f.ctx, f.assemble(f.operations));
    try {
      expect(host.status().find((row) => row.id === 'task.strategy-schedules')?.phase).toBe(
        'blocked',
      );
      expect(f.starts.get('task.strategy-schedules')).toBeUndefined();
      expect(f.starts.get('business.report')).toBe(1);
      f.set('business.strategy-execution', true);
      host.reconcile();
      host.reconcile();
      expect(f.starts.get('task.strategy-schedules')).toBe(1);
      f.set('business.strategy-execution', false);
      host.reconcile();
      expect(f.stops.get('task.strategy-schedules')).toBe(1);
      expect(f.stops.get('business.report')).toBeUndefined();
      expect(host.status().find((row) => row.id === 'business.report')?.phase).toBe('ready');
    } finally {
      await host.stop();
      f.clean();
    }
  });
});
