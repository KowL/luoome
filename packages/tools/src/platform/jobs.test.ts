import type { HostedJob, PlatformResultEvent } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildPlatformContext } from './context.js';
import {
  activateHostedJobTool,
  cancelHostedJobTool,
  cancelPreparingHostedJobTool,
  claimHostedJobForReconciliationTool,
  claimHostedJobTool,
  finishHostedJobTool,
  getHostedJobTool,
  getHostedUsageTool,
  getWorkerHostedJobTool,
  prepareHostedJobTool,
  prepareScheduledHostedJobTool,
  recordHostedProviderAttemptTool,
} from './jobs.js';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  PLATFORM_TEST_NOW,
  provisionPlatformTestTenant,
} from './testing-context.js';

const hash = 'b'.repeat(64);
const inputFor = (requestId: string) => ({
  kind: 'watchlist-facts' as const,
  version: 1 as const,
  requestId,
  payloadRef: `input:${requestId}`,
  inputHash: hash,
});

const setup = async (units = 3, clock?: () => Date) => {
  const fixture = buildPlatformTestContext(clock === undefined ? {} : { clock });
  const user = await loginPlatformTestUser(fixture);
  await provisionPlatformTestTenant(user.ctx);
  const now = user.ctx.clock();
  await fixture.ctx.repos.subscriptions.publishPlan({
    id: 'fixture-plan-v1',
    code: 'fixture',
    currency: 'CNY',
    priceMinor: 0,
    durationMonths: 1,
    limits: {
      watchlistStocks: 50,
      enabledRules: 10,
      dailyJobs: 20,
      concurrentJobs: 1,
      queuedJobs: 20,
      researchUnits: units,
    },
    productPolicyVersion: 'hosted-facts-v1',
    publishedAt: now,
  });
  await fixture.ctx.repos.subscriptions.grantTrial({
    period: {
      id: `fixture-period:${user.tenant.id}`,
      tenantId: user.tenant.id,
      planVersionId: 'fixture-plan-v1',
      startsAt: now,
      endsAt: new Date(now.getTime() + 86_400_000),
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  return { ...fixture, user, worker: buildPlatformWorkerTestContext(user.ctx) };
};

const eventFor = (job: HostedJob, committedAt: Date): PlatformResultEvent => ({
  eventId: `result-event:${job.operationId}`,
  tenantId: job.tenantId,
  generation: job.generation,
  operationId: job.operationId,
  inputHash: job.inputHash,
  resultRef: 'fixture-report',
  resultHash: 'c'.repeat(64),
  status: 'succeeded',
  notificationPolicy: 'eligible',
  businessKey: `facts:${job.operationId}`,
  committedAt,
});

describe('platform persistent job tools', () => {
  it('exposes the original budget only to workers and safely cancels an unstarted preparation', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(
      inputFor('worker-budget'),
      fixture.user.ctx,
    );
    if (!prepared.ok) throw new Error('prepare failed');
    expect(
      (await getWorkerHostedJobTool.execute({ jobId: prepared.data.job.id }, fixture.user.ctx)).ok,
    ).toBe(false);
    const workerRead = await getWorkerHostedJobTool.execute(
      { jobId: prepared.data.job.id },
      fixture.worker,
    );
    expect(workerRead.ok && workerRead.data.reservation).toMatchObject({
      budgetMicro: 100_000,
      units: 1,
      state: 'held',
    });
    const cancelled = await cancelPreparingHostedJobTool.execute(
      { jobId: prepared.data.job.id, reason: 'input_preparation_expired' },
      fixture.worker,
    );
    expect(cancelled.ok && cancelled.data.state).toBe('cancelled');
    expect(
      (await fixture.ctx.repos.jobs.findReservation(prepared.data.job.operationId))?.state,
    ).toBe('released');
  });

  it('reserves scheduled alerts with the same admission rules and an explicit worker actor', async () => {
    const fixture = await setup(1);
    const worker = buildPlatformContext({
      ...fixture.worker,
      jobPolicies: {
        ...fixture.worker.jobPolicies,
        'watch-alerts': { units: 1, budgetMicro: 100_000, priority: 70, acceptDeadlineMs: 900_000 },
      },
    });
    const input = {
      ...inputFor('scheduled-alert'),
      tenantId: fixture.user.tenant.id,
      kind: 'watch-alerts',
    };
    expect((await prepareScheduledHostedJobTool.execute(input, fixture.user.ctx)).ok).toBe(false);
    const prepared = await prepareScheduledHostedJobTool.execute(input, worker);
    expect(prepared.ok && prepared.data.job).toMatchObject({
      tenantId: fixture.user.tenant.id,
      generation: 1,
      state: 'preparing',
      kind: 'watch-alerts',
    });
    expect(
      (await prepareScheduledHostedJobTool.execute({ ...input, kind: 'watchlist-facts' }, worker))
        .ok,
    ).toBe(false);
    expect(
      (
        await prepareScheduledHostedJobTool.execute(
          { ...input, requestId: 'scheduled-second', payloadRef: 'input:scheduled-second' },
          worker,
        )
      ).ok,
    ).toBe(false);
    const replay = await prepareScheduledHostedJobTool.execute(input, worker);
    expect(replay.ok && replay.data.replayed).toBe(true);
  });

  it('claims only attempted stale jobs for receipt reconciliation while retaining the original reservation', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = await setup(3, () => now);
    const prepared = await prepareHostedJobTool.execute(
      inputFor('receipt-reconcile'),
      fixture.user.ctx,
    );
    if (!prepared.ok) throw new Error('prepare failed');
    expect(
      await claimHostedJobForReconciliationTool.execute(
        { jobId: prepared.data.job.id },
        fixture.worker,
      ),
    ).toEqual({ ok: true, data: null });
    await activateHostedJobTool.execute(
      { jobId: prepared.data.job.id, inputHash: hash },
      fixture.user.ctx,
    );
    const first = await claimHostedJobTool.execute({}, fixture.worker);
    if (!first.ok || first.data === null) throw new Error('claim failed');
    expect(
      await claimHostedJobForReconciliationTool.execute({ jobId: first.data.id }, fixture.worker),
    ).toEqual({ ok: true, data: null });
    now = new Date(now.getTime() + 120_001);
    const reconciliation = await claimHostedJobForReconciliationTool.execute(
      { jobId: first.data.id },
      fixture.worker,
    );
    if (!reconciliation.ok || reconciliation.data === null)
      throw new Error('reconciliation claim failed');
    expect(reconciliation.data).toMatchObject({
      errorKind: 'receipt-reconciliation',
      fence: first.data.fence + 1,
    });
    expect((await fixture.ctx.repos.jobs.findReservation(first.data.operationId))?.state).toBe(
      'held',
    );
    const settled = await finishHostedJobTool.execute(
      {
        jobId: reconciliation.data.id,
        fence: reconciliation.data.fence,
        attemptId: reconciliation.data.attemptId,
        event: eventFor(first.data, PLATFORM_TEST_NOW),
      },
      fixture.worker,
    );
    expect(settled.ok && settled.data.reservation?.capturedUnits).toBe(1);
  });

  it('prepares once, keeps private input out of control and does not claim before activation', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    expect(prepared.ok && prepared.data.job.state).toBe('preparing');
    expect(prepared.ok && prepared.data.job.payloadRef).toBe('input:request-1');
    expect(prepared.ok && prepared.data.job).not.toHaveProperty('input');
    expect(await claimHostedJobTool.execute({}, fixture.worker)).toEqual({ ok: true, data: null });
    const replay = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    expect(replay.ok && replay.data.replayed).toBe(true);
    expect(replay.ok && prepared.ok && replay.data.job.id).toBe(
      prepared.ok && prepared.data.job.id,
    );
    expect(
      (
        await prepareHostedJobTool.execute(
          { ...inputFor('request-1'), inputHash: 'd'.repeat(64) },
          fixture.user.ctx,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await prepareHostedJobTool.execute(
          { ...inputFor('request-2'), tenantId: 'victim', units: 0 },
          fixture.user.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('atomically admits only one concurrent operation consuming the last research unit', async () => {
    const fixture = await setup(1);
    const prepared = await Promise.all([
      prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx),
      prepareHostedJobTool.execute(inputFor('request-2'), fixture.user.ctx),
    ]);
    expect(prepared.filter((result) => result.ok)).toHaveLength(1);
    const rejected = prepared.find((result) => !result.ok);
    expect(rejected && !rejected.ok && rejected.error.kind).toBe('permission_denied');
    const entitlement = await fixture.ctx.repos.subscriptions.currentEntitlement({
      tenantId: fixture.user.tenant.id,
      now: fixture.ctx.clock(),
    });
    expect(entitlement?.heldUnits).toBe(1);
    expect(entitlement?.availableUnits).toBe(0);
  });

  it('settles a tenant event once and creates exactly one in-app delivery intent', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    await activateHostedJobTool.execute(
      { jobId: prepared.data.job.id, inputHash: hash },
      fixture.user.ctx,
    );
    const claim = await claimHostedJobTool.execute({}, fixture.worker);
    if (!claim.ok || claim.data === null) throw new Error('claim failed');
    const event = eventFor(claim.data, fixture.ctx.clock());
    const input = {
      jobId: claim.data.id,
      fence: claim.data.fence,
      attemptId: claim.data.attemptId,
      event,
    };
    const settled = await finishHostedJobTool.execute(input, fixture.worker);
    expect(settled.ok && settled.data.job.state).toBe('succeeded');
    expect(settled.ok && settled.data.reservation?.capturedUnits).toBe(1);
    const replay = await finishHostedJobTool.execute(input, fixture.worker);
    expect(replay.ok && replay.data.replayed).toBe(true);
    expect(
      await fixture.ctx.repos.jobs.listUsage({ tenantId: fixture.user.tenant.id }),
    ).toHaveLength(1);
    expect(await fixture.ctx.repos.deliveries.list(fixture.user.tenant.id)).toHaveLength(1);
  });

  it('rejects late completion from an expired control fence', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = await setup(3, () => now);
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    await activateHostedJobTool.execute(
      { jobId: prepared.data.job.id, inputHash: hash },
      fixture.user.ctx,
    );
    const first = await claimHostedJobTool.execute({}, fixture.worker);
    if (!first.ok || first.data === null) throw new Error('claim failed');
    now = new Date(now.getTime() + 120_001);
    const second = await claimHostedJobTool.execute({}, fixture.worker);
    expect(second.ok && second.data?.fence).toBe(first.data.fence + 1);
    const stale = await finishHostedJobTool.execute(
      {
        jobId: first.data.id,
        fence: first.data.fence,
        attemptId: first.data.attemptId,
        event: eventFor(first.data, now),
      },
      fixture.worker,
    );
    expect(stale.ok).toBe(false);
    expect((await fixture.ctx.repos.jobs.findById(first.data.id))?.fence).toBe(
      first.data.fence + 1,
    );
    expect(
      await fixture.ctx.repos.jobs.listUsage({ tenantId: fixture.user.tenant.id }),
    ).toHaveLength(0);
  });

  it('returns not_found for another tenant job and rejects a user claiming worker tasks', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    const other = await loginPlatformTestUser(fixture, 'other@example.test');
    expect(await getHostedJobTool.execute({ jobId: prepared.data.job.id }, other.ctx)).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'HostedJob', id: prepared.data.job.id },
    });
    expect(await claimHostedJobTool.execute({}, fixture.user.ctx)).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'actor:worker' },
    });
  });

  it('releases a cancelled pending reservation and never resurrects it on activation', async () => {
    const fixture = await setup(1);
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    const cancelled = await cancelHostedJobTool.execute(
      { jobId: prepared.data.job.id },
      fixture.user.ctx,
    );
    expect(cancelled.ok && cancelled.data.state).toBe('cancelled');
    expect(
      (await fixture.ctx.repos.jobs.findReservation(prepared.data.job.operationId))?.state,
    ).toBe('released');
    const activated = await activateHostedJobTool.execute(
      { jobId: prepared.data.job.id, inputHash: hash },
      fixture.user.ctx,
    );
    expect(activated.ok && activated.data.state).toBe('cancelled');
    expect((await prepareHostedJobTool.execute(inputFor('request-2'), fixture.user.ctx)).ok).toBe(
      true,
    );
  });

  it('preserves unknown provider cost without recording a confirmed zero', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    const now = fixture.ctx.clock();
    const attempt = {
      id: 'attempt-1',
      operationId: prepared.data.job.operationId,
      step: 'market-refresh',
      attempt: 1,
      provider: 'fixture-market',
      model: null,
      usageState: 'unknown' as const,
      reservedCostMicro: 50_000,
      estimatedCostMicro: null,
      confirmedCostMicro: null,
      pricingVersion: 'fixture-pricing-v1',
      createdAt: now,
      updatedAt: now,
    };
    expect((await recordHostedProviderAttemptTool.execute(attempt, fixture.worker)).ok).toBe(true);
    expect(
      (
        await recordHostedProviderAttemptTool.execute(
          { ...attempt, confirmedCostMicro: 0 },
          fixture.worker,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await fixture.ctx.repos.jobs.listProviderAttempts(attempt.operationId))[0]
        ?.confirmedCostMicro,
    ).toBeNull();
    expect(
      (await fixture.ctx.repos.jobs.listProviderAttempts(attempt.operationId))[0]?.usageState,
    ).toBe('unknown');
    expect(await getHostedUsageTool.execute({}, fixture.user.ctx)).toEqual({
      ok: true,
      data: { entries: [] },
    });
  });

  it('keeps historical reads available after suspension while refusing new operations', async () => {
    const fixture = await setup();
    const prepared = await prepareHostedJobTool.execute(inputFor('request-1'), fixture.user.ctx);
    if (!prepared.ok) throw new Error('prepare failed');
    await fixture.ctx.repos.tenants.suspend({
      id: fixture.user.tenant.id,
      generation: 1,
      now: fixture.ctx.clock(),
    });
    expect(
      (await getHostedJobTool.execute({ jobId: prepared.data.job.id }, fixture.user.ctx)).ok,
    ).toBe(true);
    expect(await prepareHostedJobTool.execute(inputFor('request-2'), fixture.user.ctx)).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'tenant:active' },
    });
  });
});
