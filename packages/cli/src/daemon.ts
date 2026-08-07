// @luoome/cli —— start / restart / web serve 的后台化。
//
// 默认把服务进程从终端剥离：在独立进程组重开当前命令，stdout/stderr 追加到
// LUOOME_HOME/logs/luoome.log，终端立即解放且关窗不收 SIGHUP。
// 子进程通过 LUOOME_DAEMONIZED=1 识别自身，避免无限重开。

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { luoomeHome } from './paths.js';

const DAEMON_ENV = 'LUOOME_DAEMONIZED';

export const isDaemonized = (): boolean => process.env[DAEMON_ENV] === '1';

export const daemonLogPath = (): string => join(luoomeHome(), 'logs', 'luoome.log');

export interface DaemonHandle {
  readonly pid: number;
  readonly logPath: string;
}

/** 在独立进程组重开当前命令行，输出全部进日志文件；调用方打印提示后直接退出。 */
export const respawnDetached = (): DaemonHandle => {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const proc = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, [DAEMON_ENV]: '1' },
    });
    proc.unref();
    return { pid: proc.pid, logPath };
  } finally {
    closeSync(fd);
  }
};
