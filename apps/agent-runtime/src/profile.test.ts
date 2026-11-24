import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonObject, JsonValue, RunRequest } from '@luoome/dsh-bridge/protocol';
import { HostConfigSchema } from '@luoome/dsh-bridge/runtime-config';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prepareProfile } from './profile.js';

const token = 'controlled-profile-token-123456';
const hash = `sha256:${'a'.repeat(64)}`;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  execFileSync('bun', ['--no-env-file', 'infra/dsh/build.ts'], {
    cwd: resolve('.'),
    env: { PATH: process.env.PATH ?? '' },
    stdio: 'pipe',
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const config = () =>
  HostConfigSchema.parse({
    configRef: 'fixture-v1',
    gateway: { endpoint: 'http://127.0.0.1:1/tools', token },
    model: { endpoint: 'http://127.0.0.1:1/model', token, model: 'controlled-stub' },
  });

const request = (allowSubagents?: boolean): RunRequest => ({
  protocolVersion: 1,
  runId: 'profile-run',
  conversationId: 'profile-conversation',
  manifestHash: hash,
  manifest: { protocolVersion: 1, manifestHash: hash, tools: [] },
  configRef: 'fixture-v1',
  instructions: 'Restricted profile fixture.',
  prompt: 'Profile.',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...(allowSubagents === true ? { allowSubagents: true } : {}),
});

async function prepare(allowSubagents?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'luoome-profile-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const profile = await prepareProfile(root, config(), request(allowSubagents));
  const patch = (await readFile(
    join(profile.home, 'profiles', 'luoome-restricted-v1', 'cordis.patch.yml'),
    'utf8',
  )) as string;
  return { profile, patch: JSON.parse(patch) as Array<{ insert: JsonObject[] }> };
}

const names = (entries: readonly JsonValue[]): string[] =>
  entries.map((entry) =>
    entry !== null && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string'
      ? entry.name
      : '<missing>',
  );

const OFFICIAL_COMBINATION = [
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
];

describe('restricted Profile subagent combination', () => {
  it('does not load any subagent plugin unless the run permits delegation', async () => {
    const { profile, patch } = await prepare();
    expect(patch[0]?.insert.map((entry) => entry.name)).toEqual(names(profile.entries));
    const loaded = names(profile.entries);
    for (const name of OFFICIAL_COMBINATION) expect(loaded).not.toContain(name);
    expect(loaded).not.toContain('subagent');
  });

  it('loads the official minimal combination when the run permits delegation', async () => {
    const { profile, patch } = await prepare(true);
    const loaded = names(profile.entries);
    const start = loaded.indexOf('@deepseek-ai/dsh-subagent');
    expect(loaded.slice(start, start + OFFICIAL_COMBINATION.length)).toEqual(OFFICIAL_COMBINATION);
    expect(profile.entries[start + 2]).toMatchObject({
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'spawn', toolName: 'subagent' },
    });
    // 官方组合在桥接插件之前挂载，桥接仍按同一份 entries 校验 dump-config 库存。
    const bridge = loaded.findIndex((name) => name.startsWith('/'));
    expect(bridge).toBeGreaterThan(start + OFFICIAL_COMBINATION.length - 1);
    expect(patch[0]?.insert).toEqual(profile.entries);
  });

  it('binds a different profile hash once the subagent combination is mounted', async () => {
    const off = await prepare();
    const on = await prepare(true);
    expect(on.profile.profileHash).not.toBe(off.profile.profileHash);
  });
});
