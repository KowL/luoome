import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { reconcileStaleWorkflowRunsTool } from './reconcile-stale-workflow-runs.js';

const NOW = new Date('2026-08-14T10:00:00.000Z');

describe('reconcile_stale_workflow_runs', () => {
  it('只收敛超过窗口的 running 审计，近期运行保持不变', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.workflowRun.save({
      id: 'workflow-stale',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'running',
      startedAt: new Date('2026-08-14T08:00:00.000Z'),
      inputSummary: { scheduleId: 'schedule-1' },
      providerStatuses: [],
    });
    await ctx.repos.workflowRun.save({
      id: 'workflow-active',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'running',
      startedAt: new Date('2026-08-14T09:55:00.000Z'),
      providerStatuses: [],
    });

    const result = await reconcileStaleWorkflowRunsTool.execute({ olderThanMinutes: 30 }, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { scanned: 2, reconciled: 1, skipped: 1, runIds: ['workflow-stale'] },
    });
    expect(await ctx.repos.workflowRun.findById('workflow-stale')).toMatchObject({
      status: 'failed',
      error: 'stale_workflow_run_reconciled',
      outputSummary: { reconciliation: 'stale_workflow_run_reconciled' },
    });
    expect(await ctx.repos.workflowRun.findById('workflow-active')).toMatchObject({
      status: 'running',
    });
    expect((await ctx.repos.workflowRun.findById('workflow-active'))?.finishedAt).toBeUndefined();
  });
});
