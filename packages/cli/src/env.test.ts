import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnv } from './env.js';

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
    writeFileSync(file, 'LUOOME_LLM_PROVIDER=openai-compatible\nLUOOME_LLM_API_KEY=sk-test\n');
    const target: Record<string, string | undefined> = {
      LUOOME_LLM_PROVIDER: 'anthropic', // 已设置 → 不被文件覆盖
    };
    const applied = loadProjectEnv([file], target);
    expect(target.LUOOME_LLM_PROVIDER).toBe('anthropic');
    expect(target.LUOOME_LLM_API_KEY).toBe('sk-test');
    expect(applied).toEqual(['LUOOME_LLM_API_KEY']);
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
});
