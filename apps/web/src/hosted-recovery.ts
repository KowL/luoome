import { Database } from 'bun:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnconfiguredEmailOtpAdapter } from '@luoome/adapters/hosted';
import type { HostedExecutionIdentity, PlatformRepositoryRegistry } from '@luoome/core';
import {
  createDrizzlePlatformRepos,
  createSqliteMaintenanceGate,
  PLATFORM_SCHEMA_VERSION,
} from '@luoome/db';
import { buildContext } from '@luoome/tools';
import { contextForHostedTools, hostedExecutionToolNames } from '@luoome/tools/hosted';
import {
  buildPlatformContext,
  claimHostedPaymentReconciliationTool,
  getHostedRecoverySummaryTool,
  listHostedPaymentReconciliationTool,
  listPendingHostedDeliveriesTool,
  type PlatformContext,
  prepareHostedRecoveryTool,
  queryHostedRefundTool,
  reconcileHostedDeliveryTool,
  reconcileHostedSubscriptionOrderTool,
  suppressHostedDeliveryTool,
} from '@luoome/tools/platform';
import { copyHostedBackupForRestore } from './hosted-backup.js';
import { type HostedProviders, loadConfiguredHostedProviders } from './hosted-composition.js';
import type { HostedConfig } from './hosted-config.js';
import { readDeletionLedger } from './hosted-privacy.js';
import {
  HOSTED_TENANT_SCHEMA_VERSION,
  TenantManifestSchema,
  TenantRuntimeManager,
  writePrivateArtifact,
} from './hosted-runtime.js';
import { reconcileHostedTenantOutbox } from './hosted-worker.js';

const privateDatabase = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_restore_database');
  const sqlite = new Database(path, { create: false, readonly: true });
  try {
    const integrity = sqlite.query('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    if (integrity.length === 0 || integrity.some((row) => row.integrity_check !== 'ok'))
      throw new Error('restore_integrity_failed');
  } finally {
    sqlite.close();
  }
};

export const createHostedOperatorContext = (
  repos: PlatformRepositoryRegistry,
  config?: HostedConfig,
  clock: () => Date = () => new Date(),
): PlatformContext =>
  buildPlatformContext({
    repos,
    principal: { kind: 'worker', workerId: 'offline-operator', requestId: crypto.randomUUID() },
    authSecret: config?.authSecret ?? 'unused-offline-operator-secret-32-characters',
    environment: config?.environment ?? 'production',
    emailOtp: new UnconfiguredEmailOtpAdapter(),
    registration: { enabled: false, maxUsers: config?.registrationLimit ?? 30 },
    capabilities: { write: true, external: false },
    clock,
  });
export const summarizeHostedRecovery = async (platform: PlatformContext) => {
  const result = await getHostedRecoverySummaryTool.execute({}, platform);
  if (!result.ok) throw new Error('recovery_summary_unavailable');
  return result.data;
};

export const reconcileHostedExternalResults = async (input: {
  readonly dataRoot: string;
  readonly config: HostedConfig;
  readonly writersStopped: boolean;
  readonly providers?: HostedProviders;
  readonly env?: Record<string, string | undefined>;
  readonly clock?: () => Date;
}) => {
  if (!input.writersStopped) throw new Error('reconciliation_requires_stopped_writers');
  if (!input.config.exposeWrite || !input.config.exposeExternal)
    throw new Error('reconciliation_requires_write_and_external');
  const controlPath = join(input.dataRoot, 'control.sqlite');
  privateDatabase(controlPath);
  const handle = createDrizzlePlatformRepos(controlPath, { migrate: false });
  try {
    const version = handle.sqlite
      .query('SELECT version FROM hosted_schema_versions WHERE id = 1')
      .get() as { version: number } | null;
    if (version?.version !== PLATFORM_SCHEMA_VERSION)
      throw new Error('restore_platform_schema_mismatch');
    const state = createSqliteMaintenanceGate(handle.sqlite).state();
    if (
      state.mode !== 'frozen' ||
      state.owner?.startsWith('restore:') !== true ||
      state.activities !== 0
    )
      throw new Error('not_a_prepared_restore');
    const providers =
      input.providers ?? (await loadConfiguredHostedProviders(input.config, input.env));
    if (providers === undefined) throw new Error('reconciliation_requires_configured_providers');
    const platform = buildPlatformContext({
      ...createHostedOperatorContext(handle.repos, input.config, input.clock),
      notification: providers.notification,
      payment: providers.payment,
      publicOrigin: input.config.publicOrigin,
      capabilities: { write: true, external: true },
    });
    const payments = await listHostedPaymentReconciliationTool.execute({ limit: 100 }, platform);
    if (!payments.ok) throw new Error('recovery_payments_unavailable');
    let queriedOrders = 0;
    let queriedRefunds = 0;
    let queriedDeliveries = 0;
    let failedQueries = 0;
    for (const order of payments.data.orders) {
      const claim = await claimHostedPaymentReconciliationTool.execute(
        { orderId: order.id },
        platform,
      );
      if (!claim.ok) {
        failedQueries++;
        continue;
      }
      if (!claim.data.claimed) continue;
      queriedOrders++;
      const result = await reconcileHostedSubscriptionOrderTool.execute(
        { tenantId: order.tenantId, orderId: order.id },
        platform,
      );
      if (!result.ok) failedQueries++;
    }
    for (const refund of payments.data.refunds) {
      const claim = await claimHostedPaymentReconciliationTool.execute(
        { orderId: refund.orderId, refundId: refund.id },
        platform,
      );
      if (!claim.ok) {
        failedQueries++;
        continue;
      }
      if (!claim.data.claimed) continue;
      queriedRefunds++;
      const result = await queryHostedRefundTool.execute(
        { tenantId: refund.tenantId, orderId: refund.orderId, refundId: refund.id },
        platform,
      );
      if (!result.ok) failedQueries++;
    }
    const deliveries = await listPendingHostedDeliveriesTool.execute({ limit: 100 }, platform);
    if (!deliveries.ok) throw new Error('recovery_deliveries_unavailable');
    for (const intent of deliveries.data) {
      if (intent.state !== 'unknown') continue;
      queriedDeliveries++;
      const result = await reconcileHostedDeliveryTool.execute({ deliveryId: intent.id }, platform);
      if (!result.ok) {
        failedQueries++;
        continue;
      }
      if (['pending', 'failed'].includes(result.data.state)) {
        const suppressed = await suppressHostedDeliveryTool.execute(
          { deliveryId: intent.id },
          platform,
        );
        if (!suppressed.ok) throw new Error('restore_delivery_suppression_failed');
      }
    }
    return {
      mode: 'frozen' as const,
      queriedOrders,
      queriedRefunds,
      queriedDeliveries,
      failedQueries,
      pendingReview: await summarizeHostedRecovery(platform),
    };
  } finally {
    handle.close();
  }
};

export const reconcileHostedRestoredData = async (input: {
  readonly dataRoot: string;
  readonly deletionLedger: string;
  readonly backupId?: string;
  readonly config: HostedConfig;
  readonly writersStopped: boolean;
  readonly clock?: () => Date;
}) => {
  if (!input.writersStopped) throw new Error('restore_requires_writers_stopped');
  const tombstones = readDeletionLedger(input.deletionLedger);
  const controlPath = join(input.dataRoot, 'control.sqlite');
  privateDatabase(controlPath);
  const handle = createDrizzlePlatformRepos(controlPath, { migrate: false });
  const runtimes = new TenantRuntimeManager(input.dataRoot, input.config.runtimeLimit);
  try {
    const version = handle.sqlite
      .query('SELECT version FROM hosted_schema_versions WHERE id = 1')
      .get() as { version: number } | null;
    if (version?.version !== PLATFORM_SCHEMA_VERSION)
      throw new Error('restore_platform_schema_mismatch');
    const gate = createSqliteMaintenanceGate(handle.sqlite);
    const previous = gate.state();
    if (
      input.backupId === undefined &&
      (previous.mode !== 'frozen' || previous.owner?.startsWith('restore:') !== true)
    )
      throw new Error('not_a_prepared_restore');
    const owner =
      input.backupId === undefined ? (previous.owner as string) : `restore:${input.backupId}`;
    gate.recoverStoppedWriters({ owner, writersStopped: input.writersStopped });
    const clock = input.clock ?? (() => new Date());
    const platform = createHostedOperatorContext(handle.repos, input.config, clock);
    const recovery = await prepareHostedRecoveryTool.execute({ tombstones }, platform);
    if (!recovery.ok) throw new Error('restore_control_reconciliation_failed');
    const recovered = recovery.data;
    for (const tombstone of await handle.repos.tenants.listTombstones())
      runtimes.removeTenant(tombstone.id);
    let reconciledResults = 0;
    let unresolvedResults = 0;
    const unavailable = () => Promise.reject(new Error('restore_external_access_disabled'));
    for (const tenant of await handle.repos.tenants.list()) {
      if (!['active', 'suspended'].includes(tenant.status)) continue;
      const directory = join(input.dataRoot, 'tenants', tenant.id);
      const identity = TenantManifestSchema.parse(
        JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8')),
      );
      if (
        identity.tenantId !== tenant.id ||
        identity.ownerUserId !== tenant.ownerUserId ||
        identity.generation !== tenant.generation ||
        identity.schemaVersion !== HOSTED_TENANT_SCHEMA_VERSION
      )
        throw new Error('restore_tenant_manifest_mismatch');
      privateDatabase(join(directory, 'luoome.db'));
      const lease = runtimes.acquire(identity);
      try {
        const executionIdentity: HostedExecutionIdentity = Object.freeze({
          mode: 'hosted',
          actor: 'worker',
          userId: tenant.ownerUserId,
          tenantId: tenant.id,
          tenantGeneration: tenant.generation,
          requestId: crypto.randomUUID(),
        });
        const context = buildContext({
          mode: 'hosted',
          identity: executionIdentity,
          repos: lease.runtime.repos,
          user: { id: tenant.ownerUserId, defaultAccountId: '' },
          clock,
          adapters: {
            market: {
              name: 'restore-offline',
              fetchQuote: unavailable,
              fetchDailyBars: unavailable,
              batchQuote: unavailable,
              searchStocks: unavailable,
              fetchIndexQuotes: unavailable,
              fetchIntradayMinutes: unavailable,
              fetchMinuteBars: unavailable,
              marketSourceStatus: () => [],
              fetchMarketSnapshot: unavailable,
            },
            llm: { name: 'restore-offline', generate: unavailable },
          },
        });
        const ctx = contextForHostedTools(
          {
            context,
            identity: executionIdentity,
            entitlement: null,
            capabilities: { write: true, external: false },
            currentTenant: () => handle.repos.tenants.findById(tenant.id),
          },
          hostedExecutionToolNames,
          false,
        );
        const results = await reconcileHostedTenantOutbox(tenant, ctx, platform);
        reconciledResults += results.settled + results.acknowledged;
        unresolvedResults += results.unresolved;
        for (const metadata of await handle.repos.privacy.listExports({ tenantId: tenant.id }))
          runtimes.removeExport(tenant.id, metadata.id);
      } finally {
        lease.release();
      }
    }
    const report = {
      backupId: owner.slice('restore:'.length),
      maintenanceOwner: owner,
      mode: 'frozen' as const,
      ...recovered,
      reconciledResults,
      unresolvedResults,
      pendingReview: await summarizeHostedRecovery(platform),
    };
    writePrivateArtifact(input.dataRoot, 'restore-review.json', JSON.stringify(report));
    return report;
  } finally {
    runtimes.stop();
    handle.close();
  }
};

export const prepareHostedRestore = async (input: {
  readonly source: string;
  readonly destination: string;
  readonly deletionLedger: string;
  readonly config: HostedConfig;
  readonly writersStopped: boolean;
  readonly clock?: () => Date;
}) => {
  if (!input.writersStopped) throw new Error('restore_requires_writers_stopped');
  readDeletionLedger(input.deletionLedger);
  const manifest = copyHostedBackupForRestore(input);
  return reconcileHostedRestoredData({
    dataRoot: input.destination,
    deletionLedger: input.deletionLedger,
    backupId: manifest.backupId,
    config: input.config,
    writersStopped: true,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
};

export const resumeHostedRestoredService = async (input: {
  readonly dataRoot: string;
  readonly writersStopped: boolean;
}): Promise<void> => {
  if (!input.writersStopped) throw new Error('resume_requires_writers_stopped');
  privateDatabase(join(input.dataRoot, 'control.sqlite'));
  const handle = createDrizzlePlatformRepos(join(input.dataRoot, 'control.sqlite'), {
    migrate: false,
  });
  try {
    const gate = createSqliteMaintenanceGate(handle.sqlite);
    const state = gate.state();
    if (state.mode !== 'frozen' || state.owner?.startsWith('restore:') !== true)
      throw new Error('not_a_prepared_restore');
    const report = JSON.parse(
      readFileSync(join(input.dataRoot, 'restore-review.json'), 'utf8'),
    ) as { unresolvedResults: number; maintenanceOwner: string };
    if (report.maintenanceOwner !== state.owner || report.unresolvedResults !== 0)
      throw new Error('restore_has_unreconciled_results');
    const summary = await summarizeHostedRecovery(createHostedOperatorContext(handle.repos));
    if (Object.values(summary).some((count) => count !== 0))
      throw new Error('restore_has_unresolved_operations');
    gate.finish(state.owner);
  } finally {
    handle.close();
  }
};
