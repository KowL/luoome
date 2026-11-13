import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { respawnDetached, rotateLogFile } from './daemon.js';

describe('respawnDetached', () => {
  const originalHome = process.env.LUOOME_HOME;
  let testHome: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.LUOOME_HOME;
    else process.env.LUOOME_HOME = originalHome;
    if (testHome !== undefined) rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  });

  it('用独立进程组重开当前 Bun 命令', () => {
    testHome = mkdtempSync(join(tmpdir(), 'luoome-daemon-'));
    process.env.LUOOME_HOME = testHome;
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ pid: 321, unref }));
    vi.stubGlobal('Bun', { spawn });

    const handle = respawnDetached();

    expect(handle).toEqual({ pid: 321, logPath: join(testHome, 'logs', 'luoome.log') });
    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0] as unknown as [
      readonly string[],
      Record<string, unknown>,
    ];
    expect(command).toEqual([process.execPath, '--no-env-file', ...process.argv.slice(1)]);
    expect(options).toMatchObject({
      detached: true,
      stdio: ['ignore', expect.any(Number), expect.any(Number)],
      env: expect.objectContaining({ LUOOME_DAEMONIZED: '1' }),
    });
    expect(unref).toHaveBeenCalledOnce();
    expect(existsSync(handle.logPath)).toBe(true);
  });
});

describe('rotateLogFile', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('未达阈值不轮转', () => {
    dir = mkdtempSync(join(tmpdir(), 'luoome-log-'));
    const path = join(dir, 'luoome.log');
    writeFileSync(path, 'small');
    expect(rotateLogFile(path, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('small');
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('超过阈值滚成 .1 并清空当前文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'luoome-log-'));
    const path = join(dir, 'luoome.log');
    writeFileSync(path, 'x'.repeat(2048));
    expect(rotateLogFile(path, { maxBytes: 1024, keep: 3 })).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(2048);
  });

  it('按 keep 上限移位并丢弃最旧一份', () => {
    dir = mkdtempSync(join(tmpdir(), 'luoome-log-'));
    const path = join(dir, 'luoome.log');
    writeFileSync(path, 'new'.repeat(512));
    writeFileSync(`${path}.1`, 'one');
    writeFileSync(`${path}.2`, 'two');
    writeFileSync(`${path}.3`, 'three');
    expect(rotateLogFile(path, { maxBytes: 1024, keep: 3 })).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(1536);
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('one');
    expect(readFileSync(`${path}.3`, 'utf8')).toBe('two');
    expect(existsSync(`${path}.4`)).toBe(false);
  });
});
