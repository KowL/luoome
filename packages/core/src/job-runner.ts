import { z } from 'zod';

/**
 * **长任务执行器**的窄契约（REQ-M5-01）。
 *
 * ## 为什么是窄接口，而不是把宿主 `JobRegistry` 放进 `ToolContext`
 *
 * `packages/tools` **不得 import `@deepseek-ai/dsh-*`** —— 那是分层底线
 * （`infra/check-layers.ts` 也守着）。所以领域只认这个只包含三个方法的契约，
 * 宿主实现（DSH `JobRegistry`）由 `packages/dsh-luoome` 提供。
 *
 * 与 `reportArtifacts` / `automationTierStore` **同一模式**，不是新发明。
 */

/**
 * 宿主侧的状态。
 *
 * ⚠️ 注意 `running` / `stopping` **不是终态** —— 它们**不进**下面的映射，
 * 也**不写回领域**。理由见 `DSH_TERMINAL_TO_DOMAIN`。
 */
export const HostJobStatusSchema = z.enum(['running', 'stopping', 'completed', 'killed', 'failed']);
export type HostJobStatus = z.infer<typeof HostJobStatusSchema>;

/** 宿主侧的**终态**。刻意排除 `running` / `stopping`。 */
export const HostTerminalStatusSchema = z.enum(['completed', 'killed', 'failed']);
export type HostTerminalStatus = z.infer<typeof HostTerminalStatusSchema>;

/**
 * 宿主终态 → 领域状态。
 *
 * ## 为什么 `running` / `stopping` 不在映射里
 *
 * - 映射 `stopping` 到 `claimed` 会**掩盖「正在停止」**：用户点了取消，
 *   领域层看起来毫无变化
 * - 为 `stopping` 新增领域状态，等于**让领域为宿主的一个中间态负责**，
 *   而其它 surface 没有这个概念
 * - **不映射 = 不写回**，语义最准确：**没到终态就不改终态**
 *
 * `Record<HostTerminalStatus, …>` 保证「漏映射一个终态」**编译就报错**。
 */
export const DSH_TERMINAL_TO_DOMAIN: Readonly<Record<HostTerminalStatus, DomainTerminalStatus>> =
  Object.freeze({
    completed: 'completed',
    killed: 'cancelled',
    failed: 'failed',
  });

/** 领域终态（与 `AnalysisJobStatus` 的终态子集一致）。 */
export type DomainTerminalStatus = 'completed' | 'cancelled' | 'failed';

/** 取消请求的结果。`already-finished` 表示任务已结束，**什么都不该做**。 */
export const KillOutcomeSchema = z.enum(['requested', 'already-finished']);
export type KillOutcome = z.infer<typeof KillOutcomeSchema>;

/** 一次任务执行的句柄。 */
export interface JobRunnerHandle {
  /** 追加输出（取消后仍可读，写入 `cancelledOutput`）。 */
  append(text: string): void;
  /** 外部请求取消时触发；实现方需**幂等**处理。 */
  readonly cancelled: boolean;
}

/**
 * 注入点：`ToolContext.jobRunner`。
 *
 * **只有三个方法**：启动、取消、查询。没有「列出全部」「删除」等泛化能力——
 * 泛化会把宿主的能力面泄漏进领域。
 */
export interface JobRunner {
  /** 启动一个后台任务；**同步返回**宿主 job id（这是 `≤2s` 受理的前提）。 */
  start(spec: {
    readonly label: string;
    readonly run: (handle: JobRunnerHandle) => Promise<{ readonly output: string } | null>;
  }): string;
  /** 请求取消。`already-finished` ⇒ 调用方**不应改任何状态**。 */
  kill(jobId: string, reason?: string): KillOutcome;
  /** 查询状态与已累积输出。 */
  get(jobId: string): { readonly status: HostJobStatus; readonly output: string } | null;
}
