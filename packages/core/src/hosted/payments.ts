import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { PlanVersionSchema } from './platform.js';

const Id = z.string().min(1).max(160);
const Minor = z.number().int().nonnegative().safe();
const Time = z.coerce.date();

export const SubscriptionOrderSchema = z.object({
  id: Id,
  tenantId: Id,
  requestId: Id,
  payloadHash: z.string().min(1).max(256),
  planSnapshot: PlanVersionSchema,
  provider: Id,
  merchantId: Id,
  merchantOrderId: Id,
  providerOrderId: z.string().max(256).nullable(),
  amountMinor: Minor,
  currency: z.literal('CNY'),
  state: z.enum(['created', 'pending', 'paid', 'closed']),
  providerCreateState: z.enum(['not-requested', 'accepted', 'unknown']),
  reconciliation: z.enum(['none', 'needs-review', 'refund-required']),
  refundedMinor: Minor,
  expiresAt: Time,
  createdAt: Time,
  updatedAt: Time,
});
export type SubscriptionOrder = z.infer<typeof SubscriptionOrderSchema>;

export const HostedPaymentAttemptSchema = z.object({
  id: Id,
  orderId: Id,
  provider: Id,
  merchantId: Id,
  merchantOrderId: Id,
  providerTransactionId: Id,
  amountMinor: Minor,
  currency: z.literal('CNY'),
  confirmedRefundedMinor: Minor,
  paidAt: Time.nullable(),
  confirmedAt: Time,
});
export type HostedPaymentAttempt = z.infer<typeof HostedPaymentAttemptSchema>;

export const HostedPaymentEventSchema = z.object({
  id: Id,
  provider: Id,
  eventId: Id,
  payloadDigest: z.string().min(1).max(256),
  verification: z.literal('verified'),
  merchantId: Id,
  merchantOrderId: Id,
  providerTransactionId: Id.nullable(),
  kind: z.enum(['paid', 'closed', 'refund-succeeded', 'refund-failed']),
  amountMinor: Minor,
  currency: z.literal('CNY'),
  confirmedRefundedMinor: Minor,
  refundId: Id.nullable(),
  refundAmountMinor: Minor.nullable(),
  providerRefundId: z.string().max(256).nullable(),
  paidAt: Time.nullable(),
  receivedAt: Time,
  processedAt: Time.nullable(),
  disposition: z.enum(['pending', 'applied', 'ignored', 'needs-review']),
});
export type HostedPaymentEvent = z.infer<typeof HostedPaymentEventSchema>;

export const HostedRefundSchema = z.object({
  id: Id,
  orderId: Id,
  paymentAttemptId: Id,
  tenantId: Id,
  requestId: Id,
  payloadHash: z.string().min(1).max(256),
  provider: Id,
  merchantId: Id,
  amountMinor: z.number().int().positive().safe(),
  state: z.enum(['reserved', 'submitted', 'processing', 'unknown', 'succeeded', 'failed']),
  entitlementAction: z.enum(['revoke', 'retain']),
  providerRefundId: z.string().max(256).nullable(),
  createdAt: Time,
  updatedAt: Time,
});
export type HostedRefund = z.infer<typeof HostedRefundSchema>;

export const assertSubscriptionOrderInvariants = (order: SubscriptionOrder): void => {
  if (
    order.amountMinor !== order.planSnapshot.priceMinor ||
    order.currency !== order.planSnapshot.currency
  ) {
    throw new InvariantError('order amount must match the server plan snapshot');
  }
  if (order.refundedMinor > order.amountMinor)
    throw new InvariantError('refund exceeds order amount');
  if (order.expiresAt <= order.createdAt)
    throw new InvariantError('order expiry must follow creation');
};

export const assertHostedPaymentEventInvariants = (event: HostedPaymentEvent): void => {
  if (event.confirmedRefundedMinor > event.amountMinor)
    throw new InvariantError('confirmed refund exceeds actual payment');
  if (event.kind !== 'closed' && event.providerTransactionId === null)
    throw new InvariantError('verified financial event requires a provider transaction');
  if (
    event.kind.startsWith('refund-') &&
    (event.refundId === null || event.refundAmountMinor === null || event.refundAmountMinor <= 0)
  ) {
    throw new InvariantError('refund event requires a refund identity and amount');
  }
  if (event.kind === 'paid' && event.paidAt === null)
    throw new InvariantError('paid event requires the provider payment time');
  if (
    event.kind === 'refund-succeeded' &&
    event.refundAmountMinor !== null &&
    event.confirmedRefundedMinor < event.refundAmountMinor
  ) {
    throw new InvariantError('confirmed cumulative refund must include this successful refund');
  }
};
