import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { findPidOnPort, killPid, parseNetstatPid, waitForProcessExit } from './restart.js';

/**
 * restart helpers —— lsof / netstat + 信号管理。
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

describe('parseNetstatPid', () => {
  // Windows `netstat -ano -p tcp` 的真实输出形态（含 IPv4 / IPv6 / 非 LISTENING 行）。
  const sample = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:5173         127.0.0.1:60000        ESTABLISHED     12345',
    '  TCP    127.0.0.1:60000        127.0.0.1:5173         ESTABLISHED     6789',
    '  TCP    [::1]:5173             [::]:0                 LISTENING       22222',
    '',
  ].join('\r\n');

  it('LISTENING 行命中端口 → PID', () => {
    expect(parseNetstatPid(sample, 5173)).toBe(12345);
  });

  it('ESTABLISHED 行的对端端口不误判', () => {
    expect(parseNetstatPid(sample, 60000)).toBeNull();
  });

  it('无匹配 → null', () => {
    expect(parseNetstatPid(sample, 9999)).toBeNull();
    expect(parseNetstatPid('', 5173)).toBeNull();
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
