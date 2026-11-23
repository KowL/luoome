/**
 * luoome restart —— 端口级进程管理辅助。
 *
 * 设计：
 * - findPidOnPort / waitForProcessExit / killPid 是 IO 包装，node + bun 通用；
 * - 不维护 PID 文件：start 排他使用同一个端口，按端口反查即可；
 * - macOS/Linux 依次尝试 lsof → ss → fuser（容器 / 极简发行版常缺其中一个）；
 * - Windows 没有这些工具，改用系统自带 netstat -ano 解析 LISTENING 行。
 */

import { spawnSync } from 'node:child_process';

/** 探测工具本身不在 PATH 上；调用方据此换下一个工具。 */
class ToolUnavailableError extends Error {}

/** 跑外部工具；工具缺失（ENOENT）抛 ToolUnavailableError，其余失败保持原样。 */
const runTool = (
  command: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined && result.error !== null) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT')
      throw new ToolUnavailableError(`未找到 ${command}（${err.message}）`);
    throw err;
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** 用 lsof 查 TCP:port 的 LISTEN 进程 PID；找不到返回 null。 */
const findPidWithLsof = (port: number): number | null => {
  const result = runTool('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  // lsof 找不到匹配：exit 1 + empty stderr，认为端口空闲。
  if (result.status !== 0 && result.stderr.trim().length > 0) {
    throw new Error(`lsof 失败 (exit ${result.status}): ${result.stderr}`);
  }
  const first = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return null;
  const pid = Number.parseInt(first, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

/** 解析 `ss -Hltnp 'sport = :PORT'` 输出，找指定端口 LISTEN 行的 PID；找不到返回 null。 */
export const parseSsPid = (output: string, port: number): number | null => {
  for (const line of output.split(/\r?\n/)) {
    // 行格式：LISTEN 0 512 127.0.0.1:5173 0.0.0.0:* users:(("bun",pid=1234,fd=8))
    const cols = line.trim().split(/\s+/);
    const localAddr = cols[3];
    if (cols[0] !== 'LISTEN' || localAddr === undefined) continue;
    const sep = localAddr.lastIndexOf(':');
    if (sep < 0 || Number.parseInt(localAddr.slice(sep + 1), 10) !== port) continue;
    // 非 root 下看不到别的用户的 socket：该行没有 users: 段，换下一行。
    const pidCol = /pid=(\d+)/.exec(line)?.[1];
    if (pidCol === undefined) continue;
    const pid = Number.parseInt(pidCol, 10);
    if (pid > 0) return pid;
  }
  return null;
};

/** 用 ss 查 TCP:port 的 LISTEN 进程 PID；找不到返回 null。 */
const findPidWithSs = (port: number): number | null => {
  const result = runTool('ss', ['-Hltnp', `sport = :${port}`]);
  if (result.status !== 0) {
    throw new Error(`ss 失败 (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return parseSsPid(result.stdout, port);
};

/** 解析 `fuser -n tcp PORT` 的 stdout（纯 PID 列表，可能跨行）；找不到返回 null。 */
export const parseFuserPid = (output: string): number | null => {
  for (const token of output.split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number.parseInt(token, 10);
    if (pid > 0) return pid;
  }
  return null;
};

/** 用 fuser 查 TCP:port 的 LISTEN 进程 PID；找不到返回 null。 */
const findPidWithFuser = (port: number): number | null => {
  // fuser 把 PID 打到 stdout，`PORT/tcp:` 横幅打到 stderr；端口空闲时 exit 1。
  const result = runTool('fuser', ['-n', 'tcp', String(port)]);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(`fuser 失败 (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return parseFuserPid(result.stdout);
};

const POSIX_PORT_FINDERS = [
  { tool: 'lsof', find: findPidWithLsof },
  { tool: 'ss', find: findPidWithSs },
  { tool: 'fuser', find: findPidWithFuser },
] as const;

/** POSIX 下按 lsof → ss → fuser 顺序查端口 PID；三者都缺失时抛错。 */
const findPidOnPortPosix = (port: number): number | null => {
  for (const { find } of POSIX_PORT_FINDERS) {
    try {
      return find(port);
    } catch (error) {
      if (!(error instanceof ToolUnavailableError)) throw error;
    }
  }
  const tools = POSIX_PORT_FINDERS.map(({ tool }) => tool).join(' / ');
  throw new Error(`无法查询端口 ${port} 的占用进程：${tools} 均不可用，请安装其中之一后重试`);
};

/** 解析 `netstat -ano -p tcp` 输出，找指定端口 LISTENING 行的 PID；找不到返回 null。 */
export const parseNetstatPid = (output: string, port: number): number | null => {
  for (const line of output.split(/\r?\n/)) {
    // 行格式：  TCP    127.0.0.1:5173      0.0.0.0:0      LISTENING     12345
    const cols = line.trim().split(/\s+/);
    const [proto, localAddr, , state, pidCol] = cols;
    if (
      cols.length < 5 ||
      proto !== 'TCP' ||
      state !== 'LISTENING' ||
      localAddr === undefined ||
      pidCol === undefined
    ) {
      continue;
    }
    const sep = localAddr.lastIndexOf(':');
    if (sep < 0 || Number.parseInt(localAddr.slice(sep + 1), 10) !== port) continue;
    const pid = Number.parseInt(pidCol, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
};

/** Windows 用 netstat 查端口占用 PID；netstat 是系统组件，缺失时直接抛错。 */
const findPidOnPortWin32 = (port: number): number | null => {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (result.status !== 0) {
    throw new Error(`netstat 失败 (exit ${result.status}): ${result.stderr}`);
  }
  return parseNetstatPid(result.stdout ?? '', port);
};

/** 按平台查 TCP:port 的 LISTEN 进程 PID；找不到返回 null。 */
export const findPidOnPort = async (port: number): Promise<number | null> => {
  if (process.platform === 'win32') return findPidOnPortWin32(port);
  return findPidOnPortPosix(port);
};

/**
 * 信号化终止 PID；ESRCH（进程已无）吞掉，其它错误抛。
 * `signal` 默认 SIGTERM，让 web / watch 走优雅退出；
 * Windows 无 POSIX 信号，libuv 统一映射为 TerminateProcess（强制结束）。
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
