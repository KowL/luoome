import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  type HostedPaymentCheckout,
  type HostedPaymentCreateResult,
  type HostedPaymentOrderQueryResult,
  type HostedPaymentOrderRequest,
  type HostedPaymentPort,
  type HostedPaymentRefundQueryResult,
  type HostedPaymentRefundRequest,
  type HostedPaymentRefundResult,
  type HostedPaymentWebhookEnvelope,
  type HostedPaymentWebhookVerification,
  type HostedVerifiedPaymentFact,
  HostedVerifiedPaymentFactSchema,
} from '@luoome/core';

export class UnconfiguredHostedPaymentAdapter implements HostedPaymentPort {
  readonly name = 'hosted-payment-unconfigured';
  readonly merchantId = 'unconfigured';
  readonly providerKind = 'live' as const;
  readonly configured = false;
  readonly orderIdempotency = 'unsupported' as const;
  readonly refundIdempotency = 'unsupported' as const;
  async createOrder(): Promise<HostedPaymentCreateResult> {
    return { state: 'failed', errorKind: 'provider-unconfigured' };
  }
  async queryOrder(): Promise<HostedPaymentOrderQueryResult> {
    return { state: 'unknown' };
  }
  async requestRefund(): Promise<HostedPaymentRefundResult> {
    return { state: 'failed', errorKind: 'provider-unconfigured' };
  }
  async queryRefund(): Promise<HostedPaymentRefundQueryResult> {
    return { state: 'unknown' };
  }
  async verifyWebhook(): Promise<HostedPaymentWebhookVerification> {
    return { verified: false };
  }
}

const WebhookBodySchema = HostedVerifiedPaymentFactSchema.omit({
  provider: true,
  payloadDigest: true,
  verification: true,
}).strict();
type FixtureFact = Omit<HostedVerifiedPaymentFact, 'provider' | 'payloadDigest' | 'verification'>;
interface FixtureOrder {
  readonly request: HostedPaymentOrderRequest;
  readonly checkout: HostedPaymentCheckout;
  state: 'pending' | 'paid' | 'closed';
  fact: HostedVerifiedPaymentFact | null;
}
interface FixtureRefund {
  readonly request: HostedPaymentRefundRequest;
  readonly providerRefundId: string;
  fact: HostedVerifiedPaymentFact | null;
}

export class FixtureHostedPaymentAdapter implements HostedPaymentPort {
  readonly name = 'hosted-payment-fixture';
  readonly providerKind = 'fixture' as const;
  readonly configured = true;
  readonly orderIdempotency = 'supported' as const;
  readonly refundIdempotency = 'supported' as const;
  readonly merchantId: string;
  private readonly webhookSecret: string;
  private readonly clock: () => Date;
  private readonly orders = new Map<string, FixtureOrder>();
  private readonly refunds = new Map<string, FixtureRefund>();

  constructor(
    input: {
      readonly merchantId?: string;
      readonly webhookSecret?: string;
      readonly clock?: () => Date;
    } = {},
  ) {
    this.merchantId = input.merchantId ?? 'fixture-merchant';
    this.webhookSecret = input.webhookSecret ?? 'fixture-payment-signing-secret-32-bytes-minimum';
    this.clock = input.clock ?? (() => new Date());
    if (Buffer.byteLength(this.webhookSecret, 'utf8') < 32)
      throw new Error('Payment signing secret must contain at least 32 bytes');
  }

  async createOrder(input: HostedPaymentOrderRequest): Promise<HostedPaymentCreateResult> {
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 0 ||
      input.currency !== 'CNY' ||
      input.expiresAt <= this.clock()
    )
      return { state: 'failed', errorKind: 'provider-rejected' };
    const existing = this.orders.get(input.merchantOrderId);
    if (existing !== undefined) {
      return JSON.stringify(existing.request) === JSON.stringify(input)
        ? { state: 'accepted', ...existing.checkout }
        : { state: 'failed', errorKind: 'provider-rejected' };
    }
    const checkout = {
      providerOrderId: `fixture-order:${input.merchantOrderId}`,
      checkoutUrl: `https://payment-fixture.invalid/checkout/${encodeURIComponent(input.merchantOrderId)}`,
    };
    this.orders.set(input.merchantOrderId, {
      request: { ...input, expiresAt: new Date(input.expiresAt) },
      checkout,
      state: 'pending',
      fact: null,
    });
    return { state: 'accepted', ...checkout };
  }

  async queryOrder({
    merchantOrderId,
  }: {
    readonly merchantOrderId: string;
  }): Promise<HostedPaymentOrderQueryResult> {
    const order = this.orders.get(merchantOrderId);
    if (order === undefined) return { state: 'not-found' };
    return order.fact === null
      ? { state: 'pending', ...order.checkout }
      : { state: 'confirmed', events: [this.queryFact(order.fact)] };
  }

  async requestRefund(input: HostedPaymentRefundRequest): Promise<HostedPaymentRefundResult> {
    const existing = this.refunds.get(input.refundId);
    if (existing !== undefined)
      return JSON.stringify(existing.request) === JSON.stringify(input)
        ? { state: 'submitted', providerRefundId: existing.providerRefundId }
        : { state: 'failed', errorKind: 'provider-rejected' };
    const order = this.orders.get(input.merchantOrderId);
    if (
      order?.fact?.providerTransactionId !== input.providerTransactionId ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.amountMinor > order.request.amountMinor ||
      input.currency !== 'CNY'
    )
      return { state: 'failed', errorKind: 'provider-rejected' };
    const pending = [...this.refunds.values()]
      .filter(
        (refund) =>
          refund.request.merchantOrderId === input.merchantOrderId && refund.fact === null,
      )
      .reduce((sum, refund) => sum + refund.request.amountMinor, 0);
    if (order.fact.confirmedRefundedMinor + pending + input.amountMinor > order.request.amountMinor)
      return { state: 'failed', errorKind: 'provider-rejected' };
    const providerRefundId = `fixture-refund:${input.refundId}`;
    this.refunds.set(input.refundId, { request: { ...input }, providerRefundId, fact: null });
    return { state: 'submitted', providerRefundId };
  }

  async queryRefund(input: {
    readonly refundId: string;
    readonly merchantOrderId: string;
    readonly providerTransactionId: string;
  }): Promise<HostedPaymentRefundQueryResult> {
    const refund = this.refunds.get(input.refundId);
    if (refund === undefined) return { state: 'not-found' };
    if (
      refund.request.merchantOrderId !== input.merchantOrderId ||
      refund.request.providerTransactionId !== input.providerTransactionId
    )
      return { state: 'unknown' };
    return refund.fact === null
      ? { state: 'processing', providerRefundId: refund.providerRefundId }
      : { state: 'confirmed', event: this.queryFact(refund.fact) };
  }

  async verifyWebhook(
    input: HostedPaymentWebhookEnvelope,
    now: Date,
  ): Promise<HostedPaymentWebhookVerification> {
    if (
      !/^[0-9]{10}$/.test(input.timestamp) ||
      !/^[a-f0-9]{64}$/.test(input.signature) ||
      Buffer.byteLength(input.rawBody, 'utf8') > 65_536 ||
      Math.abs(now.getTime() - Number(input.timestamp) * 1000) > 300_000
    )
      return { verified: false };
    const expected = this.signature(input.rawBody, input.timestamp);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.signature, 'hex')))
      return { verified: false };
    try {
      const parsed = WebhookBodySchema.safeParse(JSON.parse(input.rawBody));
      if (!parsed.success || parsed.data.merchantId !== this.merchantId) return { verified: false };
      return {
        verified: true,
        event: {
          ...parsed.data,
          provider: this.name,
          verification: 'verified',
          payloadDigest: createHash('sha256').update(input.rawBody, 'utf8').digest('hex'),
        },
      };
    } catch {
      return { verified: false };
    }
  }

  confirmPayment(
    merchantOrderId: string,
    input: { readonly providerTransactionId?: string; readonly paidAt?: Date } = {},
  ): HostedVerifiedPaymentFact {
    const order = this.orders.get(merchantOrderId);
    if (order === undefined) throw new Error('Fixture order not found');
    if (order.state === 'paid' && order.fact !== null) return structuredClone(order.fact);
    const paidAt = input.paidAt ?? this.clock();
    const fact = this.fact({
      eventId: this.eventId([
        'payment',
        merchantOrderId,
        input.providerTransactionId ?? merchantOrderId,
      ]),
      merchantId: this.merchantId,
      merchantOrderId,
      providerTransactionId:
        input.providerTransactionId ?? `fixture-transaction:${merchantOrderId}`,
      kind: 'paid',
      amountMinor: order.request.amountMinor,
      currency: 'CNY',
      confirmedRefundedMinor: order.fact?.confirmedRefundedMinor ?? 0,
      refundId: null,
      refundAmountMinor: null,
      providerRefundId: null,
      paidAt,
    });
    order.state = 'paid';
    order.fact = fact;
    return structuredClone(fact);
  }

  closeOrder(merchantOrderId: string): HostedVerifiedPaymentFact {
    const order = this.orders.get(merchantOrderId);
    if (order === undefined) throw new Error('Fixture order not found');
    if (order.state === 'paid' && order.fact !== null) return structuredClone(order.fact);
    const fact = this.fact({
      eventId: this.eventId(['closed', merchantOrderId]),
      merchantId: this.merchantId,
      merchantOrderId,
      providerTransactionId: null,
      kind: 'closed',
      amountMinor: order.request.amountMinor,
      currency: 'CNY',
      confirmedRefundedMinor: 0,
      refundId: null,
      refundAmountMinor: null,
      providerRefundId: null,
      paidAt: null,
    });
    order.state = 'closed';
    order.fact = fact;
    return structuredClone(fact);
  }

  confirmRefund(refundId: string, succeeded = true): HostedVerifiedPaymentFact {
    const refund = this.refunds.get(refundId);
    if (refund === undefined) throw new Error('Fixture refund not found');
    if (refund.fact !== null) return structuredClone(refund.fact);
    const order = this.orders.get(refund.request.merchantOrderId);
    if (order?.fact === null || order === undefined)
      throw new Error('Fixture payment fact not found');
    const confirmedRefundedMinor =
      order.fact.confirmedRefundedMinor + (succeeded ? refund.request.amountMinor : 0);
    if (confirmedRefundedMinor > order.request.amountMinor)
      throw new Error('Fixture refund exceeds payment');
    const fact = this.fact({
      eventId: this.eventId(['refund', refundId, succeeded]),
      merchantId: this.merchantId,
      merchantOrderId: refund.request.merchantOrderId,
      providerTransactionId: refund.request.providerTransactionId,
      kind: succeeded ? 'refund-succeeded' : 'refund-failed',
      amountMinor: order.request.amountMinor,
      currency: 'CNY',
      confirmedRefundedMinor,
      refundId,
      refundAmountMinor: refund.request.amountMinor,
      providerRefundId: refund.providerRefundId,
      paidAt: order.fact.paidAt,
    });
    refund.fact = fact;
    order.fact = fact;
    return structuredClone(fact);
  }

  signWebhook(fact: HostedVerifiedPaymentFact, at = this.clock()): HostedPaymentWebhookEnvelope {
    const {
      provider: _provider,
      verification: _verification,
      payloadDigest: _digest,
      ...body
    } = fact;
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    return { rawBody, timestamp, signature: this.signature(rawBody, timestamp) };
  }

  private signature(rawBody: string, timestamp: string): string {
    return createHmac('sha256', this.webhookSecret)
      .update(`payment-fixture-v1\0${this.name}\0${this.merchantId}\0${timestamp}\0`)
      .update(rawBody, 'utf8')
      .digest('hex');
  }

  private eventId(values: readonly unknown[]): string {
    return `fixture:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
  }
  private fact(fact: FixtureFact): HostedVerifiedPaymentFact {
    return {
      ...fact,
      provider: this.name,
      verification: 'verified',
      payloadDigest: createHash('sha256').update(JSON.stringify(fact)).digest('hex'),
    };
  }

  private queryFact(fact: HostedVerifiedPaymentFact): HostedVerifiedPaymentFact {
    const {
      provider: _provider,
      verification: _verification,
      payloadDigest: _digest,
      ...body
    } = fact;
    return this.fact({ ...body, eventId: this.eventId(['query', body.eventId]) });
  }
}
