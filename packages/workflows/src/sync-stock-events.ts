import type { ProviderStatus, WorkflowRun } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';

/**
 * sync-stock-events workflow（ruo 迁移 §4，盘外执行，cron 调度）。
 *
 * 在 sync_stock_events tool 之上加 WorkflowRun 审计：
 *   1. 写 running WorkflowRun
 *   2. 调 ctx.tools.sync_stock_events（计算同步范围 + 逐 provider upsert，空列表不删旧）
 *   3. 按 providerStatuses 映射终态：全部 ok → succeeded；部分失败 → partial；
 *      有 provider 且全部失败 → failed
 *   4. 写终态 WorkflowRun（providerStatuses / outputSummary）
 *
 * 未配置任何 provider（数据源选型未定，开放问题 1）→ succeeded、syncedStocks 反映范围、upserted=0。
 * 用法：`luoome workflow run sync-stock-events`（cron 每交易日 08:30，见 README / docs）。
 */

export const SyncStockEventsWorkflowInput = z.object({
  stockIds: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).optional(),
  windowDays: z.number().int().positive().max(365).optional(),
  mode: z.enum(['manual', 'scheduled', 'daemon']).default('scheduled'),
});

export type SyncStockEventsWorkflowInputT = z.infer<typeof SyncStockEventsWorkflowInput>;

export const SyncStockEventsWorkflowOutput = z.object({
  runId: z.string(),
  status: z.enum(['succeeded', 'partial', 'failed']),
  syncedStocks: z.number().int().nonnegative(),
  upserted: z.number().int().nonnegative(),
  staleMarked: z.number().int().nonnegative(),
  providerStatuses: z.array(
    z.object({ provider: z.string(), ok: z.boolean(), errorKind: z.string().optional() }),
  ),
});

const stepRun: WorkflowStep = async (prev, ctx: WorkflowContext) => {
  const input = prev as SyncStockEventsWorkflowInputT;
  const now = ctx.clock();
  const runId = `wfr_${globalThis.crypto.randomUUID().slice(0, 8)}`;

  const runningRun: WorkflowRun = {
    id: runId,
    workflowName: 'sync-stock-events',
    mode: input.mode,
    status: 'running',
    startedAt: now,
    providerStatuses: [],
  };
  await ctx.repos.workflowRun.save(runningRun);

  const r = await ctx.tools.sync_stock_events.execute({
    ...(input.stockIds !== undefined ? { stockIds: input.stockIds } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
  });

  const finishedAt = ctx.clock();

  if (!r.ok) {
    const failed: WorkflowRun = {
      ...runningRun,
      status: 'failed',
      finishedAt,
      error: JSON.stringify(r.error).slice(0, 500),
    };
    await ctx.repos.workflowRun.save(failed);
    return SyncStockEventsWorkflowOutput.parse({
      runId,
      status: 'failed',
      syncedStocks: 0,
      upserted: 0,
      staleMarked: 0,
      providerStatuses: [],
    });
  }

  const { synced, upserted, staleMarked, providerStatuses } = r.data;
  const anyFailed = providerStatuses.some((p) => !p.ok);
  const allFailed = providerStatuses.length > 0 && providerStatuses.every((p) => !p.ok);
  const status: WorkflowRun['status'] = allFailed ? 'failed' : anyFailed ? 'partial' : 'succeeded';

  const runProviderStatuses: ProviderStatus[] = providerStatuses.map((p) => ({
    provider: p.provider,
    ok: p.ok,
    ...(p.errorKind !== undefined ? { errorKind: p.errorKind } : {}),
  }));

  const terminal: WorkflowRun = {
    ...runningRun,
    status,
    finishedAt,
    providerStatuses: runProviderStatuses,
    outputSummary: { syncedStocks: synced, upserted, staleMarked },
    ...(status === 'failed' ? { error: '全部 provider 同步失败' } : {}),
  };
  await ctx.repos.workflowRun.save(terminal);

  return SyncStockEventsWorkflowOutput.parse({
    runId,
    status,
    syncedStocks: synced,
    upserted,
    staleMarked,
    providerStatuses: runProviderStatuses,
  });
};

export const syncStockEventsWorkflow = defineWorkflow<
  z.infer<typeof SyncStockEventsWorkflowInput>,
  z.infer<typeof SyncStockEventsWorkflowOutput>
>({
  name: 'sync-stock-events',
  description: '盘外同步公司事件（provider upsert + WorkflowRun 审计）；空列表不删旧事件',
  input: SyncStockEventsWorkflowInput,
  steps: [stepRun],
});
