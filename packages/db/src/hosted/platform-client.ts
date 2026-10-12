import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import {
  AuthChallengeSchema,
  DeliveryIntentSchema,
  HostedDeletionSchema,
  HostedExportMetadataSchema,
  HostedJobSchema,
  HostedPaymentAttemptSchema,
  HostedPaymentEventSchema,
  HostedRefundSchema,
  HostedSessionSchema,
  HostedUserSchema,
  InvariantError,
  NotificationPreferencesSchema,
  PlanVersionSchema,
  PlatformInboxSchema,
  PlatformJobCursorSchema,
  type PlatformRepositoryRegistry,
  ProviderAttemptSchema,
  SubscriptionOrderSchema,
  SubscriptionPeriodSchema,
  TenantSchema,
  TenantTombstoneSchema,
  UsageEntrySchema,
  UsageReservationSchema,
} from '@luoome/core';
import { getTableColumns, getTableName, type SQL, sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { createPlatformRepositories } from './platform-repositories.js';
import { type PlatformSchema, platformSchema } from './platform-schema.js';
import type { PlatformRecords, PlatformStore, PlatformTable } from './platform-store.js';

export type PlatformDrizzleDb = BunSQLiteDatabase<PlatformSchema>;
export const PLATFORM_SCHEMA_VERSION = 1;

const schemas = {
  users: HostedUserSchema,
  tenants: TenantSchema,
  challenges: AuthChallengeSchema,
  sessions: HostedSessionSchema,
  plans: PlanVersionSchema,
  periods: SubscriptionPeriodSchema,
  jobs: HostedJobSchema,
  reservations: UsageReservationSchema,
  usage: UsageEntrySchema,
  providerAttempts: ProviderAttemptSchema,
  deliveries: DeliveryIntentSchema,
  inbox: PlatformInboxSchema,
  tombstones: TenantTombstoneSchema,
  cursors: PlatformJobCursorSchema,
  orders: SubscriptionOrderSchema,
  paymentAttempts: HostedPaymentAttemptSchema,
  paymentEvents: HostedPaymentEventSchema,
  refunds: HostedRefundSchema,
  preferences: NotificationPreferencesSchema,
  exports: HostedExportMetadataSchema,
  deletions: HostedDeletionSchema,
};

export const ensurePlatformSchema = (db: PlatformDrizzleDb): void => {
  db.transaction(
    () => {
      db.run(
        sql`CREATE TABLE IF NOT EXISTS hosted_schema_versions (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
      );
      const version = db.all<{ version: number }>(
        sql`SELECT version FROM hosted_schema_versions WHERE id = 1`,
      )[0];
      if (version !== undefined && version.version > PLATFORM_SCHEMA_VERSION)
        throw new InvariantError('platform schema is newer than this application');
      const tables = [
        'hosted_users (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, email_key TEXT NOT NULL)',
        'hosted_tenants (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES hosted_users(id), status TEXT NOT NULL)',
        'hosted_auth_challenges (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, email_key TEXT NOT NULL, purpose TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL)',
        'hosted_sessions (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, token_hash TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES hosted_users(id), tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id))',
        'hosted_plan_versions (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)',
        'hosted_subscription_periods (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), source_order_id TEXT)',
        'hosted_jobs (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), operation_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, available_at INTEGER NOT NULL)',
        'hosted_usage_reservations (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, operation_id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), period_id TEXT NOT NULL REFERENCES hosted_subscription_periods(id))',
        'hosted_usage_entries (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), operation_id TEXT NOT NULL, period_id TEXT NOT NULL REFERENCES hosted_subscription_periods(id), revision INTEGER NOT NULL)',
        'hosted_provider_attempts (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, operation_id TEXT NOT NULL, step TEXT NOT NULL, attempt INTEGER NOT NULL)',
        'hosted_delivery_intents (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), business_key TEXT NOT NULL, channel TEXT NOT NULL, state TEXT NOT NULL)',
        'hosted_platform_inbox (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, operation_id TEXT NOT NULL)',
        'hosted_tenant_tombstones (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)',
        'hosted_scheduler_cursors (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)',
        'hosted_subscription_orders (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), request_id TEXT NOT NULL, provider TEXT NOT NULL, merchant_id TEXT NOT NULL, merchant_order_id TEXT NOT NULL)',
        'hosted_payment_attempts (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES hosted_subscription_orders(id), provider TEXT NOT NULL, merchant_id TEXT NOT NULL, provider_transaction_id TEXT NOT NULL)',
        'hosted_payment_events (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL, disposition TEXT NOT NULL)',
        'hosted_refunds (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES hosted_subscription_orders(id), payment_attempt_id TEXT NOT NULL REFERENCES hosted_payment_attempts(id), request_id TEXT NOT NULL)',
        'hosted_notification_preferences (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id))',
        'hosted_exports (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), request_id TEXT NOT NULL, operation_id TEXT NOT NULL)',
        'hosted_deletions (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES hosted_tenants(id), request_id TEXT NOT NULL)',
      ];
      for (const table of tables) db.run(sql.raw(`CREATE TABLE IF NOT EXISTS ${table}`));
      const indexes = [
        'UNIQUE INDEX hosted_users_email_key_unique ON hosted_users (email_key)',
        'UNIQUE INDEX hosted_tenants_owner_unique ON hosted_tenants (owner_user_id)',
        'INDEX hosted_challenges_email_time_idx ON hosted_auth_challenges (email_key, created_at)',
        'INDEX hosted_challenges_ip_time_idx ON hosted_auth_challenges (ip_hash, created_at)',
        'UNIQUE INDEX hosted_sessions_token_unique ON hosted_sessions (token_hash)',
        'INDEX hosted_sessions_user_idx ON hosted_sessions (user_id)',
        'INDEX hosted_periods_tenant_idx ON hosted_subscription_periods (tenant_id)',
        'UNIQUE INDEX hosted_periods_order_unique ON hosted_subscription_periods (source_order_id)',
        'UNIQUE INDEX hosted_jobs_operation_unique ON hosted_jobs (operation_id)',
        'UNIQUE INDEX hosted_jobs_request_unique ON hosted_jobs (tenant_id, request_id)',
        'INDEX hosted_jobs_due_idx ON hosted_jobs (state, available_at)',
        'UNIQUE INDEX hosted_reservations_operation_unique ON hosted_usage_reservations (operation_id)',
        'INDEX hosted_reservations_period_idx ON hosted_usage_reservations (period_id)',
        'UNIQUE INDEX hosted_usage_revision_unique ON hosted_usage_entries (operation_id, revision)',
        'INDEX hosted_usage_period_idx ON hosted_usage_entries (period_id)',
        'UNIQUE INDEX hosted_provider_attempt_unique ON hosted_provider_attempts (operation_id, step, attempt)',
        'UNIQUE INDEX hosted_delivery_business_unique ON hosted_delivery_intents (tenant_id, business_key, channel)',
        'INDEX hosted_delivery_pending_idx ON hosted_delivery_intents (state)',
        'UNIQUE INDEX hosted_orders_request_unique ON hosted_subscription_orders (tenant_id, request_id)',
        'UNIQUE INDEX hosted_orders_merchant_unique ON hosted_subscription_orders (provider, merchant_id, merchant_order_id)',
        'UNIQUE INDEX hosted_payment_transaction_unique ON hosted_payment_attempts (provider, merchant_id, provider_transaction_id)',
        'UNIQUE INDEX hosted_payment_event_unique ON hosted_payment_events (provider, event_id)',
        'UNIQUE INDEX hosted_refund_request_unique ON hosted_refunds (order_id, request_id)',
        'UNIQUE INDEX hosted_notification_preferences_tenant_unique ON hosted_notification_preferences (tenant_id)',
        'UNIQUE INDEX hosted_exports_request_unique ON hosted_exports (tenant_id, request_id)',
        'UNIQUE INDEX hosted_exports_operation_unique ON hosted_exports (operation_id)',
        'UNIQUE INDEX hosted_deletions_tenant_unique ON hosted_deletions (tenant_id)',
        'UNIQUE INDEX hosted_deletions_request_unique ON hosted_deletions (tenant_id, request_id)',
      ];
      for (const index of indexes)
        db.run(sql.raw(`CREATE ${index.replace('INDEX ', 'INDEX IF NOT EXISTS ')}`));
      db.run(
        sql`INSERT INTO hosted_schema_versions (id, version) VALUES (1, ${PLATFORM_SCHEMA_VERSION}) ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
      );
    },
    { behavior: 'immediate' },
  );
};

class DrizzlePlatformStore implements PlatformStore {
  constructor(private readonly db: PlatformDrizzleDb) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work, { behavior: 'immediate' });
  }

  get<K extends PlatformTable>(table: K, id: string): PlatformRecords[K] | null {
    return this.list(table, { id } as Partial<PlatformRecords[K]>)[0] ?? null;
  }

  list<K extends PlatformTable>(
    table: K,
    where: Partial<PlatformRecords[K]> = {},
  ): PlatformRecords[K][] {
    const definition = platformSchema[table];
    const columns: Readonly<Record<string, { readonly name: string }>> =
      getTableColumns(definition);
    const predicates: SQL[] = Object.entries(where).map(([key, value]) => {
      const column = columns[key];
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
        throw new InvariantError('invalid platform query key');
      const expression =
        column === undefined
          ? sql`json_extract(value_json, ${`$.${key}`})`
          : sql.identifier(column.name);
      const scalar = value instanceof Date ? value.getTime() : value;
      return scalar === null ? sql`${expression} IS NULL` : sql`${expression} = ${scalar}`;
    });
    const query = sql`SELECT value_json FROM ${sql.identifier(getTableName(definition))}${predicates.length === 0 ? sql`` : sql` WHERE ${sql.join(predicates, sql` AND `)}`}`;
    return this.db
      .all<{ value_json: string }>(query)
      .map((row) => schemas[table].parse(JSON.parse(row.value_json)) as PlatformRecords[K]);
  }

  put<K extends PlatformTable>(table: K, entity: PlatformRecords[K]): void {
    const definition = platformSchema[table];
    const columns = Object.entries(getTableColumns(definition));
    const values = columns.map(([key]) => {
      if (key === 'valueJson') return JSON.stringify(entity);
      const value = (entity as unknown as Record<string, unknown>)[key];
      return value instanceof Date ? value.getTime() : (value ?? null);
    });
    this.db.run(
      sql`INSERT INTO ${sql.identifier(getTableName(definition))} (${sql.join(
        columns.map(([, column]) => sql.identifier(column.name)),
        sql`, `,
      )}) VALUES (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}) ON CONFLICT (id) DO UPDATE SET ${sql.join(
        columns
          .filter(([key]) => key !== 'id')
          .map(
            ([, column]) =>
              sql`${sql.identifier(column.name)} = excluded.${sql.identifier(column.name)}`,
          ),
        sql`, `,
      )}`,
    );
  }

  remove(table: PlatformTable, id: string): void {
    this.db.run(
      sql`DELETE FROM ${sql.identifier(getTableName(platformSchema[table]))} WHERE id = ${id}`,
    );
  }
}

export interface PlatformReposHandle {
  readonly repos: PlatformRepositoryRegistry;
  readonly db: PlatformDrizzleDb;
  readonly sqlite: Database;
  close(): void;
}

export const createDrizzlePlatformRepos = (
  path: string,
  options: { readonly migrate?: boolean } = {},
): PlatformReposHandle => {
  if (path !== ':memory:') {
    const descriptor = openSync(path, 'a', 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);
  }
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const db = drizzle(sqlite, { schema: platformSchema });
    if (options.migrate !== false) ensurePlatformSchema(db);
    return {
      repos: createPlatformRepositories(new DrizzlePlatformStore(db)),
      db,
      sqlite,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
