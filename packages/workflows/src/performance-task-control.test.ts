import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedPluginId, SideEffect, ToolContext } from '@luoome/core';
import {
  auditPortfolioPerformanceSnapshotsTool,
  createPluginExecutionPolicy,
  getAccountPerformanceTool,
  listPortfolioPerformanceSnapshotsTool,
  snapshotAccountPerformanceTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginConfigStore, ProviderRuntime } from '../../adapters/src/index.js';
import { intradayWatchWorkflow } from './intraday-watch.js';
import { openingReportOperation } from './opening-report.js';
import { snapshotAccountPerformanceWorkflow } from './snapshot-account-performance.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = 'task.snapshot-account-performance' as const;
const denied = { ok: false, error: { kind: 'permission_denied', required: `plugin:${id}` } };
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-performance-task-'));
  roots.push(home);
  const store = new PluginConfigStore(join(home, 'plugins.json'));
  let config = store.initialize();
  for (const plugin of ['source.sina', 'business.report', 'business.watch-monitoring'] as const)
    config = store.set(plugin, true, config);
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  let now = new Date('2026-07-03T09:00:00Z');
  const base = await buildTestContext({ executionPolicy: policy, clock: () => now });
  const provider = new ProviderRuntime(store);
  const ctx: ToolContext = {
    ...base,
    dataScope: provider,
    adapters: {
      ...base.adapters,
      market: provider.wrap('market', ['sina'], () => base.adapters.market),
    },
  };
  const set = (enabled: boolean, plugin: ManagedPluginId = id) => {
    const read = store.read();
    if (!read.ok) throw new Error('missing fixture');
    store.set(plugin, enabled, read.config);
  };
  const input = { from: '2026-07-01', to: '2026-07-03', benchmarkStockId: '600900.SH' };
  const single = { ...input, accountIds: [ctx.user.defaultAccountId] };
  const toolInput = {
    accountId: ctx.user.defaultAccountId,
    from: new Date(input.from),
    to: new Date(input.to),
    benchmarkStockId: input.benchmarkStockId,
  };
  return {
    ctx,
    store,
    policy,
    set,
    input,
    single,
    toolInput,
    marketAdapter: base.adapters.market,
    advance: () => {
      now = new Date(now.getTime() + 60000);
    },
  };
};

describe('account performance task activation', () => {
  it('starts closed before any account/market access or audit, including direct legacy tools without a policy', async () => {
    const { ctx, input, toolInput, marketAdapter } = await setup();
    const accounts = vi.spyOn(ctx.repos.account, 'list');
    const market = vi.spyOn(marketAdapter, 'fetchDailyBars');
    for (const mode of ['manual', 'scheduled', 'daemon'])
      expect(await snapshotAccountPerformanceWorkflow.run({ ...input, mode }, ctx)).toMatchObject(
        denied,
      );
    expect(await snapshotAccountPerformanceTool.execute(toolInput, ctx)).toMatchObject(denied);
    const { executionPolicy: _policy, ...uncontrolled } = ctx;
    expect(await snapshotAccountPerformanceTool.execute(toolInput, uncontrolled)).toMatchObject(
      denied,
    );
    expect(accounts).not.toHaveBeenCalled();
    expect(market).not.toHaveBeenCalled();
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'snapshot-account-performance' }),
    ).toEqual([]);
  });

  it('preserves history, shared on-demand calculations and independent report/watch execution while disabled', async () => {
    const { ctx, set, policy, single, toolInput, marketAdapter } = await setup();
    set(true);
    const result = await snapshotAccountPerformanceWorkflow.run(single, ctx);
    expect(result).toMatchObject({ ok: true, data: { createdSnapshots: 1 } });
    const history = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(
      ctx.user.defaultAccountId,
    );
    const old = { ...ctx, executionPolicy: policy.bind() };
    set(false);
    expect(await snapshotAccountPerformanceWorkflow.run(single, old)).toMatchObject(denied);
    expect(await snapshotAccountPerformanceTool.execute(toolInput, old)).toMatchObject(denied);
    const market = vi.spyOn(marketAdapter, 'fetchDailyBars');
    expect((await listPortfolioPerformanceSnapshotsTool.execute({}, ctx)).ok).toBe(true);
    expect((await auditPortfolioPerformanceSnapshotsTool.execute(toolInput, ctx)).ok).toBe(true);
    expect(market).not.toHaveBeenCalled();
    expect(await ctx.repos.portfolioPerformanceSnapshot.findById(history[0]?.id ?? '')).toEqual(
      history[0],
    );
    expect((await getAccountPerformanceTool.execute(toolInput, ctx)).ok).toBe(true);
    expect((await openingReportOperation.run({ date: '2026-07-03', notify: false }, ctx)).ok).toBe(
      true,
    );
    expect((await intradayWatchWorkflow.run({ notify: false }, ctx)).ok).toBe(true);
    set(true);
    expect(await snapshotAccountPerformanceWorkflow.run(single, old)).toMatchObject(denied);
    expect(await snapshotAccountPerformanceTool.execute(toolInput, old)).toMatchObject(denied);
    expect(await snapshotAccountPerformanceWorkflow.run(single, ctx)).toMatchObject({
      ok: true,
      data: { createdSnapshots: 0, reusedSnapshots: 1 },
    });
  });

  it('rejects late A under the database writer guard and cannot overwrite fresh B after re-enable', async () => {
    const { ctx, set, policy, single, advance } = await setup();
    set(true);
    const started = deferred(),
      release = deferred();
    const save = ctx.repos.portfolioPerformanceSnapshot.save.bind(
      ctx.repos.portfolioPerformanceSnapshot,
    );
    vi.spyOn(ctx.repos.portfolioPerformanceSnapshot, 'save').mockImplementationOnce(
      async (snapshot) => {
        started.resolve();
        await release.promise;
        return save(snapshot);
      },
    );
    const old = { ...ctx, executionPolicy: policy.bind() };
    const pending = snapshotAccountPerformanceWorkflow.run(single, old);
    await started.promise;
    set(false);
    expect(
      policy.activity().find((activity) => activity.id === id)?.revokedInFlight,
    ).toBeGreaterThan(0);
    set(true);
    advance();
    expect(await snapshotAccountPerformanceWorkflow.run(single, ctx)).toMatchObject({
      ok: true,
      data: { createdSnapshots: 1 },
    });
    const fresh = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(
      ctx.user.defaultAccountId,
    );
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(
      await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ctx.user.defaultAccountId),
    ).toEqual(fresh);
    expect(
      (await ctx.repos.workflowRun.listRecent({ workflowName: 'snapshot-account-performance' }))
        .map((run) => run.status)
        .sort(),
    ).toEqual(['failed', 'succeeded']);
  });

  it('stops before the next account after a paused market request is revoked', async () => {
    const { ctx, set, input, marketAdapter } = await setup();
    set(true);
    const started = deferred(),
      release = deferred();
    const fetch = marketAdapter.fetchDailyBars.bind(marketAdapter);
    vi.spyOn(marketAdapter, 'fetchDailyBars').mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return fetch(...args);
    });
    const accounts = vi.spyOn(ctx.repos.account, 'findById');
    const pending = snapshotAccountPerformanceWorkflow.run(input, ctx);
    await started.promise;
    set(false);
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(new Set(accounts.mock.calls.map(([accountId]) => accountId)).size).toBe(1);
    for (const account of await ctx.repos.account.list())
      expect(await ctx.repos.portfolioPerformanceSnapshot.listByAccount(account.id)).toEqual([]);
  });

  it('keeps write and external opt-in separate from activation', async () => {
    const { ctx, store, set, toolInput } = await setup();
    set(true);
    for (const missing of ['write', 'external'] as const) {
      const allowed = new Set<SideEffect>(['read', 'write', 'external']);
      allowed.delete(missing);
      const limited = { ...ctx, executionPolicy: createPluginExecutionPolicy(store, allowed) };
      expect(await snapshotAccountPerformanceTool.execute(toolInput, limited)).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied', required: missing },
      });
    }
    expect(
      await ctx.repos.portfolioPerformanceSnapshot.listByAccount(ctx.user.defaultAccountId),
    ).toEqual([]);
  });
});
