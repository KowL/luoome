// profile-seed 的补丁层行为：插件层由镜像管理，但同一个文件里还有 DSH 自己写入的 UI 设置
// （例如已读的欢迎提示版本）。整份重写会把这些用户态设置抹掉，用户每次升级都要重新点一次「继续」。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const seed = (fixture: { home: string; modules: string; plugin: string }, profile = 'luoome-web') =>
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
    ],
    { encoding: 'utf8' },
  );

const patchPath = (fixture: { home: string }, profile = 'luoome-web') =>
  join(fixture.home, 'profiles', profile, 'cordis.patch.yml');

describe('profile-seed 补丁层', () => {
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
