import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { respawnDetached } from './daemon.js';

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
    expect(command).toEqual([process.execPath, ...process.argv.slice(1)]);
    expect(options).toMatchObject({
      detached: true,
      stdio: ['ignore', expect.any(Number), expect.any(Number)],
      env: expect.objectContaining({ LUOOME_DAEMONIZED: '1' }),
    });
    expect(unref).toHaveBeenCalledOnce();
    expect(existsSync(handle.logPath)).toBe(true);
  });
});
