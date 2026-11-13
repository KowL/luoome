// @luoome/cli —— start / restart / web serve 的后台化。
//
// 默认把服务进程从终端剥离：在独立进程组重开当前命令，stdout/stderr 追加到
// LUOOME_HOME/logs/luoome.log，终端立即解放且关窗不收 SIGHUP。
// 子进程通过 LUOOME_DAEMONIZED=1 识别自身，避免无限重开。
//
// 日志按大小轮转：stdout/stderr 是继承的 fd，无法 rename 后重开，所以用
// copy + truncate（O_APPEND 下后续写入回到文件开头），历史保留在 .1 … .N。

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { luoomeHome } from './paths.js';

const DAEMON_ENV = 'LUOOME_DAEMONIZED';

export const isDaemonized = (): boolean => process.env[DAEMON_ENV] === '1';

export const daemonLogPath = (): string => join(luoomeHome(), 'logs', 'luoome.log');

export interface DaemonHandle {
  readonly pid: number;
  readonly logPath: string;
}

export interface LogRotationOptions {
  readonly maxBytes: number;
  readonly keep: number;
}

/** 单文件 100MB × 5 份，覆盖约一周的日常日志。 */
export const DEFAULT_LOG_ROTATION: LogRotationOptions = {
  maxBytes: 100 * 1024 * 1024,
  keep: 5,
};

/**
 * 超过阈值时把当前日志滚成 .1（旧 .1→.2 …），并清空当前文件。
 *
 * 返回是否发生了轮转。文件不存在或未达阈值时不做任何 IO 之外的副作用。
 */
export const rotateLogFile = (path: string, options: LogRotationOptions): boolean => {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size < options.maxBytes) return false;
  const oldest = `${path}.${options.keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = options.keep - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
};

let rotationStarted = false;

/**
 * 守护进程内启动日志轮转：启动时先检查一次，之后每分钟一次（只 stat，成本可忽略）。
 * 重复调用只生效一次。
 */
export const startLogRotation = (options: LogRotationOptions = DEFAULT_LOG_ROTATION): void => {
  if (rotationStarted) return;
  rotationStarted = true;
  const path = daemonLogPath();
  rotateLogFile(path, options);
  const timer = setInterval(() => rotateLogFile(path, options), 60_000);
  timer.unref();
};

/** 在独立进程组重开当前命令行，输出全部进日志文件；调用方打印提示后直接退出。 */
export const respawnDetached = (): DaemonHandle => {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  rotateLogFile(logPath, DEFAULT_LOG_ROTATION);
  const fd = openSync(logPath, 'a');
  try {
    const proc = Bun.spawn([process.execPath, '--no-env-file', ...process.argv.slice(1)], {
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
