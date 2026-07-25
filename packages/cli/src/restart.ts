/**
 * luoome restart —— 端口级进程管理辅助（macOS/Linux，使用 lsof）。
 *
 * 设计：
 * - findPidOnPort / waitForProcessExit / killPid 是 IO 包装，node + bun 通用；
 * - 不维护 PID 文件：start 排他使用同一个端口，按端口反查即可；
 * - lsof 在 Alpine / 极简 Linux 上可能缺失，调用方需先看环境。
 */

import { spawnSync } from 'node:child_process';

const LSOF = 'lsof';

/** 用 lsof 查 TCP:port 的 LISTEN 进程 PID；找不到返回 null；lsof 不可用抛错。 */
export const findPidOnPort = async (port: number): Promise<number | null> => {
  const result = spawnSync(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (result.error !== undefined && result.error !== null) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`未找到 ${LSOF}（${err.message}）`);
    }
    throw err;
  }
  // lsof 找不到匹配：exit 1 + empty stderr，认为端口空闲。
  if (result.status !== 0 && (result.stderr ?? '').trim().length > 0) {
    throw new Error(`lsof 失败 (exit ${result.status}): ${result.stderr}`);
  }
  const first = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return null;
  const pid = Number.parseInt(first, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

/**
 * 信号化终止 PID；ESRCH（进程已无）吞掉，其它错误抛。
 * `signal` 默认 SIGTERM，让 web / watch 走优雅退出。
 */
export const killPid = (pid: number, signal: NodeJS.Signals = 'SIGTERM'): void => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
};

/**
 * 轮询 PID 是否退出；timeoutMs 内退出返回 true，超时返回 false。
 * 用 `kill(pid, 0)` 做探活（不发信号，仅查权限）。
 */
export const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } catch {
      return true;
    }
  }
  return false;
};
