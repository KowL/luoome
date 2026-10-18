import {
  FixtureHostedNotificationAdapter,
  SmtpHostedNotificationAdapter,
} from '@luoome/adapters/hosted';
import type { HostedJob, PlatformResultEvent } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { buildPlatformContext } from './context.js';
import {
  activateHostedJobTool,
  claimHostedJobTool,
  finishHostedJobTool,
  prepareHostedJobTool,
} from './jobs.js';
import {
  applyHostedDeliveryReceiptTool,
  getHostedNotificationPreferencesTool,
  reconcileHostedDeliveryTool,
  recoverSendingHostedDeliveryTool,
  saveHostedNotificationPreferencesTool,
  sendHostedDeliveryTool,
} from './notifications.js';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  PLATFORM_TEST_NOW,
  provisionPlatformTestTenant,
} from './testing-context.js';

const quietHours = {
  enabled: false,
  startMinutes: 22 * 60,
  endMinutes: 8 * 60,
  timeZone: 'Asia/Shanghai' as const,
};

const setup = async (start = PLATFORM_TEST_NOW) => {
  let now = new Date(start);
  const fixture = buildPlatformTestContext({ clock: () => now });
  const user = await loginPlatformTestUser(fixture);
  await provisionPlatformTestTenant(user.ctx);
  await fixture.ctx.repos.subscriptions.publishPlan({
    id: 'notification-fixture-plan',
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
      researchUnits: 20,
    },
    productPolicyVersion: 'hosted-facts-v1',
    publishedAt: now,
  });
  await fixture.ctx.repos.subscriptions.grantTrial({
    period: {
      id: 'notification-fixture-period',
      tenantId: user.tenant.id,
      planVersionId: 'notification-fixture-plan',
      startsAt: now,
      endsAt: new Date(now.getTime() + 7 * 86_400_000),
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  const provider = new FixtureHostedNotificationAdapter();
  const worker = buildPlatformContext({
    ...buildPlatformWorkerTestContext(user.ctx),
    notification: provider,
    publicOrigin: 'https://fixture.example.test',
    jobPolicies: {
      ...user.ctx.jobPolicies,
      'watch-alerts': { units: 0, budgetMicro: 0, priority: 60, acceptDeadlineMs: 900_000 },
    },
  });
  const userCtx = buildPlatformContext({ ...user.ctx, jobPolicies: worker.jobPolicies });
  return {
    ...fixture,
    user: { ...user, ctx: userCtx },
    worker,
    provider,
    setNow: (time: Date) => {
      now = time;
    },
  };
};

const save = (
  fixture: Awaited<ReturnType<typeof setup>>,
  input: {
    expectedRevision?: number;
    emailEnabled?: boolean;
    detail?: 'minimal' | 'summary';
    quiet?: boolean;
  } = {},
) =>
  saveHostedNotificationPreferencesTool.execute(
    {
      expectedRevision: input.expectedRevision ?? 0,
      emailEnabled: input.emailEnabled ?? true,
      detail: input.detail ?? 'minimal',
      quietHours: { ...quietHours, enabled: input.quiet ?? false },
    },
    fixture.user.ctx,
  );

const finish = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  extra: Partial<PlatformResultEvent> = {},
  kind: HostedJob['kind'] = 'watchlist-facts',
) => {
  const requestId = `request:${kind}`;
  const prepared = await prepareHostedJobTool.execute(
    { kind, version: 1, requestId, payloadRef: `input:${kind}`, inputHash: 'b'.repeat(64) },
    fixture.user.ctx,
  );
  if (!prepared.ok) throw new Error('Fixture prepare failed');
  await activateHostedJobTool.execute(
    { jobId: prepared.data.job.id, inputHash: prepared.data.job.inputHash },
    fixture.user.ctx,
  );
  const claimed = await claimHostedJobTool.execute({}, fixture.worker);
  if (!claimed.ok || claimed.data === null || claimed.data.attemptId === null)
    throw new Error('Fixture claim failed');
  const event: PlatformResultEvent = {
    eventId: `event:${kind}`,
    tenantId: claimed.data.tenantId,
    generation: claimed.data.generation,
    operationId: claimed.data.operationId,
    inputHash: claimed.data.inputHash,
    resultRef: 'fixture-report',
    resultHash: 'c'.repeat(64),
    status: 'succeeded',
    notificationPolicy: 'eligible',
    businessKey: `result:${kind}`,
    committedAt: fixture.ctx.clock(),
    ...extra,
  };
  const settled = await finishHostedJobTool.execute(
    { jobId: claimed.data.id, attemptId: claimed.data.attemptId, fence: claimed.data.fence, event },
    fixture.worker,
  );
  if (!settled.ok) throw new Error(`Fixture settle failed: ${settled.error.kind}`);
  return [...(await fixture.ctx.repos.deliveries.list(fixture.user.tenant.id))];
};

describe('hosted notification tools', () => {
  it('keeps SMTP acceptance unknown after a persistence interruption because SMTP cannot query the send', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('email intent missing');
    const transport = {
      sendMail: vi.fn().mockResolvedValue({
        accepted: [fixture.user.user.email],
        rejected: [],
        messageId: '<accepted@example.test>',
        response: '250 Queued',
      }),
    };
    const provider = new SmtpHostedNotificationAdapter(
      {
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        from: 'notification@example.test',
        publicOrigin: 'https://fixture.example.test',
      },
      { transport },
    );
    const context = buildPlatformContext({ ...fixture.worker, notification: provider });
    vi.spyOn(fixture.ctx.repos.deliveries, 'complete').mockRejectedValueOnce(
      new Error('interrupted persistence'),
    );
    expect(await sendHostedDeliveryTool.execute({ deliveryId: email.id }, context)).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', cause: 'delivery_persistence_unknown' },
    });
    fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + 360_000));
    expect(
      await reconcileHostedDeliveryTool.execute({ deliveryId: email.id }, context),
    ).toMatchObject({ ok: true, data: { state: 'unknown', attempt: 1, deliveredAt: null } });
    await sendHostedDeliveryTool.execute({ deliveryId: email.id }, context);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
  it('persists a real SMTP ambiguous result and never resends it during repeated dispatch or reconciliation', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('email intent missing');
    const transport = {
      sendMail: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('private SMTP details'), { code: 'ESOCKET' })),
    };
    const provider = new SmtpHostedNotificationAdapter(
      {
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        from: 'notification@example.test',
        publicOrigin: 'https://fixture.example.test',
      },
      { transport },
    );
    const context = buildPlatformContext({ ...fixture.worker, notification: provider });
    expect(await sendHostedDeliveryTool.execute({ deliveryId: email.id }, context)).toMatchObject({
      ok: true,
      data: { state: 'unknown', attempt: 1, deliveredAt: null },
    });
    fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + 360_000));
    expect(
      await reconcileHostedDeliveryTool.execute({ deliveryId: email.id }, context),
    ).toMatchObject({ ok: true, data: { state: 'unknown', attempt: 1 } });
    await sendHostedDeliveryTool.execute({ deliveryId: email.id }, context);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ address: fixture.user.user.email, name: '' }],
        text: expect.stringContaining('需要登录'),
      }),
    );
  });
  it('uses disabled defaults, compare-and-save preferences and a server-owned recipient binding', async () => {
    const fixture = await setup();
    const defaults = await getHostedNotificationPreferencesTool.execute({}, fixture.user.ctx);
    expect(defaults.ok && defaults.data).toMatchObject({
      emailEnabled: false,
      detail: 'minimal',
      revision: 0,
    });
    const first = await save(fixture);
    expect(first.ok && first.data).toMatchObject({ revision: 1, bindingVersion: 1 });
    expect((await save(fixture)).ok).toBe(false);
    const disabled = await save(fixture, { expectedRevision: 1, emailEnabled: false });
    expect(disabled.ok && disabled.data).toMatchObject({
      revision: 2,
      bindingVersion: 2,
      emailEnabled: false,
    });
    const injected = await saveHostedNotificationPreferencesTool.execute(
      {
        expectedRevision: 2,
        emailEnabled: true,
        detail: 'minimal',
        quietHours,
        destination: 'victim@example.test',
      },
      fixture.user.ctx,
    );
    expect(injected.ok).toBe(false);
  });

  it('expands eligible opaque targets into separate in-app and opted-in email intents', async () => {
    const fixture = await setup();
    await save(fixture);
    const intents = await finish(
      fixture,
      {
        deliveries: [
          { businessKey: 'trigger:one', resultRef: 'trigger-one', notificationPolicy: 'eligible' },
          { businessKey: 'trigger:two', resultRef: 'trigger-two', notificationPolicy: 'eligible' },
          { businessKey: 'trigger:quiet', resultRef: 'trigger-quiet', notificationPolicy: 'never' },
        ],
      },
      'watch-alerts',
    );
    expect(intents).toHaveLength(4);
    expect(new Set(intents.map((intent) => intent.businessKey))).toEqual(
      new Set(['trigger:one', 'trigger:two']),
    );
    expect(
      intents.every((intent) => intent.expiresAt.toISOString() === '2026-10-10T16:00:00.000Z'),
    ).toBe(true);
  });

  it('keeps summary private by default and records provider acceptance without delivered time', async () => {
    const fixture = await setup();
    await save(fixture);
    const intents = await finish(fixture);
    const email = intents.find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    const sent = await sendHostedDeliveryTool.execute(
      { deliveryId: email.id, summary: 'private stock summary' },
      fixture.worker,
    );
    expect(sent.ok && sent.data).toMatchObject({
      state: 'accepted',
      deliveredAt: null,
      attempt: 1,
    });
    const request = fixture.provider.getRequest(email.id);
    expect(request?.destination).toBe(fixture.user.user.email);
    expect(request?.message).not.toContain('private stock summary');
    expect(request?.authenticatedUrl).toBe(
      'https://fixture.example.test/#reports?reportId=fixture-report',
    );
    expect(request).not.toHaveProperty('sessionToken');
  });

  it('allows a bounded summary only after the user explicitly enables it', async () => {
    const fixture = await setup();
    await save(fixture, { detail: 'summary' });
    const email = (
      await finish(fixture, { businessKey: 'watch-trigger:fixture-report' }, 'watch-alerts')
    ).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    await sendHostedDeliveryTool.execute(
      { deliveryId: email.id, summary: 'fixture fact summary' },
      fixture.worker,
    );
    expect(fixture.provider.getRequest(email.id)?.message).toContain('fixture fact summary');
    expect(fixture.provider.getRequest(email.id)?.authenticatedUrl).toBe(
      'https://fixture.example.test/#alerts?triggerId=fixture-report',
    );
  });

  it('defers quiet-hour email without consuming an attempt while in-app remains available', async () => {
    const fixture = await setup(new Date('2026-10-10T14:30:00.000Z'));
    await save(fixture, { quiet: true });
    const intents = await finish(fixture);
    const email = intents.find((intent) => intent.channel === 'email');
    const inApp = intents.find((intent) => intent.channel === 'in-app');
    if (email === undefined || inApp === undefined) throw new Error('Fixture intents missing');
    const deferred = await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    expect(deferred.ok && deferred.data).toMatchObject({
      state: 'pending',
      attempt: 0,
      availableAt: new Date('2026-10-11T00:00:00.000Z'),
    });
    expect(fixture.provider.getRequest(email.id)).toBeUndefined();
    expect(
      (await sendHostedDeliveryTool.execute({ deliveryId: inApp.id }, fixture.worker)).ok,
    ).toBe(true);
  });

  it('suppresses old binding intents after preferences change', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    await save(fixture, { expectedRevision: 1, emailEnabled: false });
    const suppressed = await sendHostedDeliveryTool.execute(
      { deliveryId: email.id },
      fixture.worker,
    );
    expect(suppressed.ok && suppressed.data).toMatchObject({ state: 'suppressed', attempt: 0 });
    expect(fixture.provider.getRequest(email.id)).toBeUndefined();
  });

  it('keeps business settlement and in-app intent when a preference change races intent creation', async () => {
    const fixture = await setup();
    await save(fixture);
    const actualFinish = fixture.ctx.repos.jobs.finishJobAndSettle.bind(fixture.ctx.repos.jobs);
    vi.spyOn(fixture.ctx.repos.jobs, 'finishJobAndSettle').mockImplementationOnce(async (input) => {
      await save(fixture, { expectedRevision: 1, emailEnabled: false });
      return actualFinish(input);
    });
    const intents = await finish(fixture);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.channel).toBe('in-app');
    expect(
      await fixture.ctx.repos.jobs.listUsage({ tenantId: fixture.user.tenant.id }),
    ).toHaveLength(1);
  });

  it('rechecks opt-out after claim and suppresses before provider IO', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    const actualClaim = fixture.ctx.repos.deliveries.claim.bind(fixture.ctx.repos.deliveries);
    vi.spyOn(fixture.ctx.repos.deliveries, 'claim').mockImplementationOnce(async (input) => {
      const claimed = await actualClaim(input);
      await save(fixture, { expectedRevision: 1, emailEnabled: false });
      return claimed;
    });
    const result = await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    expect(result.ok && result.data.state).toBe('suppressed');
    expect(fixture.provider.getRequest(email.id)).toBeUndefined();
  });

  it('suppresses expired facts and quiet-hour alerts beyond the original Shanghai-day window', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    fixture.setNow(new Date(email.expiresAt.getTime() + 1));
    const expired = await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    expect(expired.ok && expired.data).toMatchObject({ state: 'suppressed', attempt: 0 });
    const alerts = await setup(new Date('2026-10-10T14:30:00.000Z'));
    await save(alerts, { quiet: true });
    const alert = (await finish(alerts, {}, 'watch-alerts')).find(
      (intent) => intent.channel === 'email',
    );
    if (alert === undefined) throw new Error('Fixture alert email intent missing');
    const delayed = await sendHostedDeliveryTool.execute({ deliveryId: alert.id }, alerts.worker);
    expect(delayed.ok && delayed.data).toMatchObject({ state: 'suppressed', attempt: 0 });
    expect(alerts.provider.getRequest(alert.id)).toBeUndefined();
  });

  it('recovers acceptance after persistence fails by querying without another send', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    const send = vi.spyOn(fixture.provider, 'send');
    vi.spyOn(fixture.ctx.repos.deliveries, 'complete').mockRejectedValueOnce(
      new Error('private provider payload'),
    );
    const interrupted = await sendHostedDeliveryTool.execute(
      { deliveryId: email.id },
      fixture.worker,
    );
    expect(interrupted).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', cause: 'delivery_persistence_unknown' },
    });
    expect((await fixture.ctx.repos.deliveries.findById(email.id))?.state).toBe('unknown');
    await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    const reconciled = await reconcileHostedDeliveryTool.execute(
      { deliveryId: email.id },
      fixture.worker,
    );
    expect(reconciled.ok && reconciled.data).toMatchObject({
      state: 'accepted',
      attempt: 1,
      deliveredAt: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown delivery under review when the provider cannot honor a stable idempotency key', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('email intent missing');
    await fixture.ctx.repos.deliveries.claim({
      id: email.id,
      generation: email.generation,
      bindingVersion: email.bindingVersion,
      attemptId: 'unknown-attempt',
      now: fixture.ctx.clock(),
    });
    await fixture.ctx.repos.deliveries.markUnknown({
      id: email.id,
      attemptId: 'unknown-attempt',
      now: fixture.ctx.clock(),
    });
    const send = vi.spyOn(fixture.provider, 'send');
    const context = buildPlatformContext({
      ...fixture.worker,
      notification: {
        name: fixture.provider.name,
        providerKind: 'fixture',
        configured: true,
        idempotency: 'unsupported',
        send: fixture.provider.send.bind(fixture.provider),
        lookup: fixture.provider.lookup.bind(fixture.provider),
      },
    });
    expect(
      await reconcileHostedDeliveryTool.execute({ deliveryId: email.id }, context),
    ).toMatchObject({ ok: true, data: { state: 'unknown' } });
    await sendHostedDeliveryTool.execute({ deliveryId: email.id }, context);
    expect(send).not.toHaveBeenCalled();
  });
  it('queries an abandoned sending attempt and retries only after confirmed absence', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    await fixture.ctx.repos.deliveries.claim({
      id: email.id,
      generation: email.generation,
      bindingVersion: email.bindingVersion,
      attemptId: 'crashed-attempt',
      now: fixture.ctx.clock(),
    });
    fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + 120_000));
    const recovered = await recoverSendingHostedDeliveryTool.execute(
      { deliveryId: email.id },
      fixture.worker,
    );
    expect(recovered.ok && recovered.data.state).toBe('unknown');
    const reconciled = await reconcileHostedDeliveryTool.execute(
      { deliveryId: email.id },
      fixture.worker,
    );
    expect(reconciled.ok && reconciled.data).toMatchObject({
      state: 'failed',
      errorKind: 'provider-not-found',
      attempt: 1,
    });
    await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    expect(fixture.provider.getRequest(email.id)).toBeUndefined();
    fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + 180_000));
    expect(
      (await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker)).ok,
    ).toBe(true);
    expect((await fixture.ctx.repos.deliveries.findById(email.id))?.attempt).toBe(2);
  });

  it('caps provider failures at three attempts and the original business validity window', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    const send = vi
      .spyOn(fixture.provider, 'send')
      .mockResolvedValue({ state: 'failed', errorKind: 'provider-rejected' });
    for (const elapsed of [0, 60_000, 360_000, 660_000]) {
      fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + elapsed));
      await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(await fixture.ctx.repos.deliveries.findById(email.id)).toMatchObject({
      state: 'suppressed',
      attempt: 3,
    });
  });

  it('only records a matching receipt from the configured provider webhook principal', async () => {
    const fixture = await setup();
    await save(fixture);
    const email = (await finish(fixture)).find((intent) => intent.channel === 'email');
    if (email === undefined) throw new Error('Fixture email intent missing');
    const accepted = await sendHostedDeliveryTool.execute({ deliveryId: email.id }, fixture.worker);
    if (!accepted.ok || accepted.data.providerMessageId === null)
      throw new Error('Fixture acceptance missing');
    const input = {
      deliveryId: email.id,
      providerMessageId: accepted.data.providerMessageId,
      deliveredAt: fixture.ctx.clock(),
    };
    expect((await applyHostedDeliveryReceiptTool.execute(input, fixture.user.ctx)).ok).toBe(false);
    const webhook = buildPlatformContext({
      ...fixture.worker,
      principal: {
        kind: 'webhook',
        provider: fixture.provider.name,
        eventId: 'fixture-receipt',
        requestId: 'fixture-request',
      },
    });
    const receipt = await applyHostedDeliveryReceiptTool.execute(input, webhook);
    expect(receipt.ok && receipt.data.deliveredAt).toEqual(fixture.ctx.clock());
    expect(
      (
        await applyHostedDeliveryReceiptTool.execute(
          { ...input, providerMessageId: 'wrong-message' },
          webhook,
        )
      ).ok,
    ).toBe(false);
  });
});
