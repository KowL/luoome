import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { HostedLLMPricingSchema, HostedLLMTokensSchema, hostedLLMCost } from './llm.js';

const Id = z.string().min(1).max(160);
const Digest = z.string().min(1).max(256);
const Count = z.number().int().nonnegative().safe();
const Time = z.coerce.date();

export const HostedUserSchema = z.object({
  id: Id,
  email: z.email().nullable(),
  emailKey: z.string().min(1).max(320),
  verifiedAt: Time,
  status: z.enum(['active', 'disabled', 'deleted']),
  createdAt: Time,
  updatedAt: Time,
});
export type HostedUser = z.infer<typeof HostedUserSchema>;

export const TenantStatusSchema = z.enum([
  'provisioning',
  'active',
  'suspended',
  'deleting',
  'deleted',
]);
export const TenantSchema = z.object({
  id: Id,
  ownerUserId: Id,
  status: TenantStatusSchema,
  generation: z.number().int().positive().safe(),
  schemaVersion: Count,
  provisioningErrorKind: z.string().max(100).nullable(),
  createdAt: Time,
  updatedAt: Time,
  deletedAt: Time.nullable(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const TenantTombstoneSchema = z.object({
  id: Id,
  generation: z.number().int().positive().safe(),
  deletedAt: Time,
});
export type TenantTombstone = z.infer<typeof TenantTombstoneSchema>;

export const AuthChallengeSchema = z.object({
  id: Id,
  email: z.email(),
  emailKey: z.string().min(1).max(320),
  purpose: z.enum(['login', 'reauth']),
  digest: Digest,
  ipHash: Digest,
  attempts: z.number().int().min(0).max(5),
  createdAt: Time,
  expiresAt: Time,
  consumedAt: Time.nullable(),
  invalidatedAt: Time.nullable(),
  deliveryState: z.enum(['pending', 'accepted', 'unknown', 'failed']),
  providerMessageId: z.string().max(256).nullable(),
});
export type AuthChallenge = z.infer<typeof AuthChallengeSchema>;

export const HostedSessionSchema = z.object({
  id: Id,
  userId: Id,
  tenantId: Id,
  tokenHash: Digest,
  csrfHash: Digest,
  createdAt: Time,
  lastSeenAt: Time,
  idleExpiresAt: Time,
  absoluteExpiresAt: Time,
  revokedAt: Time.nullable(),
});
export type HostedSession = z.infer<typeof HostedSessionSchema>;

export const PlanLimitsSchema = z.object({
  watchlistStocks: Count,
  enabledRules: Count,
  dailyJobs: Count,
  concurrentJobs: z.number().int().positive().safe(),
  queuedJobs: Count,
  researchUnits: Count,
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export const HostedProductPolicyVersionSchema = z.enum(['hosted-facts-v1', 'hosted-web-v2']);
export type HostedProductPolicyVersion = z.infer<typeof HostedProductPolicyVersionSchema>;

export const PlanVersionSchema = z.object({
  id: Id,
  code: z.string().min(1).max(80),
  currency: z.literal('CNY'),
  priceMinor: Count,
  durationMonths: z.number().int().positive().safe(),
  limits: PlanLimitsSchema,
  productPolicyVersion: HostedProductPolicyVersionSchema,
  publishedAt: Time,
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const SubscriptionPeriodSchema = z.object({
  id: Id,
  tenantId: Id,
  planVersionId: Id,
  startsAt: Time,
  endsAt: Time,
  anchorDay: z.number().int().min(1).max(31),
  sourceOrderId: Id.nullable(),
  status: z.enum(['trial', 'paid', 'expired', 'revoked']),
  createdAt: Time,
});
export type SubscriptionPeriod = z.infer<typeof SubscriptionPeriodSchema>;

export const HostedJobKindSchema = z.enum([
  'provision-tenant',
  'watchlist-facts',
  'watch-alerts',
  'tenant-export',
  'tenant-delete',
]);
export const HostedJobStateSchema = z.enum([
  'preparing',
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'needs-review',
]);
export const HostedJobSchema = z.object({
  id: Id,
  tenantId: Id,
  generation: z.number().int().positive().safe(),
  operationId: Id,
  requestId: Id,
  kind: HostedJobKindSchema,
  version: z.literal(1),
  payloadRef: Id.nullable(),
  inputHash: Digest,
  state: HostedJobStateSchema,
  priority: z.number().int().min(0).max(100),
  attempt: Count,
  availableAt: Time,
  deadlineAt: Time,
  fence: Count,
  attemptId: Id.nullable(),
  leaseOwner: Id.nullable(),
  leaseExpiresAt: Time.nullable(),
  cancellationRequestedAt: Time.nullable(),
  resultRef: Id.nullable(),
  resultHash: Digest.nullable(),
  errorKind: z.string().max(100).nullable(),
  createdAt: Time,
  updatedAt: Time,
});
export type HostedJob = z.infer<typeof HostedJobSchema>;

export const UsageReservationSchema = z.object({
  llm: z
    .object({
      owner: Id,
      leaseUntil: Time,
      inputHash: Digest,
      generation: z.number().int().positive(),
      pricing: HostedLLMPricingSchema,
      periodBudgetMicro: Count,
    })
    .optional(),
  id: Id,
  operationId: Id,
  tenantId: Id,
  periodId: Id,
  units: Count,
  budgetMicro: Count,
  state: z.enum(['held', 'captured', 'released']),
  capturedUnits: Count.nullable(),
  createdAt: Time,
  settledAt: Time.nullable(),
});
export type UsageReservation = z.infer<typeof UsageReservationSchema>;

export const UsageEntrySchema = z.object({
  id: Id,
  operationId: Id,
  tenantId: Id,
  periodId: Id,
  metric: z.literal('research-units'),
  delta: z.number().int().safe(),
  reason: z.enum(['capture', 'correction']),
  revision: z.number().int().positive().safe(),
  createdAt: Time,
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const ProviderAttemptSchema = z.object({
  pricing: HostedLLMPricingSchema.optional(),
  tokens: HostedLLMTokensSchema.optional(),
  requestHash: Digest.optional(),
  receiptId: z.string().max(256).optional(),
  id: Id,
  operationId: Id,
  step: Id,
  attempt: z.number().int().positive().safe(),
  provider: Id,
  model: z.string().max(160).nullable(),
  usageState: z.enum(['reserved', 'unknown', 'estimated', 'confirmed']),
  reservedCostMicro: Count,
  estimatedCostMicro: Count.nullable(),
  confirmedCostMicro: Count.nullable(),
  pricingVersion: Id,
  createdAt: Time,
  updatedAt: Time,
});
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export const DeliveryIntentSchema = z.object({
  id: Id,
  tenantId: Id,
  generation: z.number().int().positive().safe(),
  businessKey: Id,
  resultRef: Id,
  channel: z.enum(['in-app', 'email']),
  bindingVersion: z.number().int().positive().safe(),
  state: z.enum(['pending', 'sending', 'accepted', 'failed', 'unknown', 'suppressed']),
  attempt: Count,
  attemptId: Id.nullable(),
  providerMessageId: z.string().max(256).nullable(),
  availableAt: Time,
  expiresAt: Time,
  deliveredAt: Time.nullable(),
  errorKind: z.string().max(100).nullable(),
  createdAt: Time,
  updatedAt: Time,
});
export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;

export const PlatformResultEventSchema = z.object({
  eventId: Id,
  tenantId: Id,
  generation: z.number().int().positive().safe(),
  operationId: Id,
  inputHash: Digest,
  resultRef: Id,
  resultHash: Digest,
  status: z.enum(['succeeded', 'partial']),
  notificationPolicy: z.enum(['eligible', 'never']),
  businessKey: Id,
  committedAt: Time,
  deliveries: z
    .array(
      z.object({
        businessKey: Id,
        resultRef: Id,
        notificationPolicy: z.enum(['eligible', 'never']),
      }),
    )
    .max(100)
    .optional(),
});
export type PlatformResultEvent = z.infer<typeof PlatformResultEventSchema>;

export const PlatformInboxSchema = PlatformResultEventSchema.extend({
  id: Id,
  processedAt: Time,
});
export const PlatformJobCursorSchema = z.object({ id: Id, tenantId: Id });

export const isHostedJobTerminal = (state: HostedJob['state']): boolean =>
  ['succeeded', 'partial', 'failed', 'cancelled', 'needs-review'].includes(state);

export const assertTenantTransition = (from: Tenant['status'], to: Tenant['status']): void => {
  const allowed: Record<Tenant['status'], readonly Tenant['status'][]> = {
    provisioning: ['active', 'deleting'],
    active: ['suspended', 'deleting'],
    suspended: ['active', 'deleting'],
    deleting: ['deleted'],
    deleted: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new InvariantError(`tenant transition ${from} -> ${to} is forbidden`);
  }
};

export const assertHostedJobInvariants = (job: HostedJob): void => {
  if (job.deadlineAt <= job.createdAt)
    throw new InvariantError('job deadline must follow creation');
  if (
    job.state === 'running' &&
    (!job.attemptId || !job.leaseOwner || !job.leaseExpiresAt || job.fence < 1)
  ) {
    throw new InvariantError('running job requires a fenced lease');
  }
  if (
    ['succeeded', 'partial'].includes(job.state) &&
    job.kind !== 'provision-tenant' &&
    (!job.resultRef || !job.resultHash)
  ) {
    throw new InvariantError('successful business job requires a result receipt');
  }
};

export const assertUsageReservationInvariants = (reservation: UsageReservation): void => {
  if (reservation.capturedUnits !== null && reservation.capturedUnits > reservation.units) {
    throw new InvariantError('capture exceeds reserved units');
  }
  if ((reservation.state === 'captured') !== (reservation.capturedUnits !== null)) {
    throw new InvariantError('only captured reservation has captured units');
  }
  if ((reservation.state === 'held') !== (reservation.settledAt === null)) {
    throw new InvariantError('settlement timestamp must match reservation state');
  }
};

export const assertProviderAttemptInvariants = (attempt: ProviderAttempt): void => {
  if (
    attempt.pricing !== undefined &&
    attempt.usageState === 'confirmed' &&
    (attempt.tokens === undefined ||
      attempt.confirmedCostMicro !== hostedLLMCost(attempt.tokens, attempt.pricing))
  )
    throw new InvariantError('LLM confirmed cost must match token usage and frozen pricing');
  if ((attempt.usageState === 'confirmed') !== (attempt.confirmedCostMicro !== null)) {
    throw new InvariantError('confirmed cost requires confirmed usage');
  }
  if (attempt.usageState === 'estimated' && attempt.estimatedCostMicro === null) {
    throw new InvariantError('estimated usage requires estimated cost');
  }
};

export const assertSubscriptionPeriodInvariants = (period: SubscriptionPeriod): void => {
  if (period.endsAt <= period.startsAt)
    throw new InvariantError('subscription period must be positive');
  if (period.status === 'paid' && period.sourceOrderId === null) {
    throw new InvariantError('paid subscription period requires an order');
  }
};

export const addShanghaiCalendarMonths = (
  startsAt: Date,
  months: number,
  anchorDay: number,
): Date => {
  const shanghai = new Date(startsAt.getTime() + 8 * 60 * 60 * 1000);
  const year = shanghai.getUTCFullYear();
  const targetMonth = shanghai.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      targetMonth,
      Math.min(anchorDay, lastDay),
      shanghai.getUTCHours(),
      shanghai.getUTCMinutes(),
      shanghai.getUTCSeconds(),
      shanghai.getUTCMilliseconds(),
    ) -
      8 * 60 * 60 * 1000,
  );
};
