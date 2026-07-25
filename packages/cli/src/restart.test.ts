import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { findPidOnPort, killPid, waitForProcessExit } from './restart.js';

/**
 * restart helpers —— lsof + 信号管理。
 * 不启动真实 web，借空闲端口 + 临时 sleep 子进程验证探活与终止。
 */

const spawnSleepProcess = (): number => {
  const proc = spawn('sh', ['-c', 'sleep 30'], {
    stdio: 'ignore',
  });
  if (proc.pid === undefined) throw new Error('failed to spawn test process');
  return proc.pid;
};

/** 预扫描空闲端口（30000–30999）。 */
const reserveFreePort = async (): Promise<number> => {
  for (let p = 30_000; p < 31_000; p += 1) {
    const pid = await findPidOnPort(p);
    if (pid === null) return p;
  }
  throw new Error('no free port in scan range');
};

describe('findPidOnPort', () => {
  it('空闲端口 → null', async () => {
    const port = await reserveFreePort();
    expect(await findPidOnPort(port)).toBeNull();
  });
});

describe('waitForProcessExit', () => {
  it('PID 已不存在 → 立即 true', async () => {
    const pid = spawnSleepProcess();
    killPid(pid, 'SIGKILL');
    expect(await waitForProcessExit(pid, 2000)).toBe(true);
  });

  it('进程在超时内未退 → false（清理后验）', async () => {
    const pid = spawnSleepProcess();
    const exited = await waitForProcessExit(pid, 500);
    killPid(pid, 'SIGKILL');
    await waitForProcessExit(pid, 2000);
    expect(exited).toBe(false);
  });
});

describe('killPid', () => {
  it('不存在的 PID 静默吞掉 ESRCH', async () => {
    const probe = spawnSleepProcess();
    killPid(probe, 'SIGKILL');
    await waitForProcessExit(probe, 2000);
    let threw: unknown = null;
    try {
      killPid(probe, 'SIGTERM');
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
  });
});
