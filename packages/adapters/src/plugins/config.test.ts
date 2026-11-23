import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginConfigStore, resolvePluginConfigPath } from './config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-plugin-config-'));
  roots.push(dir);
  return dir;
};
const write = (dir: string, body: unknown) =>
  writeFileSync(join(dir, 'plugins.json'), JSON.stringify(body));

describe('plugin enablement file', () => {
  it('resolves under LUOOME_HOME', () => {
    expect(resolvePluginConfigPath({ LUOOME_HOME: '/tmp/x' })).toBe('/tmp/x/plugins.json');
  });

  it('treats a missing or invalid file as everything disabled', () => {
    const dir = home();
    const store = new PluginConfigStore(join(dir, 'plugins.json'));
    expect(store.read()).toEqual({ ok: false, reason: 'missing' });
    expect(store.isEnabled('business.analysis')).toBe(false);
    writeFileSync(join(dir, 'plugins.json'), '{ not json');
    expect(store.read()).toEqual({ ok: false, reason: 'invalid' });
    expect(store.isEnabled('business.analysis')).toBe(false);
  });

  it('reads enabled entries and ignores extra fields', () => {
    const dir = home();
    write(dir, {
      version: 1,
      incarnation: '00000000-0000-4000-8000-000000000000',
      revision: 3,
      entries: {
        'business.analysis': { enabled: true, epoch: 2 },
        'business.report': { enabled: false, epoch: 1 },
      },
    });
    const store = new PluginConfigStore(join(dir, 'plugins.json'));
    expect(store.isEnabled('business.analysis')).toBe(true);
    expect(store.isEnabled('business.report')).toBe(false);
    expect(store.isEnabled('business.watch-monitoring')).toBe(false);
  });

  it('drops unknown plugin ids instead of invalidating the whole file', () => {
    const dir = home();
    write(dir, {
      version: 1,
      entries: {
        'not.a.plugin': { enabled: true },
        'business.analysis': { enabled: true },
      },
    });
    const store = new PluginConfigStore(join(dir, 'plugins.json'));
    const read = store.read();
    expect(read.ok).toBe(true);
    expect(read.ok && Object.keys(read.config.entries)).toEqual(['business.analysis']);
    expect(store.isEnabled('business.analysis')).toBe(true);
    expect(store.inspect()).toMatchObject({
      ok: true,
      unknownIds: ['not.a.plugin'],
    });
  });

  it('inspect reports the file state without changing enablement semantics', () => {
    const dir = home();
    const store = new PluginConfigStore(join(dir, 'plugins.json'));
    expect(store.inspect()).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(dir, 'plugins.json'), '{ not json');
    expect(store.inspect()).toEqual({ ok: false, reason: 'invalid' });
    write(dir, { version: 1, entries: { 'business.analysis': { enabled: true } } });
    expect(store.inspect()).toEqual({
      ok: true,
      config: { version: 1, entries: { 'business.analysis': { enabled: true } } },
      unknownIds: [],
    });
  });

  it('still rejects a known id with a malformed entry', () => {
    const dir = home();
    write(dir, { version: 1, entries: { 'business.analysis': { enabled: 'yes' } } });
    const store = new PluginConfigStore(join(dir, 'plugins.json'));
    expect(store.read()).toEqual({ ok: false, reason: 'invalid' });
  });
});
