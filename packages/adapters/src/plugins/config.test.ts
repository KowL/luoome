import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginConfigError, PluginConfigStore } from './config.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-plugins-'));
  roots.push(root);
  return new PluginConfigStore(join(root, 'plugins.json'));
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persistent plugin policy', () => {
  it('never bootstraps on reads, and malformed/oversized/unknown config fails closed', () => {
    const store = setup();
    expect(store.read()).toEqual({ ok: false, reason: 'missing' });
    expect(readdirSync(join(store.path, '..'))).toEqual([]);
    expect(store.acquire('strategy.ai-insight')).toEqual({
      ok: false,
      reason: 'dependency_not_ready',
    });
    for (const raw of ['{', 'x'.repeat(65_537), JSON.stringify({ version: 999 })]) {
      writeFileSync(store.path, raw);
      expect(store.read()).toEqual({ ok: false, reason: 'invalid' });
      expect(() => store.initialize()).toThrow(PluginConfigError);
      expect(readFileSync(store.path, 'utf8')).toBe(raw);
    }
  });

  it('shares live policy between hosts, persists epochs across off/on and preserves permissions', () => {
    const store = setup();
    const initial = store.initialize();
    const other = new PluginConfigStore(store.path);
    const permit = other.acquire('strategy.ai-insight');
    expect(permit.ok).toBe(true);
    if (!permit.ok) return;
    expect(() => store.set('strategy.ai-insight', false, { ...initial, revision: 99 })).toThrow(
      'conflict',
    );
    const disabled = store.set('strategy.ai-insight', false, initial);
    expect(other.acquire('strategy.ai-insight')).toEqual({ ok: false, reason: 'plugin_disabled' });
    const enabled = store.set('strategy.ai-insight', true, disabled);
    expect(enabled.entries['strategy.ai-insight']?.epoch).toBe(3);
    expect(other.valid(permit.permit)).toBe(false);
    const fresh = other.acquire('strategy.ai-insight');
    expect(fresh.ok && other.valid(fresh.permit)).toBe(true);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(store.path, '..'))).toEqual(['plugins.json']);
  });

  it('rejects old permits and writes after disaster recovery with identical numeric versions', () => {
    const store = setup();
    const initial = store.initialize();
    const permit = store.acquire('strategy.ai-insight');
    rmSync(store.path);
    expect(store.acquire('strategy.ai-insight').ok).toBe(false);
    const recovered = store.initialize();
    expect(recovered.revision).toBe(initial.revision);
    expect(recovered.entries).toEqual(initial.entries);
    expect(recovered.incarnation).not.toBe(initial.incarnation);
    expect(permit.ok && store.valid(permit.permit)).toBe(false);
    expect(() => store.set('strategy.ai-insight', false, initial)).toThrow('conflict');
  });

  it('missing entries are disabled; migration adds disabled entries without renewing existing epochs', () => {
    const store = setup();
    const initial = store.initialize();
    writeFileSync(store.path, JSON.stringify({ ...initial, entries: {} }));
    expect(store.acquire('strategy.ai-insight')).toEqual({ ok: false, reason: 'plugin_disabled' });
    const migrated = store.migrate(initial);
    expect(migrated.entries['strategy.ai-insight']).toEqual({ enabled: false, epoch: 1 });
    expect(store.migrate(migrated).entries).toEqual(migrated.entries);
    expect(() => store.set('source.unknown', true, migrated)).toThrow('unknown_plugin');
  });

  it('a held or abandoned writer lock blocks mutations but never blocks valid reads', () => {
    const store = setup();
    const initial = store.initialize();
    writeFileSync(`${store.path}.lock`, 'held');
    expect(() => store.set('strategy.ai-insight', false, initial)).toThrow('busy');
    expect(readFileSync(`${store.path}.lock`, 'utf8')).toBe('held');
    expect(store.read()).toEqual({ ok: true, config: initial });
  });

  it('two real processes cannot both commit the same expected version', async () => {
    const store = setup();
    const initial = store.initialize();
    const module = new URL('./config.ts', import.meta.url).pathname;
    const script = `import { PluginConfigStore } from ${JSON.stringify(module)};
      try { new PluginConfigStore(process.argv[1]).set('strategy.ai-insight', false, JSON.parse(process.argv[2])); }
      catch { process.exitCode = 1; }`;
    const attempt = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          'bun',
          ['--no-env-file', '-e', script, store.path, JSON.stringify(initial)],
          { stdio: 'ignore' },
        );
        child.on('error', reject);
        child.on('exit', resolve);
      });
    expect((await Promise.all([attempt(), attempt()])).sort()).toEqual([0, 1]);
    expect(store.read()).toMatchObject({
      ok: true,
      config: { revision: 2, entries: { 'strategy.ai-insight': { epoch: 2, enabled: false } } },
    });
  });
});
