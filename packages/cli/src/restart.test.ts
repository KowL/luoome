import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  findPidOnPort,
  killPid,
  parseFuserPid,
  parseNetstatPid,
  parseSsPid,
  waitForProcessExit,
} from './restart.js';

/**
 * restart helpers —— lsof / ss / fuser / netstat + 信号管理。
 * 不启动真实 web，借空闲端口 + 临时 sleep 子进程 / 本进程监听验证探活与终止。
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

  it('监听中的端口 → 监听进程 PID', async () => {
    const port = await reserveFreePort();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    try {
      expect(await findPidOnPort(port)).toBe(process.pid);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

describe('parseSsPid', () => {
  // Linux `ss -Hltnp 'sport = :PORT'` 的真实输出形态（含 IPv4 / IPv6 / 无 users 段的行）。
  const sample = [
    'LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*',
    'LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*    users:(("nginx",pid=777,fd=6))',
    'LISTEN 0      511          0.0.0.0:5173       0.0.0.0:*    users:(("bun",pid=12345,fd=8))',
    'LISTEN 0      511             [::]:5173          [::]:*    users:(("bun",pid=12345,fd=9))',
    'LISTEN 0      511          0.0.0.0:51730      0.0.0.0:*    users:(("other",pid=54321,fd=10))',
    '',
  ].join('\n');

  it('LISTEN 行命中端口 → PID', () => {
    expect(parseSsPid(sample, 5173)).toBe(12345);
    expect(parseSsPid(sample, 8080)).toBe(777);
  });

  it('IPv6 [::]:PORT 行同样命中', () => {
    const ipv6Only =
      'LISTEN 0      511             [::]:6000          [::]:*    users:(("bun",pid=4242,fd=7))\n';
    expect(parseSsPid(ipv6Only, 6000)).toBe(4242);
  });

  it('端口前缀不误匹配（51730 ≠ 5173）', () => {
    expect(parseSsPid(sample, 51730)).toBe(54321);
    expect(
      parseSsPid('LISTEN 0 511 0.0.0.0:51730 0.0.0.0:* users:(("x",pid=1,fd=1))\n', 5173),
    ).toBeNull();
  });

  it('空输出 / 无匹配 → null', () => {
    expect(parseSsPid('', 5173)).toBeNull();
    expect(parseSsPid(sample, 9999)).toBeNull();
  });
});

describe('parseFuserPid', () => {
  it('PID 列表取首个', () => {
    expect(parseFuserPid(' 346927')).toBe(346927);
    expect(parseFuserPid('1234\n5678\n')).toBe(1234);
  });

  it('空输出 / 只有 stderr 横幅 → null', () => {
    expect(parseFuserPid('')).toBeNull();
    expect(parseFuserPid('  \n')).toBeNull();
    expect(parseFuserPid('5173/tcp:')).toBeNull();
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
