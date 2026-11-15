import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigStore, ProviderRuntime } from '@luoome/adapters';
import { createPluginExecutionPolicy } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginSettingsStore } from './plugin-settings.js';
import { type PluginTaskActivation, PluginTasks } from './plugin-tasks.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-p4-'));
  roots.push(root);
  const env = { LUOOME_HOME: root, TUSHARE_TOKEN: 'private-fixture' };
  const store = new PluginConfigStore(join(root, 'plugins.json'));
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  const context = await buildTestContext({ executionPolicy: policy });
  const settings = new PluginSettingsStore(env);
  const runtime = { context, exposeWrite: true, exposeExternal: true };
  const command = (
    id:
      | 'business.strategy-execution'
      | 'task.strategy-schedules'
      | 'strategy.ai-insight'
      | 'source.sina',
    enabled: boolean,
  ) => {
    const config = store.read();
    if (!config.ok) throw new Error('fixture configuration absent');
    return {
      action: 'set' as const,
      id,
      enabled,
      incarnation: config.config.incarnation,
      revision: config.config.revision,
    };
  };
  return { root, env, store, policy, context, settings, runtime, command };
};
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Web plugin settings projection and conditional commands', () => {
  it('reads and previews without initializing, sending upstream requests, or revealing paths/secrets', async () => {
    const { root, store, settings, runtime } = await setup();
    let builds = 0;
    const provider = new ProviderRuntime(store);
    provider.wrap('market', ['sina'], () => {
      builds++;
      return {
        read: async () => {
          throw new Error('must not call');
        },
      };
    });
    const view = settings.read({ ...runtime, provider });
    expect(view.configuration.state).toBe('missing');
    expect(view.plugins.every((row) => !row.enabled)).toBe(true);
    const preview = settings.preview(
      { action: 'initialize', expected: 'absent' },
      { ...runtime, provider },
    );
    expect(preview.affected.find((row) => row.id === 'strategy.ai-insight')?.enabled).toBe(true);
    expect(existsSync(store.path)).toBe(false);
    expect(builds).toBe(0);
    expect(JSON.stringify({ view, preview })).not.toContain(root);
    expect(JSON.stringify({ view, preview })).not.toContain('private-fixture');
    settings.save(preview.command, runtime);
    expect(
      settings
        .read(runtime)
        .plugins.filter((row) => row.enabled)
        .map((row) => row.id),
    ).toEqual(['strategy.ai-insight']);
  });

  it('keeps dependencies explicit and preserves fallback/history in impact previews', async () => {
    const { store, settings, runtime, command } = await setup();
    store.initialize();
    const provider = new ProviderRuntime(store);
    provider.wrap('market', ['sina', 'tencent'], () => ({ read: async () => 1 }));
    const task = settings.preview(command('task.strategy-schedules', true), {
      ...runtime,
      provider,
    });
    expect(task.affected[0]).toMatchObject({
      enabled: true,
      requires: [{ id: 'business.strategy-execution', enabled: false }],
      runtime: { phase: 'blocked' },
    });
    settings.save(task.command, runtime);
    expect(store.acquire('business.strategy-execution').ok).toBe(false);
    const business = settings.preview(command('business.strategy-execution', true), runtime);
    expect(business.affected.map((row) => row.id)).toEqual([
      'business.strategy-execution',
      'task.strategy-schedules',
    ]);
    const source = settings.preview(command('source.sina', true), { ...runtime, provider });
    expect(
      source.affected[0]?.contributions.some(
        (item) => item.effect === 'provider-route' && item.name === 'fetch_quote',
      ),
    ).toBe(true);
    expect(source.notes.join('')).toContain('其它候选源');
    expect(source.notes.join('')).toContain('历史策略');
    const blocked = settings.preview(command('strategy.ai-insight', true), {
      ...runtime,
      exposeExternal: false,
    });
    expect(blocked.affected[0]?.blockers.join('')).toContain('external');
  });

  it('rejects stale previews across two hosts and deleted/recreated configurations', async () => {
    const { store, env, settings, runtime, command } = await setup();
    store.initialize();
    const other = new PluginSettingsStore(env);
    const first = settings.preview(command('business.strategy-execution', true), runtime);
    const second = other.preview(command('task.strategy-schedules', true), runtime);
    settings.save(first.command, runtime);
    expect(() => other.save(second.command, runtime)).toThrow('conflict');
    const stale = command('business.strategy-execution', false);
    rmSync(store.path);
    store.initialize();
    expect(() => settings.save(stale, runtime)).toThrow('conflict');
    expect(other.read(runtime).host.id).not.toBe(settings.read(runtime).host.id);
    expect(settings.read(runtime).plugins.every((row) => row.runtime.gateApplied)).toBe(true);
  });

  it('fails closed for invalid/unknown configs and strictly validates commands without overwriting', async () => {
    const { store, settings, runtime, command } = await setup();
    store.initialize();
    const valid = command('business.strategy-execution', true);
    for (const raw of [
      { ...valid, command: 'shell' },
      { ...valid, id: 'unknown' },
      { ...valid, enabled: 'true' },
    ])
      expect(() => settings.save(raw, runtime)).toThrow();
    const original = readFileSync(store.path, 'utf8');
    expect(() => settings.preview({ action: 'initialize', expected: 'absent' }, runtime)).toThrow(
      'exists',
    );
    expect(readFileSync(store.path, 'utf8')).toBe(original);
    writeFileSync(store.path, original.replace('strategy.ai-insight', 'unknown.plugin'));
    expect(settings.read(runtime).configuration.state).toBe('invalid');
    expect(
      settings.read(runtime).plugins.every((row) => !row.enabled && !row.runtime.gateApplied),
    ).toBe(true);
    expect(() => settings.save(valid, runtime)).toThrow('invalid');
  });

  it('migrates missing entries disabled and distinguishes a committed config from application failure', async () => {
    const { store, settings, runtime } = await setup();
    const config = store.initialize();
    delete config.entries['task.strategy-schedules'];
    writeFileSync(store.path, JSON.stringify(config));
    const view = settings.read(runtime);
    expect(view.configuration.missing).toEqual(['task.strategy-schedules']);
    const saved = settings.save(
      { action: 'migrate', incarnation: config.incarnation, revision: config.revision },
      {
        ...runtime,
        tasks: {
          status: () => [],
          reconcile: () => {
            throw new Error('/private/path');
          },
        },
      },
    );
    expect(saved).toMatchObject({
      committed: true,
      committedVersion: { revision: config.revision + 1 },
    });
    expect(saved.applicationError).toContain('配置已提交');
    expect(JSON.stringify(saved)).not.toContain('/private/path');
    expect(store.acquire('task.strategy-schedules').ok).toBe(false);
  });

  it('observes real task drain, does not register twice on re-enable, and revokes saved policy/activation', async () => {
    const { store, settings, runtime, context, command, policy } = await setup();
    store.initialize();
    settings.save(command('business.strategy-execution', true), runtime);
    settings.save(command('task.strategy-schedules', true), runtime);
    let scope: PluginTaskActivation | undefined;
    let starts = 0;
    const tasks = new PluginTasks(context, [
      {
        id: 'task.strategy-schedules',
        requires: ['business.strategy-execution'],
        start: (activation) => {
          scope = activation;
          starts++;
          return { stop() {} };
        },
      },
    ]);
    const release = deferred();
    try {
      if (!scope) throw new Error('no activation');
      const old = scope;
      const oldPolicy = policy.bind();
      const active = old.run(() => release.promise);
      settings.save(command('business.strategy-execution', false), { ...runtime, tasks });
      expect(
        settings
          .read({ ...runtime, tasks })
          .plugins.find((row) => row.id === 'business.strategy-execution'),
      ).toMatchObject({
        enabled: false,
        runtime: { phase: 'draining', gateApplied: true, dependentTasks: [{ inFlight: 1 }] },
      });
      expect(() => oldPolicy.assertTool('run_strategy')).toThrow();
      settings.save(command('business.strategy-execution', true), { ...runtime, tasks });
      expect(starts).toBe(1);
      release.resolve();
      await active;
      tasks.reconcile();
      tasks.reconcile();
      expect(starts).toBe(2);
      expect(() => oldPolicy.assertTool('run_strategy')).toThrow();
      expect(() => old.ctx.executionGuard?.()).toThrow();
      expect(
        settings
          .read({ ...runtime, tasks })
          .plugins.find((row) => row.id === 'task.strategy-schedules')?.runtime.task,
      ).toMatchObject({ phase: 'ready', inFlight: 0 });
    } finally {
      release.resolve();
      await tasks.stop();
    }
  });

  it('keeps actual model activity visible after its parent is revoked until the model finishes', async () => {
    const { store, policy, settings, runtime } = await setup();
    store.initialize();
    const release = deferred();
    let valid = true;
    const active = policy.bind().runPlugin(
      'strategy.ai-insight',
      () => release.promise,
      () => {
        if (!valid) throw new Error('parent revoked');
      },
    );
    expect(policy.activity()).toEqual([
      { id: 'strategy.ai-insight', inFlight: 1, revokedInFlight: 0 },
    ]);
    valid = false;
    expect(
      settings.read(runtime).plugins.find((row) => row.id === 'strategy.ai-insight')?.runtime,
    ).toMatchObject({ phase: 'draining', inFlight: 1, revokedInFlight: 1 });
    release.resolve();
    await active;
    expect(policy.activity()).toEqual([]);
  });
});
