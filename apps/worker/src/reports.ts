import type { ToolResult } from '@luoome/core';
import { buildContext } from '@luoome/tools';
import {
  authorizeHostedWebRequest,
  contextForHostedTools,
  contextForHostedWebTools,
  type HostedInvocation,
  suppressHostedReportDeliveriesTool,
} from '@luoome/tools/hosted';
import {
  getWorkerHostedEntitlementTool,
  getWorkerTenantTool,
  listWorkerHostedTenantsTool,
} from '@luoome/tools/platform';
import { hostedReportsWorkflow } from '@luoome/workflows';
import type { HostedService } from '../../web/src/hosted-composition.js';
import { bindHostedDefaultAccount } from '../../web/src/hosted-context.js';

const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
};
export const runHostedReportPass = async (
  service: HostedService,
  workerId: string,
  stopped: () => boolean = () => false,
) => {
  const summary = { tenants: 0, created: 0, accepted: 0, waiting: 0 };
  if (
    !service.config.exposeWrite ||
    !service.config.exposeExternal ||
    service.config.productPolicyVersion !== 'hosted-web-v2'
  )
    return summary;
  const activity = service.maintenance.enter('worker-reports');
  if (activity === null) return summary;
  const platform = service.platformContext({
    kind: 'worker',
    workerId,
    requestId: crypto.randomUUID(),
  });
  try {
    for (const tenant of data(await listWorkerHostedTenantsTool.execute({}, platform))) {
      if (stopped()) break;
      if (!['active', 'suspended'].includes(tenant.status)) continue;
      let lease: ReturnType<HostedService['runtimes']['acquire']>;
      try {
        lease = service.runtimes.acquire({
          tenantId: tenant.id,
          ownerUserId: tenant.ownerUserId,
          generation: tenant.generation,
          schemaVersion: tenant.schemaVersion,
        });
      } catch {
        continue;
      }
      try {
        const identity = Object.freeze({
          mode: 'hosted' as const,
          actor: 'worker' as const,
          userId: tenant.ownerUserId,
          tenantId: tenant.id,
          tenantGeneration: tenant.generation,
          requestId: crypto.randomUUID(),
        });
        const base = buildContext({
          mode: 'hosted',
          identity,
          repos: lease.runtime.repos,
          adapters: {
            market: service.providers.market,
            llm: {
              name: 'report-facts',
              generate: async () => {
                throw new Error('报告只汇总已有事实');
              },
            },
          },
          user: { id: tenant.ownerUserId, defaultAccountId: '' },
          clock: service.clock,
        });
        const entitlement = data(
          await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform),
        );
        const invocation: HostedInvocation = {
          context:
            tenant.status === 'active' && entitlement !== null
              ? await bindHostedDefaultAccount(base, service.providers.createTenantContext)
              : base,
          identity,
          entitlement: null,
          capabilities: {
            write: service.config.exposeWrite,
            external: service.config.exposeExternal,
          },
          currentTenant: async () => {
            const result = await getWorkerTenantTool.execute({ tenantId: tenant.id }, platform);
            return result.ok ? result.data : null;
          },
          currentEntitlement: async () =>
            data(await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform)),
        };
        if (
          tenant.status !== 'active' ||
          entitlement === null ||
          (await authorizeHostedWebRequest(invocation, true)) !== null
        ) {
          await suppressHostedReportDeliveriesTool.execute(
            {},
            contextForHostedTools(
              invocation,
              new Set([suppressHostedReportDeliveriesTool.name]),
              false,
            ),
          );
          continue;
        }
        const result = await hostedReportsWorkflow.run({}, contextForHostedWebTools(invocation));
        summary.tenants += 1;
        if (result.ok) {
          summary.created += result.data.created.length;
          summary.accepted += result.data.accepted.length;
          summary.waiting += result.data.waiting.length;
        } else console.warn('hosted report tenant pass failed', { kind: result.error.kind });
      } catch (error) {
        console.warn('hosted report tenant pass failed', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
      } finally {
        lease.release();
      }
    }
  } finally {
    activity.release();
  }
  return summary;
};
