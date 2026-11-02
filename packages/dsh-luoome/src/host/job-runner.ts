import type { Context } from '@deepseek-ai/cordis';
// **必须 import 这个包**：它通过 `declare module '@deepseek-ai/cordis'` 给
// `Context` 加上 `jobs: JobRegistry`。只 import 具体类型文件不会触发合并。
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs';
import type { JobRunner, JobRunnerHandle, KillOutcome } from '@luoome/core';

/**
 * 宿主侧 `JobRunner` 实现（REQ-M5-01 第三批）。
 *
 * ## 为什么实现在这里，不在 `packages/tools`
 *
 * `tools` **不得 import `@deepseek-ai/dsh-*`**（分层底线，`check:layers` 守着）。
 * 领域只认 `core` 的窄契约，宿主能力在这里兑现。
 *
 * ## 与 DSH `JobRegistry` 的对应
 *
 * | 本接口 | DSH |
 * |---|---|
 * | `start(spec)` | `ctx.jobs.start({ kind, label, run })` —— **同步**返回 `JobId` |
 * | `kill(id)` | `ctx.jobs.kill(id)` → `'requested' \| 'already-finished'` |
 * | `get(id)` | `ctx.jobs.get(id)` → `JobView`（`status` + 环形输出） |
 *
 * ## 输出的来源
 *
 * 我们**自己累积** `append` 的文本（`JobRunnerHandle.append`），
 * 而不是每次去读宿主环形缓冲：
 * 领域要的是「这次执行产出了什么」，读宿主 ring 还要处理游标与丢失标记，
 * 那是宿主消费面的事（`JobRegistry.read`）。这里只做**记录**。
 */
export const createDshJobRunner = (ctx: Context): JobRunner => {
  /** 每个 job 已累积的输出（`append` 写入，`get` 读回）。 */
  const outputs = new Map<string, string>();
  /** 取消标志：`kill` 置位，`run` 侧通过 `handle.cancelled` 感知。 */
  const killed = new Set<string>();
  type LocalStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  const records = new Map<string, LocalStatus>();

  return {
    start({ label, run }) {
      /**
       * **同步**调用 `ctx.jobs.start`：它返回 `JobId` 而不等待工作完成。
       * `run` 是同步返回 hooks 的 —— 真正的等待发生在 `hooks.done`，
       * 由宿主在后台 settle。这里**不 await**，否则受理又会变成慢路径。
       */
      const id = ctx.jobs.start({
        kind: 'luoome-analysis' as never,
        label,
        run: (job: JobHandle) => {
          outputs.set(String(job.id), '');
          void (async () => {
            try {
              const result = await run({
                append: (text) => {
                  outputs.set(String(job.id), (outputs.get(String(job.id)) ?? '') + text);
                  job.append(text);
                },
                get cancelled() {
                  return killed.has(String(job.id));
                },
              } satisfies JobRunnerHandle);
              void result;
              records.set(String(job.id), killed.has(String(job.id)) ? 'killed' : 'completed');
            } catch {
              records.set(String(job.id), 'failed');
            }
          })();
          return {
            cancel: () => {
              killed.add(String(job.id));
              records.set(String(job.id), 'stopping');
            },
            // `done` 由宿主在 `run` 返回后 settle；这里给一个已落定的 Promise
            // （工作生命周期由上面的 async 块自己管，不额外阻塞宿主）。
            done: Promise.resolve({ status: 'completed' as const }),
          };
        },
      });
      return String(id);
    },

    kill(jobId: string, reason?: string): KillOutcome {
      killed.add(jobId);
      return ctx.jobs.kill(jobId as JobId, undefined, reason) as KillOutcome;
    },

    get(jobId: string) {
      const view = ctx.jobs.get(jobId as JobId);
      const local = records.get(jobId);
      return {
        // 宿主状态优先；本地记录兜底（`run` 尚未 settle 时宿主可能还没更新）。
        status: (view?.status ?? local ?? 'running') as
          | 'running'
          | 'stopping'
          | 'completed'
          | 'killed'
          | 'failed',
        output: outputs.get(jobId) ?? '',
      };
    },
  };
};
