import type { ToolResult } from '@luoome/core';
import { buildContext } from '@luoome/tools';
import {
  authorizeHostedWebRequest,
  contextForHostedWebTools,
  type HostedInvocation,
} from '@luoome/tools/hosted';
import {
  getWorkerHostedEntitlementTool,
  getWorkerTenantTool,
  listWorkerHostedTenantsTool,
} from '@luoome/tools/platform';
import { hostedStrategyWorkflow } from '@luoome/workflows';
import type { HostedService } from '../../web/src/hosted-composition.js';
import { bindHostedDefaultAccount } from '../../web/src/hosted-context.js';

const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
};
export const runHostedStrategyPass = async (
  service: HostedService,
  workerId: string,
  stopped: () => boolean = () => false,
  abortSignal?: AbortSignal,
) => {
  const summary = { tenants: 0, acquired: 0, runs: 0, completedObservations: 0 };
  if (
    !service.config.exposeWrite ||
    !service.config.exposeExternal ||
    service.config.productPolicyVersion !== 'hosted-web-v2'
  )
    return summary;
  service.providers.syncMarketSettings?.();
  const activity = service.maintenance.enter('worker-strategy');
  if (activity === null) return summary;
  const platform = service.platformContext({
    kind: 'worker',
    workerId,
    requestId: crypto.randomUUID(),
  });
  try {
    for (const tenant of data(await listWorkerHostedTenantsTool.execute({}, platform))) {
      if (stopped() || abortSignal?.aborted) break;
      if (tenant.status !== 'active') continue;
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
              name: 'strategy-facts',
              generate: async () => {
                throw new Error('Strategy 洞察保留事实降级');
              },
            },
          },
          user: { id: tenant.ownerUserId, defaultAccountId: '' },
          clock: service.clock,
        });
        const entitlement = data(
          await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform),
        );
        const entitlementRequired = service.config.entitlementRequired;
        const entitled = entitlement !== null || !entitlementRequired;
        const invocation: HostedInvocation = {
          context: entitled
            ? await bindHostedDefaultAccount(base, service.providers.createTenantContext)
            : base,
          identity,
          entitlement: null,
          entitlementRequired,
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
        if (!entitled || (await authorizeHostedWebRequest(invocation, true)) !== null) {
          continue;
        }
        const result = await hostedStrategyWorkflow.run(
          {},
          {
            ...contextForHostedWebTools(invocation),
            ...(abortSignal === undefined ? {} : { abortSignal }),
          },
        );
        summary.tenants += 1;
        if (result.ok) {
          summary.acquired += Number(result.data.acquired);
          summary.runs +=
            result.data.cycle?.items.filter((item) => item.runId !== undefined).length ?? 0;
          summary.completedObservations += result.data.completedObservations;
        } else console.warn('hosted strategy tenant pass failed', { kind: result.error.kind });
      } catch (error) {
        console.warn('hosted strategy tenant pass failed', {
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
