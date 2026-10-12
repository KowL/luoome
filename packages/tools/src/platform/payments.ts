import { createHash } from 'node:crypto';
import {
  HostedPaymentEventSchema,
  type HostedRefund,
  HostedRefundSchema,
  type HostedVerifiedPaymentFact,
  HostedVerifiedPaymentFactSchema,
  type SubscriptionOrder,
  SubscriptionOrderSchema,
  SubscriptionPeriodSchema,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
import type { PlatformContext } from './context.js';
import { randomAuthId } from './crypto.js';
import { definePlatformTool } from './define-platform-tool.js';

const Id = z.string().min(1).max(160);
const CheckoutSchema = z.object({
  providerOrderId: z.string().min(1).max(256),
  checkoutUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .nullable(),
});
const WebhookInputSchema = z
  .object({
    rawBody: z.string().min(1).max(65_536),
    timestamp: z.string().min(1).max(80),
    signature: z.string().min(1).max(2048),
  })
  .strict();
const AppliedEventSchema = z.object({
  order: SubscriptionOrderSchema.nullable(),
  period: SubscriptionPeriodSchema.nullable(),
  event: HostedPaymentEventSchema,
  replayed: z.boolean(),
});
const OrderObservationSchema = z.object({
  order: SubscriptionOrderSchema,
  checkout: CheckoutSchema.nullable(),
  observation: z.enum(['pending', 'confirmed', 'not-found', 'unknown']),
});
const permissionDenied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});
const payloadHash = (values: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');

const applyFact = async (
  ctx: PlatformContext,
  fact: HostedVerifiedPaymentFact,
  authoritativeQuery: boolean,
  order?: SubscriptionOrder,
) => {
  if (
    fact.provider !== ctx.payment?.name ||
    fact.merchantId !== ctx.payment.merchantId ||
    (order !== undefined && fact.merchantOrderId !== order.merchantOrderId)
  )
    return errInvalidInput('provider_payment_fact_mismatch');
  const now = ctx.clock();
  return ctx.repos.payments.applyVerifiedPaymentEvent({
    event: {
      ...fact,
      id: randomAuthId(),
      receivedAt: now,
      processedAt: null,
      disposition: 'pending',
    },
    periodId: randomAuthId(),
    now,
    allowClosedOrderGrant: authoritativeQuery,
  });
};

const observeOrder = async (ctx: PlatformContext, order: SubscriptionOrder) => {
  const provider = ctx.payment;
  if (
    provider?.configured !== true ||
    order.provider !== provider.name ||
    order.merchantId !== provider.merchantId
  )
    return errAdapterError('hosted-payment', 'provider_unconfigured');
  try {
    const outcome = await provider.queryOrder({ merchantOrderId: order.merchantOrderId });
    if (outcome.state === 'pending') {
      const current = await ctx.repos.payments.markOrderRequestOutcome({
        id: order.id,
        state: 'accepted',
        providerOrderId: outcome.providerOrderId,
        now: ctx.clock(),
      });
      return {
        order: current,
        checkout: { providerOrderId: outcome.providerOrderId, checkoutUrl: outcome.checkoutUrl },
        observation: 'pending' as const,
      };
    }
    if (outcome.state === 'confirmed') {
      if (outcome.events.length === 0 || outcome.events.length > 100)
        return errAdapterError('hosted-payment', 'provider_fact_unavailable', true);
      let current = order;
      for (const fact of outcome.events) {
        const applied = await applyFact(ctx, fact, true, order);
        if ('ok' in applied) return applied;
        if (applied.order === null) return errNotFound('SubscriptionOrder', order.id);
        current = applied.order;
      }
      return { order: current, checkout: null, observation: 'confirmed' as const };
    }
    return { order, checkout: null, observation: outcome.state };
  } catch {
    return errAdapterError('hosted-payment', 'payment_query_unknown', true);
  }
};

const submitOrder = async (ctx: PlatformContext, order: SubscriptionOrder) => {
  const provider = ctx.payment;
  if (provider?.configured !== true)
    return errAdapterError('hosted-payment', 'provider_unconfigured');
  let outcome: Awaited<ReturnType<typeof provider.createOrder>>;
  try {
    outcome = await provider.createOrder({
      merchantOrderId: order.merchantOrderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt: order.expiresAt,
    });
  } catch {
    outcome = { state: 'unknown' };
  }
  if (outcome.state === 'failed') return errAdapterError('hosted-payment', outcome.errorKind);
  try {
    const current = await ctx.repos.payments.markOrderRequestOutcome({
      id: order.id,
      state: outcome.state,
      now: ctx.clock(),
      ...(outcome.state === 'accepted' ? { providerOrderId: outcome.providerOrderId } : {}),
    });
    return {
      order: current,
      checkout:
        outcome.state === 'accepted'
          ? { providerOrderId: outcome.providerOrderId, checkoutUrl: outcome.checkoutUrl }
          : null,
    };
  } catch {
    try {
      await ctx.repos.payments.markOrderRequestOutcome({
        id: order.id,
        state: 'unknown',
        now: ctx.clock(),
      });
    } catch {}
    return errAdapterError('hosted-payment', 'payment_order_persistence_unknown', true);
  }
};

export const createHostedSubscriptionOrderTool = definePlatformTool({
  name: 'create_hosted_subscription_order',
  description:
    'Create a one-time order using the immutable server plan and stable merchant order identity.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['user'],
  input: z.object({ planVersionId: Id, requestId: Id }).strict(),
  output: z.object({
    order: SubscriptionOrderSchema,
    checkout: CheckoutSchema.nullable(),
    replayed: z.boolean(),
  }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return permissionDenied('actor:user');
    const provider = ctx.payment;
    if (provider?.configured !== true)
      return errAdapterError('hosted-payment', 'provider_unconfigured');
    const plan = await ctx.repos.subscriptions.findPlan(input.planVersionId);
    if (plan === null) return errNotFound('PlanVersion', input.planVersionId);
    const now = ctx.clock();
    const id = randomAuthId();
    const prepared = await ctx.repos.payments.createOrder({
      order: {
        id,
        tenantId: ctx.principal.tenantId,
        requestId: input.requestId,
        payloadHash: payloadHash([
          'order-v1',
          ctx.principal.tenantId,
          plan.id,
          provider.name,
          provider.merchantId,
        ]),
        planSnapshot: plan,
        provider: provider.name,
        merchantId: provider.merchantId,
        merchantOrderId: id,
        providerOrderId: null,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        state: 'created',
        providerCreateState: 'not-requested',
        reconciliation: 'none',
        refundedMinor: 0,
        expiresAt: new Date(now.getTime() + 30 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
      now,
    });
    if (prepared.replayed) {
      if (prepared.order.state === 'paid' || prepared.order.state === 'closed')
        return { order: prepared.order, checkout: null, replayed: true };
      const observed = await observeOrder(ctx, prepared.order);
      if ('ok' in observed) return observed;
      if (
        observed.observation !== 'not-found' ||
        provider.orderIdempotency !== 'supported' ||
        prepared.order.expiresAt <= now
      )
        return { order: observed.order, checkout: observed.checkout, replayed: true };
    }
    const submitted = await submitOrder(ctx, prepared.order);
    return 'ok' in submitted ? submitted : { ...submitted, replayed: prepared.replayed };
  },
});

export const listHostedSubscriptionOrdersTool = definePlatformTool({
  name: 'list_hosted_subscription_orders',
  description:
    'Read necessary order history for the authenticated tenant without requesting payment.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({}).strict(),
  output: z.array(SubscriptionOrderSchema),
  handler: async (_input, ctx) =>
    ctx.principal.kind === 'user'
      ? [...(await ctx.repos.payments.listOrders(ctx.principal.tenantId))]
      : permissionDenied('actor:user'),
});

export const queryHostedSubscriptionOrderTool = definePlatformTool({
  name: 'query_hosted_subscription_order',
  description: 'Query authoritative payment state; a browser return URL does not grant service.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['user'],
  input: z.object({ orderId: Id }).strict(),
  output: OrderObservationSchema,
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return permissionDenied('actor:user');
    const order = await ctx.repos.payments.findOrder({
      id: input.orderId,
      tenantId: ctx.principal.tenantId,
    });
    return order === null
      ? errNotFound('SubscriptionOrder', input.orderId)
      : observeOrder(ctx, order);
  },
});

export const reconcileHostedSubscriptionOrderTool = definePlatformTool({
  name: 'reconcile_hosted_subscription_order',
  description:
    'Recover a durable order from provider facts using the original merchant order identity.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['worker'],
  input: z.object({ tenantId: Id, orderId: Id }).strict(),
  output: OrderObservationSchema,
  handler: async (input, ctx) => {
    const order = await ctx.repos.payments.findOrder({
      id: input.orderId,
      tenantId: input.tenantId,
    });
    return order === null
      ? errNotFound('SubscriptionOrder', input.orderId)
      : observeOrder(ctx, order);
  },
});

export const verifyHostedPaymentWebhookTool = definePlatformTool({
  name: 'verify_hosted_payment_webhook',
  description:
    'Verify raw provider bytes, freshness and merchant identity before constructing a webhook principal.',
  sideEffect: 'read',
  actors: ['anonymous'],
  input: WebhookInputSchema,
  output: HostedVerifiedPaymentFactSchema,
  handler: async (input, ctx) => {
    if (ctx.payment?.configured !== true) return permissionDenied('payment:verified-webhook');
    try {
      const verification = await ctx.payment.verifyWebhook(input, ctx.clock());
      return verification.verified &&
        verification.event.provider === ctx.payment.name &&
        verification.event.merchantId === ctx.payment.merchantId
        ? verification.event
        : permissionDenied('payment:verified-webhook');
    } catch {
      return permissionDenied('payment:verified-webhook');
    }
  },
});

export const applyHostedPaymentWebhookTool = definePlatformTool({
  name: 'apply_hosted_payment_webhook',
  description:
    'Persist a freshly verified provider event and grant a purchased period atomically once.',
  sideEffect: 'write',
  actors: ['webhook'],
  input: WebhookInputSchema,
  output: AppliedEventSchema,
  handler: async (input, ctx) => {
    const provider = ctx.payment;
    if (
      ctx.principal.kind !== 'webhook' ||
      provider?.configured !== true ||
      ctx.principal.provider !== provider.name
    )
      return permissionDenied('payment:verified-webhook');
    let verification: Awaited<ReturnType<typeof provider.verifyWebhook>>;
    try {
      verification = await provider.verifyWebhook(input, ctx.clock());
    } catch {
      return permissionDenied('payment:verified-webhook');
    }
    if (!verification.verified || verification.event.eventId !== ctx.principal.eventId)
      return permissionDenied('payment:verified-webhook');
    return applyFact(ctx, verification.event, false);
  },
});

const observeRefund = async (
  ctx: PlatformContext,
  order: SubscriptionOrder,
  refund: HostedRefund,
) => {
  const provider = ctx.payment;
  if (
    provider?.configured !== true ||
    order.provider !== provider.name ||
    order.merchantId !== provider.merchantId
  )
    return errAdapterError('hosted-payment', 'provider_unconfigured');
  if (refund.state === 'succeeded' || refund.state === 'failed') return refund;
  const fact = (await ctx.repos.payments.listPaymentAttempts(order.id)).find(
    (candidate) => candidate.id === refund.paymentAttemptId,
  );
  if (fact === undefined) return errNotFound('HostedPaymentAttempt', refund.paymentAttemptId);
  try {
    const outcome = await provider.queryRefund({
      refundId: refund.id,
      merchantOrderId: order.merchantOrderId,
      providerTransactionId: fact.providerTransactionId,
    });
    if (outcome.state === 'confirmed') {
      if (outcome.event.refundId !== refund.id)
        return errInvalidInput('provider_refund_fact_mismatch');
      const applied = await applyFact(ctx, outcome.event, true, order);
      if ('ok' in applied) return applied;
      return (
        (await ctx.repos.payments.listRefunds(order.id)).find(
          (candidate) => candidate.id === refund.id,
        ) ?? errNotFound('HostedRefund', refund.id)
      );
    }
    return ctx.repos.payments.updateRefundOutcome({
      id: refund.id,
      state:
        outcome.state === 'not-found'
          ? 'failed'
          : outcome.state === 'processing'
            ? 'processing'
            : 'unknown',
      now: ctx.clock(),
      ...(outcome.state === 'processing' ? { providerRefundId: outcome.providerRefundId } : {}),
    });
  } catch {
    return errAdapterError('hosted-payment', 'refund_query_unknown', true);
  }
};

export const requestHostedRefundTool = definePlatformTool({
  name: 'request_hosted_refund',
  description:
    'Reserve available paid funds and submit an explicitly audited operator refund action.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['worker'],
  input: z
    .object({
      tenantId: Id,
      orderId: Id,
      paymentAttemptId: Id,
      requestId: Id,
      amountMinor: z.number().int().positive().safe(),
      entitlementAction: z.enum(['revoke', 'retain']),
    })
    .strict(),
  output: z.object({ refund: HostedRefundSchema, replayed: z.boolean() }),
  handler: async (input, ctx) => {
    const provider = ctx.payment;
    if (provider?.configured !== true)
      return errAdapterError('hosted-payment', 'provider_unconfigured');
    const order = await ctx.repos.payments.findOrder({
      id: input.orderId,
      tenantId: input.tenantId,
    });
    if (order === null) return errNotFound('SubscriptionOrder', input.orderId);
    if (order.provider !== provider.name || order.merchantId !== provider.merchantId)
      return errAdapterError('hosted-payment', 'provider_unconfigured');
    const payment = (await ctx.repos.payments.listPaymentAttempts(order.id)).find(
      (candidate) => candidate.id === input.paymentAttemptId,
    );
    if (payment === undefined) return errNotFound('HostedPaymentAttempt', input.paymentAttemptId);
    const now = ctx.clock();
    const reserved = await ctx.repos.payments.reserveRefund({
      refund: {
        id: randomAuthId(),
        orderId: order.id,
        tenantId: order.tenantId,
        paymentAttemptId: payment.id,
        requestId: input.requestId,
        payloadHash: payloadHash([
          'refund-v1',
          order.id,
          payment.id,
          input.amountMinor,
          input.entitlementAction,
        ]),
        provider: provider.name,
        merchantId: provider.merchantId,
        amountMinor: input.amountMinor,
        state: 'reserved',
        entitlementAction: input.entitlementAction,
        providerRefundId: null,
        createdAt: now,
        updatedAt: now,
      },
      now,
    });
    if (reserved.replayed) {
      const observed = await observeRefund(ctx, order, reserved.refund);
      return 'ok' in observed ? observed : { refund: observed, replayed: true };
    }
    let outcome: Awaited<ReturnType<typeof provider.requestRefund>>;
    try {
      outcome = await provider.requestRefund({
        refundId: reserved.refund.id,
        merchantOrderId: order.merchantOrderId,
        providerTransactionId: payment.providerTransactionId,
        amountMinor: reserved.refund.amountMinor,
        currency: order.currency,
      });
    } catch {
      outcome = { state: 'unknown' };
    }
    try {
      const refund = await ctx.repos.payments.updateRefundOutcome({
        id: reserved.refund.id,
        state: outcome.state,
        now: ctx.clock(),
        ...(outcome.state === 'submitted' || outcome.state === 'processing'
          ? { providerRefundId: outcome.providerRefundId }
          : {}),
      });
      return { refund, replayed: false };
    } catch {
      try {
        await ctx.repos.payments.updateRefundOutcome({
          id: reserved.refund.id,
          state: 'unknown',
          now: ctx.clock(),
        });
      } catch {}
      return errAdapterError('hosted-payment', 'refund_persistence_unknown', true);
    }
  },
});

export const queryHostedRefundTool = definePlatformTool({
  name: 'query_hosted_refund',
  description:
    'Resolve a submitted or unknown refund from authoritative provider state without resubmitting.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['worker'],
  input: z.object({ tenantId: Id, orderId: Id, refundId: Id }).strict(),
  output: HostedRefundSchema,
  handler: async (input, ctx) => {
    const order = await ctx.repos.payments.findOrder({
      id: input.orderId,
      tenantId: input.tenantId,
    });
    if (order === null) return errNotFound('SubscriptionOrder', input.orderId);
    const refund = (await ctx.repos.payments.listRefunds(order.id)).find(
      (candidate) => candidate.id === input.refundId,
    );
    return refund === undefined
      ? errNotFound('HostedRefund', input.refundId)
      : observeRefund(ctx, order, refund);
  },
});

export const listHostedPaymentReconciliationTool = definePlatformTool({
  name: 'list_hosted_payment_reconciliation',
  description:
    'Read a bounded set of durable orders and refunds due for provider queries, including deleted-tenant financial records.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
  output: z.object({
    orders: z.array(SubscriptionOrderSchema),
    refunds: z.array(HostedRefundSchema),
  }),
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const all = (
      await Promise.all(
        (await ctx.repos.tenants.list()).map((tenant) => ctx.repos.payments.listOrders(tenant.id)),
      )
    ).flat();
    const due = (record: { updatedAt: Date }) =>
      now.getTime() - record.updatedAt.getTime() >= 60_000;
    const orders = all
      .filter(
        (order) =>
          (['created', 'pending'].includes(order.state) || order.reconciliation !== 'none') &&
          due(order),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
    const refunds = (
      await Promise.all(all.map((order) => ctx.repos.payments.listRefunds(order.id)))
    )
      .flat()
      .filter((refund) => !['succeeded', 'failed'].includes(refund.state) && due(refund))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, input.limit);
    return { orders, refunds };
  },
});
export const claimHostedPaymentReconciliationTool = definePlatformTool({
  name: 'claim_hosted_payment_reconciliation',
  description: 'Atomically reserve one bounded payment polling interval across worker processes.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ orderId: Id, refundId: Id.nullable().default(null) }).strict(),
  output: z.object({ claimed: z.boolean() }),
  handler: async (input, ctx) => ({
    claimed: await ctx.repos.payments.claimReconciliation({
      ...input,
      now: ctx.clock(),
      intervalMs: 60_000,
    }),
  }),
});

export const platformPaymentTools = [
  createHostedSubscriptionOrderTool,
  listHostedSubscriptionOrdersTool,
  queryHostedSubscriptionOrderTool,
  reconcileHostedSubscriptionOrderTool,
  verifyHostedPaymentWebhookTool,
  applyHostedPaymentWebhookTool,
  requestHostedRefundTool,
  queryHostedRefundTool,
  listHostedPaymentReconciliationTool,
  claimHostedPaymentReconciliationTool,
] as const;
