import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSettingsStore } from './mcp-settings.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-mcp-settings-'));
  roots.push(root);
  return new McpSettingsStore({ LUOOME_HOME: root });
};
const input = (store: McpSettingsStore) => ({
  enabled: true,
  tools: ['search_docs'],
  scenarios: ['research'],
  revision: store.read().revision,
});

describe('MCP settings persistence', () => {
  it('offers disabled builtin docs without starting or persisting a service, then saves and reloads exact allowlists', () => {
    const store = setup();
    expect(store.read().services).toEqual([
      {
        id: 'docs',
        label: 'luoome 文档检索',
        enabled: false,
        tools: ['search_docs'],
        scenarios: ['research'],
      },
    ]);
    expect(existsSync(store.configPath)).toBe(false);
    const saved = store.save('docs', input(store));
    expect(saved.services[0]?.enabled).toBe(true);
    const reopened = new McpSettingsStore({ LUOOME_MCP_CONFIG: store.configPath });
    expect(reopened.read()).toEqual(saved);
    expect(statSync(store.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved)).not.toContain('command');
    expect(JSON.stringify(saved)).not.toContain('args');
    expect(JSON.stringify(saved)).not.toContain(store.configPath);
    expect(
      store.save('docs', { ...input(store), enabled: false, tools: [], scenarios: ['review'] })
        .services[0],
    ).toMatchObject({ enabled: false, tools: [], scenarios: ['review'] });
  });

  it('preserves trusted launch configuration and other services; rejects executable injection and stale writes', () => {
    const store = setup();
    const service = {
      enabled: true,
      command: '/trusted/local-program',
      args: ['private-argument'],
      tools: ['lookup'],
      scenarios: ['research'],
    };
    writeFileSync(
      store.configPath,
      JSON.stringify({ version: 1, services: { custom: service, other: service } }),
    );
    const original = readFileSync(store.configPath, 'utf8');
    const first = input(store);
    expect(() => store.save('custom', { ...first, command: '/other-program' })).toThrow();
    expect(() => store.save('custom', { ...first, args: ['replace'] })).toThrow();
    expect(() => store.save('unregistered', first)).toThrow('服务尚未登记');
    expect(readFileSync(store.configPath, 'utf8')).toBe(original);
    expect(JSON.stringify(store.read())).not.toContain('private-argument');
    store.save('custom', { ...first, enabled: false, tools: ['lookup'], scenarios: ['general'] });
    const next = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(next.services.custom).toEqual({ ...service, enabled: false, scenarios: ['general'] });
    expect(next.services.other).toEqual(service);
    expect(() => store.save('custom', first)).toThrow('配置已变更');
  });

  it('rejects malformed configs and invalid allowlists without overwriting the file', () => {
    const store = setup();
    for (const raw of ['', '{broken']) {
      writeFileSync(store.configPath, raw);
      expect(store.read().configError).toContain('配置文件无效');
      expect(() => store.save('docs', input(store))).toThrow();
      expect(readFileSync(store.configPath, 'utf8')).toBe(raw);
    }
    rmSync(store.configPath);
    for (const invalid of [
      { tools: ['*'] },
      { tools: ['lookup', 'lookup'] },
      { scenarios: [] },
      { scenarios: ['shell'] },
    ]) {
      expect(() => store.save('docs', { ...input(store), ...invalid })).toThrow();
    }
    expect(existsSync(store.configPath)).toBe(false);
  });
});
