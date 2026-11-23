import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_PLUGIN_IDS } from '@luoome/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from './builtin-plugins.js';
import { inspectPluginConfig, pluginConfigWarnings } from './plugin-config-check.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-plugin-check-'));
  roots.push(dir);
  return dir;
};

const writeConfig = (dir: string, body: unknown): string => {
  const path = join(dir, 'plugins.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
};

describe('inspectPluginConfig', () => {
  it('reports missing, disabled and enabled rows without treating absence as enabled', () => {
    const dir = home();
    const path = writeConfig(dir, {
      version: 1,
      entries: {
        'strategy.ai-insight': { enabled: true },
        'business.analysis': { enabled: false },
      },
    });
    const check = inspectPluginConfig({ path });
    expect(check.file).toBe('ok');
    expect(check.summary).toMatchObject({
      total: MANAGED_PLUGIN_IDS.length,
      enabled: 1,
      disabled: 1,
      missing: MANAGED_PLUGIN_IDS.length - 2,
    });
    expect(check.plugins.find((plugin) => plugin.id === 'strategy.ai-insight')).toMatchObject({
      configured: true,
      enabled: true,
      status: 'enabled',
    });
    expect(check.plugins.find((plugin) => plugin.id === 'business.analysis')).toMatchObject({
      configured: true,
      enabled: false,
      status: 'disabled',
    });
    expect(check.plugins.find((plugin) => plugin.id === 'source.sina')?.status).toBe('missing');
  });

  it('reports a missing or invalid file as all plugins disabled', () => {
    const dir = home();
    const missing = inspectPluginConfig({ path: join(dir, 'plugins.json') });
    expect(missing.file).toBe('missing');
    expect(missing.missing).toHaveLength(MANAGED_PLUGIN_IDS.length);
    expect(missing.summary.enabled).toBe(0);

    writeFileSync(join(dir, 'plugins.json'), '{ not json');
    const invalid = inspectPluginConfig({ path: join(dir, 'plugins.json') });
    expect(invalid.file).toBe('invalid');
    expect(invalid.missing).toHaveLength(MANAGED_PLUGIN_IDS.length);
  });

  it('reports unknown ids with near-miss suggestions', () => {
    const dir = home();
    const path = writeConfig(dir, {
      version: 1,
      entries: {
        'strategy.ai-insite': { enabled: true },
        'not.a.plugin': { enabled: true },
      },
    });
    const check = inspectPluginConfig({ path });
    expect(check.summary.unknown).toBe(2);
    expect(check.unknown).toEqual([
      { id: 'strategy.ai-insite', suggestions: ['strategy.ai-insight'] },
      { id: 'not.a.plugin', suggestions: [] },
    ]);
  });

  it('startup warnings surface missing, invalid and unknown entries without rewriting', () => {
    const dir = home();
    const missing = inspectPluginConfig({ path: join(dir, 'plugins.json') });
    expect(pluginConfigWarnings(missing).join('\n')).toContain('plugins.json 缺失');

    writeFileSync(join(dir, 'plugins.json'), '{ not json');
    const invalid = inspectPluginConfig({ path: join(dir, 'plugins.json') });
    expect(pluginConfigWarnings(invalid).join('\n')).toContain('无法解析');

    const path = writeConfig(dir, {
      version: 1,
      entries: { 'not.a.plugin': { enabled: true } },
    });
    const warnings = pluginConfigWarnings(inspectPluginConfig({ path }));
    expect(warnings.join('\n')).toContain('缺少配置项');
    expect(warnings.join('\n')).toContain('未知 key：not.a.plugin');
  });

  it('reports unmet requires by the declared plugin definitions', () => {
    const dir = home();
    const path = writeConfig(dir, {
      version: 1,
      entries: {
        'business.analysis': { enabled: true },
        'source.sina': { enabled: false },
      },
    });
    const definitions = {
      ...BUILTIN_PLUGINS,
      'business.analysis': {
        ...BUILTIN_PLUGINS['business.analysis'],
        requires: ['source.sina'] as const,
      },
    };
    const check = inspectPluginConfig({ path, definitions });
    expect(check.plugins.find((plugin) => plugin.id === 'business.analysis')).toMatchObject({
      enabled: true,
      dependenciesReady: false,
      status: 'dependency_not_ready',
      dependencies: [{ id: 'source.sina', configured: true, enabled: false, ready: false }],
    });
    expect(check.summary.dependencyNotReady).toBe(1);
  });
});
