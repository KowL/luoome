import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { listWorkflowRunsTool } from './list-workflow-runs.js';
import { recordWorkflowRunTool } from './record-workflow-run.js';

describe('record_workflow_run', () => {
  it('通过 tool 保存 running 并以同一 id 更新为 terminal 审计', async () => {
    const ctx = await buildTestContext();
    const startedAt = new Date('2026-07-27T01:00:00.000Z');
    const running = await recordWorkflowRunTool.execute(
      {
        run: {
          id: 'run-opening-1',
          workflowName: 'opening-report',
          mode: 'manual',
          status: 'running',
          startedAt,
          inputSummary: { periodEnd: '2026-07-27', template: 'opening-v1' },
          providerStatuses: [],
        },
      },
      ctx,
    );
    expect(running).toMatchObject({ ok: true, data: { run: { status: 'running' } } });

    const terminal = await recordWorkflowRunTool.execute(
      {
        run: {
          id: 'run-opening-1',
          workflowName: 'opening-report',
          mode: 'manual',
          status: 'partial',
          startedAt,
          finishedAt: new Date('2026-07-27T01:00:05.000Z'),
          inputSummary: { periodEnd: '2026-07-27', template: 'opening-v1' },
          outputSummary: { reportId: 'report-opening-1', reportStatus: 'partial' },
          providerStatuses: [{ provider: 'eastmoney', ok: false, errorKind: 'timeout' }],
        },
      },
      ctx,
    );
    expect(terminal).toMatchObject({ ok: true, data: { run: { status: 'partial' } } });

    const listed = await listWorkflowRunsTool.execute(
      { workflowName: 'opening-report', includeWatch: false },
      ctx,
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.runs).toHaveLength(1);
    expect(listed.data.runs[0]).toMatchObject({
      name: 'opening-report',
      status: 'partial',
      summary: { reportId: 'report-opening-1' },
    });
  });
});
