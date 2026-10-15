import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthChallenge,
  addShanghaiCalendarMonths,
  type DeliveryIntent,
  type HostedExportMetadata,
  type HostedJob,
  type HostedPaymentEvent,
  type HostedRefund,
  type HostedSession,
  type PlanVersion,
  PlatformAccessDeniedError,
  type PlatformRepositoryRegistry,
  type PlatformResultEvent,
  type SubscriptionOrder,
  type Tenant,
  type UsageReservation,
} from '@luoome/core';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import {
  createDrizzlePlatformRepos,
  ensurePlatformSchema,
  PLATFORM_SCHEMA_VERSION,
  type PlatformReposHandle,
} from './platform-client.js';
import { createInMemoryPlatformRepos } from './platform-memory.js';
import { platformSchema } from './platform-schema.js';

const NOW = new Date('2026-10-10T01:00:00.000Z');
const minute = (count: number) => new Date(NOW.getTime() + count * 60_000);
const limits = {
  cooldownSeconds: 60,
  emailHourly: 5,
  emailDaily: 10,
  ipHourly: 20,
  globalHourly: 100,
};
const plan = (units = 10): PlanVersion => ({
  id: 'plan-v1',
  code: 'test-personal',
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
  publishedAt: NOW,
});
const challenge = (suffix: string, now = NOW, email = `${suffix}@example.test`): AuthChallenge => ({
  id: `challenge:${suffix}`,
  email,
  emailKey: email.toLowerCase(),
  digest: `digest:${suffix}`,
  purpose: 'login',
  ipHash: 'ip-hash',
  attempts: 0,
  createdAt: now,
  expiresAt: new Date(now.getTime() + 300_000),
  consumedAt: null,
  invalidatedAt: null,
  deliveryState: 'accepted',
  providerMessageId: null,
});
const session = (suffix: string, now = NOW): Omit<HostedSession, 'userId' | 'tenantId'> => ({
  id: `session:${suffix}`,
  tokenHash: `token-hash:${suffix}`,
  csrfHash: `csrf-hash:${suffix}`,
  createdAt: now,
  lastSeenAt: now,
  idleExpiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
  absoluteExpiresAt: new Date(now.getTime() + 30 * 24 * 3600_000),
  revokedAt: null,
});
const consume = (suffix: string, now = NOW) => ({
  challengeId: `challenge:${suffix}`,
  digest: `digest:${suffix}`,
  now,
  userId: `user:${suffix}`,
  tenantId: `tenant:${suffix}`,
  provisioningJobId: `provision:${suffix}`,
  session: session(suffix, now),
  registration: { enabled: true, maxUsers: 30 },
});
const signIn = async (repos: PlatformRepositoryRegistry, suffix: string, now = NOW) => {
  await repos.auth.createChallenge({ challenge: challenge(suffix, now), now, limits });
  const result = await repos.auth.consumeChallengeAndCreateSession(consume(suffix, now));
  if (!result.authenticated) throw new Error('fixture sign-in failed');
  return result;
};
const activeTenant = async (
  repos: PlatformRepositoryRegistry,
  suffix: string,
  units = 10,
  end = minute(60),
) => {
  const result = await signIn(repos, suffix);
  const claimed = await repos.jobs.claimJob({
    workerId: 'worker',
    attemptId: `init:${suffix}`,
    now: NOW,
    leaseMs: 120_000,
  });
  if (claimed === null || claimed.tenantId !== result.tenant.id)
    throw new Error('fixture provisioning claim failed');
  const tenant = await repos.jobs.completeProvisioning({
    id: claimed.id,
    fence: claimed.fence,
    attemptId: claimed.attemptId!,
    now: NOW,
    schemaVersion: 1,
  });
  await repos.subscriptions.publishPlan(plan(units));
  await repos.subscriptions.grantTrial({
    period: {
      id: `period:${suffix}`,
      tenantId: tenant.id,
      planVersionId: 'plan-v1',
      startsAt: NOW,
      endsAt: end,
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: NOW,
    },
    now: NOW,
  });
  return { ...result, tenant };
};
const preparing = (
  tenant: Tenant,
  suffix: string,
  units = 1,
): { job: HostedJob; reservation: UsageReservation; now: Date } => ({
  now: NOW,
  job: {
    id: `job:${suffix}`,
    tenantId: tenant.id,
    generation: tenant.generation,
    operationId: `operation:${suffix}`,
    requestId: `request:${suffix}`,
    kind: 'watchlist-facts',
    version: 1,
    payloadRef: `operation:${suffix}`,
    inputHash: `input:${suffix}`,
    state: 'preparing',
    priority: 10,
    attempt: 0,
    availableAt: NOW,
    deadlineAt: minute(15),
    fence: 0,
    attemptId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    resultRef: null,
    resultHash: null,
    errorKind: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  reservation: {
    id: `reservation:${suffix}`,
    operationId: `operation:${suffix}`,
    tenantId: tenant.id,
    periodId: `period:${tenant.id.slice('tenant:'.length)}`,
    units,
    budgetMicro: 50,
    state: 'held',
    capturedUnits: null,
    createdAt: NOW,
    settledAt: null,
  },
});
const event = (job: HostedJob): PlatformResultEvent => ({
  eventId: `event:${job.id}`,
  tenantId: job.tenantId,
  generation: job.generation,
  operationId: job.operationId,
  inputHash: job.inputHash,
  resultRef: `report:${job.id}`,
  resultHash: `result:${job.id}`,
  status: 'succeeded',
  notificationPolicy: 'eligible',
  businessKey: `report:${job.id}`,
  committedAt: NOW,
});
const delivery = (job: HostedJob): DeliveryIntent => ({
  id: `delivery:${job.id}`,
  tenantId: job.tenantId,
  generation: job.generation,
  businessKey: `report:${job.id}`,
  resultRef: `report:${job.id}`,
  channel: 'in-app',
  bindingVersion: 1,
  state: 'pending',
  attempt: 0,
  attemptId: null,
  providerMessageId: null,
  availableAt: NOW,
  expiresAt: minute(60),
  deliveredAt: null,
  errorKind: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const queued = async (
  repos: PlatformRepositoryRegistry,
  tenant: Tenant,
  suffix: string,
  units = 1,
) => {
  const input = preparing(tenant, suffix, units);
  await repos.jobs.prepareReservedJob(input);
  await repos.jobs.activatePreparedJob({
    id: input.job.id,
    inputHash: input.job.inputHash,
    now: NOW,
  });
  return input.job;
};
const claim = (
  repos: PlatformRepositoryRegistry,
  attemptId = 'attempt',
  now = NOW,
  leaseMs = 120_000,
) => repos.jobs.claimJob({ workerId: 'worker', attemptId, now, leaseMs });
const settle = (
  repos: PlatformRepositoryRegistry,
  job: HostedJob,
  extra: Partial<Parameters<PlatformRepositoryRegistry['jobs']['finishJobAndSettle']>[0]> = {},
) =>
  repos.jobs.finishJobAndSettle({
    id: job.id,
    fence: job.fence,
    attemptId: job.attemptId!,
    now: NOW,
    event: event(job),
    captureUnits: 1,
    ...extra,
  });
const paidPlan = (): PlanVersion => ({
  ...plan(),
  id: 'paid-plan-v1',
  code: 'paid-test-personal',
  priceMinor: 7900,
});
const orderFor = (tenant: Tenant, suffix: string, now = NOW): SubscriptionOrder => ({
  id: `order:${suffix}`,
  tenantId: tenant.id,
  requestId: `purchase:${suffix}`,
  payloadHash: `purchase-hash:${suffix}`,
  planSnapshot: paidPlan(),
  provider: 'sandbox',
  merchantId: 'merchant-test',
  merchantOrderId: `merchant-order:${suffix}`,
  providerOrderId: null,
  amountMinor: 7900,
  currency: 'CNY',
  state: 'created',
  providerCreateState: 'not-requested',
  reconciliation: 'none',
  refundedMinor: 0,
  expiresAt: new Date(now.getTime() + 30 * 60_000),
  createdAt: now,
  updatedAt: now,
});
const paidEvent = (order: SubscriptionOrder, suffix: string, now = NOW): HostedPaymentEvent => ({
  id: `payment-event:${suffix}`,
  provider: order.provider,
  eventId: `provider-event:${suffix}`,
  payloadDigest: `payment-digest:${suffix}`,
  verification: 'verified',
  merchantId: order.merchantId,
  merchantOrderId: order.merchantOrderId,
  providerTransactionId: `provider-transaction:${order.id}`,
  kind: 'paid',
  amountMinor: order.amountMinor,
  currency: 'CNY',
  confirmedRefundedMinor: 0,
  refundId: null,
  refundAmountMinor: null,
  providerRefundId: null,
  paidAt: now,
  receivedAt: now,
  processedAt: null,
  disposition: 'pending',
});
const purchase = async (
  repos: PlatformRepositoryRegistry,
  tenant: Tenant,
  suffix: string,
  now = NOW,
) => {
  await repos.subscriptions.publishPlan(paidPlan());
  const order = orderFor(tenant, suffix, now);
  await repos.payments.createOrder({ order, now });
  return order;
};
const refundFor = (
  order: SubscriptionOrder,
  paymentAttemptId: string,
  suffix: string,
  amountMinor = 7900,
): HostedRefund => ({
  id: `refund:${suffix}`,
  orderId: order.id,
  paymentAttemptId,
  tenantId: order.tenantId,
  requestId: `refund-request:${suffix}`,
  payloadHash: `refund-hash:${suffix}`,
  provider: order.provider,
  merchantId: order.merchantId,
  amountMinor,
  state: 'reserved',
  entitlementAction: 'revoke',
  providerRefundId: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const exportFor = (tenant: Tenant, suffix: string, now = NOW): HostedExportMetadata => ({
  id: `export-${suffix}`,
  tenantId: tenant.id,
  generation: tenant.generation,
  requestId: `export-request:${suffix}`,
  operationId: `export-operation:${suffix}`,
  inputHash: 'a'.repeat(64),
  state: 'requested',
  artifactRef: null,
  resultHash: null,
  byteLength: null,
  createdAt: now,
  expiresAt: new Date(now.getTime() + 86_400_000),
  completedAt: null,
  errorKind: null,
});

for (const mode of ['memory', 'drizzle'] as const) {
  describe(`PlatformRepositoryRegistry [${mode}]`, () => {
    const handles: PlatformReposHandle[] = [];
    const setup = () => {
      if (mode === 'memory') return createInMemoryPlatformRepos();
      const handle = createDrizzlePlatformRepos(':memory:');
      handles.push(handle);
      return handle.repos;
    };
    afterEach(() => {
      for (const handle of handles.splice(0)) handle.close();
    });

    const llmPricing = {
      version: 'fixture-peak-v1',
      provider: 'deepseek',
      model: 'deepseek-flash',
      currency: 'CNY' as const,
      inputMicroPerMillion: 2_000_000,
      cachedInputMicroPerMillion: 40_000,
      outputMicroPerMillion: 8_000_000,
    };
    const llmReservation = (tenant: Tenant, operationId = 'llm-op') => ({
      operationId,
      tenantId: tenant.id,
      generation: tenant.generation,
      owner: 'fixture-owner',
      leaseUntil: minute(2),
      inputHash: 'a'.repeat(64),
      pricing: llmPricing,
      budgetMicro: 10_000,
      periodBudgetMicro: 100_000,
      now: NOW,
    });
    it('DS-7 跨服务期/跨日重试保留原预占，unknown 不重发或释放，结算不重复扣额', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'llm', 10, minute(1));
      const input = llmReservation(tenant);
      const [first, replay] = await Promise.all([
        repos.llm.reserve(input),
        repos.llm.reserve(input),
      ]);
      expect(first.periodId).toBe('period:llm');
      expect(replay.id).toBe(first.id);
      const attempt = await repos.llm.begin({
        owner: 'fixture-owner',
        operationId: input.operationId,
        id: 'llm-attempt-1',
        requestHash: 'b'.repeat(64),
        reservedCostMicro: 9000,
        pricing: llmPricing,
        now: NOW,
      });
      expect(attempt.usageState).toBe('unknown');
      expect(attempt.confirmedCostMicro).toBeNull();
      await expect(
        repos.llm.settle({
          operationId: input.operationId,
          capture: false,
          now: NOW,
          executionStopped: true,
        }),
      ).rejects.toThrow('usage_unknown');
      await expect(
        repos.llm.begin({
          owner: 'fixture-owner',
          operationId: input.operationId,
          id: 'llm-attempt-2',
          requestHash: 'b'.repeat(64),
          reservedCostMicro: 9000,
          pricing: llmPricing,
          now: NOW,
        }),
      ).rejects.toThrow('usage_unknown');
      const order = await purchase(repos, tenant, 'llm-renewal');
      await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'llm-renewal'),
        periodId: 'paid:llm-renewal',
        now: NOW,
      });
      const tomorrow = minute(24 * 60);
      expect(
        await repos.llm.execution({
          operationId: input.operationId,
          owner: 'fixture-owner',
          action: 'acquire',
          now: tomorrow,
          leaseUntil: new Date(tomorrow.getTime() + 120_000),
        }),
      ).toBe(true);
      expect(
        (
          await repos.llm.reserve({
            ...input,
            now: tomorrow,
            leaseUntil: new Date(tomorrow.getTime() + 120_000),
          })
        ).periodId,
      ).toBe(first.periodId);
      const confirmed = await repos.llm.complete({
        operationId: input.operationId,
        id: attempt.id,
        tokens: { input: 1000, cachedInput: 200, output: 500 },
        receiptId: 'provider-fixture-receipt',
        now: tomorrow,
      });
      expect(confirmed.confirmedCostMicro).toBe(5608);
      await Promise.all([
        repos.llm.settle({
          operationId: input.operationId,
          capture: true,
          now: tomorrow,
          executionStopped: true,
        }),
        repos.llm.settle({
          operationId: input.operationId,
          capture: true,
          now: tomorrow,
          executionStopped: true,
        }),
      ]);
      const entries = await repos.jobs.listUsage({ tenantId: tenant.id });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ periodId: first.periodId, delta: 1 });
      expect(
        (await repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: tomorrow }))
          ?.capturedUnits,
      ).toBe(0);
    });
    it('DS-7 control lease fencing 拒绝旧执行者结算与续租，过期可接管且不重复扣额', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'llm-fencing');
      const input = llmReservation(tenant);
      await repos.llm.reserve(input);
      expect(
        await repos.llm.execution({
          operationId: input.operationId,
          owner: 'successor',
          action: 'acquire',
          now: NOW,
          leaseUntil: minute(4),
        }),
      ).toBe(false);
      expect(
        await repos.llm.execution({
          operationId: input.operationId,
          owner: 'successor',
          action: 'acquire',
          now: minute(3),
          leaseUntil: minute(5),
        }),
      ).toBe(true);
      expect(
        await repos.llm.execution({
          operationId: input.operationId,
          owner: input.owner,
          action: 'renew',
          now: minute(3),
          leaseUntil: minute(5),
        }),
      ).toBe(false);
      await expect(
        repos.llm.settle({
          operationId: input.operationId,
          owner: input.owner,
          capture: false,
          now: minute(3),
        }),
      ).rejects.toThrow('lease_lost');
      await expect(
        repos.llm.begin({
          operationId: input.operationId,
          owner: input.owner,
          id: 'stale-http',
          requestHash: 'b'.repeat(64),
          reservedCostMicro: 100,
          pricing: llmPricing,
          now: minute(3),
        }),
      ).rejects.toThrow('lease_lost');
      expect((await repos.llm.find(input.operationId))?.state).toBe('held');
      await repos.llm.settle({
        operationId: input.operationId,
        owner: 'successor',
        capture: true,
        now: minute(3),
      });
      await repos.llm.settle({
        operationId: input.operationId,
        owner: 'successor',
        capture: true,
        now: minute(3),
      });
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(1);
    });
    it('DS-7 总预算阻止并发穿透，失败释放额度但保留已发生成本，释放幂等', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'budget');
      const first = { ...llmReservation(tenant), periodBudgetMicro: 10_000 };
      await repos.llm.reserve(first);
      await expect(repos.llm.reserve({ ...first, operationId: 'another' })).rejects.toThrow(
        'budget_exhausted',
      );
      await repos.llm.begin({
        owner: 'fixture-owner',
        operationId: first.operationId,
        id: 'budget-attempt',
        requestHash: 'b'.repeat(64),
        reservedCostMicro: 9000,
        pricing: llmPricing,
        now: NOW,
      });
      await repos.llm.complete({
        operationId: first.operationId,
        id: 'budget-attempt',
        tokens: { input: 1000, cachedInput: 200, output: 500 },
        receiptId: 'budget-receipt',
        now: NOW,
      });
      await repos.llm.settle({
        operationId: first.operationId,
        capture: false,
        now: NOW,
        executionStopped: true,
      });
      await repos.llm.settle({
        operationId: first.operationId,
        capture: true,
        now: NOW,
        executionStopped: true,
      });
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(0);
      await expect(repos.llm.reserve({ ...first, operationId: 'another' })).rejects.toThrow(
        'budget_exhausted',
      );
      expect(
        (await repos.llm.reserve({ ...first, operationId: 'another', periodBudgetMicro: 20_000 }))
          .state,
      ).toBe('held');
      expect((await repos.llm.costs())[0]?.confirmedMicro).toBe(5608);
    });
    it('DS-7 成本按租户归属，确认 token/单价不可覆盖，unknown 成本独立呈现', async () => {
      const repos = setup();
      const a = await activeTenant(repos, 'cost-a');
      const b = await activeTenant(repos, 'cost-b');
      await repos.llm.reserve(llmReservation(a.tenant, 'cost-a'));
      await repos.llm.reserve(llmReservation(b.tenant, 'cost-b'));
      for (const operationId of ['cost-a', 'cost-b'])
        await repos.llm.begin({
          owner: 'fixture-owner',
          operationId,
          id: operationId,
          requestHash: 'b'.repeat(64),
          reservedCostMicro: 9000,
          pricing: llmPricing,
          now: NOW,
        });
      const tokens = { input: 1000, cachedInput: 200, output: 500 };
      await repos.llm.complete({
        operationId: 'cost-a',
        id: 'cost-a',
        tokens,
        receiptId: 'receipt-a',
        now: NOW,
      });
      await expect(
        repos.llm.complete({
          operationId: 'cost-a',
          id: 'cost-a',
          tokens: { ...tokens, output: 0 },
          receiptId: 'receipt-a',
          now: NOW,
        }),
      ).rejects.toThrow('immutable');
      await expect(repos.llm.reserve(llmReservation(b.tenant, 'cost-a'))).rejects.toThrow(
        'identity',
      );
      expect(await repos.llm.costs()).toEqual([
        expect.objectContaining({
          tenantId: a.tenant.id,
          confirmedMicro: 5608,
          unknownAttempts: 0,
          inputTokens: 1000,
          cachedInputTokens: 200,
          outputTokens: 500,
        }),
        expect.objectContaining({
          tenantId: b.tenant.id,
          confirmedMicro: 0,
          unknownAttempts: 1,
          reservedMicro: 9000,
        }),
      ]);
      expect(await repos.llm.costs({ since: minute(1) })).toEqual([]);
    });
    it('DS-7 额度耗尽/暂停阻断新调用，已发生的成本仍可核对结算', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'quota', 1);
      await repos.llm.reserve(llmReservation(tenant, 'one'));
      await expect(repos.llm.reserve(llmReservation(tenant, 'two'))).rejects.toThrow(
        'quota_exhausted',
      );
      await repos.tenants.suspend({ id: tenant.id, generation: tenant.generation, now: NOW });
      await expect(
        repos.llm.begin({
          owner: 'fixture-owner',
          operationId: 'one',
          id: 'blocked',
          requestHash: 'b'.repeat(64),
          reservedCostMicro: 100,
          pricing: llmPricing,
          now: NOW,
        }),
      ).rejects.toThrow('operation_closed');
      expect(
        (
          await repos.llm.settle({
            operationId: 'one',
            capture: false,
            now: NOW,
            executionStopped: true,
          })
        ).state,
      ).toBe('released');
    });

    it('consumes one challenge once and atomically creates one tenant, provisioning job, and session', async () => {
      const repos = setup();
      await repos.auth.createChallenge({ challenge: challenge('a'), now: NOW, limits });
      const results = await Promise.all([
        repos.auth.consumeChallengeAndCreateSession(consume('a')),
        repos.auth.consumeChallengeAndCreateSession({ ...consume('a'), session: session('other') }),
      ]);
      expect(results.filter((item) => item.authenticated)).toHaveLength(1);
      expect(await repos.tenants.list()).toHaveLength(1);
      expect(await repos.jobs.list({ states: ['queued'] })).toHaveLength(1);
      expect((await repos.auth.findChallenge('challenge:a'))?.consumedAt).toEqual(NOW);
    });

    it('atomically installs a password, prevents OTP overwrite, and fences password login against a concurrent change', async () => {
      const repos = setup();
      const passwordHash = `scrypt-v1$${'A'.repeat(22)}$${'B'.repeat(43)}`;
      const nextHash = `scrypt-v1$${'C'.repeat(22)}$${'D'.repeat(43)}`;
      await repos.auth.createChallenge({ challenge: challenge('password'), now: NOW, limits });
      const registered = await repos.auth.consumeChallengeAndCreateSession({
        ...consume('password'),
        passwordHash,
      });
      if (!registered.authenticated) throw new Error('registration failed');
      expect(await repos.auth.findPasswordByUserId(registered.user.id)).toEqual({
        id: registered.user.id,
        passwordHash,
        updatedAt: NOW,
      });
      const login = await repos.auth.createPasswordSession({
        userId: registered.user.id,
        expectedPasswordHash: passwordHash,
        now: NOW,
        session: session('password-login'),
      });
      expect(login?.user.id).toBe(registered.user.id);
      await repos.auth.createChallenge({
        challenge: challenge('overwrite', minute(1), registered.user.email as string),
        now: minute(1),
        limits,
      });
      expect(
        await repos.auth.consumeChallengeAndCreateSession({
          ...consume('overwrite', minute(1)),
          passwordHash: nextHash,
        }),
      ).toEqual({ authenticated: false });
      expect(
        await repos.auth.changePassword({
          userId: registered.user.id,
          sessionId: registered.session.id,
          expectedPasswordHash: passwordHash,
          passwordHash: nextHash,
          now: minute(1),
        }),
      ).toBe(true);
      expect(
        await repos.auth.createPasswordSession({
          userId: registered.user.id,
          expectedPasswordHash: passwordHash,
          now: minute(1),
          session: session('stale', minute(1)),
        }),
      ).toBeNull();
      expect(
        await repos.auth.resolveSession({
          tokenHash: login?.session.tokenHash as string,
          now: minute(1),
        }),
      ).toBeNull();
      expect((await repos.auth.findPasswordByUserId(registered.user.id))?.passwordHash).toBe(
        nextHash,
      );
      const deleting = await repos.tenants.beginDeletion({
        id: registered.tenant.id,
        generation: 1,
        now: minute(1),
      });
      await repos.tenants.completeDeletion({
        id: registered.tenant.id,
        generation: deleting.generation,
        now: minute(1),
      });
      expect(await repos.auth.findPasswordByUserId(registered.user.id)).toBeNull();
    });

    it('bounds password attempts atomically and releases the budget after fifteen minutes', async () => {
      const repos = setup();
      const input = { emailHash: 'email-key-hash', ipHash: 'ip-key-hash', now: NOW };
      const attempts = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          repos.auth.reservePasswordAttempt({ ...input, id: `attempt-${index}` }),
        ),
      );
      expect(attempts.filter(Boolean)).toHaveLength(10);
      expect(
        await repos.auth.reservePasswordAttempt({ ...input, id: 'later', now: minute(15) }),
      ).toBe(true);
    });

    it('limits verification to five total attempts and rejects expired or failed-delivery challenges', async () => {
      const repos = setup();
      await repos.auth.createChallenge({ challenge: challenge('a'), now: NOW, limits });
      for (let index = 0; index < 5; index++)
        expect(
          await repos.auth.consumeChallengeAndCreateSession({ ...consume('a'), digest: 'wrong' }),
        ).toEqual({ authenticated: false });
      expect(await repos.auth.consumeChallengeAndCreateSession(consume('a'))).toEqual({
        authenticated: false,
      });
      await repos.auth.createChallenge({ challenge: challenge('b'), now: NOW, limits });
      expect(await repos.auth.consumeChallengeAndCreateSession(consume('b', minute(5)))).toEqual({
        authenticated: false,
      });
      await repos.auth.createChallenge({
        challenge: { ...challenge('c'), deliveryState: 'pending' },
        now: NOW,
        limits,
      });
      await repos.auth.setChallengeDelivery({ id: 'challenge:c', state: 'failed', now: NOW });
      expect(await repos.auth.consumeChallengeAndCreateSession(consume('c'))).toEqual({
        authenticated: false,
      });
    });

    it('enforces send budgets atomically and invalidates the previous same-purpose challenge', async () => {
      const repos = setup();
      expect(
        await repos.auth.createChallenge({ challenge: challenge('a'), now: NOW, limits }),
      ).toEqual({ accepted: true });
      expect(
        await repos.auth.createChallenge({
          challenge: challenge('b', NOW, 'a@example.test'),
          now: NOW,
          limits,
        }),
      ).toEqual({ accepted: false });
      expect(
        await repos.auth.createChallenge({
          challenge: challenge('b', minute(1), 'a@example.test'),
          now: minute(1),
          limits,
        }),
      ).toEqual({ accepted: true });
      expect(await repos.auth.consumeChallengeAndCreateSession(consume('a', minute(1)))).toEqual({
        authenticated: false,
      });
      expect(
        await repos.auth.createChallenge({
          challenge: challenge('c', NOW),
          now: NOW,
          limits: { ...limits, globalHourly: 2 },
        }),
      ).toEqual({ accepted: false });
      expect(
        await repos.auth.createChallenge({
          challenge: challenge('d', NOW),
          now: NOW,
          limits: { ...limits, ipHourly: 2 },
        }),
      ).toEqual({ accepted: false });
    });

    it('caps concurrent registrations without preventing existing-user sign-in', async () => {
      const repos = setup();
      await repos.auth.createChallenge({ challenge: challenge('a'), now: NOW, limits });
      await repos.auth.createChallenge({ challenge: challenge('b'), now: NOW, limits });
      const results = await Promise.all(
        ['a', 'b'].map((suffix) =>
          repos.auth.consumeChallengeAndCreateSession({
            ...consume(suffix),
            registration: { enabled: true, maxUsers: 1 },
          }),
        ),
      );
      expect(results.filter((item) => item.authenticated)).toHaveLength(1);
      await repos.auth.createChallenge({
        challenge: challenge('a2', minute(1), 'a@example.test'),
        now: minute(1),
        limits,
      });
      const existing = await repos.auth.consumeChallengeAndCreateSession({
        ...consume('a2', minute(1)),
        registration: { enabled: false, maxUsers: 0 },
        rotateSessionId: 'session:a',
      });
      expect(existing.authenticated).toBe(true);
      if (existing.authenticated) expect(existing.tenant.id).toBe('tenant:a');
      expect(
        await repos.auth.resolveSession({ tokenHash: 'token-hash:a', now: minute(1) }),
      ).toBeNull();
      expect(await repos.tenants.list()).toHaveLength(1);
    });

    it('rolls back challenge consumption and identity creation when session constraints fail', async () => {
      const repos = setup();
      await signIn(repos, 'a');
      await repos.auth.createChallenge({ challenge: challenge('b'), now: NOW, limits });
      await expect(
        repos.auth.consumeChallengeAndCreateSession({
          ...consume('b'),
          session: { ...session('b'), tokenHash: 'token-hash:a' },
        }),
      ).rejects.toThrow();
      expect((await repos.auth.findChallenge('challenge:b'))?.attempts).toBe(0);
      expect(await repos.tenants.findById('tenant:b')).toBeNull();
    });

    it('touches sessions within the absolute expiry and revokes restored credentials', async () => {
      const repos = setup();
      const signed = await signIn(repos, 'a');
      const touchAt = new Date(NOW.getTime() + 6 * 24 * 3600_000);
      const touched = await repos.auth.resolveSession({
        tokenHash: signed.session.tokenHash,
        now: touchAt,
        touch: true,
      });
      expect(touched?.session.idleExpiresAt).toEqual(
        new Date(touchAt.getTime() + 7 * 24 * 3600_000),
      );
      expect(
        await repos.auth.resolveSession({
          tokenHash: signed.session.tokenHash,
          now: signed.session.absoluteExpiresAt,
        }),
      ).toBeNull();
      await repos.auth.createChallenge({ challenge: challenge('b'), now: NOW, limits });
      await repos.auth.revokeAllCredentials(NOW);
      expect(
        await repos.auth.resolveSession({ tokenHash: signed.session.tokenHash, now: NOW }),
      ).toBeNull();
      expect(await repos.auth.consumeChallengeAndCreateSession(consume('b'))).toEqual({
        authenticated: false,
      });
    });

    it('allows suspended users to sign in for historical and privacy operations', async () => {
      const repos = setup();
      const { tenant, session: signedSession } = await activeTenant(repos, 'a');
      await repos.tenants.suspend({ id: tenant.id, generation: tenant.generation, now: NOW });
      expect(
        (await repos.auth.resolveSession({ tokenHash: signedSession.tokenHash, now: NOW }))?.tenant
          .status,
      ).toBe('suspended');
      await expect(repos.jobs.prepareReservedJob(preparing(tenant, 'a'))).rejects.toBeInstanceOf(
        PlatformAccessDeniedError,
      );
    });

    it('publishes immutable plans and grants a trial only once', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await repos.subscriptions.publishPlan(plan());
      await expect(repos.subscriptions.publishPlan({ ...plan(), priceMinor: 1 })).rejects.toThrow(
        'immutable',
      );
      const period = (await repos.subscriptions.listPeriods(tenant.id))[0]!;
      await expect(
        repos.subscriptions.grantTrial({ period: { ...period, id: 'second-trial' }, now: NOW }),
      ).rejects.toThrow('already granted');
    });

    it('holds the last research unit for only one concurrent operation', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a', 1);
      const results = await Promise.allSettled(
        ['a', 'b'].map((id) => repos.jobs.prepareReservedJob(preparing(tenant, id))),
      );
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(
        (await repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: NOW }))
          ?.availableUnits,
      ).toBe(0);
    });

    it('keeps preparing unclaimable and reuses one idempotent request', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const input = preparing(tenant, 'a');
      await repos.jobs.prepareReservedJob(input);
      expect(await claim(repos)).toBeNull();
      expect((await repos.jobs.prepareReservedJob(input)).replayed).toBe(true);
      await expect(
        repos.jobs.prepareReservedJob({ ...input, job: { ...input.job, inputHash: 'changed' } }),
      ).rejects.toThrow('different content');
      await expect(
        repos.jobs.activatePreparedJob({ id: input.job.id, inputHash: 'changed', now: NOW }),
      ).rejects.toThrow('mismatch');
      await repos.jobs.activatePreparedJob({
        id: input.job.id,
        inputHash: input.job.inputHash,
        now: NOW,
      });
      expect((await claim(repos))?.id).toBe(input.job.id);
    });

    it('fences a stale worker and atomically settles result, usage, and delivery intent', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const old = (await claim(repos, 'old', NOW, 30_000))!;
      const next = (await claim(repos, 'new', minute(1)))!;
      expect(next.fence).toBe(old.fence + 1);
      await expect(settle(repos, old, { now: minute(1) })).rejects.toThrow('lease lost');
      const finished = await settle(repos, next, { now: minute(1), delivery: delivery(next) });
      expect(finished.reservation?.state).toBe('captured');
      const replay = await settle(repos, next, { now: minute(1), delivery: delivery(next) });
      expect(replay.replayed).toBe(true);
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(1);
      expect(await repos.deliveries.list(tenant.id)).toHaveLength(1);
    });

    it('rolls back every settlement write when the delivery contract is invalid', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await expect(
        settle(repos, job, { delivery: { ...delivery(job), businessKey: 'wrong' } }),
      ).rejects.toThrow('does not match');
      expect((await repos.jobs.findById(job.id))?.state).toBe('running');
      expect((await repos.jobs.findReservation(job.operationId))?.state).toBe('held');
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(0);
      expect((await settle(repos, job, { delivery: delivery(job) })).replayed).toBe(false);
    });

    it('settles a running operation against its original period after expiry', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a', 10, minute(1));
      await queued(repos, tenant, 'a');
      const job = (await claim(repos, 'long', NOW, 10 * 60_000))!;
      expect(
        await repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: minute(2) }),
      ).toBeNull();
      const result = await settle(repos, job, { now: minute(2) });
      expect(result.reservation?.periodId).toBe('period:a');
      expect((await repos.jobs.listUsage({ tenantId: tenant.id }))[0]?.periodId).toBe('period:a');
    });

    it('does not recapture released quota when an audited result arrives late', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await repos.jobs.stopJob({
        id: job.id,
        fence: job.fence,
        attemptId: job.attemptId!,
        now: NOW,
        state: 'failed',
        errorKind: 'execution-stopped',
        executionStopped: true,
      });
      const result = await settle(repos, job);
      expect(result.job.state).toBe('succeeded');
      expect(result.reservation?.state).toBe('released');
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(0);
    });

    it('releases queued reservations on expiry and cancellation but waits for active execution', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a', 10, minute(1));
      const pending = await queued(repos, tenant, 'pending');
      expect(await claim(repos, 'late', minute(2))).toBeNull();
      expect((await repos.jobs.findReservation(pending.operationId))?.state).toBe('released');
      expect((await repos.jobs.findById(pending.id))?.state).toBe('cancelled');
    });

    it('reconciles a previously executed retry after its deadline without releasing its original reservation', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a', 10, minute(1));
      await queued(repos, tenant, 'a');
      const first = (await claim(repos))!;
      const receipt = event(first);
      await repos.jobs.retryJob({
        id: first.id,
        fence: first.fence,
        attemptId: first.attemptId!,
        now: NOW,
        availableAt: minute(1),
        errorKind: 'control-commit-interrupted',
      });
      const recovered = (await claim(repos, 'recovered', minute(16)))!;
      expect(recovered).toMatchObject({
        id: first.id,
        errorKind: 'receipt-reconciliation',
        fence: first.fence + 1,
      });
      expect((await repos.jobs.findReservation(first.operationId))?.state).toBe('held');
      await settle(repos, recovered, { now: minute(16), event: receipt });
      expect((await repos.jobs.findReservation(first.operationId))?.state).toBe('captured');
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toMatchObject([
        { periodId: 'period:a', delta: 1 },
      ]);
      expect((await settle(repos, recovered, { now: minute(16), event: receipt })).replayed).toBe(
        true,
      );
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(1);
    });

    it('preserves a previously executed cancelled retry until receipt reconciliation establishes its result', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const first = (await claim(repos))!;
      await repos.jobs.retryJob({
        id: first.id,
        fence: first.fence,
        attemptId: first.attemptId!,
        now: NOW,
        availableAt: minute(1),
        errorKind: 'control-commit-interrupted',
      });
      const cancelled = await repos.jobs.requestCancellation({
        id: first.id,
        tenantId: tenant.id,
        now: NOW,
      });
      expect(cancelled).toMatchObject({
        state: 'queued',
        cancellationRequestedAt: NOW,
        errorKind: 'receipt-reconciliation',
      });
      expect((await repos.jobs.findReservation(first.operationId))?.state).toBe('held');
      const recovered = (await repos.jobs.claimJobForReconciliation({
        id: first.id,
        workerId: 'recovery',
        attemptId: 'recovery',
        now: minute(16),
        leaseMs: 60_000,
      }))!;
      await settle(repos, recovered, { now: minute(16), event: event(first) });
      expect((await repos.jobs.findReservation(first.operationId))?.state).toBe('captured');
    });

    it('allows receipt-only reconciliation of review jobs while preventing a competing live lease', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const first = (await claim(repos))!;
      expect(
        await repos.jobs.claimJobForReconciliation({
          id: first.id,
          workerId: 'competing',
          attemptId: 'competing',
          now: NOW,
          leaseMs: 60_000,
        }),
      ).toBeNull();
      await repos.jobs.stopJob({
        id: first.id,
        fence: first.fence,
        attemptId: first.attemptId!,
        now: NOW,
        state: 'needs-review',
        errorKind: 'uncertain-business-commit',
        executionStopped: false,
      });
      await repos.tenants.suspend({ id: tenant.id, generation: tenant.generation, now: NOW });
      const recovered = (await repos.jobs.claimJobForReconciliation({
        id: first.id,
        workerId: 'recovery',
        attemptId: 'recovery',
        now: minute(16),
        leaseMs: 60_000,
      }))!;
      expect(recovered.errorKind).toBe('receipt-reconciliation');
      await expect(settle(repos, first)).rejects.toThrow('lease lost');
      await settle(repos, recovered, { now: minute(16), event: event(first) });
      expect((await repos.jobs.findReservation(first.operationId))?.state).toBe('captured');
    });

    it('does not use a new paid period to start a never-executed job authorized by an expired trial', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a', 10, minute(1));
      const job = await queued(repos, tenant, 'a');
      const order = await purchase(repos, tenant, 'renewal');
      await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'renewal'),
        periodId: 'paid:renewal',
        now: NOW,
      });
      expect(
        (await repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: minute(2) }))
          ?.period.id,
      ).toBe('paid:renewal');
      expect(await claim(repos, 'late', minute(2))).toBeNull();
      expect((await repos.jobs.findById(job.id))?.state).toBe('cancelled');
      expect((await repos.jobs.findReservation(job.operationId))?.state).toBe('released');
    });

    it('records unknown provider cost separately and never replaces it with zero', async () => {
      const repos = setup();
      const unknown = {
        id: 'attempt:a',
        operationId: 'operation:a',
        step: 'market',
        attempt: 1,
        provider: 'fixture',
        model: null,
        usageState: 'unknown' as const,
        reservedCostMicro: 900,
        estimatedCostMicro: null,
        confirmedCostMicro: null,
        pricingVersion: 'test-v1',
        createdAt: NOW,
        updatedAt: NOW,
      };
      await repos.jobs.saveProviderAttempt(unknown);
      expect(
        (await repos.jobs.listProviderAttempts('operation:a'))[0]?.confirmedCostMicro,
      ).toBeNull();
      await expect(
        repos.jobs.saveProviderAttempt({ ...unknown, confirmedCostMicro: 0 }),
      ).rejects.toThrow('confirmed');
      await repos.jobs.saveProviderAttempt({
        ...unknown,
        usageState: 'confirmed',
        confirmedCostMicro: 123,
      });
      await expect(
        repos.jobs.saveProviderAttempt({
          ...unknown,
          usageState: 'confirmed',
          confirmedCostMicro: 0,
        }),
      ).rejects.toThrow('immutable');
    });

    it('requires provider reconciliation before automatically retrying an unknown outcome', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await repos.jobs.saveProviderAttempt({
        id: 'unknown-attempt',
        operationId: job.operationId,
        step: 'market',
        attempt: 1,
        provider: 'fixture',
        model: null,
        usageState: 'unknown',
        reservedCostMicro: 50,
        estimatedCostMicro: null,
        confirmedCostMicro: null,
        pricingVersion: 'test-v1',
        createdAt: NOW,
        updatedAt: NOW,
      });
      await expect(
        repos.jobs.retryJob({
          id: job.id,
          fence: job.fence,
          attemptId: job.attemptId!,
          now: NOW,
          availableAt: minute(1),
          errorKind: 'provider-timeout',
        }),
      ).rejects.toThrow('requires reconciliation');
      expect((await repos.jobs.findById(job.id))?.state).toBe('running');
    });

    it('rotates tenants fairly and applies per-tenant concurrency limits', async () => {
      const repos = setup();
      const a = await activeTenant(repos, 'a');
      const b = await activeTenant(repos, 'b');
      await queued(repos, a.tenant, 'a1');
      await queued(repos, a.tenant, 'a2');
      await queued(repos, b.tenant, 'b1');
      const first = (await claim(repos, 'one'))!;
      const second = (await claim(repos, 'two'))!;
      expect(new Set([first.tenantId, second.tenantId]).size).toBe(2);
      expect(await claim(repos, 'three')).toBeNull();
    });

    it('keeps unknown delivery outcomes unclaimable and distinguishes accepted from delivered', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await settle(repos, job, { delivery: delivery(job) });
      const intent = (await repos.deliveries.claim({
        id: delivery(job).id,
        generation: tenant.generation,
        bindingVersion: 1,
        attemptId: 'send-1',
        now: NOW,
      }))!;
      await repos.deliveries.complete({
        id: intent.id,
        attemptId: 'send-1',
        state: 'unknown',
        now: NOW,
      });
      expect(
        await repos.deliveries.claim({
          id: intent.id,
          generation: tenant.generation,
          bindingVersion: 1,
          attemptId: 'send-2',
          now: minute(5),
        }),
      ).toBeNull();
      expect((await repos.deliveries.findById(intent.id))?.deliveredAt).toBeNull();
    });

    it('revokes sessions, cancels pending work, drains, and tombstones a deleted tenant', async () => {
      const repos = setup();
      const signed = await activeTenant(repos, 'a');
      const pending = await queued(repos, signed.tenant, 'pending');
      const deleting = await repos.tenants.beginDeletion({
        id: signed.tenant.id,
        generation: 1,
        now: NOW,
      });
      expect(deleting.generation).toBe(2);
      expect(
        await repos.auth.resolveSession({ tokenHash: signed.session.tokenHash, now: NOW }),
      ).toBeNull();
      expect((await repos.jobs.findById(pending.id))?.state).toBe('cancelled');
      expect((await repos.jobs.findReservation(pending.operationId))?.state).toBe('released');
      await repos.tenants.completeDeletion({ id: deleting.id, generation: 2, now: NOW });
      await expect(
        repos.tenants.resume({ id: deleting.id, generation: 2, now: NOW }),
      ).rejects.toThrow('forbidden');
      expect(await claim(repos)).toBeNull();
      expect(await repos.tenants.listTombstones()).toEqual([
        { id: deleting.id, generation: 2, deletedAt: NOW },
      ]);
      expect(await repos.auth.findChallenge('challenge:a')).toBeNull();
    });

    it('does not finish deletion while an active job has not stopped', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await repos.tenants.beginDeletion({ id: tenant.id, generation: 1, now: NOW });
      await expect(
        repos.tenants.completeDeletion({ id: tenant.id, generation: 2, now: NOW }),
      ).rejects.toThrow('not drained');
      await expect(settle(repos, job)).rejects.toThrow('generation changed');
      await repos.jobs.stopJob({
        id: job.id,
        fence: job.fence,
        attemptId: job.attemptId!,
        now: NOW,
        state: 'cancelled',
        errorKind: 'tenant-deleting',
        executionStopped: true,
      });
      await repos.tenants.completeDeletion({ id: tenant.id, generation: 2, now: NOW });
    });

    it('invalidates restored credentials and execution fences while preserving unknown cost and held quota', async () => {
      const repos = setup();
      const { tenant, session } = await activeTenant(repos, 'a');
      await repos.auth.createChallenge({ challenge: challenge('pending-login'), now: NOW, limits });
      await queued(repos, tenant, 'completed');
      const completed = (await claim(repos))!;
      const firstDelivery = delivery(completed);
      const secondDelivery = { ...firstDelivery, id: 'second-delivery', channel: 'email' as const };
      await repos.notifications.savePreferences({
        tenantId: tenant.id,
        userId: tenant.ownerUserId,
        expectedRevision: 0,
        emailEnabled: true,
        detail: 'minimal',
        quietHours: { enabled: false, startMinutes: 0, endMinutes: 0, timeZone: 'Asia/Shanghai' },
        now: NOW,
      });
      await settle(repos, completed, { deliveries: [firstDelivery, secondDelivery] });
      await repos.deliveries.claim({
        id: firstDelivery.id,
        generation: 1,
        bindingVersion: 1,
        attemptId: 'sending',
        now: NOW,
      });
      await queued(repos, tenant, 'running');
      const running = (await claim(repos, 'running'))!;
      await repos.jobs.saveProviderAttempt({
        id: 'uncertain-provider',
        operationId: running.operationId,
        step: 'market',
        attempt: 1,
        provider: 'fixture',
        model: null,
        usageState: 'unknown',
        reservedCostMicro: 50,
        estimatedCostMicro: null,
        confirmedCostMicro: null,
        pricingVersion: 'fixture-v1',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const restored = await repos.recovery.prepareRestore({ now: minute(1), tombstones: [] });
      expect(restored).toMatchObject({
        revokedSessions: 1,
        fencedJobs: 1,
        suppressedDeliveries: 1,
        unknownDeliveries: 1,
      });
      expect(
        await repos.auth.resolveSession({ tokenHash: session.tokenHash, now: minute(1) }),
      ).toBeNull();
      expect(
        await repos.auth.consumeChallengeAndCreateSession(consume('pending-login', minute(1))),
      ).toEqual({ authenticated: false });
      expect(await repos.jobs.findById(running.id)).toMatchObject({
        state: 'needs-review',
        fence: running.fence + 1,
        attemptId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect((await repos.jobs.findReservation(running.operationId))?.state).toBe('held');
      expect(
        (await repos.jobs.listProviderAttempts(running.operationId))[0]?.confirmedCostMicro,
      ).toBeNull();
      await expect(settle(repos, running, { now: minute(1) })).rejects.toThrow('lease lost');
      expect((await repos.deliveries.findById(firstDelivery.id))?.state).toBe('unknown');
      expect((await repos.deliveries.findById(secondDelivery.id))?.state).toBe('suppressed');
      expect(await repos.recovery.prepareRestore({ now: minute(2), tombstones: [] })).toMatchObject(
        { revokedSessions: 0, fencedJobs: 0, suppressedDeliveries: 0, unknownDeliveries: 0 },
      );
    });

    it('applies an independent deletion tombstone over an older active backup and removes private control data', async () => {
      const repos = setup();
      const { tenant, user, session } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const running = (await claim(repos))!;
      const tombstone = { id: tenant.id, generation: 2, deletedAt: minute(1) };
      await repos.recovery.prepareRestore({
        now: minute(2),
        tombstones: [tombstone, { id: 'not-in-backup', generation: 2, deletedAt: minute(1) }],
      });
      expect(await repos.tenants.findById(tenant.id)).toMatchObject({
        status: 'deleted',
        generation: 2,
        deletedAt: minute(1),
      });
      expect(await repos.auth.findUserById(user.id)).toMatchObject({
        status: 'deleted',
        email: null,
        emailKey: `deleted:${user.id}`,
      });
      expect(await repos.auth.findChallenge('challenge:a')).toBeNull();
      expect(
        await repos.auth.resolveSession({ tokenHash: session.tokenHash, now: minute(2) }),
      ).toBeNull();
      expect(await repos.jobs.findById(running.id)).toMatchObject({
        state: 'cancelled',
        payloadRef: null,
        resultRef: null,
        resultHash: null,
      });
      expect((await repos.jobs.findReservation(running.operationId))?.state).toBe('released');
      expect(
        await repos.jobs.claimJobForReconciliation({
          id: running.id,
          workerId: 'stale',
          attemptId: 'stale',
          now: minute(2),
          leaseMs: 60_000,
        }),
      ).toBeNull();
      expect(await repos.tenants.listTombstones()).toHaveLength(2);
      expect(await claim(repos, 'stale', minute(2))).toBeNull();
      await repos.recovery.prepareRestore({ now: minute(3), tombstones: [tombstone] });
      expect((await repos.tenants.listTombstones()).find((item) => item.id === tenant.id)).toEqual(
        tombstone,
      );
    });

    it('saves verified notification preferences with owner, revision, and binding checks', async () => {
      const repos = setup();
      const { tenant, user } = await activeTenant(repos, 'a');
      expect(await repos.notifications.findPreferences(tenant.id)).toBeNull();
      const input = {
        tenantId: tenant.id,
        userId: user.id,
        expectedRevision: 0,
        emailEnabled: true,
        detail: 'minimal' as const,
        quietHours: {
          enabled: false,
          startMinutes: 1320,
          endMinutes: 480,
          timeZone: 'Asia/Shanghai' as const,
        },
        now: NOW,
      };
      await expect(
        repos.notifications.savePreferences({ ...input, userId: 'another-user' }),
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError);
      const first = await repos.notifications.savePreferences(input);
      expect(first).toMatchObject({ revision: 1, bindingVersion: 1 });
      await expect(repos.notifications.savePreferences(input)).rejects.toThrow('revision changed');
      const disabled = await repos.notifications.savePreferences({
        ...input,
        expectedRevision: 1,
        emailEnabled: false,
      });
      expect(disabled).toMatchObject({ revision: 2, bindingVersion: 2 });
    });

    it('accepts private exports without entitlement and gives each request an immutable expiring artifact receipt', async () => {
      const repos = setup();
      const { tenant, user } = await activeTenant(repos, 'a', 10, minute(1));
      await repos.tenants.suspend({ id: tenant.id, generation: 1, now: minute(2) });
      const metadata = exportFor(tenant, 'a', minute(2));
      const request = { metadata, userId: user.id, now: minute(2) };
      expect((await repos.privacy.requestExport(request)).replayed).toBe(false);
      const replay = await repos.privacy.requestExport({
        ...request,
        metadata: { ...metadata, id: 'unused-id', operationId: 'unused-operation' },
      });
      expect(replay).toMatchObject({
        export: { id: metadata.id, operationId: metadata.operationId },
        replayed: true,
      });
      await expect(
        repos.privacy.requestExport({
          ...request,
          metadata: { ...metadata, inputHash: 'b'.repeat(64) },
        }),
      ).rejects.toThrow('different content');
      await expect(
        repos.privacy.requestExport({ ...request, userId: 'another-user' }),
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError);
      expect(
        await repos.privacy.findExport({
          id: metadata.id,
          tenantId: 'another-tenant',
          generation: 1,
          now: minute(2),
        }),
      ).toBeNull();
      const complete = {
        id: metadata.id,
        generation: 1,
        resultHash: 'f'.repeat(64),
        byteLength: 250,
        now: minute(3),
      };
      expect(await repos.privacy.completeExport(complete)).toMatchObject({
        state: 'ready',
        artifactRef: metadata.id,
      });
      expect(await repos.privacy.completeExport(complete)).toMatchObject({
        state: 'ready',
        artifactRef: metadata.id,
      });
      await expect(
        repos.privacy.completeExport({ ...complete, resultHash: 'e'.repeat(64) }),
      ).rejects.toThrow('immutable');
      expect(
        await repos.privacy.findExport({
          id: metadata.id,
          tenantId: tenant.id,
          generation: 1,
          now: metadata.expiresAt,
        }),
      ).toMatchObject({ state: 'expired', artifactRef: null });
      expect(await repos.privacy.expireExports(metadata.expiresAt)).toHaveLength(1);
      expect(await repos.privacy.expireExports(metadata.expiresAt)).toHaveLength(1);
      await expect(
        repos.privacy.completeExport({ ...complete, now: metadata.expiresAt }),
      ).rejects.toThrow('expired');
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(0);
    });

    it('requires recent verification and same-tenant confirmation before atomically beginning deletion', async () => {
      const repos = setup();
      const { tenant, user, session } = await activeTenant(repos, 'a');
      const pending = await queued(repos, tenant, 'pending-delete');
      const metadata = exportFor(tenant, 'a');
      await repos.privacy.requestExport({ metadata, userId: user.id, now: NOW });
      const input = {
        id: 'deletion-a',
        tenantId: tenant.id,
        userId: user.id,
        generation: 1,
        sessionId: session.id,
        confirmationTenantId: tenant.id,
        requestId: 'delete-request-a',
        now: NOW,
      };
      await expect(
        repos.privacy.requestDeletion({ ...input, now: minute(11) }),
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError);
      await expect(
        repos.privacy.requestDeletion({ ...input, confirmationTenantId: 'another-tenant' }),
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError);
      expect((await repos.tenants.findById(tenant.id))?.generation).toBe(1);
      const begun = await repos.privacy.requestDeletion(input);
      expect(begun).toMatchObject({
        deletion: { state: 'draining', generation: 2 },
        tenant: { status: 'deleting', generation: 2 },
        replayed: false,
      });
      expect((await repos.privacy.requestDeletion(input)).replayed).toBe(true);
      expect((await repos.jobs.findById(pending.id))?.state).toBe('cancelled');
      expect(
        await repos.auth.resolveSession({ tokenHash: session.tokenHash, now: NOW }),
      ).toBeNull();
      expect(
        await repos.privacy.findExport({
          id: metadata.id,
          tenantId: tenant.id,
          generation: 1,
          now: NOW,
        }),
      ).toBeNull();
      expect(await repos.privacy.listExports({ tenantId: tenant.id })).toMatchObject([
        { state: 'expired', artifactRef: null },
      ]);
      const finished = await repos.privacy.completeDeletion({
        id: begun.deletion.id,
        generation: 2,
        now: minute(1),
      });
      expect(finished).toMatchObject({
        deletion: { state: 'completed', completedAt: minute(1) },
        tombstone: { id: tenant.id, generation: 2 },
      });
      expect(await repos.privacy.listExports({ tenantId: tenant.id })).toHaveLength(0);
      expect((await repos.auth.findUserById(user.id))?.email).toBeNull();
      expect(
        await repos.privacy.completeDeletion({
          id: begun.deletion.id,
          generation: 2,
          now: minute(2),
        }),
      ).toEqual(finished);
    });

    it('atomically settles multiple opaque notification targets while retaining a single result', async () => {
      const repos = setup();
      const { tenant, user } = await activeTenant(repos, 'a');
      await repos.notifications.savePreferences({
        tenantId: tenant.id,
        userId: user.id,
        expectedRevision: 0,
        emailEnabled: true,
        detail: 'minimal',
        quietHours: {
          enabled: false,
          startMinutes: 1320,
          endMinutes: 480,
          timeZone: 'Asia/Shanghai',
        },
        now: NOW,
      });
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      const targets = ['trigger-1', 'trigger-2'].map((id) => ({
        businessKey: `watch-trigger:${id}`,
        resultRef: id,
        notificationPolicy: 'eligible' as const,
      }));
      const intents = targets.flatMap((target) =>
        (['in-app', 'email'] as const).map((channel) => ({
          ...delivery(job),
          id: `delivery:${target.resultRef}:${channel}`,
          channel,
          businessKey: target.businessKey,
          resultRef: target.resultRef,
        })),
      );
      const first = await settle(repos, job, {
        event: { ...event(job), deliveries: targets },
        deliveries: intents,
      });
      expect(first.job.resultRef).toBe(event(job).resultRef);
      expect(await repos.deliveries.list(tenant.id)).toHaveLength(4);
      expect(await repos.jobs.listUsage({ tenantId: tenant.id })).toHaveLength(1);
      const replay = await settle(repos, job, {
        event: { ...event(job), deliveries: targets },
        deliveries: intents,
      });
      expect(replay.replayed).toBe(true);
      expect(await repos.deliveries.list(tenant.id)).toHaveLength(4);
    });

    it('skips unbound email at settlement and suppresses intents invalidated by changed preferences', async () => {
      const repos = setup();
      const { tenant, user } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      await settle(repos, job, {
        deliveries: [delivery(job), { ...delivery(job), id: 'email-unbound', channel: 'email' }],
      });
      expect(await repos.deliveries.list(tenant.id)).toHaveLength(1);
      const preference = {
        tenantId: tenant.id,
        userId: user.id,
        expectedRevision: 0,
        emailEnabled: true,
        detail: 'minimal' as const,
        quietHours: {
          enabled: false,
          startMinutes: 1320,
          endMinutes: 480,
          timeZone: 'Asia/Shanghai' as const,
        },
        now: NOW,
      };
      await repos.notifications.savePreferences(preference);
      await queued(repos, tenant, 'b');
      const nextJob = (await claim(repos, 'next'))!;
      const email = { ...delivery(nextJob), id: 'email-bound', channel: 'email' as const };
      await settle(repos, nextJob, { deliveries: [delivery(nextJob), email] });
      await repos.notifications.savePreferences({
        ...preference,
        expectedRevision: 1,
        emailEnabled: false,
      });
      expect(
        await repos.deliveries.claim({
          id: email.id,
          generation: tenant.generation,
          bindingVersion: 1,
          attemptId: 'send',
          now: NOW,
        }),
      ).toBeNull();
      expect((await repos.deliveries.findById(email.id))?.state).toBe('suppressed');
    });

    it('defers without spending attempts and reconciles an interrupted delivery without resending it', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      await queued(repos, tenant, 'a');
      const job = (await claim(repos))!;
      const intent = delivery(job);
      await settle(repos, job, { delivery: intent });
      expect(
        (await repos.deliveries.defer({ id: intent.id, availableAt: minute(1), now: NOW })).attempt,
      ).toBe(0);
      expect(await repos.deliveries.listPending({ now: NOW })).toHaveLength(0);
      await repos.deliveries.claim({
        id: intent.id,
        generation: tenant.generation,
        bindingVersion: 1,
        attemptId: 'interrupted-send',
        now: minute(1),
      });
      await repos.deliveries.markUnknown({
        id: intent.id,
        attemptId: 'interrupted-send',
        now: minute(1),
      });
      const accepted = await repos.deliveries.resolveUnknown({
        id: intent.id,
        attemptId: 'interrupted-send',
        state: 'accepted',
        providerMessageId: 'provider-message',
        now: minute(2),
      });
      expect(accepted.deliveredAt).toBeNull();
      expect(accepted.attempt).toBe(1);
      await repos.deliveries.markDelivered({
        id: intent.id,
        providerMessageId: 'provider-message',
        deliveredAt: minute(3),
      });
      expect((await repos.deliveries.findById(intent.id))?.deliveredAt).toEqual(minute(3));
    });

    it('keeps server-priced orders idempotent and payment request timeouts unknown', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      expect((await repos.payments.createOrder({ order, now: NOW })).replayed).toBe(true);
      await expect(
        repos.payments.createOrder({
          order: { ...order, id: 'bad-order', requestId: 'bad-request', amountMinor: 1 },
          now: NOW,
        }),
      ).rejects.toThrow('server plan');
      await expect(
        repos.payments.createOrder({ order: { ...order, payloadHash: 'changed' }, now: NOW }),
      ).rejects.toThrow('different content');
      const unknown = await repos.payments.markOrderRequestOutcome({
        id: order.id,
        state: 'unknown',
        now: NOW,
      });
      expect(unknown).toMatchObject({
        state: 'pending',
        providerCreateState: 'unknown',
        merchantOrderId: order.merchantOrderId,
      });
      expect(
        await repos.payments.findOrder({ id: order.id, tenantId: 'another-tenant' }),
      ).toBeNull();
    });

    it('reserves one payment query interval across competing workers without changing financial content', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'poll');
      const input = { orderId: order.id, refundId: null, now: minute(2), intervalMs: 60_000 };
      expect(
        await Promise.all([
          repos.payments.claimReconciliation(input),
          repos.payments.claimReconciliation(input),
        ]),
      ).toEqual([true, false]);
      expect(
        await repos.payments.claimReconciliation({
          ...input,
          now: new Date(input.now.getTime() + 59_999),
        }),
      ).toBe(false);
      expect(await repos.payments.claimReconciliation({ ...input, now: minute(3) })).toBe(true);
      expect(await repos.payments.findOrder({ id: order.id, tenantId: tenant.id })).toEqual({
        ...order,
        updatedAt: minute(3),
      });
    });
    it('binds one provider transaction to one order and grants one immutable period', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      const event = paidEvent(order, 'a');
      const first = await repos.payments.applyVerifiedPaymentEvent({
        event,
        periodId: 'paid-period:a',
        now: NOW,
      });
      expect(first.period?.startsAt).toEqual(minute(60));
      expect(
        (
          await repos.payments.applyVerifiedPaymentEvent({
            event,
            periodId: 'ignored-period',
            now: NOW,
          })
        ).replayed,
      ).toBe(true);
      const second = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'b'),
        periodId: 'ignored-period-2',
        now: NOW,
      });
      expect(second.period?.id).toBe(first.period?.id);
      expect(
        (await repos.subscriptions.listPeriods(tenant.id)).filter(
          (period) => period.sourceOrderId === order.id,
        ),
      ).toHaveLength(1);
      const other = await purchase(repos, tenant, 'other');
      await expect(
        repos.payments.applyVerifiedPaymentEvent({
          event: {
            ...paidEvent(other, 'other'),
            providerTransactionId: event.providerTransactionId,
          },
          periodId: 'forbidden-period',
          now: NOW,
        }),
      ).rejects.toThrow('already belongs');
      await expect(
        repos.payments.applyVerifiedPaymentEvent({
          event: { ...event, payloadDigest: 'changed' },
          periodId: 'forbidden-period',
          now: NOW,
        }),
      ).rejects.toThrow('different content');
    });

    it('serializes concurrent paid periods and starts expired renewals at actual activation time', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const a = await purchase(repos, tenant, 'a');
      const b = await purchase(repos, tenant, 'b');
      const results = await Promise.all(
        [a, b].map((order) =>
          repos.payments.applyVerifiedPaymentEvent({
            event: paidEvent(order, order.id),
            periodId: `paid:${order.id}`,
            now: NOW,
          }),
        ),
      );
      const periods = results
        .map((result) => result.period!)
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
      expect(periods[1]!.startsAt).toEqual(periods[0]!.endsAt);
      const activation = new Date('2027-01-31T01:00:00.000Z');
      const lateOrder = await purchase(repos, tenant, 'late', activation);
      const delayed = await repos.payments.applyVerifiedPaymentEvent({
        event: { ...paidEvent(lateOrder, 'late', activation), paidAt: NOW },
        periodId: 'paid:late',
        now: activation,
      });
      expect(delayed.period?.startsAt).toEqual(activation);
      expect(delayed.period?.endsAt.toISOString()).toBe('2027-02-28T01:00:00.000Z');
      expect(delayed.period?.anchorDay).toBe(31);
    });

    it('holds refund amounts through unknown outcomes and prevents concurrent over-refunding', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'paid'),
        periodId: 'paid:a',
        now: NOW,
      });
      const fact = (await repos.payments.listPaymentAttempts(order.id))[0]!;
      const results = await Promise.allSettled(
        ['a', 'b'].map((suffix) =>
          repos.payments.reserveRefund({
            refund: refundFor(order, fact.id, suffix, 5000),
            now: NOW,
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refund = (await repos.payments.listRefunds(order.id))[0]!;
      await repos.payments.updateRefundOutcome({ id: refund.id, state: 'unknown', now: NOW });
      await expect(
        repos.payments.reserveRefund({
          refund: refundFor(order, fact.id, 'excess', 3000),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError);
      await expect(
        repos.payments.updateRefundOutcome({ id: refund.id, state: 'submitted', now: NOW }),
      ).rejects.toThrow('queried');
      await repos.payments.updateRefundOutcome({ id: refund.id, state: 'failed', now: NOW });
      expect(
        (
          await repos.payments.reserveRefund({
            refund: refundFor(order, fact.id, 'replacement'),
            now: NOW,
          })
        ).refund.amountMinor,
      ).toBe(7900);
    });

    it('applies full refunds without reverting paid facts or resurrecting revoked periods', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      const payment = paidEvent(order, 'paid');
      const paid = await repos.payments.applyVerifiedPaymentEvent({
        event: payment,
        periodId: 'paid:a',
        now: NOW,
      });
      const fact = (await repos.payments.listPaymentAttempts(order.id))[0]!;
      const refund = refundFor(order, fact.id, 'a');
      await repos.payments.reserveRefund({ refund, now: NOW });
      const refunded = await repos.payments.applyVerifiedPaymentEvent({
        event: {
          ...paidEvent(order, 'refunded'),
          kind: 'refund-succeeded',
          refundId: refund.id,
          refundAmountMinor: 7900,
          confirmedRefundedMinor: 7900,
          providerRefundId: 'provider-refund',
        },
        periodId: 'unused',
        now: NOW,
      });
      expect(refunded.order).toMatchObject({ state: 'paid', refundedMinor: 7900 });
      expect(refunded.period?.status).toBe('revoked');
      const late = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'late-paid'),
        periodId: 'forbidden-new-period',
        now: NOW,
      });
      expect(late.period).toMatchObject({ id: paid.period?.id, status: 'revoked' });
      expect((await repos.payments.listRefunds(order.id))[0]?.state).toBe('succeeded');
    });

    it('does not grant service when refund confirmation arrives before the paid callback', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      await repos.payments.applyVerifiedPaymentEvent({
        event: {
          ...paidEvent(order, 'refund-first'),
          kind: 'refund-succeeded',
          refundId: 'external-refund',
          refundAmountMinor: 7900,
          confirmedRefundedMinor: 7900,
        },
        periodId: 'unused',
        now: NOW,
      });
      const paid = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'late-paid'),
        periodId: 'forbidden-period',
        now: NOW,
      });
      expect(paid.period).toBeNull();
      expect(paid.order?.reconciliation).toBe('needs-review');
      expect(paid.order?.refundedMinor).toBe(7900);
    });

    it('revokes a paid period from an authoritative cumulative refund query after a lost refund callback', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'paid'),
        periodId: 'paid:a',
        now: NOW,
      });
      const reconciled = await repos.payments.applyVerifiedPaymentEvent({
        event: { ...paidEvent(order, 'query'), confirmedRefundedMinor: 7900 },
        periodId: 'unused',
        now: NOW,
      });
      expect(reconciled.order).toMatchObject({ state: 'paid', refundedMinor: 7900 });
      expect(reconciled.period).toMatchObject({ id: 'paid:a', status: 'revoked' });
      await expect(
        repos.payments.applyVerifiedPaymentEvent({
          event: {
            ...paidEvent(order, 'invalid'),
            kind: 'refund-succeeded',
            refundId: 'invalid',
            refundAmountMinor: 7900,
            confirmedRefundedMinor: 100,
          },
          periodId: 'unused',
          now: NOW,
        }),
      ).rejects.toThrow('successful refund');
    });

    it('retains service after an explicitly retained partial refund and revokes it for an explicit revoke', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'paid'),
        periodId: 'paid:a',
        now: NOW,
      });
      const fact = (await repos.payments.listPaymentAttempts(order.id))[0]!;
      const retained = {
        ...refundFor(order, fact.id, 'retained', 1000),
        entitlementAction: 'retain' as const,
      };
      await repos.payments.reserveRefund({ refund: retained, now: NOW });
      const partial = await repos.payments.applyVerifiedPaymentEvent({
        event: {
          ...paidEvent(order, 'partial'),
          kind: 'refund-succeeded',
          refundId: retained.id,
          refundAmountMinor: 1000,
          confirmedRefundedMinor: 1000,
        },
        periodId: 'unused',
        now: NOW,
      });
      expect(partial.period?.status).toBe('paid');
      const revoked = refundFor(order, fact.id, 'revoked', 1000);
      await repos.payments.reserveRefund({ refund: revoked, now: NOW });
      const later = await repos.payments.applyVerifiedPaymentEvent({
        event: {
          ...paidEvent(order, 'later'),
          kind: 'refund-succeeded',
          refundId: revoked.id,
          refundAmountMinor: 1000,
          confirmedRefundedMinor: 2000,
        },
        periodId: 'unused',
        now: NOW,
      });
      expect(later.period?.status).toBe('revoked');
    });

    it('requires review for closed-order late payment and never revives a deleted tenant', async () => {
      const repos = setup();
      const { tenant } = await activeTenant(repos, 'a');
      const order = await purchase(repos, tenant, 'a');
      await repos.payments.applyVerifiedPaymentEvent({
        event: {
          ...paidEvent(order, 'closed'),
          kind: 'closed',
          providerTransactionId: null,
          paidAt: null,
        },
        periodId: 'unused',
        now: NOW,
      });
      const reviewed = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'late'),
        periodId: 'unused',
        now: NOW,
      });
      expect(reviewed.period).toBeNull();
      expect(reviewed.event.disposition).toBe('needs-review');
      const reconciled = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(order, 'query-confirmed'),
        periodId: 'paid:reconciled',
        now: NOW,
        allowClosedOrderGrant: true,
      });
      expect(reconciled.period?.status).toBe('paid');
      const deletingOrder = await purchase(repos, tenant, 'deleted');
      await repos.tenants.beginDeletion({ id: tenant.id, generation: 1, now: NOW });
      await repos.tenants.completeDeletion({ id: tenant.id, generation: 2, now: NOW });
      const late = await repos.payments.applyVerifiedPaymentEvent({
        event: paidEvent(deletingOrder, 'deleted-late'),
        periodId: 'forbidden-deleted-period',
        now: NOW,
        allowClosedOrderGrant: true,
      });
      expect(late.period).toBeNull();
      expect(late.order).toMatchObject({ state: 'paid', reconciliation: 'refund-required' });
      expect((await repos.tenants.findById(tenant.id))?.status).toBe('deleted');
      expect(await claim(repos)).toBeNull();
    });
  });
}

describe('platform SQLite lifecycle', () => {
  it('can open without migrations until the startup maintenance barrier permits schema writes', () => {
    const handle = createDrizzlePlatformRepos(':memory:', { migrate: false });
    try {
      expect(
        handle.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`),
      ).toHaveLength(0);
      ensurePlatformSchema(handle.db);
      ensurePlatformSchema(handle.db);
      expect(
        handle.db.all<{ version: number }>(
          sql`SELECT version FROM hosted_schema_versions WHERE id = 1`,
        )[0]?.version,
      ).toBe(PLATFORM_SCHEMA_VERSION);
    } finally {
      handle.close();
    }
  });

  it('persists credentials and jobs across reopen with matching schema DDL and private file permissions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-platform-'));
    const path = join(directory, 'control.sqlite');
    let handle = createDrizzlePlatformRepos(path);
    try {
      const signed = await signIn(handle.repos, 'persist');
      ensurePlatformSchema(handle.db);
      for (const table of Object.values(platformSchema)) {
        const actual = handle.db
          .all<{ name: string }>(sql.raw(`PRAGMA table_info(${getTableName(table)})`))
          .map((column) => column.name)
          .sort();
        expect(actual).toEqual(
          Object.values(getTableColumns(table))
            .map((column) => column.name)
            .sort(),
        );
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
      handle.close();
      handle = createDrizzlePlatformRepos(path);
      expect(
        (await handle.repos.auth.resolveSession({ tokenHash: signed.session.tokenHash, now: NOW }))
          ?.tenant.id,
      ).toBe(signed.tenant.id);
      expect((await handle.repos.jobs.list({ states: ['queued'] }))[0]?.kind).toBe(
        'provision-tenant',
      );
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a newer platform schema without downgrading its version', () => {
    const handle = createDrizzlePlatformRepos(':memory:');
    try {
      handle.db.run(sql`UPDATE hosted_schema_versions SET version = 999 WHERE id = 1`);
      expect(() => ensurePlatformSchema(handle.db)).toThrow('newer');
      expect(
        handle.db.all<{ version: number }>(
          sql`SELECT version FROM hosted_schema_versions WHERE id = 1`,
        )[0]?.version,
      ).toBe(999);
    } finally {
      handle.close();
    }
  });
});

it('preserves the original Shanghai calendar-month anchor through short months', () => {
  const january = new Date('2027-01-31T01:02:03.004Z');
  const february = addShanghaiCalendarMonths(january, 1, 31);
  expect(february.toISOString()).toBe('2027-02-28T01:02:03.004Z');
  expect(addShanghaiCalendarMonths(february, 1, 31).toISOString()).toBe('2027-03-31T01:02:03.004Z');
});
