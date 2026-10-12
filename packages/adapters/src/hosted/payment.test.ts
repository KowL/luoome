import { describe, expect, it } from 'vitest';
import { FixtureHostedPaymentAdapter, UnconfiguredHostedPaymentAdapter } from './payment.js';

const now = new Date('2026-10-10T01:00:00.000Z');
const request = {
  merchantOrderId: 'fixture-order',
  amountMinor: 1200,
  currency: 'CNY' as const,
  expiresAt: new Date(now.getTime() + 1_800_000),
};

describe('fixture payment provider contract', () => {
  it('creates the same merchant order once and never treats creation as a payment', async () => {
    const provider = new FixtureHostedPaymentAdapter({ clock: () => now });
    const created = await provider.createOrder(request);
    expect(created.state).toBe('accepted');
    expect(await provider.createOrder(request)).toEqual(created);
    expect(await provider.createOrder({ ...request, amountMinor: 1 })).toEqual({
      state: 'failed',
      errorKind: 'provider-rejected',
    });
    expect(await provider.queryOrder({ merchantOrderId: request.merchantOrderId })).toMatchObject({
      state: 'pending',
    });
    expect(await provider.queryOrder({ merchantOrderId: 'missing' })).toEqual({
      state: 'not-found',
    });
  });

  it('binds signature to exact raw UTF8, timestamp, provider and configured merchant', async () => {
    const provider = new FixtureHostedPaymentAdapter({ clock: () => now });
    await provider.createOrder(request);
    const fact = provider.confirmPayment(request.merchantOrderId);
    const envelope = provider.signWebhook(fact);
    expect(await provider.verifyWebhook(envelope, now)).toMatchObject({
      verified: true,
      event: { kind: 'paid', amountMinor: 1200, merchantId: provider.merchantId },
    });
    expect(
      await provider.verifyWebhook({ ...envelope, rawBody: `${envelope.rawBody} ` }, now),
    ).toEqual({ verified: false });
    expect(await provider.verifyWebhook({ ...envelope, signature: 'a'.repeat(64) }, now)).toEqual({
      verified: false,
    });
    expect(await provider.verifyWebhook(envelope, new Date(now.getTime() + 301_000))).toEqual({
      verified: false,
    });
    expect(
      await provider.verifyWebhook(
        provider.signWebhook({ ...fact, merchantId: 'another-merchant' }),
        now,
      ),
    ).toEqual({ verified: false });
  });

  it('keeps refund submission distinct from confirmed funds and preserves its idempotency key', async () => {
    const provider = new FixtureHostedPaymentAdapter({ clock: () => now });
    await provider.createOrder(request);
    const fact = provider.confirmPayment(request.merchantOrderId);
    if (fact.providerTransactionId === null) throw new Error('Fixture payment transaction missing');
    const refund = {
      refundId: 'fixture-refund',
      merchantOrderId: request.merchantOrderId,
      providerTransactionId: fact.providerTransactionId,
      amountMinor: 500,
      currency: 'CNY' as const,
    };
    const submitted = await provider.requestRefund(refund);
    expect(submitted.state).toBe('submitted');
    expect(await provider.requestRefund(refund)).toEqual(submitted);
    expect(await provider.queryRefund(refund)).toMatchObject({ state: 'processing' });
    expect(
      await provider.requestRefund({ ...refund, refundId: 'overflow', amountMinor: 800 }),
    ).toEqual({ state: 'failed', errorKind: 'provider-rejected' });
    provider.confirmRefund(refund.refundId);
    expect(await provider.queryRefund(refund)).toMatchObject({
      state: 'confirmed',
      event: { kind: 'refund-succeeded', confirmedRefundedMinor: 500, refundAmountMinor: 500 },
    });
    expect(await provider.queryOrder({ merchantOrderId: request.merchantOrderId })).toMatchObject({
      state: 'confirmed',
      events: [{ kind: 'refund-succeeded' }],
    });
  });

  it('does not invent an order, financial confirmation or valid webhook without configuration', async () => {
    const provider = new UnconfiguredHostedPaymentAdapter();
    expect(provider.providerKind).toBe('live');
    expect(provider.configured).toBe(false);
    expect(await provider.createOrder()).toEqual({
      state: 'failed',
      errorKind: 'provider-unconfigured',
    });
    expect(await provider.queryOrder()).toEqual({ state: 'unknown' });
    expect(await provider.requestRefund()).toEqual({
      state: 'failed',
      errorKind: 'provider-unconfigured',
    });
    expect(await provider.queryRefund()).toEqual({ state: 'unknown' });
    expect(await provider.verifyWebhook()).toEqual({ verified: false });
  });
});
