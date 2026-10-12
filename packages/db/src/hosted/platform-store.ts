import type {
  AuthChallenge,
  DeliveryIntent,
  HostedDeletion,
  HostedExportMetadata,
  HostedJob,
  HostedPaymentAttempt,
  HostedPaymentEvent,
  HostedRefund,
  HostedSession,
  HostedUser,
  NotificationPreferences,
  PlanVersion,
  PlatformResultEvent,
  ProviderAttempt,
  SubscriptionOrder,
  SubscriptionPeriod,
  Tenant,
  TenantTombstone,
  UsageEntry,
  UsageReservation,
} from '@luoome/core';

export interface PlatformRecords {
  users: HostedUser;
  tenants: Tenant;
  challenges: AuthChallenge;
  sessions: HostedSession;
  plans: PlanVersion;
  periods: SubscriptionPeriod;
  jobs: HostedJob;
  reservations: UsageReservation;
  usage: UsageEntry;
  providerAttempts: ProviderAttempt;
  deliveries: DeliveryIntent;
  inbox: PlatformResultEvent & { readonly id: string; readonly processedAt: Date };
  tombstones: TenantTombstone;
  cursors: { readonly id: string; readonly tenantId: string };
  orders: SubscriptionOrder;
  paymentAttempts: HostedPaymentAttempt;
  paymentEvents: HostedPaymentEvent;
  refunds: HostedRefund;
  preferences: NotificationPreferences;
  exports: HostedExportMetadata;
  deletions: HostedDeletion;
}
export type PlatformTable = keyof PlatformRecords;

export interface PlatformStore {
  transaction<T>(work: () => T): T;
  get<K extends PlatformTable>(table: K, id: string): PlatformRecords[K] | null;
  list<K extends PlatformTable>(
    table: K,
    where?: Partial<PlatformRecords[K]>,
  ): PlatformRecords[K][];
  put<K extends PlatformTable>(table: K, entity: PlatformRecords[K]): void;
  remove<K extends PlatformTable>(table: K, id: string): void;
}

export const PLATFORM_TABLES: readonly PlatformTable[] = [
  'users',
  'tenants',
  'challenges',
  'sessions',
  'plans',
  'periods',
  'jobs',
  'reservations',
  'usage',
  'providerAttempts',
  'deliveries',
  'inbox',
  'tombstones',
  'cursors',
  'orders',
  'paymentAttempts',
  'paymentEvents',
  'refunds',
  'preferences',
  'exports',
  'deletions',
];
