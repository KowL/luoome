import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const record = () => ({ id: text('id').primaryKey(), valueJson: text('value_json').notNull() });

export const platformUsers = sqliteTable(
  'hosted_users',
  {
    ...record(),
    emailKey: text('email_key').notNull(),
  },
  (table) => [uniqueIndex('hosted_users_email_key_unique').on(table.emailKey)],
);
export const platformTenants = sqliteTable(
  'hosted_tenants',
  {
    ...record(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => platformUsers.id),
    status: text('status').notNull(),
  },
  (table) => [uniqueIndex('hosted_tenants_owner_unique').on(table.ownerUserId)],
);
export const platformChallenges = sqliteTable(
  'hosted_auth_challenges',
  {
    ...record(),
    emailKey: text('email_key').notNull(),
    purpose: text('purpose').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('hosted_challenges_email_time_idx').on(table.emailKey, table.createdAt),
    index('hosted_challenges_ip_time_idx').on(table.ipHash, table.createdAt),
  ],
);
export const platformSessions = sqliteTable(
  'hosted_sessions',
  {
    ...record(),
    tokenHash: text('token_hash').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => platformUsers.id),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
  },
  (table) => [
    uniqueIndex('hosted_sessions_token_unique').on(table.tokenHash),
    index('hosted_sessions_user_idx').on(table.userId),
  ],
);
export const platformPasswords = sqliteTable('hosted_passwords', {
  ...record(),
  id: text('id')
    .primaryKey()
    .references(() => platformUsers.id),
});
export const platformPasswordAttempts = sqliteTable(
  'hosted_password_attempts',
  {
    ...record(),
    emailHash: text('email_hash').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('hosted_password_attempts_email_idx').on(table.emailHash, table.createdAt),
    index('hosted_password_attempts_ip_idx').on(table.ipHash, table.createdAt),
  ],
);
export const platformPlans = sqliteTable('hosted_plan_versions', record());
export const platformPeriods = sqliteTable(
  'hosted_subscription_periods',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    sourceOrderId: text('source_order_id'),
  },
  (table) => [
    index('hosted_periods_tenant_idx').on(table.tenantId),
    uniqueIndex('hosted_periods_order_unique').on(table.sourceOrderId),
  ],
);
export const platformJobs = sqliteTable(
  'hosted_jobs',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    operationId: text('operation_id').notNull(),
    requestId: text('request_id').notNull(),
    state: text('state').notNull(),
    availableAt: integer('available_at').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_jobs_operation_unique').on(table.operationId),
    uniqueIndex('hosted_jobs_request_unique').on(table.tenantId, table.requestId),
    index('hosted_jobs_due_idx').on(table.state, table.availableAt),
  ],
);
export const platformReservations = sqliteTable(
  'hosted_usage_reservations',
  {
    ...record(),
    operationId: text('operation_id').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    periodId: text('period_id')
      .notNull()
      .references(() => platformPeriods.id),
  },
  (table) => [
    uniqueIndex('hosted_reservations_operation_unique').on(table.operationId),
    index('hosted_reservations_period_idx').on(table.periodId),
  ],
);
export const platformUsage = sqliteTable(
  'hosted_usage_entries',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    operationId: text('operation_id').notNull(),
    periodId: text('period_id')
      .notNull()
      .references(() => platformPeriods.id),
    revision: integer('revision').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_usage_revision_unique').on(table.operationId, table.revision),
    index('hosted_usage_period_idx').on(table.periodId),
  ],
);
export const platformProviderAttempts = sqliteTable(
  'hosted_provider_attempts',
  {
    ...record(),
    operationId: text('operation_id').notNull(),
    step: text('step').notNull(),
    attempt: integer('attempt').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_provider_attempt_unique').on(table.operationId, table.step, table.attempt),
  ],
);
export const platformDeliveries = sqliteTable(
  'hosted_delivery_intents',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    businessKey: text('business_key').notNull(),
    channel: text('channel').notNull(),
    state: text('state').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_delivery_business_unique').on(
      table.tenantId,
      table.businessKey,
      table.channel,
    ),
    index('hosted_delivery_pending_idx').on(table.state),
  ],
);
export const platformInbox = sqliteTable('hosted_platform_inbox', {
  ...record(),
  operationId: text('operation_id').notNull(),
});
export const platformTombstones = sqliteTable('hosted_tenant_tombstones', record());
export const platformCursors = sqliteTable('hosted_scheduler_cursors', record());
export const platformSchemaVersions = sqliteTable('hosted_schema_versions', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
});

export const platformOrders = sqliteTable(
  'hosted_subscription_orders',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    requestId: text('request_id').notNull(),
    provider: text('provider').notNull(),
    merchantId: text('merchant_id').notNull(),
    merchantOrderId: text('merchant_order_id').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_orders_request_unique').on(table.tenantId, table.requestId),
    uniqueIndex('hosted_orders_merchant_unique').on(
      table.provider,
      table.merchantId,
      table.merchantOrderId,
    ),
  ],
);
export const platformPaymentAttempts = sqliteTable(
  'hosted_payment_attempts',
  {
    ...record(),
    orderId: text('order_id')
      .notNull()
      .references(() => platformOrders.id),
    provider: text('provider').notNull(),
    merchantId: text('merchant_id').notNull(),
    providerTransactionId: text('provider_transaction_id').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_payment_transaction_unique').on(
      table.provider,
      table.merchantId,
      table.providerTransactionId,
    ),
  ],
);
export const platformPaymentEvents = sqliteTable(
  'hosted_payment_events',
  {
    ...record(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    disposition: text('disposition').notNull(),
  },
  (table) => [uniqueIndex('hosted_payment_event_unique').on(table.provider, table.eventId)],
);
export const platformRefunds = sqliteTable(
  'hosted_refunds',
  {
    ...record(),
    orderId: text('order_id')
      .notNull()
      .references(() => platformOrders.id),
    paymentAttemptId: text('payment_attempt_id')
      .notNull()
      .references(() => platformPaymentAttempts.id),
    requestId: text('request_id').notNull(),
  },
  (table) => [uniqueIndex('hosted_refund_request_unique').on(table.orderId, table.requestId)],
);
export const platformPreferences = sqliteTable(
  'hosted_notification_preferences',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
  },
  (table) => [uniqueIndex('hosted_notification_preferences_tenant_unique').on(table.tenantId)],
);
export const platformExports = sqliteTable(
  'hosted_exports',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    requestId: text('request_id').notNull(),
    operationId: text('operation_id').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_exports_request_unique').on(table.tenantId, table.requestId),
    uniqueIndex('hosted_exports_operation_unique').on(table.operationId),
  ],
);
export const platformDeletions = sqliteTable(
  'hosted_deletions',
  {
    ...record(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => platformTenants.id),
    requestId: text('request_id').notNull(),
  },
  (table) => [
    uniqueIndex('hosted_deletions_tenant_unique').on(table.tenantId),
    uniqueIndex('hosted_deletions_request_unique').on(table.tenantId, table.requestId),
  ],
);

export const platformSchema = {
  passwords: platformPasswords,
  passwordAttempts: platformPasswordAttempts,
  users: platformUsers,
  tenants: platformTenants,
  challenges: platformChallenges,
  sessions: platformSessions,
  plans: platformPlans,
  periods: platformPeriods,
  jobs: platformJobs,
  reservations: platformReservations,
  usage: platformUsage,
  providerAttempts: platformProviderAttempts,
  deliveries: platformDeliveries,
  inbox: platformInbox,
  tombstones: platformTombstones,
  cursors: platformCursors,
  orders: platformOrders,
  paymentAttempts: platformPaymentAttempts,
  paymentEvents: platformPaymentEvents,
  refunds: platformRefunds,
  preferences: platformPreferences,
  exports: platformExports,
  deletions: platformDeletions,
};
export type PlatformSchema = typeof platformSchema;
