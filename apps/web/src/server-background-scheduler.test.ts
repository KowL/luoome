// startWeb 的后台调度器闸口：能力开关必须来自已解析的 options，
// 不能在调度器里绕过注入值重新读 process.env（回归：仅注入 options 时采集从不启动）。
// market-batch-scheduler 以模块 mock 计数，避免测试等 60s 定时器或访问外部行情。

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let marketBatchStarts = 0;

mock.module('./market-batch-scheduler.js', () => ({
  isMarketBatchSession: () => false,
  startMarketBatchScheduler: () => {
    marketBatchStarts += 1;
    return { tick: async () => {}, stop: () => {} };
  },
}));

const { startWeb } = await import('./server.js');

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
  mock.restore();
});

const startOnce = async (options: Parameters<typeof startWeb>[0]): Promise<number> => {
  const before = marketBatchStarts;
  const dir = mkdtempSync(join(tmpdir(), 'luoome-web-scheduler-'));
  const handle = await startWeb({ ...options, dbPath: join(dir, 'local.db') });
  try {
    return marketBatchStarts - before;
  } finally {
    await handle.stop(true);
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
