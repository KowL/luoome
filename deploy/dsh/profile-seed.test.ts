// profile-seed 的补丁层行为：插件层由镜像管理，但同一个文件里还有 DSH 自己写入的 UI 设置
// （例如已读的欢迎提示版本）。整份重写会把这些用户态设置抹掉，用户每次升级都要重新点一次「继续」。
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SEED = new URL('./profile-seed.mjs', import.meta.url).pathname;
const SKILLS = [
  'daily-market-analysis',
  'decision-journal',
  'luoome-batch',
  'morning-brief',
  'post-close-review',
  'stock-deep-dive',
  'strategy-lab',
  'strategy-result-review',
];
const PARQUET_MANIFEST = {
  name: 'parquet-wasm',
  version: '0.9.0',
  exports: {
    './node': './node/parquet_wasm.js',
    './node/parquet_wasm_bg.wasm': './node/parquet_wasm_bg.wasm',
  },
};
const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-seed-'));
  temporaries.push(root);
  const home = join(root, 'dsh-home');
  const modules = join(root, 'modules');
  const plugin = join(root, 'plugin');
  mkdirSync(join(modules, '@deepseek-ai', 'dsh'), { recursive: true });
  mkdirSync(join(plugin, 'dist'), { recursive: true });
  writeFileSync(join(plugin, 'dist', 'host.js'), 'export default {};\n');
  writeFileSync(join(plugin, 'dist', 'client.js'), 'export default {};\n');
  writeFileSync(
    join(plugin, 'package.json'),
    `${JSON.stringify({ name: 'dsh-luoome', version: '0.1.0', dsh: { client: { platform: 'web' } } })}\n`,
  );
  for (const skill of SKILLS) {
    mkdirSync(join(plugin, 'skills', skill), { recursive: true });
    writeFileSync(join(plugin, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') === 'root -g') { console.log(${JSON.stringify(modules)}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(root, 'npm-calls.jsonl'))}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ 'parquet-wasm': '0.9.0' })) process.exit(2);
const target = path.join(process.cwd(), 'node_modules', 'parquet-wasm');
fs.mkdirSync(path.join(target, 'node'), { recursive: true });
fs.writeFileSync(path.join(target, 'package.json'), ${JSON.stringify(JSON.stringify(PARQUET_MANIFEST))});
fs.writeFileSync(path.join(target, 'node', 'parquet_wasm.js'), 'module.exports = {};');
fs.writeFileSync(path.join(target, 'node', 'parquet_wasm_bg.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  return { root, home, modules, plugin, bin };
};

const seed = (
  fixture: { home: string; modules: string; plugin: string; bin: string; pocket?: string },
  profile = 'luoome-web',
) =>
  execFileSync(
    'node',
    [
      SEED,
      '--plugin',
      fixture.plugin,
      '--profile',
      profile,
      '--home',
      fixture.home,
      '--modules',
      fixture.modules,
      ...(fixture.pocket === undefined ? [] : ['--pocket', fixture.pocket]),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` } },
  );

const patchPath = (fixture: { home: string }, profile = 'luoome-web') =>
  join(fixture.home, 'profiles', profile, 'cordis.patch.yml');

const setDependencies = (plugin: string, dependencies: Record<string, string>) => {
  const path = join(plugin, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies }));
};

describe('profile-seed runtime dependencies', () => {
  it.each(['^0.9.0', '~0.9.0', 'latest', '0.8.0', 'file:../parquet'])(
    '拒绝 parquet-wasm 的非许可版本 %s',
    (version) => {
      const fixture = makeFixture();
      setDependencies(fixture.plugin, { 'parquet-wasm': version });
      expect(() => seed(fixture)).toThrow('unsupported runtime dependency');
      expect(() => readFileSync(join(fixture.root, 'npm-calls.jsonl'))).toThrow();
    },
  );

  it('拒绝未知非 DSH 运行依赖', () => {
    const fixture = makeFixture();
    setDependencies(fixture.plugin, { unknown: '1.0.0' });
    expect(() => seed(fixture)).toThrow('unsupported runtime dependency: unknown@1.0.0');
  });

  it('profile node_modules 指向外部目录时保留外部内容并退出', () => {
    const fixture = makeFixture();
    const profile = join(fixture.home, 'profiles', 'luoome-web');
    const external = join(fixture.root, 'external');
    mkdirSync(profile, { recursive: true });
    mkdirSync(join(external, '@deepseek-ai'), { recursive: true });
    const sentinel = join(external, '@deepseek-ai', 'keep.txt');
    writeFileSync(sentinel, 'keep');
    symlinkSync(external, join(profile, 'node_modules'), 'dir');
    expect(() => seed(fixture)).toThrow('outside profile');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('复用目录插件已有的有效 WASM 依赖而不运行 npm install', () => {
    const fixture = makeFixture();
    setDependencies(fixture.plugin, { 'parquet-wasm': '0.9.0' });
    const requireAdapters = createRequire(
      new URL('../../packages/adapters/package.json', import.meta.url),
    );
    const dependency = dirname(dirname(requireAdapters.resolve('parquet-wasm/node')));
    mkdirSync(join(fixture.plugin, 'node_modules'));
    symlinkSync(dependency, join(fixture.plugin, 'node_modules', 'parquet-wasm'), 'dir');
    seed(fixture);
    seed(fixture);
    const installed = join(fixture.home, 'profiles', 'luoome-web', 'node_modules', 'dsh-luoome');
    const requirePlugin = createRequire(join(installed, 'dist', 'host.js'));
    expect(typeof requirePlugin('parquet-wasm/node').readParquet).toBe('function');
    expect(
      WebAssembly.validate(
        readFileSync(requirePlugin.resolve('parquet-wasm/node/parquet_wasm_bg.wasm')),
      ),
    ).toBe(true);
    expect(() => readFileSync(join(fixture.root, 'npm-calls.jsonl'))).toThrow();
  });

  it('通过 CLI 装配 tarball 的 WASM，保持 DSH singleton identity 并复用 runtime', () => {
    const fixture = makeFixture();
    setDependencies(fixture.plugin, {
      '@deepseek-ai/dsh': '0.2.1-rc.2',
      'parquet-wasm': '0.9.0',
    });
    const sdk = join(fixture.modules, '@deepseek-ai', 'dsh');
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', main: 'index.cjs' }),
    );
    writeFileSync(join(sdk, 'index.cjs'), 'module.exports = {};');
    const tarball = join(fixture.root, 'plugin.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', fixture.root, 'plugin']);
    const packed = { ...fixture, plugin: tarball };
    seed(packed);
    const profile = join(fixture.home, 'profiles', 'luoome-web');
    const installed = join(profile, 'node_modules', 'dsh-luoome');
    const requirePlugin = createRequire(join(installed, 'dist', 'host.js'));
    const wasm = requirePlugin.resolve('parquet-wasm/node/parquet_wasm_bg.wasm');
    expect(WebAssembly.validate(readFileSync(wasm))).toBe(true);
    expect(lstatSync(join(installed, 'node_modules', 'parquet-wasm')).isSymbolicLink()).toBe(true);
    const sdkLink = join(profile, 'node_modules', '@deepseek-ai', 'dsh');
    expect(lstatSync(sdkLink).isSymbolicLink()).toBe(true);
    expect(requirePlugin('@deepseek-ai/dsh')).toBe(
      createRequire(join(sdk, 'package.json'))('./index.cjs'),
    );
    const patch =
      '- insert:\n    - id: luoome-plugin\n      name: dsh-luoome\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: fixture\n- id: llm-pi-ai\n  config:\n    providers: fixture\n';
    writeFileSync(patchPath(fixture), patch);
    seed(packed);
    expect(readFileSync(patchPath(fixture), 'utf8')).toBe(patch);
    expect(realpathSync(sdkLink)).toBe(realpathSync(sdk));
    expect(requirePlugin.resolve('parquet-wasm/node/parquet_wasm_bg.wasm')).toBe(wasm);
    const calls = readFileSync(join(fixture.root, 'npm-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(realpathSync(join(profile, 'runtime')));
    expect(calls[0].args).toContain('--ignore-scripts');
  });
});

describe('profile-seed 补丁层', () => {
  it('将 Pocket 装入实际 profile，并在重复装配时保留 UI 设置', () => {
    const fixture = makeFixture();
    const pocket = join(fixture.root, 'pocket');
    mkdirSync(pocket);
    writeFileSync(
      join(pocket, 'package.json'),
      JSON.stringify({ name: 'dsh-pocket', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    );
    seed(fixture);
    const originalPatch = readFileSync(patchPath(fixture), 'utf8');
    for (let attempt = 0; attempt < 2; attempt += 1) seed({ ...fixture, pocket });
    const profileDir = join(fixture.home, 'profiles', 'luoome-web');
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    expect(manifest.dependencies['dsh-pocket']).toBe(`file:${pocket}`);
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-pocket',
    ]);
    expect(realpathSync(join(profileDir, 'node_modules', 'dsh-pocket'))).toBe(realpathSync(pocket));
    expect(readFileSync(patchPath(fixture), 'utf8')).toBe(originalPatch);
  });

  it('首次装配写入插件层', () => {
    const fixture = makeFixture();
    seed(fixture);
    const patch = readFileSync(patchPath(fixture), 'utf8');
    expect(patch).toContain('luoome-plugin');
    expect(patch).toContain('dsh-luoome');
  });

  it('保留 DSH 自己写入的 UI 设置条目', () => {
    const fixture = makeFixture();
    seed(fixture);
    // DSH 启动后把插件层与自己的 UI 设置写进同一个文件（真实形态）。
    const settings = [
      '- id: ui-settings-general',
      '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
      '  config:',
      '    welcomeNoticeVersion: 2026-09-28.1',
      '',
    ].join('\n');
    writeFileSync(patchPath(fixture), `${readFileSync(patchPath(fixture), 'utf8')}\n${settings}`);
    seed(fixture);
    const patch = readFileSync(patchPath(fixture), 'utf8');
    expect(patch).toContain('welcomeNoticeVersion');
    expect(patch).toContain('luoome-plugin');
  });

  it('保留 DSH 写回的 YAML 补丁层（含模型 provider 配置）', () => {
    const fixture = makeFixture();
    seed(fixture);
    // DSH 写回整个补丁层时用的是 YAML，不是 seed 自己写的 JSON。
    const dshPatch = [
      '-- insert:',
      '    - id: luoome-plugin',
      '      name: dsh-luoome',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      minimax-cn:',
      '        apiKeyEnv: MINIMAX_CN_API_KEY',
      '',
    ].join('\n');
    writeFileSync(patchPath(fixture), dshPatch);
    seed(fixture);
    const patch = readFileSync(patchPath(fixture), 'utf8');
    expect(patch).toContain('apiKeyEnv: MINIMAX_CN_API_KEY');
    expect(patch).toContain('llm-pi-ai');
    expect(patch).toContain('luoome-plugin');
  });

  it('插件挂载缺失时仍然补写插件层', () => {
    const fixture = makeFixture();
    seed(fixture);
    writeFileSync(patchPath(fixture), '[]\n');
    seed(fixture);
    const patch = readFileSync(patchPath(fixture), 'utf8');
    expect(patch).toContain('luoome-plugin');
    expect(patch).toContain('dsh-luoome');
  });
});
