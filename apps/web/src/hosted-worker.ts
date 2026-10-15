import {
  type DeliveryIntent,
  dateInShanghai,
  type HostedJob,
  isAshareTradingSession,
  type Tenant,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  buildContext,
  buildPersonalAlertEvaluationTool,
  buildWatchlistFactsTool,
  commitPersonalAlertEvaluationTool,
  commitWatchlistFactsTool,
  listPersonalAlertPlansTool,
  preparePersonalAlertRequestTool,
  preparePersonalHostedDeliveryTool,
  syncPersonalHostedDeliveryTool,
} from '@luoome/tools';
import {
  acknowledgeTenantResultOutboxTool,
  claimTenantExecutionTool,
  contextForHostedTools,
  createTenantExportSnapshotTool,
  getTenantExecutionRequestTool,
  getTenantOperationReceiptTool,
  type HostedInvocation,
  hashHostedInput,
  hostedExecutionToolNames,
  listTenantResultOutboxTool,
  persistTenantExecutionRequestTool,
  renewTenantExecutionTool,
} from '@luoome/tools/hosted';
import {
  activateHostedJobTool,
  cancelPreparingHostedJobTool,
  claimHostedJobForReconciliationTool,
  claimHostedJobTool,
  claimHostedPaymentReconciliationTool,
  completeTenantProvisioningTool,
  findWorkerHostedJobRequestTool,
  finishHostedJobTool,
  getWorkerHostedEntitlementTool,
  getWorkerHostedJobTool,
  getWorkerHostedOperationTool,
  getWorkerTenantTool,
  grantHostedTrialTool,
  listHostedPaymentReconciliationTool,
  listPendingHostedDeliveriesTool,
  listPreparingHostedJobsTool,
  listWorkerHostedProviderAttemptsTool,
  listWorkerHostedTenantsTool,
  type PlatformContext,
  prepareScheduledHostedJobTool,
  publishHostedPlanTool,
  queryHostedRefundTool,
  reconcileHostedDeliveryTool,
  reconcileHostedSubscriptionOrderTool,
  recordHostedProviderAttemptTool,
  recoverSendingHostedDeliveryTool,
  renewHostedJobLeaseTool,
  retryHostedJobTool,
  sendHostedDeliveryTool,
  stopHostedJobTool,
  suppressHostedDeliveryTool,
} from '@luoome/tools/platform';
import { personalAlertsWorkflow, watchlistFactsWorkflow } from '@luoome/workflows';
import type { HostedService } from './hosted-composition.js';
import { bindHostedDefaultAccount } from './hosted-context.js';
import { processHostedPrivacy } from './hosted-privacy.js';
import { HOSTED_TENANT_SCHEMA_VERSION, type TenantRuntimeLease } from './hosted-runtime.js';

class HostedToolFailure extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}
const value = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new HostedToolFailure(result.error.kind);
  return result.data;
};
const fenced = (job: HostedJob) => {
  if (job.attemptId === null) throw new HostedToolFailure('lease_lost_before_commit');
  return { jobId: job.id, fence: job.fence, attemptId: job.attemptId };
};

const workerInvocation = async (
  service: HostedService,
  tenant: Tenant,
  lease: TenantRuntimeLease,
  operation?: HostedJob,
): Promise<HostedInvocation> => {
  const identity = Object.freeze({
    mode: 'hosted' as const,
    userId: tenant.ownerUserId,
    tenantId: tenant.id,
    tenantGeneration: tenant.generation,
    actor: 'worker' as const,
    requestId: crypto.randomUUID(),
    ...(operation === undefined ? {} : { operationId: operation.operationId }),
  });
  const base = buildContext({
    mode: 'hosted',
    identity,
    repos: lease.runtime.repos,
    adapters: {
      market: service.providers.market,
      llm: {
        name: 'hosted-ai-disabled',
        generate: async () => {
          throw new Error('hosted AI is disabled');
        },
      },
    },
    user: { id: tenant.ownerUserId, defaultAccountId: '' },
    clock: service.clock,
  });
  const context =
    service.config.productPolicyVersion === 'hosted-web-v2'
      ? await bindHostedDefaultAccount(base, service.providers.createTenantContext)
      : base;
  return {
    context,
    identity,
    entitlement: null,
    capabilities: { write: service.config.exposeWrite, external: service.config.exposeExternal },
    currentTenant: () => service.repos.tenants.findById(tenant.id),
    ...(operation === undefined
      ? {}
      : {
          acceptedOperation: {
            deadlineAt: operation.deadlineAt,
            operationId: operation.operationId,
          },
        }),
  };
};
const acquireTenant = (service: HostedService, tenant: Tenant) =>
  service.runtimes.acquire({
    tenantId: tenant.id,
    ownerUserId: tenant.ownerUserId,
    generation: tenant.generation,
    schemaVersion: tenant.schemaVersion,
  });
const settleOutbox = async (
  tenant: Tenant,
  job: HostedJob,
  ctx: ToolContext,
  platform: PlatformContext,
  afterPlatform?: () => Promise<void>,
) => {
  const events = value(await listTenantResultOutboxTool.execute({}, ctx)).events;
  const event = events.find((entry) => entry.operationId === job.operationId);
  if (event === undefined) throw new HostedToolFailure('missing_outbox');
  value(
    await finishHostedJobTool.execute(
      {
        ...fenced(job),
        event: {
          ...event,
          tenantId: tenant.id,
          generation: tenant.generation,
        },
      },
      platform,
    ),
  );
  await afterPlatform?.();
  value(await acknowledgeTenantResultOutboxTool.execute({ eventId: event.eventId }, ctx));
};

export const reconcileHostedTenantOutbox = async (
  tenant: Tenant,
  ctx: ToolContext,
  platform: PlatformContext,
): Promise<{ settled: number; acknowledged: number; unresolved: number }> => {
  const result = { settled: 0, acknowledged: 0, unresolved: 0 };
  for (const event of value(await listTenantResultOutboxTool.execute({}, ctx)).events) {
    const job = value(
      await getWorkerHostedOperationTool.execute({ operationId: event.operationId }, platform),
    );
    if (job === null || job.tenantId !== tenant.id || job.generation !== tenant.generation) {
      result.unresolved++;
      continue;
    }
    if (job.state === 'succeeded' || job.state === 'partial') {
      if (job.resultRef !== event.resultRef || job.resultHash !== event.resultHash) {
        result.unresolved++;
        continue;
      }
      value(await acknowledgeTenantResultOutboxTool.execute({ eventId: event.eventId }, ctx));
      result.acknowledged++;
      continue;
    }
    const claimed = value(
      await claimHostedJobForReconciliationTool.execute({ jobId: job.id }, platform),
    );
    if (claimed === null) {
      result.unresolved++;
      continue;
    }
    await settleOutbox(tenant, claimed, ctx, platform);
    result.settled++;
  }
  return result;
};

const reconcileAndSchedule = async (service: HostedService, platform: PlatformContext) => {
  const tenants = value(await listWorkerHostedTenantsTool.execute({}, platform));
  for (const tenant of tenants) {
    if (!['active', 'suspended'].includes(tenant.status)) continue;
    let lease: TenantRuntimeLease;
    try {
      lease = acquireTenant(service, tenant);
    } catch {
      continue;
    }
    try {
      const invocation = await workerInvocation(service, tenant, lease);
      const ctx = contextForHostedTools(invocation, hostedExecutionToolNames, false);
      await reconcileHostedTenantOutbox(tenant, ctx, platform);
      if (service.config.productPolicyVersion === 'hosted-web-v2') continue;
      if (
        !service.config.exposeExternal ||
        tenant.status !== 'active' ||
        !isAshareTradingSession(service.clock())
      )
        continue;
      const entitlement = value(
        await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform),
      );
      if (entitlement === null) continue;
      const scheduling = contextForHostedTools(
        { ...invocation, entitlement },
        new Set([
          listPersonalAlertPlansTool.name,
          preparePersonalAlertRequestTool.name,
          persistTenantExecutionRequestTool.name,
        ]),
        true,
      );
      const plans = value(await listPersonalAlertPlansTool.execute({}, scheduling)).plans;
      for (const watchlistId of new Set(
        plans.filter((entry) => entry.plan.enabled).map((entry) => entry.plan.watchlistId),
      )) {
        const requestId = `alerts:${watchlistId}:${Math.floor(service.clock().getTime() / 900_000)}`;
        if (
          value(
            await findWorkerHostedJobRequestTool.execute(
              { tenantId: tenant.id, requestId },
              platform,
            ),
          ) !== null
        )
          continue;
        const snapshot = await preparePersonalAlertRequestTool.execute(
          { watchlistId, period: dateInShanghai(service.clock()), maxDailyNotifications: 20 },
          scheduling,
        );
        if (!snapshot.ok) continue;
        const inputHash = hashHostedInput(snapshot.data.input);
        const prepared = await prepareScheduledHostedJobTool.execute(
          {
            tenantId: tenant.id,
            kind: 'watch-alerts',
            version: 1,
            requestId,
            payloadRef: `request:${requestId}`,
            inputHash,
          },
          platform,
        );
        if (!prepared.ok) continue;
        value(
          await persistTenantExecutionRequestTool.execute(
            {
              operationId: prepared.data.job.operationId,
              inputHash,
              generation: tenant.generation,
              kind: 'watch-alerts',
              input: snapshot.data.input,
              createdAt: prepared.data.job.createdAt,
            },
            scheduling,
          ),
        );
        value(
          await activateHostedJobTool.execute({ jobId: prepared.data.job.id, inputHash }, platform),
        );
      }
    } finally {
      lease.release();
    }
  }
};

export interface HostedWorkerHooks {
  readonly afterBusinessCommit?: (job: HostedJob) => Promise<void>;
  readonly afterPlatformCommit?: (job: HostedJob) => Promise<void>;
}

export const runHostedWorkerOnce = async (
  service: HostedService,
  workerId = `worker:${crypto.randomUUID()}`,
  hooks: HostedWorkerHooks = {},
): Promise<{ processed: boolean; kind?: string }> => {
  if (!service.config.exposeWrite) return { processed: false };
  const activity = service.maintenance.enter('worker');
  if (activity === null) return { processed: false };
  const platform = service.platformContext({
    kind: 'worker',
    workerId,
    requestId: crypto.randomUUID(),
  });
  try {
    const privacyProcessed = await processHostedPrivacy(service, platform, async (tenant, lease) =>
      contextForHostedTools(
        await workerInvocation(service, tenant, lease),
        new Set([createTenantExportSnapshotTool.name]),
        false,
      ),
    );
    await reconcileAndSchedule(service, platform);
    if (!service.config.exposeExternal) return { processed: privacyProcessed };
    const payments = value(await listHostedPaymentReconciliationTool.execute({}, platform));
    for (const order of payments.orders) {
      if (
        !value(await claimHostedPaymentReconciliationTool.execute({ orderId: order.id }, platform))
          .claimed
      )
        continue;
      await reconcileHostedSubscriptionOrderTool.execute(
        { tenantId: order.tenantId, orderId: order.id },
        platform,
      );
    }
    for (const refund of payments.refunds) {
      if (
        !value(
          await claimHostedPaymentReconciliationTool.execute(
            { orderId: refund.orderId, refundId: refund.id },
            platform,
          ),
        ).claimed
      )
        continue;
      await queryHostedRefundTool.execute(
        { tenantId: refund.tenantId, orderId: refund.orderId, refundId: refund.id },
        platform,
      );
    }
    for (const intent of value(
      await listPendingHostedDeliveriesTool.execute({ limit: 20 }, platform),
    )) {
      const tenant = value(
        await getWorkerTenantTool.execute({ tenantId: intent.tenantId }, platform),
      );
      const deliveryLease = service.maintenance.registerTenantRuntime({
        tenantId: tenant.id,
        ownerUserId: tenant.ownerUserId,
        generation: intent.generation,
      });
      if (deliveryLease === null) continue;
      let runtime: TenantRuntimeLease | undefined;
      try {
        let updated: DeliveryIntent;
        let ctx: ToolContext | undefined;
        if (intent.businessKey === `watch-trigger:${intent.resultRef}`) {
          runtime = acquireTenant(service, tenant);
          ctx = contextForHostedTools(
            await workerInvocation(service, tenant, runtime),
            new Set([preparePersonalHostedDeliveryTool.name, syncPersonalHostedDeliveryTool.name]),
            false,
          );
        }
        if (intent.state === 'sending')
          updated = value(
            await recoverSendingHostedDeliveryTool.execute({ deliveryId: intent.id }, platform),
          );
        else if (intent.state === 'unknown')
          updated = value(
            await reconcileHostedDeliveryTool.execute({ deliveryId: intent.id }, platform),
          );
        else {
          const eligible =
            ctx === undefined ||
            value(
              await preparePersonalHostedDeliveryTool.execute(
                {
                  triggerId: intent.resultRef,
                  channel: intent.channel,
                  emailAttempt: intent.channel === 'email' ? intent.attempt + 1 : 0,
                },
                ctx,
              ),
            ).eligible;
          updated = value(
            await (eligible ? sendHostedDeliveryTool : suppressHostedDeliveryTool).execute(
              { deliveryId: intent.id },
              platform,
            ),
          );
        }
        if (ctx !== undefined)
          value(
            await syncPersonalHostedDeliveryTool.execute(
              {
                triggerId: updated.resultRef,
                channel: updated.channel,
                attempts: updated.attempt,
                state: updated.state,
                notificationId: updated.id,
              },
              ctx,
            ),
          );
      } finally {
        runtime?.release();
        deliveryLease.release();
      }
    }
    for (const pending of value(await listPreparingHostedJobsTool.execute({}, platform)).slice(
      0,
      100,
    )) {
      const tenant = value(
        await getWorkerTenantTool.execute({ tenantId: pending.tenantId }, platform),
      );
      if (pending.deadlineAt <= service.clock()) {
        value(
          await cancelPreparingHostedJobTool.execute(
            { jobId: pending.id, reason: 'preparing-deadline' },
            platform,
          ),
        );
        continue;
      }
      if (tenant.status !== 'active' || tenant.generation !== pending.generation) continue;
      let lease: TenantRuntimeLease;
      try {
        lease = acquireTenant(service, tenant);
      } catch {
        continue;
      }
      try {
        const ctx = contextForHostedTools(
          await workerInvocation(service, tenant, lease),
          hostedExecutionToolNames,
          false,
        );
        const saved = value(
          await getTenantExecutionRequestTool.execute({ operationId: pending.operationId }, ctx),
        );
        if (
          saved !== null &&
          saved.inputHash === pending.inputHash &&
          saved.generation === pending.generation
        ) {
          value(
            await activateHostedJobTool.execute(
              { jobId: pending.id, inputHash: pending.inputHash },
              platform,
            ),
          );
        }
      } finally {
        lease.release();
      }
    }
    const job = value(await claimHostedJobTool.execute({}, platform));
    if (job === null) return { processed: privacyProcessed };
    let lease: TenantRuntimeLease | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPromise: Promise<void> | undefined;
    let leaseAlive = true;
    let receiptContext: ToolContext | undefined;
    let localClaimAcquired = false;
    try {
      const tenant = value(await getWorkerTenantTool.execute({ tenantId: job.tenantId }, platform));
      if (
        tenant.generation !== job.generation ||
        !['active', 'provisioning'].includes(tenant.status)
      )
        throw new HostedToolFailure('tenant_generation_changed');
      if (job.kind === 'provision-tenant') {
        if (tenant.status !== 'provisioning')
          throw new HostedToolFailure('tenant_not_provisioning');
        const handle = await service.runtimes.provision(
          {
            tenantId: tenant.id,
            ownerUserId: tenant.ownerUserId,
            generation: tenant.generation,
            schemaVersion: HOSTED_TENANT_SCHEMA_VERSION,
          },
          service.providers.stockSeed,
        );
        try {
          if (service.config.productPolicyVersion === 'hosted-web-v2') {
            await bindHostedDefaultAccount(
              buildContext({
                mode: 'hosted',
                identity: Object.freeze({
                  mode: 'hosted',
                  userId: tenant.ownerUserId,
                  tenantId: tenant.id,
                  tenantGeneration: tenant.generation,
                  actor: 'worker',
                  requestId: crypto.randomUUID(),
                }),
                repos: handle.repos,
                adapters: {
                  market: service.providers.market,
                  llm: {
                    name: 'hosted-provider-unconfigured',
                    generate: async () => {
                      throw new Error('LLM provider unavailable');
                    },
                  },
                },
                clock: service.clock,
              }),
            );
          }
        } finally {
          handle.close();
        }
        value(await publishHostedPlanTool.execute(service.providers.trialPlan, platform));
        value(
          await grantHostedTrialTool.execute(
            { tenantId: tenant.id, planVersionId: service.providers.trialPlan.id },
            platform,
          ),
        );
        value(
          await completeTenantProvisioningTool.execute(
            { ...fenced(job), schemaVersion: HOSTED_TENANT_SCHEMA_VERSION },
            platform,
          ),
        );
        return { processed: true, kind: job.kind };
      }
      if (!['watchlist-facts', 'watch-alerts'].includes(job.kind) || tenant.status !== 'active')
        throw new HostedToolFailure('unsupported_operation');
      lease = acquireTenant(service, tenant);
      const invocation = await workerInvocation(service, tenant, lease, job);
      receiptContext = contextForHostedTools(invocation, hostedExecutionToolNames, false);
      const allowed = new Set([
        ...hostedExecutionToolNames,
        buildWatchlistFactsTool.name,
        commitWatchlistFactsTool.name,
        buildPersonalAlertEvaluationTool.name,
        commitPersonalAlertEvaluationTool.name,
      ]);
      const authorized = contextForHostedTools(invocation, allowed, true);
      const ctx: ToolContext = {
        ...authorized,
        hostedAuthorization: async (name, input, capabilities) => {
          if (!leaseAlive)
            return {
              ok: false,
              error: { kind: 'lease_lost_before_commit', message: 'worker lease lost' },
            };
          const current = await getWorkerHostedJobTool.execute({ jobId: job.id }, platform);
          if (
            !current.ok ||
            current.data.job.state !== 'running' ||
            current.data.job.fence !== job.fence ||
            current.data.job.attemptId !== job.attemptId ||
            current.data.job.cancellationRequestedAt !== null ||
            current.data.job.deadlineAt <= service.clock()
          ) {
            leaseAlive = false;
            return {
              ok: false,
              error: { kind: 'lease_lost_before_commit', message: 'worker operation stopped' },
            };
          }
          return authorized.hostedAuthorization?.(name, input, capabilities) ?? null;
        },
      };
      const saved = value(
        await getTenantExecutionRequestTool.execute(
          { operationId: job.operationId },
          receiptContext,
        ),
      );
      if (saved === null || saved.inputHash !== job.inputHash)
        throw new HostedToolFailure('missing_execution_input');
      const local = value(
        await claimTenantExecutionTool.execute(
          {
            operationId: job.operationId,
            generation: job.generation,
            attemptId: fenced(job).attemptId,
          },
          receiptContext,
        ),
      );
      if (local.kind === 'busy') throw new HostedToolFailure('tenant_busy');
      if (local.kind === 'completed') {
        await settleOutbox(tenant, job, receiptContext, platform);
        return { processed: true, kind: job.kind };
      }
      localClaimAcquired = true;
      if (
        job.errorKind === 'receipt-reconciliation' ||
        job.deadlineAt <= service.clock() ||
        job.cancellationRequestedAt !== null
      ) {
        value(
          await stopHostedJobTool.execute(
            {
              ...fenced(job),
              state: job.cancellationRequestedAt === null ? 'failed' : 'cancelled',
              errorKind: 'execution-stopped-without-receipt',
              executionStopped: true,
            },
            platform,
          ),
        );
        return { processed: true, kind: job.kind };
      }
      const localFence = local.lease.fence;
      if (
        value(
          await listWorkerHostedProviderAttemptsTool.execute(
            { operationId: job.operationId },
            platform,
          ),
        ).some((attempt) => attempt.usageState === 'unknown')
      ) {
        value(
          await stopHostedJobTool.execute(
            {
              ...fenced(job),
              state: 'needs-review',
              errorKind: 'provider-usage-unknown',
              executionStopped: false,
            },
            platform,
          ),
        );
        return { processed: true, kind: job.kind };
      }
      heartbeat = setInterval(() => {
        if (heartbeatPromise !== undefined) return;
        heartbeatPromise = (async () => {
          const control = await renewHostedJobLeaseTool.execute(fenced(job), platform);
          const business = await renewTenantExecutionTool.execute(
            {
              operationId: job.operationId,
              generation: job.generation,
              fence: localFence,
              attemptId: fenced(job).attemptId,
            },
            ctx,
          );
          if (!control.ok || !control.data.renewed || !business.ok || !business.data.renewed)
            leaseAlive = false;
        })()
          .catch(() => {
            leaseAlive = false;
          })
          .finally(() => {
            heartbeatPromise = undefined;
          });
      }, 30_000);
      const now = service.clock();
      const reservation = value(
        await getWorkerHostedJobTool.execute({ jobId: job.id }, platform),
      ).reservation;
      if (reservation === null) throw new HostedToolFailure('missing_reservation');
      const attempt = {
        id: `${job.operationId}:market:${job.attempt}`,
        operationId: job.operationId,
        step: 'market',
        attempt: job.attempt,
        provider: service.providers.market.name,
        model: null,
        usageState: 'reserved',
        reservedCostMicro: reservation.budgetMicro,
        estimatedCostMicro: null,
        confirmedCostMicro: null,
        pricingVersion:
          service.config.providerMode === 'fixture' ? 'fixture-zero-v1' : 'operator-policy-v1',
        createdAt: now,
        updatedAt: now,
      };
      value(await recordHostedProviderAttemptTool.execute(attempt, platform));
      value(
        await recordHostedProviderAttemptTool.execute(
          { ...attempt, usageState: 'unknown', updatedAt: service.clock() },
          platform,
        ),
      );
      value<unknown>(
        await (job.kind === 'watch-alerts' ? personalAlertsWorkflow : watchlistFactsWorkflow).run(
          {
            operationId: job.operationId,
            inputHash: job.inputHash,
            generation: job.generation,
            fence: localFence,
            attemptId: fenced(job).attemptId,
          },
          ctx,
        ),
      );
      if (service.config.providerMode === 'fixture')
        value(
          await recordHostedProviderAttemptTool.execute(
            {
              ...attempt,
              usageState: 'confirmed',
              confirmedCostMicro: 0,
              updatedAt: service.clock(),
            },
            platform,
          ),
        );
      await hooks.afterBusinessCommit?.(job);
      await settleOutbox(
        tenant,
        job,
        receiptContext,
        platform,
        hooks.afterPlatformCommit === undefined
          ? undefined
          : () => hooks.afterPlatformCommit?.(job) ?? Promise.resolve(),
      );
      return { processed: true, kind: job.kind };
    } catch (error) {
      const kind = error instanceof HostedToolFailure ? error.kind : 'worker_interrupted';
      const receipt =
        receiptContext === undefined
          ? null
          : await getTenantOperationReceiptTool.execute(
              { operationId: job.operationId },
              receiptContext,
            );
      const committed = receipt?.ok === true && receipt.data !== null;
      const costs = await listWorkerHostedProviderAttemptsTool.execute(
        { operationId: job.operationId },
        platform,
      );
      const uncertainCost =
        costs.ok && costs.data.some((attempt) => attempt.usageState === 'unknown');
      if (kind !== 'lease_lost_before_commit') {
        if (!committed && uncertainCost) {
          await stopHostedJobTool.execute(
            {
              ...fenced(job),
              state: 'needs-review',
              errorKind: 'provider-usage-unknown',
              executionStopped: false,
            },
            platform,
          );
        } else if (
          committed ||
          (job.attempt < 3 &&
            job.deadlineAt > service.clock() &&
            kind !== 'invalid_input' &&
            kind !== 'unsupported_operation')
        ) {
          await retryHostedJobTool.execute(
            {
              ...fenced(job),
              availableAt: new Date(service.clock().getTime() + 5_000),
              errorKind: kind,
            },
            platform,
          );
        } else
          await stopHostedJobTool.execute(
            {
              ...fenced(job),
              state: localClaimAcquired ? 'failed' : 'needs-review',
              errorKind: kind,
              executionStopped: localClaimAcquired,
            },
            platform,
          );
      }
      return { processed: true, kind: job.kind };
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (heartbeatPromise !== undefined) await heartbeatPromise;
      lease?.release();
    }
  } finally {
    activity.release();
  }
};
