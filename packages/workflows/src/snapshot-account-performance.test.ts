import { createPortfolioCashFlowTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { snapshotAccountPerformanceWorkflow } from './snapshot-account-performance.js';

describe('snapshot-account-performance workflow', () => {
  it('为全部账户生成隔离快照，重跑复用，事实变化只修订对应账户', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-07-03T09:00:00.000Z'),
    });
    const ctx = {
      ...base,
      portfolioBenchmark: { stockId: '600900.SH', name: '长江电力' },
    };
    const input = {
      from: '2026-07-01',
      to: '2026-07-03',
      benchmarkStockId: '600900.SH',
      mode: 'scheduled' as const,
    };
    const first = await snapshotAccountPerformanceWorkflow.run(input, ctx);
    expect(first).toMatchObject({
      ok: true,
      data: {
        status: 'succeeded',
        requestedAccounts: 3,
        completedAccounts: 3,
        failedAccounts: 0,
        createdSnapshots: 3,
        reusedSnapshots: 0,
      },
    });
    const second = await snapshotAccountPerformanceWorkflow.run(input, ctx);
    expect(second).toMatchObject({
      ok: true,
      data: { createdSnapshots: 0, reusedSnapshots: 3 },
    });

    await createPortfolioCashFlowTool.execute(
      {
        accountId: base.user.defaultAccountId,
        occurredAt: new Date('2026-07-02T00:00:00.000Z'),
        kind: 'fee',
        amount: 10,
        currency: 'CNY',
      },
      base,
    );
    const revised = await snapshotAccountPerformanceWorkflow.run(input, ctx);
    expect(revised).toMatchObject({
      ok: true,
      data: { createdSnapshots: 1, reusedSnapshots: 2 },
    });
    if (!revised.ok) return;
    for (const item of revised.data.items) {
      const expected = item.accountId === base.user.defaultAccountId ? 2 : 1;
      expect(
        await base.repos.portfolioPerformanceSnapshot.listByAccount(item.accountId),
      ).toHaveLength(expected);
    }
    const audits = await base.repos.workflowRun.listRecent({
      workflowName: 'snapshot-account-performance',
    });
    expect(audits).toHaveLength(3);
    const revisedAudit = await base.repos.workflowRun.findById(revised.data.runId);
    expect(revisedAudit).toMatchObject({
      status: 'succeeded',
      outputSummary: {
        createdSnapshots: 1,
        reusedSnapshots: 2,
        priceSeries: expect.any(Number),
        dailyBars: expect.any(Number),
      },
    });
  });

  it('单账户失败不阻断其它账户，WorkflowRun 保留 partial 审计', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-07-03T09:00:00.000Z'),
    });
    const result = await snapshotAccountPerformanceWorkflow.run(
      {
        accountIds: [base.user.defaultAccountId, 'missing-account'],
        from: '2026-07-01',
        to: '2026-07-03',
        benchmarkStockId: '600900.SH',
      },
      base,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'partial',
        requestedAccounts: 2,
        completedAccounts: 1,
        failedAccounts: 1,
      },
    });
    if (!result.ok) return;
    expect(
      result.data.items.find((item) => item.accountId === base.user.defaultAccountId),
    ).toMatchObject({ status: 'complete' });
    expect(result.data.items.find((item) => item.accountId === 'missing-account')).toMatchObject({
      status: 'failed',
      errorKind: 'not_found',
    });
  });

  it('在任何运行审计前拒绝反向区间，并去重重复账户', async () => {
    const base = await buildTestContext({
      clock: () => new Date('2026-07-03T09:00:00.000Z'),
    });
    const invalid = await snapshotAccountPerformanceWorkflow.run(
      { from: '2026-07-03', to: '2026-07-01' },
      base,
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.kind).toBe('invalid_input');
    expect(
      await base.repos.workflowRun.listRecent({
        workflowName: 'snapshot-account-performance',
      }),
    ).toEqual([]);

    const accountId = base.user.defaultAccountId;
    const deduplicated = await snapshotAccountPerformanceWorkflow.run(
      {
        accountIds: [accountId, accountId, accountId],
        from: '2026-07-01',
        to: '2026-07-03',
      },
      base,
    );
    expect(deduplicated).toMatchObject({
      ok: true,
      data: {
        requestedAccounts: 1,
        completedAccounts: 1,
        items: [{ accountId }],
      },
    });
    expect(await base.repos.portfolioPerformanceSnapshot.listByAccount(accountId)).toHaveLength(1);
  });
});
