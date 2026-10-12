import {
  FixtureHostedPaymentAdapter,
  UnconfiguredHostedPaymentAdapter,
} from '@luoome/adapters/hosted';
import type {
  HostedPaymentWebhookEnvelope,
  HostedVerifiedPaymentFact,
  SubscriptionOrder,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { buildPlatformContext } from './context.js';
import {
  applyHostedPaymentWebhookTool,
  createHostedSubscriptionOrderTool,
  queryHostedRefundTool,
  queryHostedSubscriptionOrderTool,
  reconcileHostedSubscriptionOrderTool,
  requestHostedRefundTool,
  verifyHostedPaymentWebhookTool,
} from './payments.js';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  PLATFORM_TEST_NOW,
  provisionPlatformTestTenant,
} from './testing-context.js';

const setup = async () => {
  const fixture = buildPlatformTestContext();
  const user = await loginPlatformTestUser(fixture);
  await provisionPlatformTestTenant(user.ctx);
  const plan = {
    id: 'fixture-payment-monthly-v1',
    code: 'fixture',
    currency: 'CNY' as const,
    priceMinor: 1200,
    durationMonths: 1,
    limits: {
      watchlistStocks: 50,
      enabledRules: 10,
      dailyJobs: 20,
      concurrentJobs: 1,
      queuedJobs: 20,
      researchUnits: 30,
    },
    productPolicyVersion: 'hosted-facts-v1' as const,
    publishedAt: fixture.ctx.clock(),
  };
  await fixture.ctx.repos.subscriptions.publishPlan(plan);
  const provider = new FixtureHostedPaymentAdapter({ clock: fixture.ctx.clock });
  const ctx = buildPlatformContext({ ...user.ctx, payment: provider });
  const anonymous = buildPlatformContext({ ...fixture.ctx, payment: provider });
  return {
    ...fixture,
    user: { ...user, ctx },
    anonymous,
    provider,
    plan,
    worker: buildPlatformWorkerTestContext(ctx),
  };
};

const create = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  requestId = 'fixture-payment-request',
) => {
  const result = await createHostedSubscriptionOrderTool.execute(
    { planVersionId: fixture.plan.id, requestId },
    fixture.user.ctx,
  );
  if (!result.ok) throw new Error(`Fixture order failed: ${result.error.kind}`);
  return result.data;
};

const webhook = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  fact: HostedVerifiedPaymentFact,
  envelope = fixture.provider.signWebhook(fact),
) => {
  const verified = await verifyHostedPaymentWebhookTool.execute(envelope, fixture.anonymous);
  if (!verified.ok) throw new Error('Fixture webhook verification failed');
  const ctx = buildPlatformContext({
    ...fixture.worker,
    principal: {
      kind: 'webhook',
      provider: verified.data.provider,
      eventId: verified.data.eventId,
      requestId: 'fixture-payment-webhook',
    },
  });
  return applyHostedPaymentWebhookTool.execute(envelope, ctx);
};

const pay = async (fixture: Awaited<ReturnType<typeof setup>>, order: SubscriptionOrder) => {
  const fact = fixture.provider.confirmPayment(order.merchantOrderId);
  const result = await queryHostedSubscriptionOrderTool.execute(
    { orderId: order.id },
    fixture.user.ctx,
  );
  if (!result.ok || result.data.order.state !== 'paid')
    throw new Error('Fixture payment query failed');
  const attempt = (await fixture.ctx.repos.payments.listPaymentAttempts(order.id))[0];
  if (attempt === undefined) throw new Error('Fixture confirmed payment attempt missing');
  return { fact, attempt };
};

describe('platform one-time subscription payment tools', () => {
  it('uses server plan price, rejects client payment claims and prepares one stable merchant order', async () => {
    const fixture = await setup();
    const providerCreate = vi.spyOn(fixture.provider, 'createOrder');
    const request = { planVersionId: fixture.plan.id, requestId: 'request-1' };
    expect(
      (
        await createHostedSubscriptionOrderTool.execute(
          { ...request, amountMinor: 1, state: 'paid', merchantId: 'attacker' },
          fixture.user.ctx,
        )
      ).ok,
    ).toBe(false);
    const [first, second] = await Promise.all([
      createHostedSubscriptionOrderTool.execute(request, fixture.user.ctx),
      createHostedSubscriptionOrderTool.execute(request, fixture.user.ctx),
    ]);
    expect(first.ok && first.data.order).toMatchObject({
      amountMinor: 1200,
      currency: 'CNY',
      state: 'pending',
      providerCreateState: 'accepted',
    });
    expect(first.ok && second.ok && first.data.order.id === second.data.order.id).toBe(true);
    expect(await fixture.ctx.repos.payments.listOrders(fixture.user.tenant.id)).toHaveLength(1);
    expect(await fixture.ctx.repos.subscriptions.listPeriods(fixture.user.tenant.id)).toHaveLength(
      0,
    );
    expect(providerCreate).toHaveBeenCalledTimes(1);
    if (!first.ok) throw new Error('Fixture order missing');
    expect(
      (
        await queryHostedSubscriptionOrderTool.execute(
          { orderId: first.data.order.id, paid: true },
          fixture.user.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('refuses invalid raw signatures, stale events and a mismatched trusted webhook principal', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const fact = fixture.provider.confirmPayment(order.merchantOrderId);
    const envelope = fixture.provider.signWebhook(fact);
    const invalid: HostedPaymentWebhookEnvelope[] = [
      { ...envelope, rawBody: `${envelope.rawBody} ` },
      { ...envelope, signature: 'f'.repeat(64) },
      fixture.provider.signWebhook(fact, new Date(PLATFORM_TEST_NOW.getTime() - 301_000)),
      fixture.provider.signWebhook({ ...fact, merchantId: 'another-merchant' }),
    ];
    for (const input of invalid)
      expect(await verifyHostedPaymentWebhookTool.execute(input, fixture.anonymous)).toEqual({
        ok: false,
        error: { kind: 'permission_denied', required: 'payment:verified-webhook' },
      });
    const wrongPrincipal = buildPlatformContext({
      ...fixture.worker,
      principal: {
        kind: 'webhook',
        provider: fixture.provider.name,
        eventId: 'wrong-event',
        requestId: 'fixture-webhook',
      },
    });
    expect((await applyHostedPaymentWebhookTool.execute(envelope, wrongPrincipal)).ok).toBe(false);
    expect((await applyHostedPaymentWebhookTool.execute(envelope, fixture.user.ctx)).ok).toBe(
      false,
    );
    expect(await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId)).toHaveLength(0);
  });

  it('applies a verified webhook once and grants only one calendar service period', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const fact = fixture.provider.confirmPayment(order.merchantOrderId);
    const first = await webhook(fixture, fact);
    const duplicate = await webhook(fixture, fact);
    expect(first.ok && first.data.order?.state).toBe('paid');
    expect(duplicate.ok && duplicate.data.replayed).toBe(true);
    const periods = await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      sourceOrderId: order.id,
      startsAt: PLATFORM_TEST_NOW,
      endsAt: new Date('2026-11-10T01:00:00.000Z'),
      status: 'paid',
    });
  });

  it('recovers a lost webhook by authoritative query and keeps later confirmations idempotent', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const { fact } = await pay(fixture, order);
    await queryHostedSubscriptionOrderTool.execute({ orderId: order.id }, fixture.user.ctx);
    expect((await webhook(fixture, fact)).ok).toBe(true);
    expect(await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId)).toHaveLength(1);
    expect(await fixture.ctx.repos.payments.listPaymentAttempts(order.id)).toHaveLength(1);
  });

  it('queries an unknown create outcome with the original merchant order without another charge', async () => {
    const fixture = await setup();
    const actualCreate = fixture.provider.createOrder.bind(fixture.provider);
    const createCall = vi
      .spyOn(fixture.provider, 'createOrder')
      .mockImplementationOnce(async (input) => {
        await actualCreate(input);
        throw new Error('private provider timeout payload');
      });
    const first = await create(fixture);
    expect(first.order.providerCreateState).toBe('unknown');
    expect(first.checkout).toBeNull();
    const recovered = await create(fixture);
    expect(recovered.order.id).toBe(first.order.id);
    expect(recovered.order.providerCreateState).toBe('accepted');
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it('retains unknown after accepted-request persistence fails and returns a redacted recoverable error', async () => {
    const fixture = await setup();
    const createCall = vi.spyOn(fixture.provider, 'createOrder');
    vi.spyOn(fixture.ctx.repos.payments, 'markOrderRequestOutcome').mockRejectedValueOnce(
      new Error('private provider payload'),
    );
    const result = await createHostedSubscriptionOrderTool.execute(
      { planVersionId: fixture.plan.id, requestId: 'persist-failure' },
      fixture.user.ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'adapter_error',
        cause: 'payment_order_persistence_unknown',
        recoverable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('private provider payload');
    const recovered = await create(fixture, 'persist-failure');
    expect(recovered.order.providerCreateState).toBe('accepted');
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it('requires authoritative query for a closed order late payment and never reactivates a suspended tenant', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    await webhook(fixture, fixture.provider.closeOrder(order.merchantOrderId));
    const paid = fixture.provider.confirmPayment(order.merchantOrderId);
    const late = await webhook(fixture, paid);
    expect(late.ok && late.data.event.disposition).toBe('needs-review');
    expect(await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId)).toHaveLength(0);
    const reconciled = await queryHostedSubscriptionOrderTool.execute(
      { orderId: order.id },
      fixture.user.ctx,
    );
    expect(reconciled.ok && reconciled.data.order.reconciliation).toBe('none');
    expect(await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId)).toHaveLength(1);

    const { order: second } = await create(fixture, 'suspended-order');
    await fixture.ctx.repos.tenants.suspend({
      id: order.tenantId,
      generation: 1,
      now: fixture.ctx.clock(),
    });
    fixture.provider.confirmPayment(second.merchantOrderId);
    const suspended = await reconcileHostedSubscriptionOrderTool.execute(
      { tenantId: second.tenantId, orderId: second.id },
      fixture.worker,
    );
    expect(suspended.ok && suspended.data.order).toMatchObject({
      state: 'paid',
      reconciliation: 'refund-required',
    });
    expect((await fixture.ctx.repos.tenants.findById(order.tenantId))?.status).toBe('suspended');
    expect(await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId)).toHaveLength(1);
  });

  it('uses not_found for another tenant order and requires operator authority for refunds', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const other = await loginPlatformTestUser(fixture, 'other@example.test');
    const ctx = buildPlatformContext({ ...other.ctx, payment: fixture.provider });
    expect(await queryHostedSubscriptionOrderTool.execute({ orderId: order.id }, ctx)).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'SubscriptionOrder', id: order.id },
    });
    expect(
      (
        await requestHostedRefundTool.execute(
          {
            tenantId: order.tenantId,
            orderId: order.id,
            paymentAttemptId: 'attempt',
            requestId: 'refund',
            amountMinor: 1,
            entitlementAction: 'retain',
          },
          fixture.user.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('atomically reserves concurrent refunds without exceeding confirmed paid funds', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const { attempt } = await pay(fixture, order);
    const input = {
      tenantId: order.tenantId,
      orderId: order.id,
      paymentAttemptId: attempt.id,
      amountMinor: 800,
      entitlementAction: 'retain' as const,
    };
    const results = await Promise.all([
      requestHostedRefundTool.execute({ ...input, requestId: 'refund-a' }, fixture.worker),
      requestHostedRefundTool.execute({ ...input, requestId: 'refund-b' }, fixture.worker),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'refund:available-amount' },
    });
    const refunds = await fixture.ctx.repos.payments.listRefunds(order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.state).toBe('submitted');
    expect(
      (await fixture.ctx.repos.payments.findOrder({ id: order.id, tenantId: order.tenantId }))
        ?.refundedMinor,
    ).toBe(0);
  });

  it('queries unknown refunds before any retry, then confirms partial retain and final revoke', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const { attempt } = await pay(fixture, order);
    const actualRequest = fixture.provider.requestRefund.bind(fixture.provider);
    const requestCall = vi
      .spyOn(fixture.provider, 'requestRefund')
      .mockImplementationOnce(async (input) => {
        await actualRequest(input);
        throw new Error('private refund timeout');
      });
    const input = {
      tenantId: order.tenantId,
      orderId: order.id,
      paymentAttemptId: attempt.id,
      requestId: 'partial-refund',
      amountMinor: 500,
      entitlementAction: 'retain' as const,
    };
    const first = await requestHostedRefundTool.execute(input, fixture.worker);
    if (!first.ok) throw new Error('Fixture refund missing');
    expect(first.data.refund.state).toBe('unknown');
    const observed = await requestHostedRefundTool.execute(input, fixture.worker);
    expect(observed.ok && observed.data.refund.state).toBe('processing');
    expect(requestCall).toHaveBeenCalledTimes(1);
    fixture.provider.confirmRefund(first.data.refund.id);
    const partial = await queryHostedRefundTool.execute(
      { tenantId: order.tenantId, orderId: order.id, refundId: first.data.refund.id },
      fixture.worker,
    );
    expect(partial.ok && partial.data.state).toBe('succeeded');
    expect((await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId))[0]?.status).toBe(
      'paid',
    );
    const final = await requestHostedRefundTool.execute(
      { ...input, requestId: 'remaining-refund', amountMinor: 700, entitlementAction: 'revoke' },
      fixture.worker,
    );
    if (!final.ok) throw new Error('Fixture final refund missing');
    fixture.provider.confirmRefund(final.data.refund.id);
    await queryHostedRefundTool.execute(
      { tenantId: order.tenantId, orderId: order.id, refundId: final.data.refund.id },
      fixture.worker,
    );
    expect((await fixture.ctx.repos.subscriptions.listPeriods(order.tenantId))[0]?.status).toBe(
      'revoked',
    );
    expect(
      (await fixture.ctx.repos.payments.findOrder({ id: order.id, tenantId: order.tenantId }))
        ?.refundedMinor,
    ).toBe(1200);
  });

  it('releases refund occupation only after a confirmed absence, without resubmitting', async () => {
    const fixture = await setup();
    const { order } = await create(fixture);
    const { attempt } = await pay(fixture, order);
    const requestCall = vi
      .spyOn(fixture.provider, 'requestRefund')
      .mockResolvedValueOnce({ state: 'unknown' });
    const input = {
      tenantId: order.tenantId,
      orderId: order.id,
      paymentAttemptId: attempt.id,
      requestId: 'unaccepted-refund',
      amountMinor: 1200,
      entitlementAction: 'revoke' as const,
    };
    const reserved = await requestHostedRefundTool.execute(input, fixture.worker);
    expect(reserved.ok && reserved.data.refund.state).toBe('unknown');
    const absent = await requestHostedRefundTool.execute(input, fixture.worker);
    expect(absent.ok && absent.data.refund.state).toBe('failed');
    expect(requestCall).toHaveBeenCalledTimes(1);
    const newRequest = await requestHostedRefundTool.execute(
      { ...input, requestId: 'new-confirmed-absence-request' },
      fixture.worker,
    );
    expect(newRequest.ok && newRequest.data.refund.state).toBe('submitted');
  });

  it('rejects missing providers, denied external capability and fixture production configuration', async () => {
    const fixture = await setup();
    const unavailable = buildPlatformContext({
      ...fixture.user.ctx,
      payment: new UnconfiguredHostedPaymentAdapter(),
    });
    expect(
      (
        await createHostedSubscriptionOrderTool.execute(
          { planVersionId: fixture.plan.id, requestId: 'missing' },
          unavailable,
        )
      ).ok,
    ).toBe(false);
    const denied = buildPlatformContext({
      ...fixture.user.ctx,
      capabilities: { write: true, external: false },
    });
    expect(
      await createHostedSubscriptionOrderTool.execute(
        { planVersionId: fixture.plan.id, requestId: 'denied' },
        denied,
      ),
    ).toEqual({ ok: false, error: { kind: 'permission_denied', required: 'external' } });
    expect(() =>
      buildPlatformContext({
        ...fixture.user.ctx,
        environment: 'production',
        emailOtp: {
          ...fixture.emailOtp,
          providerKind: 'live',
          sendChallenge: fixture.emailOtp.sendChallenge.bind(fixture.emailOtp),
        },
      }),
    ).toThrow('Fixture payment provider');
  });
});
