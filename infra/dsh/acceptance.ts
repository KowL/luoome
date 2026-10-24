import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const root = await mkdtemp(join(tmpdir(), 'luoome-web-acceptance-'));
const profileDir = join(root, 'profiles', 'luoome-acceptance');
await mkdir(profileDir, { recursive: true });
await mkdir(join(root, 'workspace'));
await symlink(
  join(repo, 'node_modules/.bun/node_modules'),
  join(profileDir, 'node_modules'),
  'dir',
);
const fixtureDir = join(root, 'fixture');
await mkdir(fixtureDir);
await symlink(
  join(repo, 'node_modules/.bun/node_modules'),
  join(fixtureDir, 'node_modules'),
  'dir',
);
const built = await Bun.build({
  entrypoints: [join(repo, 'packages/dsh-luoome/src/testing/web-fixture.ts')],
  outdir: fixtureDir,
  target: 'node',
  format: 'esm',
  external: ['@deepseek-ai/*'],
});
if (!built.success) throw new AggregateError(built.logs);
const client = await Bun.build({
  entrypoints: [join(repo, 'packages/dsh-luoome/src/client/operations.js')],
  target: 'browser',
  format: 'cjs',
  external: ['react'],
});
if (!client.success) throw new AggregateError(client.logs);
await writeFile(
  join(fixtureDir, 'client.js'),
  `window.__ModuleLoader__.load({id:"@luoome/dsh-acceptance",factory:(require)=>{var module={exports:{}};var exports=module.exports;${await client.outputs[0].text()};return module.exports;}});`,
);
await writeFile(
  join(fixtureDir, 'package.json'),
  JSON.stringify({
    name: '@luoome/dsh-acceptance',
    type: 'module',
    version: '0.1.0',
    exports: { '.': './web-fixture.js', './client': './client.js' },
    dsh: {
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
      },
    },
  }),
);
const kind = process.argv[2] ?? 'web';
const state = process.argv[3] ?? 'empty';
if (!['web', 'probe', 'worker'].includes(kind) || !['empty', 'ready', 'error'].includes(state))
  throw new Error('Usage: acceptance.ts [web|probe|worker] [empty|ready|error]');
const plugin = join(fixtureDir, kind === 'web' ? 'web-fixture.js' : `${kind}.js`);
if (kind !== 'web')
  await writeFile(
    plugin,
    `export { ${kind === 'probe' ? 'applyProbe' : 'applyWorker'} as apply } from './web-fixture.js'; export const inject = ${JSON.stringify(kind === 'probe' ? [] : ['llm', 'agentLoop'])};`,
  );
const patch: unknown[] = [
  { id: 'session-title-llm', disabled: true },
  { id: 'llm-deepseek', disabled: true },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'llm-pi-ai', disabled: true },
  { id: 'agent-default-model', config: { provider: 'luoome-fixture', model: 'scripted' } },
  { id: 'approval', config: { policy: 'ask' } },
  { id: 'working-directory', config: { defaultDirectory: join(root, 'workspace') } },
  { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: join(root, 'workspace') } },
  { id: 'hmr', disabled: true },
  { insert: [{ id: 'luoome-acceptance', name: plugin, config: { state } }] },
];
if (kind === 'web') {
  patch.push({
    id: 'workspace-controller',
    config: { documentsDirectory: join(root, 'documents') },
  });
  patch.push({ id: 'agent-preset-registry', config: { default: 'luoome-acceptance' } });
  patch.push({
    insert: [
      {
        id: 'preset-luoome-acceptance',
        name: '@deepseek-ai/dsh-agent-preset',
        config: { id: 'luoome-acceptance', label: 'Luoome 隔离验收', plugins: [] },
      },
    ],
  });
} else if (kind === 'probe') {
  // No headless runner, provider, Agent, or browser is needed for a probe.
  patch.push({ id: 'agent-loop', disabled: true });
}
await writeFile(
  join(profileDir, 'package.json'),
  JSON.stringify({
    name: 'dsh-profile-luoome-acceptance',
    private: true,
    type: 'module',
    dependencies: {},
    dsh: {
      profile: {
        bundles:
          kind === 'probe'
            ? ['@deepseek-ai/dsh-base']
            : [
                '@deepseek-ai/dsh-base',
                kind === 'web' ? '@deepseek-ai/dsh-web-app' : '@deepseek-ai/dsh-headless',
              ],
      },
    },
  }),
);
await writeFile(join(profileDir, 'cordis.yml'), '[]\n');
await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
const cli = resolve(repo, 'node_modules/.bun/node_modules/@deepseek-ai/dsh/lib/bin.js');
await writeFile(
  join(root, 'launch.json'),
  JSON.stringify({
    cli,
    root,
    cwd: join(root, 'workspace'),
    kind,
    profile: 'luoome-acceptance',
    args:
      kind === 'web' ? ['--no-open', '--port', '0'] : kind === 'worker' ? ['queue acceptance'] : [],
  }),
);
process.stdout.write(`${root}\n`);
