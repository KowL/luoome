import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkills, planSkillInstall, WORKER_ONLY_SKILLS } from './skills.js';

const ALL_SKILLS = [
  'analysis-worker',
  'decision-journal',
  'luoome-batch',
  'morning-brief',
  'post-close-review',
  'stock-deep-dive',
] as const;

const webSkills = ALL_SKILLS.filter((name) => name !== 'analysis-worker');

let root: string;
let sourceDir: string;
let targetDir: string;

const skillDirs = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'luoome-dsh-skills-'));
  sourceDir = join(root, 'repo', '.dsh', 'skills');
  targetDir = join(root, 'workspace', '.dsh', 'skills');
  for (const name of ALL_SKILLS) {
    await mkdir(join(sourceDir, name), { recursive: true });
    await writeFile(join(sourceDir, name, 'SKILL.md'), `# ${name}\n`);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DSH 技能安装按角色区分', () => {
  it('计划是纯函数：read 排除 worker 专属技能，worker 不排除', () => {
    expect(planSkillInstall([...ALL_SKILLS], 'read')).toEqual({
      install: [...webSkills].sort(),
      remove: [...WORKER_ONLY_SKILLS],
    });
    expect(planSkillInstall([...ALL_SKILLS], 'worker')).toEqual({
      install: [...ALL_SKILLS].sort(),
      remove: [],
    });
  });

  it('read 角色安装后没有 analysis-worker，其它技能都在', async () => {
    const plan = await installSkills({ sourceDir, targetDir, role: 'read' });
    expect(plan.install).not.toContain('analysis-worker');
    expect(plan.install).toHaveLength(webSkills.length);
    expect(await skillDirs(targetDir)).toEqual([...webSkills].sort());
    expect(await readFile(join(targetDir, 'stock-deep-dive', 'SKILL.md'), 'utf8')).toContain(
      'stock-deep-dive',
    );
  });

  it('worker 角色保留 analysis-worker，装全部技能', async () => {
    const plan = await installSkills({ sourceDir, targetDir, role: 'worker' });
    expect(plan.remove).toEqual([]);
    expect(await skillDirs(targetDir)).toEqual([...ALL_SKILLS].sort());
  });

  it('重复安装幂等，内容仍在', async () => {
    const first = await installSkills({ sourceDir, targetDir, role: 'read' });
    const second = await installSkills({ sourceDir, targetDir, role: 'read' });
    expect(second).toEqual(first);
    expect(await skillDirs(targetDir)).toEqual([...webSkills].sort());
    for (const name of webSkills) {
      expect(await readFile(join(targetDir, name, 'SKILL.md'), 'utf8')).toBe(`# ${name}\n`);
    }
  });

  it('worker 装过的目录切到 read 角色时清掉 analysis-worker 历史残留', async () => {
    await installSkills({ sourceDir, targetDir, role: 'worker' });
    expect(await skillDirs(targetDir)).toContain('analysis-worker');

    const plan = await installSkills({ sourceDir, targetDir, role: 'read' });
    expect(plan.remove).toEqual(['analysis-worker']);
    expect(await skillDirs(targetDir)).toEqual([...webSkills].sort());
  });

  it('源目录没有 worker 技能时，read 角色也清理目标目录的同名残留', async () => {
    await mkdir(join(targetDir, 'analysis-worker'), { recursive: true });
    await writeFile(join(targetDir, 'analysis-worker', 'SKILL.md'), '# stale\n');
    await installSkills({ sourceDir, targetDir, role: 'read' });
    expect(await skillDirs(targetDir)).toEqual([...webSkills].sort());
  });
});
