import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  loadProjectEnv: vi.fn(),
  createCliContext: vi.fn(),
  startWeb: vi.fn(),
  respawnDetached: vi.fn(),
  findPidOnPort: vi.fn(async () => null),
}));

vi.mock('./env.js', () => ({ loadProjectEnv: mocked.loadProjectEnv }));
vi.mock('./context.js', () => ({ createCliContext: mocked.createCliContext }));
vi.mock('./daemon.js', () => ({
  isDaemonized: () => false,
  respawnDetached: mocked.respawnDetached,
}));
vi.mock('./restart.js', () => ({
  findPidOnPort: mocked.findPidOnPort,
  killPid: vi.fn(),
  waitForProcessExit: vi.fn(),
}));
vi.mock('@luoome/web', () => ({ startWeb: mocked.startWeb }));

import { runCli } from './index.js';

describe('CLI Web entry', () => {
  const originalExecArgv = process.execArgv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.execArgv = ['--no-env-file'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.execArgv = originalExecArgv;
    vi.restoreAllMocks();
  });

  it.each([['start'], ['restart'], ['web', 'serve']])(
    '%j 使用相同 Web 入口，不加载单机环境或启动单机 watch，并等待 SIGTERM 后关闭',
    async (...command) => {
      let finishStop: (() => void) | undefined;
      const stop = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      );
      mocked.startWeb.mockResolvedValue({ port: 5173, stop });

      const running = runCli([...command, '--foreground']);
      await vi.waitFor(() => expect(mocked.startWeb).toHaveBeenCalledOnce());
      expect(mocked.startWeb).toHaveBeenCalledWith({ port: 5173, host: '127.0.0.1' });
      expect(mocked.loadProjectEnv).not.toHaveBeenCalled();
      expect(mocked.createCliContext).not.toHaveBeenCalled();
      let completed = false;
      void running.then(() => {
        completed = true;
      });

      process.emit('SIGTERM');
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(true));
      expect(completed).toBe(false);
      finishStop?.();
      expect(await running).toBe(0);
    },
  );

  it('未禁用 Bun 隐式 dotenv 时在后台启动或本地环境加载前拒绝', async () => {
    process.execArgv = [];
    await expect(runCli(['start'])).rejects.toThrow('必须禁用隐式环境文件');
    expect(mocked.loadProjectEnv).not.toHaveBeenCalled();
    expect(mocked.respawnDetached).not.toHaveBeenCalled();
    expect(mocked.startWeb).not.toHaveBeenCalled();
  });

  it('保留单机查询命令的显式环境加载', async () => {
    expect(await runCli(['tools', 'list', '--json'])).toBe(0);
    expect(mocked.loadProjectEnv).toHaveBeenCalledOnce();
    expect(mocked.startWeb).not.toHaveBeenCalled();
  });
});
