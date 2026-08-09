import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import type { WatchRun } from './watch-run.js';

/**
 * Workflow 运行审计（ruo 能力迁移 Phase 1C，docs/ddd/ruo-feature-migration-detailed-design.md §3.4）。
 *
 * 自动任务统一由 workflow 执行；唤醒来源可以是 luoome 内置调度器或外部 cron。每次运行落一条
 * WorkflowRun，支撑「自动任务可审计率」指标。与既有 WatchRun 共用统一读模型
 *（UnifiedRun，查询层适配不迁表）。
 */

export const WorkflowRunModeSchema = z.enum(['manual', 'scheduled', 'daemon']);
export type WorkflowRunMode = z.infer<typeof WorkflowRunModeSchema>;

export const WorkflowRunStatusSchema = z.enum(['running', 'succeeded', 'partial', 'failed']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const ProviderStatusSchema = z.object({
  provider: z.string(),
  ok: z.boolean(),
  errorKind: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string().min(1),
  /** 'sync-stock-events' | 'evaluate-event-rules' | 'refresh-groups' | ... */
  workflowName: z.string().min(1),
  mode: WorkflowRunModeSchema,
  status: WorkflowRunStatusSchema,
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  inputSummary: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.record(z.string(), z.unknown()).optional(),
  providerStatuses: z.array(ProviderStatusSchema).default([]),
  error: z.string().max(500).optional(),
});

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const assertWorkflowRunInvariants = (run: WorkflowRun): void => {
  if (run.status === 'running' && run.finishedAt !== undefined) {
    throw new InvariantError('running workflow run 的 finishedAt 必须为空');
  }
  if (run.status !== 'running' && run.finishedAt === undefined) {
    throw new InvariantError('已结束 workflow run 必须有 finishedAt');
  }
  if (run.finishedAt !== undefined && run.finishedAt.getTime() < run.startedAt.getTime()) {
    throw new InvariantError('workflow run finishedAt < startedAt');
  }
  if (run.status === 'failed' && run.error === undefined) {
    throw new InvariantError('failed workflow run 必须有 error');
  }
};

/**
 * WatchRun / WorkflowRun 统一读模型（docs/.../§3.4）。
 * list_workflow_runs 默认返回两者合并视图，供仪表盘 / 设置页消费。
 */
export interface UnifiedRun {
  source: 'watch' | 'workflow';
  /** watch → 'intraday-watch'。 */
  name: string;
  mode: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: Date;
  finishedAt?: Date;
  summary?: Record<string, unknown>;
  error?: string;
}

/** WorkflowRun → UnifiedRun。 */
export const workflowRunToUnified = (run: WorkflowRun): UnifiedRun => ({
  source: 'workflow',
  name: run.workflowName,
  mode: run.mode,
  status: run.status,
  startedAt: run.startedAt,
  ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
  ...(run.outputSummary !== undefined ? { summary: run.outputSummary } : {}),
  ...(run.error !== undefined ? { error: run.error } : {}),
});

/**
 * WatchRun → UnifiedRun。
 * WatchRun 只有 succeeded / failed / running 三态；notifyFailed>0 的 succeeded 映射为 partial
 * （§14 开放问题 4：按现有枚举定稿，用 notifyFailed 派生 partial）。
 */
export const watchRunToUnified = (run: WatchRun): UnifiedRun => {
  const status: UnifiedRun['status'] =
    run.status === 'succeeded' && run.notifyFailed > 0 ? 'partial' : run.status;
  return {
    source: 'watch',
    name: 'intraday-watch',
    mode: run.mode,
    status,
    startedAt: run.startedAt,
    ...(run.finishedAt !== null ? { finishedAt: run.finishedAt } : {}),
    summary: {
      evaluatedPools: run.evaluatedPools,
      evaluatedStocks: run.evaluatedStocks,
      triggered: run.triggered,
      notified: run.notified,
      suppressedByCooldown: run.suppressedByCooldown,
      suppressedByDailyLimit: run.suppressedByDailyLimit,
      notifyFailed: run.notifyFailed,
    },
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
};
