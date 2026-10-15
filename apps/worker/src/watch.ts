import {
  dateInShanghai,
  isAshareTradingSession,
  isHoliday,
  isWeekend,
  type ToolResult,
} from '@luoome/core';
import { buildContext, recordWatchRunTool } from '@luoome/tools';
import {
  authorizeHostedWebRequest,
  claimHostedWatchTickTool,
  contextForHostedTools,
  contextForHostedWebTools,
  finishHostedWatchTickTool,
  type HostedInvocation,
  suppressHostedWatchDeliveriesTool,
} from '@luoome/tools/hosted';
import {
  getWorkerHostedEntitlementTool,
  getWorkerTenantTool,
  listWorkerHostedTenantsTool,
} from '@luoome/tools/platform';
import { evaluateEventRulesWorkflow, intradayWatchWorkflow } from '@luoome/workflows';
import type { HostedService } from '../../web/src/hosted-composition.js';
import { bindHostedDefaultAccount } from '../../web/src/hosted-context.js';

const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
};

export const runHostedWatchPass = async (
  service: HostedService,
  workerId: string,
  stopped: () => boolean = () => false,
): Promise<{ tenants: number; ticks: number; quoteBatches: number }> => {
  const summary = { tenants: 0, ticks: 0, quoteBatches: 0 };
  if (
    !service.config.exposeWrite ||
    !service.config.exposeExternal ||
    service.config.productPolicyVersion !== 'hosted-web-v2'
  )
    return summary;
  const activity = service.maintenance.enter('worker-watch');
  if (activity === null) return summary;
  const platform = service.platformContext({
    kind: 'worker',
    workerId,
    requestId: crypto.randomUUID(),
  });
  try {
    const tenants = data(await listWorkerHostedTenantsTool.execute({}, platform));
    for (const tenant of tenants) {
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
              name: 'watch-no-ai',
              generate: async () => {
                throw new Error('预警不调用 AI');
              },
            },
          },
          user: { id: tenant.ownerUserId, defaultAccountId: '' },
          clock: service.clock,
        });
        const entitlement = data(
          await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform),
        );
        if (tenant.status !== 'active' || entitlement === null) {
          const cleanupInvocation: HostedInvocation = {
            context: base,
            identity,
            entitlement: null,
            capabilities: { write: true, external: true },
            currentTenant: async () =>
              data(await getWorkerTenantTool.execute({ tenantId: tenant.id }, platform)),
          };
          await suppressHostedWatchDeliveriesTool.execute(
            {},
            contextForHostedTools(
              cleanupInvocation,
              new Set([suppressHostedWatchDeliveriesTool.name]),
              false,
            ),
          );
          continue;
        }
        const context = await bindHostedDefaultAccount(base, service.providers.createTenantContext);
        const invocation: HostedInvocation = {
          context,
          identity,
          entitlement: null,
          capabilities: {
            write: service.config.exposeWrite,
            external: service.config.exposeExternal,
          },
          currentTenant: async () => {
            const current = await getWorkerTenantTool.execute({ tenantId: tenant.id }, platform);
            return current.ok ? current.data : null;
          },
          currentEntitlement: async () =>
            data(await getWorkerHostedEntitlementTool.execute({ tenantId: tenant.id }, platform)),
        };
        if ((await authorizeHostedWebRequest(invocation, true)) !== null) {
          const cleanup = contextForHostedTools(
            invocation,
            new Set([suppressHostedWatchDeliveriesTool.name]),
            false,
          );
          await suppressHostedWatchDeliveriesTool.execute({}, cleanup);
          continue;
        }
        const now = service.clock();
        const intraday = isAshareTradingSession(now);
        const day = dateInShanghai(now);
        const events =
          !isWeekend(now) &&
          !isHoliday(now) &&
          now >= new Date(`${day}T08:50:00+08:00`) &&
          now < new Date(`${day}T15:00:00+08:00`);
        if (!intraday && !events) continue;
        const ctx = contextForHostedWebTools(invocation);
        summary.tenants += 1;
        const run = data(await claimHostedWatchTickTool.execute({}, ctx));
        if (run === null) continue;
        const outputs: Record<string, unknown> = {};
        let status: 'succeeded' | 'partial' | 'failed' = 'succeeded';
        if (intraday && !stopped()) {
          const result = await intradayWatchWorkflow.run({ notify: true }, ctx);
          summary.ticks += 1;
          if (result.ok) {
            const scan = result.data;
            outputs.intraday = scan;
            summary.quoteBatches += scan.quoteBatches;
            if (scan.notifyFailed > 0) status = 'partial';
            await recordWatchRunTool.execute(
              {
                id: run.id,
                mode: 'daemon',
                status: 'succeeded',
                startedAt: run.startedAt,
                finishedAt: service.clock(),
                evaluatedPools: scan.evaluatedPlans,
                evaluatedStocks: scan.evaluatedStocks,
                triggered: scan.triggers.length,
                notified: scan.notified,
                delivered: scan.delivered,
                unknownRules: scan.unknownRules,
                suppressedByCooldown: scan.suppressedByCooldown,
                suppressedByDailyLimit: scan.suppressedByDailyLimit,
                notifyFailed: scan.notifyFailed,
              },
              ctx,
            );
          } else {
            status = 'failed';
            outputs.intradayError = result.error.kind;
          }
        }
        if (events && !stopped()) {
          const result = await evaluateEventRulesWorkflow.run(
            { mode: 'daemon', dryRun: false },
            ctx,
          );
          summary.ticks += 1;
          if (result.ok) {
            outputs.events = result.data;
            if (result.data.status === 'failed') status = 'failed';
            else if (result.data.status === 'partial' && status === 'succeeded') status = 'partial';
          } else {
            status = 'failed';
            outputs.eventError = result.error.kind;
          }
        }
        data(
          await finishHostedWatchTickTool.execute(
            {
              run: {
                ...run,
                status,
                finishedAt: service.clock(),
                outputSummary: outputs,
                ...(status === 'failed' ? { error: 'watch evaluation failed' } : {}),
              },
              claimToken: run.inputSummary?.claimToken,
            },
            ctx,
          ),
        );
      } catch (error) {
        console.warn('hosted watch tenant pass failed', {
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
