import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultEnvFiles, loadProjectEnv } from './env.js';

describe('cli/env loadProjectEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'luoome-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件存在时注入未设置的 key；真实 env 优先', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'LUOOME_AI_CONFIG=/tmp/models.json\nMINIMAX_API_KEY=sk-test\n');
    const target: Record<string, string | undefined> = {
      LUOOME_AI_CONFIG: '/configured/models.json', // 已设置 → 不被文件覆盖
    };
    const applied = loadProjectEnv([file], target);
    expect(target.LUOOME_AI_CONFIG).toBe('/configured/models.json');
    expect(target.MINIMAX_API_KEY).toBe('sk-test');
    expect(applied).toEqual(['MINIMAX_API_KEY']);
  });

  it('多个文件按序加载，先加载的不被后加载的覆盖', () => {
    const userFile = join(dir, 'user.env');
    const projectFile = join(dir, 'project.env');
    writeFileSync(userFile, 'A=user\nB=user\n');
    writeFileSync(projectFile, 'B=project\n');
    const target: Record<string, string | undefined> = {};
    loadProjectEnv([userFile, projectFile], target);
    expect(target.A).toBe('user');
    expect(target.B).toBe('user'); // 先加载的 user.env 已占位，project.env 不覆盖
  });

  it('文件不存在静默跳过', () => {
    const target: Record<string, string | undefined> = {};
    const applied = loadProjectEnv([join(dir, 'missing.env')], target);
    expect(applied).toEqual([]);
    expect(target).toEqual({});
  });

  it('文件内容非法行静默跳过，合法行仍生效', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'GARBAGE LINE\nOK=1\n');
    const target: Record<string, string | undefined> = {};
    loadProjectEnv([file], target);
    expect(target.OK).toBe('1');
  });

  it('defaultEnvFiles 解析的项目根包含 package.json', () => {
    const files = defaultEnvFiles();
    expect(files.length).toBe(2);
    const projectEnv = files[1];
    expect(projectEnv?.endsWith('.env')).toBe(true);
    if (projectEnv === undefined) throw new Error('projectEnv missing');
    // 项目根必须是指向 luoome 仓库根（存在 package.json）
    const projectRoot = join(projectEnv, '..');
    expect(existsSync(join(projectRoot, 'package.json'))).toBe(true);
  });
});
