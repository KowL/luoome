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

  it('账户计划批次保留更长执行窗口，再以领取令牌收敛', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const startedAt = new Date(NOW.getTime() - 90 * 60_000);
    await ctx.repos.workflowRun.claim({
      id: 'account-batch',
      workflowName: 'account-plan-batch',
      mode: 'scheduled',
      status: 'running',
      startedAt,
      inputSummary: { claimToken: 'owner-1' },
      providerStatuses: [],
    });
    const early = await reconcileStaleWorkflowRunsTool.execute({ olderThanMinutes: 30 }, ctx);
    expect(early).toMatchObject({ ok: true, data: { reconciled: 0 } });
    expect((await ctx.repos.workflowRun.findById('account-batch'))?.status).toBe('running');

    const later = await buildTestContext({ clock: () => new Date(NOW.getTime() + 60 * 60_000) });
    const lateCtx = { ...later, repos: ctx.repos };
    const expired = await reconcileStaleWorkflowRunsTool.execute({ olderThanMinutes: 30 }, lateCtx);
    expect(expired).toMatchObject({ ok: true, data: { reconciled: 1 } });
    expect((await ctx.repos.workflowRun.findById('account-batch'))?.status).toBe('failed');
  });
});
