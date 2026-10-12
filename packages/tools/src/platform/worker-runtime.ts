import {
  DeliveryIntentSchema,
  HostedJobSchema,
  isHostedJobTerminal,
  PlanVersionSchema,
  ProviderAttemptSchema,
  SubscriptionPeriodSchema,
  TenantSchema,
  TenantTombstoneSchema,
} from '@luoome/core';
import { z } from 'zod';
import { definePlatformTool } from './define-platform-tool.js';

export const listWorkerHostedTenantsTool = definePlatformTool({
  name: 'list_worker_hosted_tenants',
  description: 'Enumerate opaque tenant identities for worker reconciliation and scheduling.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({}).strict(),
  output: z.array(TenantSchema),
  handler: async (_input, ctx) =>
    [...(await ctx.repos.tenants.list())].filter((tenant) => tenant.status !== 'deleted'),
});
export const getWorkerHostedEntitlementTool = definePlatformTool({
  name: 'get_worker_hosted_entitlement',
  description: 'Read current server entitlement before scheduling new work.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ tenantId: z.string().min(1) }).strict(),
  output: z
    .object({
      period: SubscriptionPeriodSchema,
      plan: PlanVersionSchema,
      capturedUnits: z.number(),
      heldUnits: z.number(),
      availableUnits: z.number(),
    })
    .nullable(),
  handler: (input, ctx) =>
    ctx.repos.subscriptions.currentEntitlement({ tenantId: input.tenantId, now: ctx.clock() }),
});
export const getWorkerHostedOperationTool = definePlatformTool({
  name: 'get_worker_hosted_operation',
  description: 'Resolve a durable operation for receipt-only recovery.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ operationId: z.string().min(1) }).strict(),
  output: HostedJobSchema.nullable(),
  handler: (input, ctx) => ctx.repos.jobs.findByOperation(input.operationId),
});
export const findWorkerHostedJobRequestTool = definePlatformTool({
  name: 'find_worker_hosted_job_request',
  description: 'Read the original scheduled request without freezing changed tenant input again.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ tenantId: z.string().min(1), requestId: z.string().min(1).max(160) }).strict(),
  output: HostedJobSchema.nullable(),
  handler: (input, ctx) => ctx.repos.jobs.findByRequest(input),
});
export const listWorkerHostedJobsTool = definePlatformTool({
  name: 'list_worker_hosted_jobs',
  description: 'Read opaque jobs for a trusted tenant drain or recovery.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ tenantId: z.string().min(1) }).strict(),
  output: z.array(HostedJobSchema),
  handler: async (input, ctx) => [...(await ctx.repos.jobs.list({ tenantId: input.tenantId }))],
});
export const listWorkerHostedDeliveriesTool = definePlatformTool({
  name: 'list_worker_hosted_deliveries',
  description: 'Read delivery metadata for a trusted tenant drain or recovery.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ tenantId: z.string().min(1) }).strict(),
  output: z.array(DeliveryIntentSchema),
  handler: async (input, ctx) => [...(await ctx.repos.deliveries.list(input.tenantId))],
});
export const listWorkerHostedProviderAttemptsTool = definePlatformTool({
  name: 'list_worker_hosted_provider_attempts',
  description:
    'Keep uncertain provider costs visible before deciding whether to repeat a paid step.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ operationId: z.string().min(1) }).strict(),
  output: z.array(ProviderAttemptSchema),
  handler: async (input, ctx) => [
    ...(await ctx.repos.jobs.listProviderAttempts(input.operationId)),
  ],
});
export const prepareHostedRecoveryTool = definePlatformTool({
  name: 'prepare_hosted_recovery',
  description: '在已经停写的恢复目录撤销凭证、失效旧执行并应用独立删除记录',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ tombstones: z.array(TenantTombstoneSchema).max(10000) }).strict(),
  output: z.object({
    revokedSessions: z.number(),
    invalidatedChallenges: z.number(),
    fencedJobs: z.number(),
    suppressedDeliveries: z.number(),
    unknownDeliveries: z.number(),
    appliedTombstones: z.number(),
  }),
  handler: (input, ctx) => ctx.repos.recovery.prepareRestore({ ...input, now: ctx.clock() }),
});
export const getHostedRecoverySummaryTool = definePlatformTool({
  name: 'get_hosted_recovery_summary',
  description: '只返回可信运营入口需要的积压计数，不包含邮件、投资正文或私人对象引用',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({}).strict(),
  output: z.object({
    pendingJobs: z.number(),
    unknownCosts: z.number(),
    pendingPayments: z.number(),
    unknownDeliveries: z.number(),
    pendingDeletions: z.number(),
  }),
  handler: async (_input, ctx) => {
    const result = {
      pendingJobs: 0,
      unknownCosts: 0,
      pendingPayments: 0,
      unknownDeliveries: 0,
      pendingDeletions: 0,
    };
    for (const tenant of await ctx.repos.tenants.list()) {
      const jobs = await ctx.repos.jobs.list({ tenantId: tenant.id });
      result.pendingJobs += jobs.filter((job) => !isHostedJobTerminal(job.state)).length;
      for (const job of jobs)
        result.unknownCosts += (await ctx.repos.jobs.listProviderAttempts(job.operationId)).filter(
          (entry) => entry.usageState === 'unknown',
        ).length;
      for (const order of await ctx.repos.payments.listOrders(tenant.id)) {
        if (['created', 'pending'].includes(order.state) || order.reconciliation !== 'none')
          result.pendingPayments++;
        result.pendingPayments += (await ctx.repos.payments.listRefunds(order.id)).filter(
          (refund) => ['reserved', 'submitted', 'processing', 'unknown'].includes(refund.state),
        ).length;
      }
      result.unknownDeliveries += (await ctx.repos.deliveries.list(tenant.id)).filter((delivery) =>
        ['sending', 'unknown'].includes(delivery.state),
      ).length;
    }
    result.pendingPayments += (await ctx.repos.payments.listEvents({})).filter((event) =>
      ['pending', 'needs-review'].includes(event.disposition),
    ).length;
    result.pendingDeletions = (
      await ctx.repos.privacy.listDeletions({ states: ['draining', 'needs-review'] })
    ).length;
    return result;
  },
});
export const workerRuntimeTools = [
  listWorkerHostedTenantsTool,
  getWorkerHostedEntitlementTool,
  getWorkerHostedOperationTool,
  findWorkerHostedJobRequestTool,
  listWorkerHostedJobsTool,
  listWorkerHostedDeliveriesTool,
  listWorkerHostedProviderAttemptsTool,
  prepareHostedRecoveryTool,
  getHostedRecoverySummaryTool,
] as const;
