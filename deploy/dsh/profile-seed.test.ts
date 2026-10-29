// profile-seed 的补丁层行为：插件层由镜像管理，但同一个文件里还有 DSH 自己写入的 UI 设置
// （例如已读的欢迎提示版本）。整份重写会把这些用户态设置抹掉，用户每次升级都要重新点一次「继续」。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SEED = new URL('./profile-seed.mjs', import.meta.url).pathname;
const SKILLS = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
];
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
  return { root, home, modules, plugin };
};

const seed = (
  fixture: { home: string; modules: string; plugin: string; pocket?: string },
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
    { encoding: 'utf8' },
  );

const patchPath = (fixture: { home: string }, profile = 'luoome-web') =>
  join(fixture.home, 'profiles', profile, 'cordis.patch.yml');

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
