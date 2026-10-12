import {
  addShanghaiCalendarMonths,
  assertHostedPaymentEventInvariants,
  assertSubscriptionOrderInvariants,
  assertSubscriptionPeriodInvariants,
  type HostedPaymentAttempt,
  type HostedPaymentEvent,
  type HostedRefund,
  InvariantError,
  PlatformAccessDeniedError,
  type PlatformPaymentRepository,
  type SubscriptionOrder,
  type SubscriptionPeriod,
} from '@luoome/core';
import type { PlatformStore } from './platform-store.js';

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const financialContent = (event: HostedPaymentEvent) => ({
  provider: event.provider,
  eventId: event.eventId,
  payloadDigest: event.payloadDigest,
  merchantId: event.merchantId,
  merchantOrderId: event.merchantOrderId,
  providerTransactionId: event.providerTransactionId,
  kind: event.kind,
  amountMinor: event.amountMinor,
  currency: event.currency,
  confirmedRefundedMinor: event.confirmedRefundedMinor,
  refundId: event.refundId,
  refundAmountMinor: event.refundAmountMinor,
  providerRefundId: event.providerRefundId,
  paidAt: event.paidAt,
});

export const createPlatformPayments = (
  store: PlatformStore,
  onPeriodRevoked: (periodId: string, now: Date) => void,
): PlatformPaymentRepository => {
  const orderPeriod = (orderId: string): SubscriptionPeriod | null =>
    store.list('periods', { sourceOrderId: orderId })[0] ?? null;
  const revokePeriod = (orderId: string, now: Date): SubscriptionPeriod | null => {
    const period = orderPeriod(orderId);
    if (period === null || period.status === 'revoked') return period;
    const revoked: SubscriptionPeriod = { ...period, status: 'revoked' };
    store.put('periods', revoked);
    onPeriodRevoked(revoked.id, now);
    return revoked;
  };
  const refundOccupation = (fact: HostedPaymentAttempt): number => {
    const refunds = store.list('refunds', { paymentAttemptId: fact.id });
    const confirmed = refunds
      .filter((refund) => refund.state === 'succeeded')
      .reduce((sum, refund) => sum + refund.amountMinor, 0);
    const pending = refunds
      .filter((refund) => !['succeeded', 'failed'].includes(refund.state))
      .reduce((sum, refund) => sum + refund.amountMinor, 0);
    return Math.max(confirmed, fact.confirmedRefundedMinor) + pending;
  };

  return {
    async claimReconciliation({ orderId, refundId, now, intervalMs }) {
      return store.transaction(() => {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000)
          throw new InvariantError('payment reconciliation interval is too short');
        if (refundId === null) {
          const order = store.get('orders', orderId);
          if (order === null || now.getTime() - order.updatedAt.getTime() < intervalMs)
            return false;
          store.put('orders', { ...order, updatedAt: now });
        } else {
          const refund = store.get('refunds', refundId);
          if (
            refund?.orderId !== orderId ||
            ['succeeded', 'failed'].includes(refund.state) ||
            now.getTime() - refund.updatedAt.getTime() < intervalMs
          )
            return false;
          store.put('refunds', { ...refund, updatedAt: now });
        }
        return true;
      });
    },
    async createOrder({ order, now }) {
      return store.transaction(() => {
        assertSubscriptionOrderInvariants(order);
        const existing = store.list('orders', {
          tenantId: order.tenantId,
          requestId: order.requestId,
        })[0];
        if (existing !== undefined) {
          if (
            existing.payloadHash !== order.payloadHash ||
            existing.planSnapshot.id !== order.planSnapshot.id ||
            existing.provider !== order.provider ||
            existing.merchantId !== order.merchantId ||
            existing.amountMinor !== order.amountMinor
          )
            throw new InvariantError('order request reused with different content');
          return { order: existing, replayed: true };
        }
        const tenant = store.get('tenants', order.tenantId);
        if (tenant?.status !== 'active') throw new PlatformAccessDeniedError('tenant:active');
        const published = store.get('plans', order.planSnapshot.id);
        if (published === null || !sameValue(published, order.planSnapshot))
          throw new InvariantError('order plan snapshot is not a published server version');
        if (
          order.state !== 'created' ||
          order.providerCreateState !== 'not-requested' ||
          order.providerOrderId !== null ||
          order.refundedMinor !== 0 ||
          order.reconciliation !== 'none' ||
          order.createdAt.getTime() !== now.getTime()
        )
          throw new InvariantError('order initial state is invalid');
        if (
          store.get('orders', order.id) !== null ||
          store.list('orders', {
            provider: order.provider,
            merchantId: order.merchantId,
            merchantOrderId: order.merchantOrderId,
          }).length > 0
        )
          throw new InvariantError('order or merchant order identity already exists');
        store.put('orders', order);
        return { order, replayed: false };
      });
    },
    async findOrder({ id, tenantId }) {
      const order = store.get('orders', id);
      return order?.tenantId === tenantId ? order : null;
    },
    async listOrders(tenantId) {
      return store.list('orders', { tenantId });
    },
    async markOrderRequestOutcome({ id, state, providerOrderId, now }) {
      return store.transaction(() => {
        const order = store.get('orders', id);
        if (order === null) throw new InvariantError('order not found');
        if (order.providerCreateState === 'accepted' && state !== 'accepted')
          throw new InvariantError('accepted payment request cannot regress to unknown');
        if (state === 'accepted' && providerOrderId === undefined)
          throw new InvariantError('accepted payment request requires provider reference');
        if (
          order.providerOrderId !== null &&
          providerOrderId !== undefined &&
          order.providerOrderId !== providerOrderId
        )
          throw new InvariantError('provider order identity is immutable');
        const next: SubscriptionOrder = {
          ...order,
          providerCreateState: state,
          providerOrderId: providerOrderId ?? order.providerOrderId,
          state: order.state === 'created' ? 'pending' : order.state,
          updatedAt: now,
        };
        store.put('orders', next);
        return next;
      });
    },
    async applyVerifiedPaymentEvent({ event, periodId, now, allowClosedOrderGrant = false }) {
      return store.transaction(() => {
        assertHostedPaymentEventInvariants(event);
        const saved = store.list('paymentEvents', {
          provider: event.provider,
          eventId: event.eventId,
        })[0];
        if (saved !== undefined) {
          if (!sameValue(financialContent(saved), financialContent(event)))
            throw new InvariantError('payment event identity reused with different content');
          const order =
            store.list('orders', {
              provider: saved.provider,
              merchantId: saved.merchantId,
              merchantOrderId: saved.merchantOrderId,
            })[0] ?? null;
          return {
            order,
            period: order === null ? null : orderPeriod(order.id),
            event: saved,
            replayed: true,
          };
        }
        if (
          store.get('paymentEvents', event.id) !== null ||
          event.processedAt !== null ||
          event.disposition !== 'pending'
        )
          throw new InvariantError('payment event initial state is invalid');
        const current = store.list('orders', {
          provider: event.provider,
          merchantId: event.merchantId,
          merchantOrderId: event.merchantOrderId,
        })[0];
        if (current === undefined) {
          const pending: HostedPaymentEvent = {
            ...event,
            processedAt: now,
            disposition: 'needs-review',
          };
          store.put('paymentEvents', pending);
          return { order: null, period: null, event: pending, replayed: false };
        }
        if (current.amountMinor !== event.amountMinor || current.currency !== event.currency)
          throw new InvariantError('verified payment amount or currency does not match order');
        let disposition: HostedPaymentEvent['disposition'] = 'applied';
        let order: SubscriptionOrder = { ...current, updatedAt: now };
        let period = orderPeriod(order.id);
        if (event.kind === 'closed') {
          if (current.state === 'paid') disposition = 'ignored';
          else order = { ...order, state: 'closed' };
        } else {
          if (event.providerTransactionId === null)
            throw new InvariantError('payment transaction is missing');
          const existingFact = store.list('paymentAttempts', {
            provider: event.provider,
            merchantId: event.merchantId,
            providerTransactionId: event.providerTransactionId,
          })[0];
          if (
            existingFact !== undefined &&
            (existingFact.orderId !== order.id ||
              existingFact.amountMinor !== event.amountMinor ||
              existingFact.currency !== event.currency)
          )
            throw new InvariantError(
              'provider transaction already belongs to another order or amount',
            );
          const fact: HostedPaymentAttempt = {
            id: existingFact?.id ?? event.id,
            orderId: order.id,
            provider: event.provider,
            merchantId: event.merchantId,
            merchantOrderId: event.merchantOrderId,
            providerTransactionId: event.providerTransactionId,
            amountMinor: event.amountMinor,
            currency: event.currency,
            confirmedRefundedMinor: Math.max(
              existingFact?.confirmedRefundedMinor ?? 0,
              event.confirmedRefundedMinor,
            ),
            paidAt: existingFact?.paidAt ?? event.paidAt,
            confirmedAt: existingFact?.confirmedAt ?? now,
          };
          if (existingFact === undefined && store.get('paymentAttempts', fact.id) !== null)
            throw new InvariantError('payment fact id already exists');
          let refund: HostedRefund | null = null;
          if (event.kind.startsWith('refund-')) {
            refund = event.refundId === null ? null : store.get('refunds', event.refundId);
            if (refund === null) {
              disposition = 'needs-review';
              order = { ...order, reconciliation: 'needs-review' };
            } else {
              if (
                refund.orderId !== order.id ||
                refund.paymentAttemptId !== fact.id ||
                refund.amountMinor !== event.refundAmountMinor
              )
                throw new InvariantError('refund event does not match reserved refund');
              if (event.kind === 'refund-succeeded') {
                refund = {
                  ...refund,
                  state: 'succeeded',
                  providerRefundId: event.providerRefundId ?? refund.providerRefundId,
                  updatedAt: now,
                };
                store.put('refunds', refund);
                const sum = store
                  .list('refunds', { paymentAttemptId: fact.id })
                  .filter((item) => item.state === 'succeeded')
                  .reduce((total, item) => total + item.amountMinor, 0);
                if (sum > fact.amountMinor)
                  throw new InvariantError('confirmed refunds exceed actual payment');
                fact.confirmedRefundedMinor = Math.max(fact.confirmedRefundedMinor, sum);
                if (
                  refund.entitlementAction === 'revoke' ||
                  fact.confirmedRefundedMinor === fact.amountMinor
                )
                  period = revokePeriod(order.id, now);
              } else if (refund.state === 'succeeded') disposition = 'ignored';
              else {
                refund = { ...refund, state: 'failed', updatedAt: now };
                store.put('refunds', refund);
              }
            }
          }
          store.put('paymentAttempts', fact);
          order = {
            ...order,
            state: 'paid',
            refundedMinor: Math.max(order.refundedMinor, fact.confirmedRefundedMinor),
          };
          if (fact.confirmedRefundedMinor > 0 && fact.confirmedRefundedMinor === fact.amountMinor)
            period = revokePeriod(order.id, now);
          const tenant = store.get('tenants', order.tenantId);
          const duplicatePayment = store.list('paymentAttempts', { orderId: order.id }).length > 1;
          if (
            tenant?.status !== 'active' ||
            store.get('users', tenant.ownerUserId)?.status !== 'active' ||
            duplicatePayment
          ) {
            order = { ...order, reconciliation: 'refund-required' };
            disposition = 'needs-review';
          } else if (event.kind === 'paid' && period === null) {
            if (
              order.refundedMinor > 0 ||
              (current.reconciliation !== 'none' &&
                !(current.reconciliation === 'needs-review' && allowClosedOrderGrant)) ||
              (current.state === 'closed' && !allowClosedOrderGrant)
            ) {
              order = {
                ...order,
                reconciliation:
                  order.reconciliation === 'refund-required' ? 'refund-required' : 'needs-review',
              };
              disposition = 'needs-review';
            } else {
              const previous = store
                .list('periods', { tenantId: order.tenantId })
                .filter((item) => ['paid', 'trial'].includes(item.status) && item.endsAt > now)
                .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
              const startsAt = previous?.endsAt ?? now;
              const anchorDay =
                previous?.anchorDay ?? new Date(now.getTime() + 8 * 3600_000).getUTCDate();
              period = {
                id: periodId,
                tenantId: order.tenantId,
                planVersionId: order.planSnapshot.id,
                startsAt,
                endsAt: addShanghaiCalendarMonths(
                  startsAt,
                  order.planSnapshot.durationMonths,
                  anchorDay,
                ),
                anchorDay,
                sourceOrderId: order.id,
                status: 'paid',
                createdAt: now,
              };
              assertSubscriptionPeriodInvariants(period);
              if (store.get('periods', periodId) !== null)
                throw new InvariantError('subscription period identity already exists');
              store.put('periods', period);
              order = { ...order, reconciliation: 'none' };
            }
          }
        }
        assertSubscriptionOrderInvariants(order);
        const processed: HostedPaymentEvent = { ...event, processedAt: now, disposition };
        store.put('orders', order);
        store.put('paymentEvents', processed);
        return { order, period, event: processed, replayed: false };
      });
    },
    async reserveRefund({ refund, now }) {
      return store.transaction(() => {
        const existing = store.list('refunds', {
          orderId: refund.orderId,
          requestId: refund.requestId,
        })[0];
        if (existing !== undefined) {
          if (
            existing.tenantId !== refund.tenantId ||
            existing.payloadHash !== refund.payloadHash ||
            existing.amountMinor !== refund.amountMinor ||
            existing.paymentAttemptId !== refund.paymentAttemptId ||
            existing.entitlementAction !== refund.entitlementAction
          )
            throw new InvariantError('refund request reused with different content');
          return { refund: existing, replayed: true };
        }
        const order = store.get('orders', refund.orderId);
        const fact = store.get('paymentAttempts', refund.paymentAttemptId);
        if (
          order === null ||
          order.state !== 'paid' ||
          fact === null ||
          fact.orderId !== order.id ||
          refund.tenantId !== order.tenantId ||
          refund.provider !== order.provider ||
          refund.merchantId !== order.merchantId
        )
          throw new InvariantError('refund requires its verified payment fact');
        if (
          refund.state !== 'reserved' ||
          refund.providerRefundId !== null ||
          refund.createdAt.getTime() !== now.getTime() ||
          refund.amountMinor <= 0 ||
          !Number.isSafeInteger(refund.amountMinor)
        )
          throw new InvariantError('refund initial state is invalid');
        if (refundOccupation(fact) + refund.amountMinor > fact.amountMinor)
          throw new PlatformAccessDeniedError('refund:available-amount');
        if (store.get('refunds', refund.id) !== null)
          throw new InvariantError('refund identity already exists');
        store.put('refunds', refund);
        return { refund, replayed: false };
      });
    },
    async updateRefundOutcome({ id, state, providerRefundId, now }) {
      return store.transaction(() => {
        const refund = store.get('refunds', id);
        if (refund === null) throw new InvariantError('refund not found');
        if (refund.state === 'succeeded' || refund.state === 'failed') {
          if (refund.state !== state)
            throw new InvariantError('terminal refund cannot return to a pending state');
          return refund;
        }
        if (refund.state === 'unknown' && state === 'submitted')
          throw new InvariantError('unknown refund must be queried before resubmission');
        if (
          refund.providerRefundId !== null &&
          providerRefundId !== undefined &&
          refund.providerRefundId !== providerRefundId
        )
          throw new InvariantError('provider refund identity is immutable');
        const next: HostedRefund = {
          ...refund,
          state,
          providerRefundId: providerRefundId ?? refund.providerRefundId,
          updatedAt: now,
        };
        store.put('refunds', next);
        return next;
      });
    },
    async listRefunds(orderId) {
      return store.list('refunds', { orderId });
    },
    async listPaymentAttempts(orderId) {
      return store.list('paymentAttempts', { orderId });
    },
    async listEvents({ provider, disposition }) {
      return store.list('paymentEvents', {
        ...(provider === undefined ? {} : { provider }),
        ...(disposition === undefined ? {} : { disposition }),
      });
    },
  };
};
