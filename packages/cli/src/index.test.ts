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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      ['start', '--no-watch'],
      { port: 5173, host: '127.0.0.1', intradayPlanSchedulerEnabled: false },
    ],
    [
      ['restart', '--no-watch'],
      { port: 5173, host: '127.0.0.1', intradayPlanSchedulerEnabled: false },
    ],
    [['web', 'serve'], { port: 5173, host: '127.0.0.1' }],
  ])(
    '%j 启动单机多账户 Web 入口，加载环境并等待 SIGTERM 后优雅关闭',
    async (command, expectedArgs) => {
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
      expect(mocked.startWeb).toHaveBeenCalledWith(expectedArgs);
      expect(mocked.loadProjectEnv).toHaveBeenCalledOnce();
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

  it('未带 --foreground 时通过 respawnDetached 后台启动', async () => {
    mocked.respawnDetached.mockReturnValue({ pid: 4242, logPath: '/tmp/luoome.log' });
    expect(await runCli(['web', 'serve'])).toBe(0);
    expect(mocked.loadProjectEnv).toHaveBeenCalledOnce();
    expect(mocked.respawnDetached).toHaveBeenCalledOnce();
    expect(mocked.startWeb).not.toHaveBeenCalled();
  });

  it('保留单机查询命令的显式环境加载', async () => {
    expect(await runCli(['tools', 'list', '--json'])).toBe(0);
    expect(mocked.loadProjectEnv).toHaveBeenCalledOnce();
    expect(mocked.startWeb).not.toHaveBeenCalled();
  });
});
