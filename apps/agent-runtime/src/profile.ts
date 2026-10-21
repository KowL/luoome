import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type JsonValue, type RunRequest } from '@luoome/dsh-bridge/protocol';
import type { HostConfig } from '../../../packages/dsh-bridge/src/runtime-config.js';

export const PROFILE_NAME = 'luoome-restricted-v1';
export function hashJson(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function installedDshBin(): string {
  const sdkManifest = import.meta.resolve('@deepseek-ai/dsh-sdk-client/package.json');
  const require = createRequire(sdkManifest);
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = require(manifestPath) as { bin: { dsh: string }; version: string };
  if (manifest.version !== '0.2.1-rc.2') throw new Error('Unapproved DSH runtime version');
  return resolve(dirname(manifestPath), manifest.bin.dsh);
}

export async function prepareProfile(root: string, config: HostConfig, run: RunRequest) {
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const profile = join(home, 'profiles', PROFILE_NAME);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const pluginSource = fileURLToPath(
    new URL('../../../packages/dsh-bridge/dist/plugin.js', import.meta.url),
  );
  const pluginCode = await readFile(pluginSource);
  const plugin = join(profile, 'luoome-run-bridge.js');
  await writeFile(plugin, pluginCode, { mode: 0o600 });
  const entries: JsonValue[] = [
    { id: 'sdk-startup', name: '@deepseek-ai/dsh-sdk-app', config: { profile: PROFILE_NAME } },
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
    {
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      config: { includeHarnessIdentity: false, includeRuntimeContext: false },
    },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agents', name: '@deepseek-ai/dsh-agent' },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-local' },
    {
      id: 'working-directory',
      name: '@deepseek-ai/dsh-working-directory',
      config: { defaultDirectory: workspace },
    },
    {
      id: 'agent-loop',
      name: '@deepseek-ai/dsh-agent-loop',
      config: { agents: [], maxParallelToolCalls: 1 },
    },
    {
      id: 'session-storage',
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      config: { root: join(home, 'sessions'), compression: 'none' },
    },
  ];
  const native = run.manifest.tools.filter((tool) => tool.executionLocation === 'runtime-native');
  if (native.length) {
    if (!config.native || native.length !== 1 || native[0]?.name !== 'web_fetch') {
      throw new Error('Only explicitly authorized web_fetch may execute natively');
    }
    entries.push(
      {
        id: 'web',
        name: '@deepseek-ai/dsh-web',
        config: { fetchProvider: config.native.fixtures ? 'luoome-fixture' : 'http' },
      },
      {
        id: 'web-http',
        name: '@deepseek-ai/dsh-web-fetch-http',
        config: {
          maxResponseBytes: 1000000,
          maxBodyChars: 50000,
          timeoutMs: config.limits.toolTimeoutMs,
          maxRedirects: 0,
        },
      },
      {
        id: 'tool-web',
        name: '@deepseek-ai/dsh-tool-web',
        config: {
          search: false,
          fetch: true,
          fetchTimeoutMs: config.limits.toolTimeoutMs,
          fetchMaxOutputChars: 100000,
        },
      },
    );
  }
  entries.push(
    { id: 'luoome-run-bridge', name: plugin },
    {
      id: 'sdk-server',
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server',
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    },
  );
  const patches = [{ insert: entries }];
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: [] } } }),
    { mode: 0o600 },
  );
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patches), { mode: 0o600 });
  return {
    home,
    workspace,
    profileHash: hashJson({
      patches,
      bridgeSha256: createHash('sha256').update(pluginCode).digest('hex'),
    }),
    entries,
  };
}
