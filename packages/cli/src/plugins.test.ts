import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigStore } from '@luoome/adapters';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdPlugins } from './plugins.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('manages plugins without initializing DB/providers and requires write plus a current version', () => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-plugin-cli-'));
  roots.push(home);
  vi.stubEnv('LUOOME_HOME', home);
  vi.stubEnv('LUOOME_EXPOSE_WRITE', 'false');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const flags = (entries: [string, string | boolean][] = []) => new Map(entries);
  expect(cmdPlugins('status', [], flags())).toBe(0);
  const status = JSON.parse(String(output.mock.calls[0]?.[0]));
  expect(status.definitions['task.strategy-schedules'].requires).toEqual([
    'business.strategy-execution',
  ]);
  expect(status.contributions['business.strategy-execution']).toContainEqual(
    expect.objectContaining({ name: 'run_strategy', effect: 'owned' }),
  );
  expect(status.runtime).toBe('not-started');
  expect(cmdPlugins('init', [], flags())).toBe(0);
  expect(cmdPlugins('init', [], flags([['apply', 'false']]))).toBe(1);
  expect(readdirSync(home)).toEqual([]);
  expect(cmdPlugins('init', [], flags([['apply', true]]))).toBe(1);
  vi.stubEnv('LUOOME_EXPOSE_WRITE', 'true');
  expect(cmdPlugins('init', [], flags([['apply', true]]))).toBe(0);
  const initial = new PluginConfigStore(join(home, 'plugins.json')).read();
  expect(initial.ok).toBe(true);
  if (!initial.ok) return;
  const expected: [string, string | boolean][] = [
    ['expected-incarnation', initial.config.incarnation],
    ['expected-revision', '1'],
    ['enabled', 'false'],
  ];
  expect(cmdPlugins('set', ['strategy.ai-insight'], flags(expected))).toBe(0);
  expect(cmdPlugins('set', ['strategy.ai-insight'], flags(expected))).toBe(1);
  expect(cmdPlugins('set', ['run_strategy'], flags(expected))).toBe(1);
  expect(output.mock.calls.some(([line]) => String(line).includes('conflict'))).toBe(true);
  expect(readdirSync(home)).toEqual(['plugins.json']);
});
