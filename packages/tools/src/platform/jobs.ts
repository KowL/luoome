import {
  DeliveryIntentSchema,
  type HostedJob,
  HostedJobSchema,
  PlanVersionSchema,
  PlatformResultEventSchema,
  ProviderAttemptSchema,
  SubscriptionPeriodSchema,
  type Tenant,
  TenantSchema,
  type ToolResult,
  UsageEntrySchema,
  UsageReservationSchema,
} from '@luoome/core';
import { z } from 'zod';
import { errInvalidInput, errNotFound } from '../define-tool.js';
import type { PlatformContext } from './context.js';
import { randomAuthId } from './crypto.js';
import { definePlatformTool } from './define-platform-tool.js';

const Id = z.string().min(1).max(160);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

const readUserTenant = async (ctx: PlatformContext) => {
  if (ctx.principal.kind !== 'user') return denied('actor:user');
  const tenant = await ctx.repos.tenants.findById(ctx.principal.tenantId);
  if (
    tenant === null ||
    tenant.ownerUserId !== ctx.principal.userId ||
    tenant.generation !== ctx.principal.tenantGeneration ||
    tenant.status === 'deleting' ||
    tenant.status === 'deleted'
  ) {
    return errNotFound('Tenant', ctx.principal.tenantId);
  }
  return tenant;
};

const readUserJob = async (
  ctx: PlatformContext,
  id: string,
): Promise<HostedJob | ToolResult<never>> => {
  const tenant = await readUserTenant(ctx);
  if ('ok' in tenant) return tenant;
  const job = await ctx.repos.jobs.findById(id);
  return job === null || job.tenantId !== tenant.id ? errNotFound('HostedJob', id) : job;
};

const JobPreparationInputSchema = z
  .object({
    kind: z.enum(['watchlist-facts', 'watch-alerts']),
    version: z.literal(1),
    requestId: Id,
    payloadRef: Id,
    inputHash: Digest,
  })
  .strict();
const PreparedJobSchema = z.object({
  job: HostedJobSchema,
  reservation: UsageReservationSchema.nullable(),
  replayed: z.boolean(),
});
const prepareReservedOperation = async (
  input: z.infer<typeof JobPreparationInputSchema>,
  ctx: PlatformContext,
  tenant: Tenant,
) => {
  const previous = await ctx.repos.jobs.findByRequest({
    tenantId: tenant.id,
    requestId: input.requestId,
  });
  if (previous !== null) {
    if (
      previous.inputHash !== input.inputHash ||
      previous.kind !== input.kind ||
      previous.version !== input.version ||
      previous.payloadRef !== input.payloadRef
    )
      return errInvalidInput('request_id_input_conflict');
    return {
      job: previous,
      reservation: await ctx.repos.jobs.findReservation(previous.operationId),
      replayed: true,
    };
  }
  if (tenant.status !== 'active') return denied('tenant:active');
  const policy = ctx.jobPolicies[input.kind];
  if (policy === undefined) return denied(`hosted-operation:${input.kind}`);
  const now = ctx.clock();
  const entitlement = await ctx.repos.subscriptions.currentEntitlement({
    tenantId: tenant.id,
    now,
  });
  if (entitlement === null) return denied('entitlement:research-credit');
  if (policy.units > entitlement.availableUnits) return denied('entitlement:research-credit');
  const operationId = randomAuthId();
  const job = HostedJobSchema.parse({
    id: randomAuthId(),
    tenantId: tenant.id,
    generation: tenant.generation,
    operationId,
    requestId: input.requestId,
    kind: input.kind,
    version: input.version,
    payloadRef: input.payloadRef,
    inputHash: input.inputHash,
    state: 'preparing',
    priority: policy.priority,
    attempt: 0,
    availableAt: now,
    deadlineAt: new Date(now.getTime() + policy.acceptDeadlineMs),
    fence: 0,
    attemptId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    resultRef: null,
    resultHash: null,
    errorKind: null,
    createdAt: now,
    updatedAt: now,
  });
  const reservation = UsageReservationSchema.parse({
    id: randomAuthId(),
    operationId,
    tenantId: tenant.id,
    periodId: entitlement.period.id,
    units: policy.units,
    budgetMicro: policy.budgetMicro,
    state: 'held',
    capturedUnits: null,
    createdAt: now,
    settledAt: null,
  });
  return ctx.repos.jobs.prepareReservedJob({ job, reservation, now });
};

export const prepareHostedJobTool = definePlatformTool({
  name: 'prepare_hosted_job',
  description: 'Atomically reserve a versioned operation and create its preparing job.',
  sideEffect: 'write',
  actors: ['user'],
  input: JobPreparationInputSchema,
  output: PreparedJobSchema,
  handler: async (input, ctx) => {
    const tenant = await readUserTenant(ctx);
    return 'ok' in tenant ? tenant : prepareReservedOperation(input, ctx, tenant);
  },
});

export const prepareScheduledHostedJobTool = definePlatformTool({
  name: 'prepare_scheduled_hosted_job',
  description:
    'Reserve a server-scheduled alert operation using the authoritative tenant and policy.',
  sideEffect: 'write',
  actors: ['worker'],
  input: JobPreparationInputSchema.extend({ tenantId: Id, kind: z.literal('watch-alerts') }),
  output: PreparedJobSchema,
  handler: async (input, ctx) => {
    const tenant = await ctx.repos.tenants.findById(input.tenantId);
    if (tenant === null || tenant.status === 'deleting' || tenant.status === 'deleted')
      return errNotFound('Tenant', input.tenantId);
    return prepareReservedOperation(input, ctx, tenant);
  },
});

export const activateHostedJobTool = definePlatformTool({
  name: 'activate_hosted_job',
  description: 'Queue a preparing operation after its tenant input has been durably persisted.',
  sideEffect: 'write',
  actors: ['user', 'worker'],
  input: z.object({ jobId: Id, inputHash: Digest }).strict(),
  output: HostedJobSchema,
  handler: async (input, ctx) => {
    if (ctx.principal.kind === 'user') {
      const job = await readUserJob(ctx, input.jobId);
      if ('ok' in job) return job;
    }
    return ctx.repos.jobs.activatePreparedJob({
      id: input.jobId,
      inputHash: input.inputHash,
      now: ctx.clock(),
    });
  },
});

export const claimHostedJobTool = definePlatformTool({
  name: 'claim_hosted_job',
  description: 'Fairly claim one durable operation using a new fenced control lease.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({}).strict(),
  output: HostedJobSchema.nullable(),
  handler: async (_input, ctx) => {
    if (ctx.principal.kind !== 'worker') return denied('actor:worker');
    return ctx.repos.jobs.claimJob({
      workerId: ctx.principal.workerId,
      attemptId: randomAuthId(),
      now: ctx.clock(),
      leaseMs: 120_000,
      maxGlobalRunning: 4,
      maxTenantRunning: 1,
    });
  },
});

const FencedJobInput = z
  .object({ jobId: Id, fence: z.number().int().positive().safe(), attemptId: Id })
  .strict();
const fencedInput = (input: z.infer<typeof FencedJobInput>, now: Date) => ({
  id: input.jobId,
  fence: input.fence,
  attemptId: input.attemptId,
  now,
});

export const renewHostedJobLeaseTool = definePlatformTool({
  name: 'renew_hosted_job_lease',
  description: 'Renew a still-valid control lease without changing its fencing identity.',
  sideEffect: 'write',
  actors: ['worker'],
  input: FencedJobInput,
  output: z.object({ renewed: z.boolean() }),
  handler: async (input, ctx) => ({
    renewed: await ctx.repos.jobs.renewJobLease({
      ...fencedInput(input, ctx.clock()),
      leaseMs: 120_000,
    }),
  }),
});

export const completeTenantProvisioningTool = definePlatformTool({
  name: 'complete_tenant_provisioning',
  description: 'Activate the original tenant only after its identity manifest and schema exist.',
  sideEffect: 'write',
  actors: ['worker'],
  input: FencedJobInput.extend({ schemaVersion: z.number().int().nonnegative().safe() }),
  output: TenantSchema,
  handler: (input, ctx) =>
    ctx.repos.jobs.completeProvisioning({
      ...fencedInput(input, ctx.clock()),
      schemaVersion: input.schemaVersion,
    }),
});

export const finishHostedJobTool = definePlatformTool({
  name: 'finish_hosted_job',
  description:
    'Consume one tenant result event, settle its original reservation and create an in-app delivery intent.',
  sideEffect: 'write',
  actors: ['worker'],
  input: FencedJobInput.extend({ event: PlatformResultEventSchema }),
  output: z.object({
    job: HostedJobSchema,
    reservation: UsageReservationSchema.nullable(),
    replayed: z.boolean(),
  }),
  handler: async (input, ctx) => {
    const job = await ctx.repos.jobs.findById(input.jobId);
    if (job === null) return errNotFound('HostedJob', input.jobId);
    const reservation = await ctx.repos.jobs.findReservation(job.operationId);
    const captureUnits =
      reservation === null ? 0 : input.event.status === 'partial' ? 0 : reservation.units;
    const now = ctx.clock();
    const preferences = await ctx.repos.notifications.findPreferences(input.event.tenantId);
    const targets =
      job.errorKind === 'restored-reconciliation'
        ? []
        : (input.event.deliveries ??
          (input.event.notificationPolicy === 'never'
            ? []
            : [
                {
                  businessKey: input.event.businessKey,
                  resultRef: input.event.resultRef,
                  notificationPolicy: input.event.notificationPolicy,
                },
              ]));
    const committedShanghai = new Date(input.event.committedAt.getTime() + 8 * 60 * 60 * 1000);
    const expiresAt =
      job.kind === 'watch-alerts'
        ? new Date(
            Date.UTC(
              committedShanghai.getUTCFullYear(),
              committedShanghai.getUTCMonth(),
              committedShanghai.getUTCDate() + 1,
            ) -
              8 * 60 * 60 * 1000,
          )
        : new Date(input.event.committedAt.getTime() + 86_400_000);
    const deliveries = targets
      .filter((target) => target.notificationPolicy === 'eligible')
      .flatMap((target) => {
        const inApp = DeliveryIntentSchema.parse({
          id: randomAuthId(),
          tenantId: input.event.tenantId,
          generation: input.event.generation,
          businessKey: target.businessKey,
          resultRef: target.resultRef,
          channel: 'in-app',
          bindingVersion: 1,
          state: 'pending',
          attempt: 0,
          attemptId: null,
          providerMessageId: null,
          availableAt: now,
          expiresAt,
          deliveredAt: null,
          errorKind: null,
          createdAt: now,
          updatedAt: now,
        });
        return preferences?.emailEnabled
          ? [
              inApp,
              {
                ...inApp,
                id: randomAuthId(),
                channel: 'email' as const,
                bindingVersion: preferences.bindingVersion,
              },
            ]
          : [inApp];
      });
    return ctx.repos.jobs.finishJobAndSettle({
      ...fencedInput(input, now),
      event: input.event,
      captureUnits,
      deliveries,
    });
  },
});

export const retryHostedJobTool = definePlatformTool({
  name: 'retry_hosted_job',
  description:
    'Reschedule a recoverable operation without discarding its persisted input or reservation.',
  sideEffect: 'write',
  actors: ['worker'],
  input: FencedJobInput.extend({
    availableAt: z.coerce.date(),
    errorKind: z.string().min(1).max(100),
  }),
  output: HostedJobSchema,
  handler: (input, ctx) =>
    ctx.repos.jobs.retryJob({
      ...fencedInput(input, ctx.clock()),
      availableAt: input.availableAt,
      errorKind: input.errorKind,
    }),
});

export const stopHostedJobTool = definePlatformTool({
  name: 'stop_hosted_job',
  description:
    'Record a terminal job outcome and release user quota only after execution has stopped.',
  sideEffect: 'write',
  actors: ['worker'],
  input: FencedJobInput.extend({
    state: z.enum(['failed', 'cancelled', 'needs-review']),
    errorKind: z.string().min(1).max(100),
    executionStopped: z.boolean(),
  }),
  output: HostedJobSchema,
  handler: (input, ctx) =>
    ctx.repos.jobs.stopJob({
      ...fencedInput(input, ctx.clock()),
      state: input.state,
      errorKind: input.errorKind,
      executionStopped: input.executionStopped,
    }),
});

export const getHostedJobTool = definePlatformTool({
  name: 'get_hosted_job',
  description: 'Read one operation owned by the authenticated tenant.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ jobId: Id }).strict(),
  output: HostedJobSchema,
  handler: (input, ctx) => readUserJob(ctx, input.jobId),
});

export const cancelHostedJobTool = definePlatformTool({
  name: 'cancel_hosted_job',
  description: 'Request best-effort cancellation of the current tenant operation.',
  sideEffect: 'write',
  actors: ['user'],
  input: z.object({ jobId: Id }).strict(),
  output: HostedJobSchema,
  handler: async (input, ctx) => {
    const job = await readUserJob(ctx, input.jobId);
    if ('ok' in job) return job;
    return ctx.repos.jobs.requestCancellation({
      id: job.id,
      tenantId: job.tenantId,
      now: ctx.clock(),
    });
  },
});

export const getHostedSubscriptionTool = definePlatformTool({
  name: 'get_hosted_subscription',
  description: 'Read current entitlement and immutable service periods without external refresh.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({}).strict(),
  output: z.object({
    current: z
      .object({
        period: SubscriptionPeriodSchema,
        plan: PlanVersionSchema,
        capturedUnits: z.number(),
        heldUnits: z.number(),
        availableUnits: z.number(),
      })
      .nullable(),
    periods: z.array(SubscriptionPeriodSchema),
    plans: z.array(PlanVersionSchema),
  }),
  handler: async (_input, ctx) => {
    const tenant = await readUserTenant(ctx);
    if ('ok' in tenant) return tenant;
    const current = await ctx.repos.subscriptions.currentEntitlement({
      tenantId: tenant.id,
      now: ctx.clock(),
    });
    return {
      current,
      periods: [...(await ctx.repos.subscriptions.listPeriods(tenant.id))],
      plans: [...(await ctx.repos.subscriptions.listPlans())],
    };
  },
});

export const getHostedUsageTool = definePlatformTool({
  name: 'get_hosted_usage',
  description: 'Read the current tenant quota ledger and outstanding reservations.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ periodId: Id.optional() }).strict(),
  output: z.object({ entries: z.array(UsageEntrySchema) }),
  handler: async (input, ctx) => {
    const tenant = await readUserTenant(ctx);
    if ('ok' in tenant) return tenant;
    return {
      entries: [
        ...(await ctx.repos.jobs.listUsage({
          tenantId: tenant.id,
          ...(input.periodId === undefined ? {} : { periodId: input.periodId }),
        })),
      ],
    };
  },
});

export const recordHostedProviderAttemptTool = definePlatformTool({
  name: 'record_hosted_provider_attempt',
  description:
    'Persist observed provider costs while keeping unknown usage distinct from confirmed zero.',
  sideEffect: 'write',
  actors: ['worker'],
  input: ProviderAttemptSchema,
  output: ProviderAttemptSchema,
  handler: async (input, ctx) => {
    if ((await ctx.repos.jobs.findByOperation(input.operationId)) === null)
      return errNotFound('HostedOperation', input.operationId);
    await ctx.repos.jobs.saveProviderAttempt(input);
    return input;
  },
});

export const publishHostedPlanTool = definePlatformTool({
  name: 'publish_hosted_plan',
  description: 'Publish the immutable operator-provided plan version.',
  sideEffect: 'write',
  actors: ['worker'],
  input: PlanVersionSchema,
  output: PlanVersionSchema,
  handler: async (input, ctx) => {
    await ctx.repos.subscriptions.publishPlan(input);
    return input;
  },
});

export const grantHostedTrialTool = definePlatformTool({
  name: 'grant_hosted_trial',
  description: 'Idempotently initialize a single trial for the original provisioning tenant.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z
    .object({ tenantId: Id, planVersionId: Id, days: z.number().int().min(1).max(30).default(7) })
    .strict(),
  output: SubscriptionPeriodSchema,
  handler: async (input, ctx) => {
    const previous = (await ctx.repos.subscriptions.listPeriods(input.tenantId)).find(
      (period) => period.status === 'trial',
    );
    if (previous !== undefined) {
      if (previous.planVersionId !== input.planVersionId)
        return errInvalidInput('trial_plan_conflict');
      return previous;
    }
    const now = ctx.clock();
    const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const period = SubscriptionPeriodSchema.parse({
      id: `trial:${input.tenantId}`,
      tenantId: input.tenantId,
      planVersionId: input.planVersionId,
      startsAt: now,
      endsAt: new Date(now.getTime() + input.days * 86_400_000),
      anchorDay: shanghaiNow.getUTCDate(),
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    });
    return ctx.repos.subscriptions.grantTrial({ period, now });
  },
});

export const getWorkerTenantTool = definePlatformTool({
  name: 'get_worker_tenant',
  description: 'Read the authoritative tenant generation before a worker touches its runtime.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ tenantId: Id }).strict(),
  output: TenantSchema,
  handler: async (input, ctx) =>
    (await ctx.repos.tenants.findById(input.tenantId)) ?? errNotFound('Tenant', input.tenantId),
});

export const findHostedJobRequestTool = definePlatformTool({
  name: 'find_hosted_job_request',
  description: 'Find a previous durable request inside the authenticated tenant.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ requestId: Id }).strict(),
  output: HostedJobSchema.nullable(),
  handler: async (input, ctx) => {
    const tenant = await readUserTenant(ctx);
    if ('ok' in tenant) return tenant;
    return ctx.repos.jobs.findByRequest({ tenantId: tenant.id, requestId: input.requestId });
  },
});

export const listPreparingHostedJobsTool = definePlatformTool({
  name: 'list_preparing_hosted_jobs',
  description: 'List durable preparing jobs for reconciliation with tenant execution requests.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({}).strict(),
  output: z.array(HostedJobSchema),
  handler: async (_input, ctx) => [...(await ctx.repos.jobs.list({ states: ['preparing'] }))],
});

export const getWorkerHostedJobTool = definePlatformTool({
  name: 'get_worker_hosted_job',
  description: 'Read the authoritative job lease, cancellation and original budget for a worker.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ jobId: Id }).strict(),
  output: z.object({ job: HostedJobSchema, reservation: UsageReservationSchema.nullable() }),
  handler: async (input, ctx) => {
    const job = await ctx.repos.jobs.findById(input.jobId);
    if (job === null) return errNotFound('HostedJob', input.jobId);
    return { job, reservation: await ctx.repos.jobs.findReservation(job.operationId) };
  },
});

export const cancelPreparingHostedJobTool = definePlatformTool({
  name: 'cancel_preparing_hosted_job',
  description: 'Cancel an unstarted job whose durable input preparation cannot be completed.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ jobId: Id, reason: z.string().min(1).max(100) }).strict(),
  output: HostedJobSchema,
  handler: (input, ctx) =>
    ctx.repos.jobs.cancelPendingJob({ id: input.jobId, reason: input.reason, now: ctx.clock() }),
});

export const claimHostedJobForReconciliationTool = definePlatformTool({
  name: 'claim_hosted_job_for_reconciliation',
  description: 'Fence an attempted operation solely to reconcile its persisted tenant receipt.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ jobId: Id }).strict(),
  output: HostedJobSchema.nullable(),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'worker') return denied('actor:worker');
    return ctx.repos.jobs.claimJobForReconciliation({
      id: input.jobId,
      workerId: ctx.principal.workerId,
      attemptId: randomAuthId(),
      now: ctx.clock(),
      leaseMs: 120_000,
    });
  },
});

export const platformJobTools = [
  prepareHostedJobTool,
  prepareScheduledHostedJobTool,
  activateHostedJobTool,
  claimHostedJobTool,
  renewHostedJobLeaseTool,
  completeTenantProvisioningTool,
  finishHostedJobTool,
  retryHostedJobTool,
  stopHostedJobTool,
  getHostedJobTool,
  cancelHostedJobTool,
  getHostedSubscriptionTool,
  getHostedUsageTool,
  recordHostedProviderAttemptTool,
  publishHostedPlanTool,
  grantHostedTrialTool,
  getWorkerTenantTool,
  findHostedJobRequestTool,
  listPreparingHostedJobsTool,
  getWorkerHostedJobTool,
  cancelPreparingHostedJobTool,
  claimHostedJobForReconciliationTool,
] as const;
