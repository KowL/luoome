import { buildTestContext } from '@luoome/tools/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runs = vi.hoisted(() => ({
  daily: vi.fn(),
  closing: vi.fn(),
  snapshot: vi.fn(),
  intraday: vi.fn(),
  weekly: vi.fn(),
  replay: vi.fn(),
}));
vi.mock('@luoome/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@luoome/workflows')>()),
  strategyDailyCycleWorkflow: { run: runs.daily },
  closingReportCutoffWorkflow: { run: runs.closing },
  snapshotAccountPerformanceWorkflow: { run: runs.snapshot },
  intradayTradingPlanWatchWorkflow: { run: runs.intraday },
  strategyAutonomyWeeklyWorkflow: { run: runs.weekly },
  replayStrategyRangeWorkflow: { run: runs.replay },
}));

import {
  batchTools,
  runClosingReportCutoffTool,
  runIntradayPlanBatchTool,
  runPortfolioPerformanceSnapshotTool,
  runStrategyAutonomyWeeklyTool,
  runStrategyDailyCycleTool,
  runStrategyEvaluationTool,
} from './index.js';

const context = (time: string) => buildTestContext({ clock: () => new Date(time) });
const weekly = {
  evaluated: 2,
  paused: 1,
  failed: 0,
  archive: { failed: 0 },
  proposals: { failed: 0 },
  validation: { failed: 0 },
  promotion: { failed: 0, published: 0 },
  weeklyReport: { status: 'complete' },
};
beforeEach(() => {
  vi.resetAllMocks();
  runs.daily.mockResolvedValue({
    ok: true,
    data: { complete: 1, partial: 2, skipped: 3, failed: 4 },
  });
  runs.closing.mockResolvedValue({
    ok: true,
    data: { date: '2026-07-15', created: [], failed: [] },
  });
  runs.snapshot.mockResolvedValue({
    ok: true,
    data: {
      completedAccounts: 1,
      partialAccounts: 0,
      failedAccounts: 0,
      createdSnapshots: 1,
      reusedSnapshots: 0,
    },
  });
  runs.intraday.mockResolvedValue({ ok: true, data: { status: 'complete' } });
  runs.weekly.mockResolvedValue({ ok: true, data: weekly });
});

describe('DSH batch workflow entrypoints', () => {
  it('advances only the bound evaluation identity and rejects cancelled/foreign sessions', async () => {
    const ctx = await context('2026-08-12T16:30:00+08:00');
    const session = {
      id: 'research-evaluation',
      strategyId: 'research-strategy',
      strategyVersionId: 'research-v1',
      from: new Date('2026-08-10Z'),
      to: new Date('2026-08-11Z'),
      createdAt: ctx.clock(),
      status: 'running' as const,
      definitionHash: 'a'.repeat(64),
      stockIds: ['600519.SH'],
      stockIdChecksum: 'a'.repeat(64),
    };
    await ctx.repos.strategyEvaluation.saveSession(session);
    const args = { strategyId: session.strategyId, sessionId: session.id, maxDays: 2 };
    expect(
      await runStrategyEvaluationTool.execute({ ...args, strategyId: 'foreign-strategy' }, ctx),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    runs.replay.mockResolvedValue({
      ok: true,
      data: {
        sessionId: session.id,
        status: 'partial',
        summary: {
          tradingDays: 0,
          completedDays: 0,
          failedDays: 0,
          vintageAvailableDays: 0,
          vintageUnavailableDays: 0,
          evaluatedCount: 0,
          selectedCount: 0,
          signalCount: 0,
          failedCount: 0,
        },
        days: [],
      },
    });
    const advanced = await runStrategyEvaluationTool.execute(args, ctx);
    expect(advanced).toMatchObject({
      ok: true,
      data: {
        progress: { session: { id: session.id, status: 'running' }, progress: { pending: 2 } },
      },
    });
    expect(runs.replay).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        strategyId: session.strategyId,
        versionId: session.strategyVersionId,
        from: session.from,
        to: session.to,
        stockIds: session.stockIds,
        resumeSessionId: session.id,
        maxDays: 2,
      }),
      ctx,
    );
    await ctx.repos.strategyEvaluation.saveSession({
      ...session,
      status: 'failed',
      error: 'evaluation_cancelled',
    });
    expect(await runStrategyEvaluationTool.execute(args, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input' },
    });
    expect(runs.replay).toHaveBeenCalledTimes(1);
    expect(batchTools).not.toContain(runStrategyEvaluationTool);
  });
  it('scopes account workflows while retaining shared strategy execution', async () => {
    const ctx = await context('2026-07-15T16:30:00+08:00');
    const accountId = ctx.user.defaultAccountId;
    await runStrategyDailyCycleTool.execute({ accountId }, ctx);
    expect(runs.daily).toHaveBeenCalledWith(expect.objectContaining({ accountId }), ctx);
    await runClosingReportCutoffTool.execute({ accountId }, ctx);
    expect(runs.closing.mock.calls.map((call) => call[0])).toEqual([
      { date: '2026-07-14', accountId },
      { accountId },
    ]);
    await runPortfolioPerformanceSnapshotTool.execute({ accountId }, ctx);
    expect(runs.snapshot).toHaveBeenCalledWith(
      { to: '2026-07-15', mode: 'scheduled', accountIds: [accountId] },
      ctx,
    );
    await runIntradayPlanBatchTool.execute({ accountId, force: true }, ctx);
    expect(runs.intraday).toHaveBeenCalledExactlyOnceWith({ accountId }, ctx);
  });

  it('keeps weekly receipts and reports separate for each account', async () => {
    const ctx = await context('2026-07-19T09:30:00+08:00');
    const accountId = ctx.user.defaultAccountId;
    await runStrategyAutonomyWeeklyTool.execute({ accountId }, ctx);
    expect(runs.weekly).toHaveBeenCalledWith({ mode: 'scheduled', accountId }, ctx);
    expect(
      await ctx.repos.workflowRun.findById(`strategy-autonomy-weekly:2026-07-19:${accountId}`),
    ).toMatchObject({ status: 'succeeded' });
    expect(await runStrategyAutonomyWeeklyTool.execute({ accountId }, ctx)).toMatchObject({
      data: { outcome: 'skipped' },
    });
  });
  it.each(['2026-07-18T10:00:00+08:00', '2026-10-01T16:30:00+08:00'])(
    'skips non-trading days without running workflows: %s',
    async (time) => {
      const ctx = await context(time);
      for (const tool of [
        runStrategyDailyCycleTool,
        runClosingReportCutoffTool,
        runPortfolioPerformanceSnapshotTool,
        runIntradayPlanBatchTool,
      ]) {
        expect(await tool.execute({}, ctx)).toMatchObject({
          ok: true,
          data: { outcome: 'skipped' },
        });
      }
      for (const run of Object.values(runs)) expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['2026-07-15T09:05:00+08:00', 'skipped'],
    ['2026-07-15T09:35:00+08:00', 'due'],
    ['2026-07-15T12:00:00+08:00', 'skipped'],
    ['2026-07-15T13:30:00+08:00', 'due'],
    ['2026-07-15T15:30:00+08:00', 'skipped'],
  ])('checks the actual trading session at %s', async (time, outcome) => {
    const ctx = await context(time);
    expect(await runIntradayPlanBatchTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { outcome },
    });
    expect(runs.intraday).toHaveBeenCalledTimes(
      outcome === 'due' ? (await ctx.repos.account.list()).length : 0,
    );
  });

  it('uses Shanghai 16:00 boundary for performance snapshots', async () => {
    expect(
      await runPortfolioPerformanceSnapshotTool.execute({}, await context('2026-07-15T07:59:59Z')),
    ).toMatchObject({ data: { outcome: 'skipped' } });
    const ctx = await context('2026-07-15T08:00:00Z');
    expect(await runPortfolioPerformanceSnapshotTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'due', summary: { tradingDay: '2026-07-15', createdSnapshots: 1 } },
    });
    expect(runs.snapshot).toHaveBeenCalledExactlyOnceWith(
      { to: '2026-07-15', mode: 'scheduled' },
      ctx,
    );
  });

  it('passes workflow summaries unchanged and recovers the previous date before current cutoff', async () => {
    const ctx = await context('2026-07-15T15:50:00+08:00');
    expect(await runStrategyDailyCycleTool.execute({}, ctx)).toMatchObject({
      data: { summary: { complete: 1, partial: 2, skipped: 3, failed: 4 } },
    });
    expect(await runClosingReportCutoffTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'due', summary: { recoveredFailed: 0 } },
    });
    expect(runs.closing.mock.calls.map((call) => call[0])).toEqual([{ date: '2026-07-14' }, {}]);
  });

  it('recovers Friday on Monday rather than treating Sunday as a trading day', async () => {
    const ctx = await context('2026-07-20T15:50:00+08:00');
    expect(await runClosingReportCutoffTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'due' },
    });
    expect(runs.closing.mock.calls.map((call) => call[0])).toEqual([{ date: '2026-07-17' }, {}]);
  });

  it('only runs weekly on Sunday and persists a receipt that suppresses a repeated invocation', async () => {
    expect(
      await runStrategyAutonomyWeeklyTool.execute({}, await context('2026-07-15T09:30:00+08:00')),
    ).toMatchObject({ data: { outcome: 'skipped' } });
    const ctx = await context('2026-07-19T09:30:00+08:00');
    expect(await runStrategyAutonomyWeeklyTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'due' },
    });
    expect(
      await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-07-19'),
    ).toMatchObject({ status: 'succeeded', outputSummary: { evaluated: 2 } });
    expect(await runStrategyAutonomyWeeklyTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'skipped', reason: '本周已执行' },
    });
    expect(runs.weekly).toHaveBeenCalledTimes(1);
  });

  it('records failure, allows retry, and preserves partial completion without repeating it', async () => {
    const ctx = await context('2026-07-19T09:30:00+08:00');
    runs.weekly.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'unavailable', message: 'fixture failure' },
    });
    expect(await runStrategyAutonomyWeeklyTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'failed', reason: 'fixture failure' },
    });
    expect(
      await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-07-19'),
    ).toMatchObject({ status: 'failed' });
    runs.weekly.mockResolvedValueOnce({ ok: true, data: { ...weekly, validation: { failed: 1 } } });
    expect(await runStrategyAutonomyWeeklyTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'partial', summary: { failed: 1 } },
    });
    expect(
      await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-07-19'),
    ).toMatchObject({ status: 'partial' });
    expect(await runStrategyAutonomyWeeklyTool.execute({}, ctx)).toMatchObject({
      data: { outcome: 'skipped' },
    });
    expect(runs.weekly).toHaveBeenCalledTimes(2);
  });

  it('requires a boolean explicit force and rejects unknown inputs without running anything', async () => {
    const ctx = await context('2026-07-18T09:05:00+08:00');
    for (const tool of batchTools) {
      expect(await tool.execute({ force: 'true' }, ctx)).toMatchObject({ ok: false });
      expect(await tool.execute({ unexpected: true }, ctx)).toMatchObject({ ok: false });
    }
    for (const run of Object.values(runs)) expect(run).not.toHaveBeenCalled();
    expect(await runIntradayPlanBatchTool.execute({ force: true }, ctx)).toMatchObject({
      data: { outcome: 'due' },
    });
    expect(runs.intraday).toHaveBeenCalledTimes((await ctx.repos.account.list()).length);
  });
});
