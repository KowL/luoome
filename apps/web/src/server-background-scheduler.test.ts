// 能力开关以启动参数为准；检查实际插件资源投影，定时器首次运行前即停止宿主。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setPluginEnabled } from '@luoome/tools/testing';
import { startWeb } from './server.js';

const SAVED_ENV = [
  'LUOOME_EXPOSE_WRITE',
  'LUOOME_EXPOSE_EXTERNAL',
  'LUOOME_MARKET_PROVIDER',
  'LUOOME_MARKET_SOURCES',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of SAVED_ENV) savedEnv[name] = process.env[name];
  delete process.env.LUOOME_EXPOSE_WRITE;
  delete process.env.LUOOME_EXPOSE_EXTERNAL;
  // startWeb 读 process.env 组装 context；这里只补齐启动所需的市场源配置，
  // afterAll 原样恢复，避免污染同进程的其它 web 测试。
  process.env.LUOOME_MARKET_PROVIDER = 'real';
  process.env.LUOOME_MARKET_SOURCES = 'sina';
});

afterAll(() => {
  for (const name of SAVED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const startOnce = async (options: Parameters<typeof startWeb>[0]): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-web-scheduler-'));
  setPluginEnabled(join(dir, 'plugins.json'), 'task.collect-market-snapshot', true);
  const previousHome = process.env.LUOOME_HOME;
  process.env.LUOOME_HOME = dir;
  const handle = await startWeb({ ...options, dbPath: join(dir, 'local.db') });
  try {
    const task = handle.tasks?.status().find((row) => row.id === 'task.collect-market-snapshot');
    return Number(task?.phase === 'ready');
  } finally {
    await handle.stop(true);
    if (previousHome === undefined) delete process.env.LUOOME_HOME;
    else process.env.LUOOME_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('startWeb 后台采集调度器', () => {
  it('显式注入 exposeWrite + exposeExternal（无环境变量）时启动盘中批次采集', async () => {
    expect(await startOnce({ port: 0, exposeWrite: true, exposeExternal: true })).toBe(1);
  });

  it('只注入 write 或只注入 external 时不启动采集', async () => {
    expect(await startOnce({ port: 0, exposeWrite: true })).toBe(0);
    expect(await startOnce({ port: 0, exposeExternal: true })).toBe(0);
  });

  it('既未注入也未设置环境变量时不启动采集', async () => {
    expect(await startOnce({ port: 0 })).toBe(0);
  });
});
