/**
 * 消费者唤醒前的免模型预检。
 *
 * 消费者每轮唤醒都是一次真实模型调用；队列长期为空时这就是纯空转开销。
 * 通过只读指标工具检查已到执行时间的任务与待回收租约。
 *
 * 退出码：0 = 有可执行任务/过期租约；1 = 无待执行工作；2 = 探测失败。
 * 探测失败不触发付费模型；下一轮重试并由宿主记录错误。
 */
import { spawnSync } from 'node:child_process';

/** 与 bootstrap 同一套解析规则：分号分隔的 k=v，值本身可能是逗号分隔的列表。 */
const parseMcpEnv = (value: string | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const pair of (value ?? '').split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
};

export const queueProbeState = (
  status: number | null,
  stdout: string,
): 'ready' | 'empty' | 'error' => {
  if (status !== 0) return 'error';
  try {
    const result = JSON.parse(stdout);
    const data = result?.data;
    if (
      result?.ok !== true ||
      !Number.isInteger(data?.readyPending) ||
      data.readyPending < 0 ||
      !Number.isInteger(data?.claimExpiredNotRecycled?.count) ||
      data.claimExpiredNotRecycled.count < 0
    )
      return 'error';
    return data.readyPending > 0 || data.claimExpiredNotRecycled.count > 0 ? 'ready' : 'empty';
  } catch {
    return 'error';
  }
};

if (import.meta.main) {
  const result = spawnSync(
    'bun',
    [
      '--no-env-file',
      'packages/cli/src/index.ts',
      'tools',
      'call',
      'get_analysis_metrics',
      '--input',
      '{}',
      '--json',
    ],
    {
      cwd: process.env.LUOOME_MCP_CWD ?? '/app',
      env: { ...process.env, ...parseMcpEnv(process.env.LUOOME_MCP_ENV) },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const state = queueProbeState(result.status, result.stdout ?? '');
  process.stdout.write(`${state}\n`);
  process.exit(state === 'ready' ? 0 : state === 'empty' ? 1 : 2);
}
