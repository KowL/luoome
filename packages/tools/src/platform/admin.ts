import { createHash } from 'node:crypto';
import {
  HostedUserSchema,
  InvariantError,
  PlanVersionSchema,
  SubscriptionOrderSchema,
  SubscriptionPeriodSchema,
  TenantSchema,
  UsageEntrySchema,
} from '@luoome/core';
import { z } from 'zod';
import { errInvalidInput, errNotFound } from '../define-tool.js';
import { randomAuthId } from './crypto.js';
import { definePlatformTool } from './define-platform-tool.js';

const Id = z.string().min(1).max(160);
const Count = z.number().int().nonnegative().safe();

const OPERATOR_PROVIDER = 'operator-manual';
const OPERATOR_MERCHANT = 'operator';

const payloadHash = (values: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');

const EntitlementSchema = z.object({
  period: SubscriptionPeriodSchema,
  plan: PlanVersionSchema,
  capturedUnits: Count,
  heldUnits: Count,
  availableUnits: Count,
});

export const listHostedUsersTool = definePlatformTool({
  name: 'list_hosted_users',
  description: 'List every hosted user with tenant and current subscription entitlement.',
  sideEffect: 'read',
  actors: ['admin'],
  input: z.object({}).strict(),
  output: z.object({
    users: z.array(
      z.object({
        user: HostedUserSchema,
        tenant: TenantSchema,
        entitlement: EntitlementSchema.nullable(),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    const now = ctx.clock();
    const rows = await Promise.all(
      (await ctx.repos.tenants.list()).map(async (tenant) => {
        const user = await ctx.repos.auth.findUserById(tenant.ownerUserId);
        if (user === null) return null;
        const entitlement = await ctx.repos.subscriptions.currentEntitlement({
          tenantId: tenant.id,
          now,
        });
        return { user, tenant, entitlement };
      }),
    );
    return {
      users: rows
        .filter((row) => row !== null)
        .sort((a, b) => b.user.createdAt.getTime() - a.user.createdAt.getTime()),
    };
  },
});

export const getHostedUserDetailTool = definePlatformTool({
  name: 'get_hosted_user_detail',
  description:
    'Read one tenant with owner user, entitlement, subscription periods, orders and usage ledger.',
  sideEffect: 'read',
  actors: ['admin'],
  input: z.object({ tenantId: Id }).strict(),
  output: z.object({
    user: HostedUserSchema,
    tenant: TenantSchema,
    entitlement: EntitlementSchema.nullable(),
    periods: z.array(SubscriptionPeriodSchema),
    orders: z.array(SubscriptionOrderSchema),
    usage: z.array(UsageEntrySchema),
  }),
  handler: async (input, ctx) => {
    const tenant = await ctx.repos.tenants.findById(input.tenantId);
    if (tenant === null) return errNotFound('Tenant', input.tenantId);
    const user = await ctx.repos.auth.findUserById(tenant.ownerUserId);
    if (user === null) return errNotFound('HostedUser', tenant.ownerUserId);
    const now = ctx.clock();
    const [entitlement, periods, orders, usage] = await Promise.all([
      ctx.repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now }),
      ctx.repos.subscriptions.listPeriods(tenant.id),
      ctx.repos.payments.listOrders(tenant.id),
      ctx.repos.jobs.listUsage({ tenantId: tenant.id }),
    ]);
    return {
      user,
      tenant,
      entitlement,
      periods: [...periods],
      orders: [...orders],
      usage: [...usage],
    };
  },
});

export const recordHostedOperatorPaymentTool = definePlatformTool({
  name: 'record_hosted_operator_payment',
  description:
    'Record an off-platform payment the operator already collected and grant the purchased period once.',
  sideEffect: 'write',
  actors: ['admin'],
  input: z
    .object({
      tenantId: Id,
      planVersionId: Id,
      reference: z.string().min(2).max(120),
      requestId: Id,
    })
    .strict(),
  output: z.object({
    order: SubscriptionOrderSchema,
    period: SubscriptionPeriodSchema.nullable(),
    replayed: z.boolean(),
  }),
  handler: async (input, ctx) => {
    const plan = await ctx.repos.subscriptions.findPlan(input.planVersionId);
    if (plan === null) return errNotFound('PlanVersion', input.planVersionId);
    const tenant = await ctx.repos.tenants.findById(input.tenantId);
    if (tenant === null) return errNotFound('Tenant', input.tenantId);
    const now = ctx.clock();
    const id = randomAuthId();
    let prepared: Awaited<ReturnType<typeof ctx.repos.payments.createOrder>>;
    try {
      prepared = await ctx.repos.payments.createOrder({
        order: {
          id,
          tenantId: tenant.id,
          requestId: input.requestId,
          payloadHash: payloadHash(['operator-order-v1', tenant.id, plan.id, input.reference]),
          planSnapshot: plan,
          provider: OPERATOR_PROVIDER,
          merchantId: OPERATOR_MERCHANT,
          merchantOrderId: id,
          providerOrderId: null,
          amountMinor: plan.priceMinor,
          currency: plan.currency,
          state: 'created',
          providerCreateState: 'not-requested',
          reconciliation: 'none',
          refundedMinor: 0,
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
          createdAt: now,
          updatedAt: now,
        },
        now,
      });
    } catch (error) {
      if (error instanceof InvariantError) return errInvalidInput('operator_order_rejected');
      throw error;
    }
    if (prepared.replayed) {
      const period =
        (await ctx.repos.subscriptions.listPeriods(tenant.id)).find(
          (candidate) => candidate.sourceOrderId === prepared.order.id,
        ) ?? null;
      return { order: prepared.order, period, replayed: true };
    }
    let applied: Awaited<ReturnType<typeof ctx.repos.payments.applyVerifiedPaymentEvent>>;
    try {
      applied = await ctx.repos.payments.applyVerifiedPaymentEvent({
        event: {
          id: randomAuthId(),
          provider: OPERATOR_PROVIDER,
          eventId: randomAuthId(),
          payloadDigest: payloadHash(['operator-payment-v1', id, input.reference]),
          verification: 'verified',
          merchantId: OPERATOR_MERCHANT,
          merchantOrderId: id,
          providerTransactionId: `operator:${input.reference}`,
          kind: 'paid',
          amountMinor: plan.priceMinor,
          currency: plan.currency,
          confirmedRefundedMinor: 0,
          refundId: null,
          refundAmountMinor: null,
          providerRefundId: null,
          paidAt: now,
          receivedAt: now,
          processedAt: null,
          disposition: 'pending',
        },
        periodId: randomAuthId(),
        now,
        allowClosedOrderGrant: false,
      });
    } catch (error) {
      if (error instanceof InvariantError) return errInvalidInput('operator_reference_reused');
      throw error;
    }
    if (applied.order === null) return errInvalidInput('operator_order_rejected');
    return { order: applied.order, period: applied.period, replayed: false };
  },
});

export const setHostedUserStatusTool = definePlatformTool({
  name: 'set_hosted_user_status',
  description: 'Disable a hosted user and revoke sessions, or re-enable a disabled user.',
  sideEffect: 'write',
  actors: ['admin'],
  input: z.object({ userId: Id, status: z.enum(['active', 'disabled']) }).strict(),
  output: z.object({ user: HostedUserSchema }),
  handler: async (input, ctx) => {
    const current = await ctx.repos.auth.findUserById(input.userId);
    if (current === null) return errNotFound('HostedUser', input.userId);
    if (current.status === 'deleted') return errInvalidInput('user_deleted');
    return { user: await ctx.repos.auth.setUserStatus({ ...input, now: ctx.clock() }) };
  },
});

export const platformAdminTools = [
  listHostedUsersTool,
  getHostedUserDetailTool,
  recordHostedOperatorPaymentTool,
  setHostedUserStatusTool,
] as const;
