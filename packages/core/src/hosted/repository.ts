import type { PlatformLLMRepository } from './llm.js';
import type { HostedQuietHours, NotificationPreferences } from './notification.js';
import type {
  HostedPaymentAttempt,
  HostedPaymentEvent,
  HostedRefund,
  SubscriptionOrder,
} from './payments.js';
import type {
  AuthChallenge,
  DeliveryIntent,
  HostedJob,
  HostedSession,
  HostedUser,
  PlanVersion,
  PlatformResultEvent,
  ProviderAttempt,
  SubscriptionPeriod,
  Tenant,
  TenantTombstone,
  UsageEntry,
  UsageReservation,
} from './platform.js';
import type { HostedDeletion, HostedExportMetadata } from './privacy.js';

export class PlatformAccessDeniedError extends Error {
  override readonly name = 'PlatformAccessDeniedError';
  constructor(readonly required: string) {
    super(`platform operation requires ${required}`);
  }
}

export class PlatformLeaseLostError extends Error {
  override readonly name = 'PlatformLeaseLostError';
}

export interface AuthChallengeLimits {
  readonly cooldownSeconds: number;
  readonly emailHourly: number;
  readonly emailDaily: number;
  readonly ipHourly: number;
  readonly globalHourly: number;
}

export interface PlatformAuthRepository {
  findUserById(id: string): Promise<HostedUser | null>;
  setUserStatus(input: {
    readonly userId: string;
    readonly status: 'active' | 'disabled';
    readonly now: Date;
  }): Promise<HostedUser>;
  findPasswordByUserId(userId: string): Promise<HostedPasswordCredential | null>;
  findPasswordByEmail(emailKey: string): Promise<{
    readonly user: HostedUser;
    readonly credential: HostedPasswordCredential | null;
  } | null>;
  reservePasswordAttempt(input: {
    readonly id: string;
    readonly emailHash: string;
    readonly ipHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  createPasswordSession(input: {
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly now: Date;
    readonly session: Omit<HostedSession, 'userId' | 'tenantId'>;
    readonly rotateSessionId?: string;
  }): Promise<{
    readonly user: HostedUser;
    readonly tenant: Tenant;
    readonly session: HostedSession;
  } | null>;
  changePassword(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly expectedPasswordHash: string | null;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  createChallenge(input: {
    readonly challenge: AuthChallenge;
    readonly now: Date;
    readonly limits: AuthChallengeLimits;
  }): Promise<{ readonly accepted: boolean }>;
  findChallenge(id: string): Promise<AuthChallenge | null>;
  setChallengeDelivery(input: {
    readonly id: string;
    readonly state: AuthChallenge['deliveryState'];
    readonly providerMessageId?: string;
    readonly now: Date;
  }): Promise<void>;
  consumeChallengeAndCreateSession(input: {
    readonly challengeId: string;
    readonly digest: string;
    readonly now: Date;
    readonly userId: string;
    readonly tenantId: string;
    readonly provisioningJobId: string;
    readonly registration: { readonly enabled: boolean; readonly maxUsers: number };
    readonly session: Omit<HostedSession, 'userId' | 'tenantId'>;
    readonly rotateSessionId?: string;
    readonly passwordHash?: string;
  }): Promise<
    | { readonly authenticated: false }
    | {
        readonly authenticated: true;
        readonly user: HostedUser;
        readonly tenant: Tenant;
        readonly session: HostedSession;
        readonly provisioningJob: HostedJob | null;
      }
  >;
  resolveSession(input: {
    readonly tokenHash: string;
    readonly now: Date;
    readonly touch?: boolean;
    readonly idleTtlMs?: number;
  }): Promise<{
    readonly user: HostedUser;
    readonly tenant: Tenant;
    readonly session: HostedSession;
  } | null>;
  revokeSession(input: { readonly id: string; readonly now: Date }): Promise<void>;
  revokeUserSessions(input: { readonly userId: string; readonly now: Date }): Promise<void>;
  revokeAllCredentials(now: Date): Promise<void>;
}

export interface PlatformTenantRepository {
  findById(id: string): Promise<Tenant | null>;
  findByOwner(userId: string): Promise<Tenant | null>;
  list(): Promise<readonly Tenant[]>;
  suspend(input: {
    readonly id: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<Tenant>;
  resume(input: {
    readonly id: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<Tenant>;
  beginDeletion(input: {
    readonly id: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<Tenant>;
  completeDeletion(input: {
    readonly id: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<TenantTombstone>;
  listTombstones(): Promise<readonly TenantTombstone[]>;
}

export interface HostedEntitlement {
  readonly period: SubscriptionPeriod;
  readonly plan: PlanVersion;
  readonly capturedUnits: number;
  readonly heldUnits: number;
  readonly availableUnits: number;
}

export interface PlatformSubscriptionRepository {
  publishPlan(plan: PlanVersion): Promise<void>;
  findPlan(id: string): Promise<PlanVersion | null>;
  listPlans(): Promise<readonly PlanVersion[]>;
  grantTrial(input: {
    readonly period: SubscriptionPeriod;
    readonly now: Date;
  }): Promise<SubscriptionPeriod>;
  currentEntitlement(input: {
    readonly tenantId: string;
    readonly now: Date;
  }): Promise<HostedEntitlement | null>;
  listPeriods(tenantId: string): Promise<readonly SubscriptionPeriod[]>;
}

export interface FencedJobInput {
  readonly id: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly now: Date;
}

export interface PlatformJobUsageRepository {
  findById(id: string): Promise<HostedJob | null>;
  findByOperation(operationId: string): Promise<HostedJob | null>;
  findByRequest(input: {
    readonly tenantId: string;
    readonly requestId: string;
  }): Promise<HostedJob | null>;
  list(input: {
    readonly tenantId?: string;
    readonly states?: readonly HostedJob['state'][];
  }): Promise<readonly HostedJob[]>;
  prepareReservedJob(input: {
    readonly job: HostedJob;
    readonly reservation: UsageReservation;
    readonly now: Date;
  }): Promise<{
    readonly job: HostedJob;
    readonly reservation: UsageReservation;
    readonly replayed: boolean;
  }>;
  activatePreparedJob(input: {
    readonly id: string;
    readonly inputHash: string;
    readonly now: Date;
  }): Promise<HostedJob>;
  claimJob(input: {
    readonly workerId: string;
    readonly attemptId: string;
    readonly now: Date;
    readonly leaseMs: number;
    readonly maxGlobalRunning?: number;
    readonly maxTenantRunning?: number;
  }): Promise<HostedJob | null>;
  claimJobForReconciliation(input: {
    readonly id: string;
    readonly workerId: string;
    readonly attemptId: string;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<HostedJob | null>;
  renewJobLease(input: FencedJobInput & { readonly leaseMs: number }): Promise<boolean>;
  completeProvisioning(input: FencedJobInput & { readonly schemaVersion: number }): Promise<Tenant>;
  finishJobAndSettle(
    input: FencedJobInput & {
      readonly event: PlatformResultEvent;
      readonly captureUnits: number;
      readonly delivery?: DeliveryIntent;
      readonly deliveries?: readonly DeliveryIntent[];
    },
  ): Promise<{
    readonly job: HostedJob;
    readonly reservation: UsageReservation | null;
    readonly replayed: boolean;
  }>;
  retryJob(
    input: FencedJobInput & { readonly availableAt: Date; readonly errorKind: string },
  ): Promise<HostedJob>;
  stopJob(
    input: FencedJobInput & {
      readonly state: 'failed' | 'cancelled' | 'needs-review';
      readonly errorKind: string;
      readonly executionStopped: boolean;
    },
  ): Promise<HostedJob>;
  cancelPendingJob(input: {
    readonly id: string;
    readonly now: Date;
    readonly reason: string;
  }): Promise<HostedJob>;
  requestCancellation(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly now: Date;
  }): Promise<HostedJob>;
  findReservation(operationId: string): Promise<UsageReservation | null>;
  listUsage(input: {
    readonly tenantId: string;
    readonly periodId?: string;
  }): Promise<readonly UsageEntry[]>;
  correctUsage(input: { readonly entry: UsageEntry }): Promise<void>;
  saveProviderAttempt(attempt: ProviderAttempt): Promise<void>;
  listProviderAttempts(operationId: string): Promise<readonly ProviderAttempt[]>;
}

export interface PlatformDeliveryRepository {
  findById(id: string): Promise<DeliveryIntent | null>;
  list(tenantId: string): Promise<readonly DeliveryIntent[]>;
  listPending(input: {
    readonly states?: readonly DeliveryIntent['state'][];
    readonly now?: Date;
    readonly limit?: number;
  }): Promise<readonly DeliveryIntent[]>;
  defer(input: {
    readonly id: string;
    readonly availableAt: Date;
    readonly now: Date;
  }): Promise<DeliveryIntent>;
  markUnknown(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly now: Date;
  }): Promise<DeliveryIntent>;
  resolveUnknown(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly state: 'accepted' | 'failed';
    readonly providerMessageId?: string;
    readonly now: Date;
  }): Promise<DeliveryIntent>;
  claim(input: {
    readonly id: string;
    readonly generation: number;
    readonly bindingVersion: number;
    readonly attemptId: string;
    readonly now: Date;
  }): Promise<DeliveryIntent | null>;
  complete(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly state: 'accepted' | 'failed' | 'unknown' | 'suppressed';
    readonly now: Date;
    readonly providerMessageId?: string;
    readonly errorKind?: string;
    readonly retryAt?: Date;
  }): Promise<DeliveryIntent>;
  markDelivered(input: {
    readonly id: string;
    readonly providerMessageId: string;
    readonly deliveredAt: Date;
  }): Promise<void>;
}

export interface PlatformRepositoryRegistry {
  readonly llm: PlatformLLMRepository;
  readonly auth: PlatformAuthRepository;
  readonly tenants: PlatformTenantRepository;
  readonly subscriptions: PlatformSubscriptionRepository;
  readonly jobs: PlatformJobUsageRepository;
  readonly deliveries: PlatformDeliveryRepository;
  readonly payments: PlatformPaymentRepository;
  readonly notifications: PlatformNotificationRepository;
  readonly recovery: PlatformRecoveryRepository;
  readonly privacy: PlatformPrivacyRepository;
}

export interface PlatformPrivacyRepository {
  requestExport(input: {
    readonly metadata: HostedExportMetadata;
    readonly userId: string;
    readonly now: Date;
  }): Promise<{ readonly export: HostedExportMetadata; readonly replayed: boolean }>;
  findExport(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<HostedExportMetadata | null>;
  listExports(input: {
    readonly tenantId?: string;
    readonly states?: readonly HostedExportMetadata['state'][];
  }): Promise<readonly HostedExportMetadata[]>;
  completeExport(input: {
    readonly id: string;
    readonly generation: number;
    readonly resultHash: string;
    readonly byteLength: number;
    readonly now: Date;
  }): Promise<HostedExportMetadata>;
  failExport(input: {
    readonly id: string;
    readonly errorKind: string;
    readonly now: Date;
  }): Promise<HostedExportMetadata>;
  expireExports(now: Date): Promise<readonly HostedExportMetadata[]>;
  requestDeletion(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly confirmationTenantId: string;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<{
    readonly deletion: HostedDeletion;
    readonly tenant: Tenant;
    readonly replayed: boolean;
  }>;
  listDeletions(input: {
    readonly states?: readonly HostedDeletion['state'][];
  }): Promise<readonly HostedDeletion[]>;
  markDeletionNeedsReview(input: {
    readonly id: string;
    readonly errorKind: string;
    readonly now: Date;
  }): Promise<HostedDeletion>;
  completeDeletion(input: {
    readonly id: string;
    readonly generation: number;
    readonly now: Date;
  }): Promise<{ readonly deletion: HostedDeletion; readonly tombstone: TenantTombstone }>;
}

export interface PlatformRecoveryRepository {
  prepareRestore(input: {
    readonly now: Date;
    readonly tombstones: readonly TenantTombstone[];
  }): Promise<{
    readonly revokedSessions: number;
    readonly invalidatedChallenges: number;
    readonly fencedJobs: number;
    readonly suppressedDeliveries: number;
    readonly unknownDeliveries: number;
    readonly appliedTombstones: number;
  }>;
}

export interface PlatformNotificationRepository {
  findPreferences(tenantId: string): Promise<NotificationPreferences | null>;
  savePreferences(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly expectedRevision: number;
    readonly emailEnabled: boolean;
    readonly detail: NotificationPreferences['detail'];
    readonly quietHours: HostedQuietHours;
    readonly now: Date;
  }): Promise<NotificationPreferences>;
}

export interface PlatformPaymentRepository {
  claimReconciliation(input: {
    readonly orderId: string;
    readonly refundId: string | null;
    readonly now: Date;
    readonly intervalMs: number;
  }): Promise<boolean>;
  createOrder(input: {
    readonly order: SubscriptionOrder;
    readonly now: Date;
  }): Promise<{ readonly order: SubscriptionOrder; readonly replayed: boolean }>;
  findOrder(input: {
    readonly id: string;
    readonly tenantId: string;
  }): Promise<SubscriptionOrder | null>;
  listOrders(tenantId: string): Promise<readonly SubscriptionOrder[]>;
  markOrderRequestOutcome(input: {
    readonly id: string;
    readonly state: 'accepted' | 'unknown';
    readonly providerOrderId?: string;
    readonly now: Date;
  }): Promise<SubscriptionOrder>;
  applyVerifiedPaymentEvent(input: {
    readonly event: HostedPaymentEvent;
    readonly periodId: string;
    readonly now: Date;
    readonly allowClosedOrderGrant?: boolean;
  }): Promise<{
    readonly order: SubscriptionOrder | null;
    readonly period: SubscriptionPeriod | null;
    readonly event: HostedPaymentEvent;
    readonly replayed: boolean;
  }>;
  reserveRefund(input: {
    readonly refund: HostedRefund;
    readonly now: Date;
  }): Promise<{ readonly refund: HostedRefund; readonly replayed: boolean }>;
  updateRefundOutcome(input: {
    readonly id: string;
    readonly state: 'submitted' | 'processing' | 'unknown' | 'failed';
    readonly providerRefundId?: string;
    readonly now: Date;
  }): Promise<HostedRefund>;
  listRefunds(orderId: string): Promise<readonly HostedRefund[]>;
  listPaymentAttempts(orderId: string): Promise<readonly HostedPaymentAttempt[]>;
  listEvents(input: {
    readonly provider?: string;
    readonly disposition?: HostedPaymentEvent['disposition'];
  }): Promise<readonly HostedPaymentEvent[]>;
}

import type { HostedPasswordCredential } from './auth.js';
