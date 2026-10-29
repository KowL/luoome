import { money } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runAccountPlanBatch } from './account-plan-batch.js';
import { buildWorkflowTools } from './define-workflow.js';

const NOW = new Date('2026-07-17T07:00:00.000Z');
const DATE = '2026-07-17';

describe('workflow/account-plan-batch', () => {
  it('非 UUID 账户键（如 default-account）不会触发 sync_quotes 的 Invalid UUID', async () => {
    const toolCtx = await buildTestContext({ clock: () => NOW });
    await toolCtx.repos.account.save({
      id: 'default-account',
      name: '默认投资账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(0),
      cashBalance: money(0),
      createdAt: new Date('2026-01-05T01:00:00.000Z'),
    });
    const ctx = { ...toolCtx, tools: buildWorkflowTools(toolCtx) };

    const result = await runAccountPlanBatch(
      'default-account',
      DATE,
      'fingerprint-1',
      'digest-1',
      ctx,
    );
    expect(result.newlyFinished).toBe(true);

    const audits = await toolCtx.repos.workflowRun.listRecent({
      workflowName: 'account-plan-batch',
    });
    expect(audits).not.toHaveLength(0);
    for (const run of audits) {
      expect(run.error ?? '').not.toContain('Invalid UUID');
      expect(JSON.stringify(run.outputSummary ?? {})).not.toContain('Invalid UUID');
    }
  });
});
