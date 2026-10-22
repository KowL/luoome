import type {
  HostedEntitlement,
  HostedExecutionIdentity,
  SideEffect,
  Tenant,
  ToolContext,
  ToolResult,
  WatchlistMemberSource,
} from '@luoome/core';
import { z } from 'zod';
import { errInvalidInput, errNotFound, type Tool } from '../define-tool.js';
import {
  CommitWatchlistImportInput,
  commitWatchlistImportTool,
  ListPersonalAlertPlansInput,
  ListPersonalWatchFeedbackInput,
  listPersonalAlertPlansTool,
  listPersonalWatchFeedbackTool,
  PreviewPersonalAlertPlanInput,
  PreviewWatchlistImportInput,
  pausePersonalAlertPlanTool,
  previewPersonalAlertPlanTool,
  previewWatchlistImportTool,
  RecordPersonalWatchFeedbackInput,
  RemovePersonalAlertPlanInput,
  RemovePersonalWatchlistMembersInput,
  recordPersonalWatchFeedbackTool,
  removePersonalAlertPlanTool,
  removePersonalWatchlistMembersTool,
  SavePersonalAlertPlanInput,
  savePersonalAlertPlanTool,
} from '../tools/hosted-tenant.js';
import {
  createWatchlistTool,
  getWatchlistTool,
  listWatchlistsTool,
  updateWatchlistTool,
} from '../tools/watchlist.js';
import {
  getHostedFactsReportTool,
  getPersonalWatchTriggerTool,
  listHostedFactsReportsTool,
  listPersonalWatchTriggersTool,
  selectHostedAccountTool,
} from './read.js';

export interface HostedInvocation {
  readonly context: ToolContext;
  readonly identity: HostedExecutionIdentity;
  readonly entitlement: HostedEntitlement | null;
  readonly capabilities: { readonly write: boolean; readonly external: boolean };
  readonly currentTenant: () => Promise<Tenant | null>;
  readonly currentEntitlement?: () => Promise<HostedEntitlement | null>;
  readonly currentReadWindow?: () => Promise<boolean>;
  readonly acceptedOperation?: { readonly deadlineAt: Date; readonly operationId: string };
  /** 订阅流程未开放时运营方可显式关闭权益门禁；缺省保持要求有效服务期。 */
  readonly entitlementRequired?: boolean;
}

const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export const authorizeHostedInvocation = async (
  invocation: HostedInvocation,
  capabilities: readonly SideEffect[],
  paid: boolean,
): Promise<ToolResult<never> | null> => {
  const { context, identity } = invocation;
  if (
    context.identity?.mode !== 'hosted' ||
    context.identity.tenantId !== identity.tenantId ||
    context.identity.tenantGeneration !== identity.tenantGeneration ||
    context.identity.userId !== identity.userId ||
    context.user.id !== identity.userId
  )
    return denied('hosted:trusted-identity');
  const tenant = await invocation.currentTenant();
  if (tenant === null || tenant.ownerUserId !== identity.userId) {
    return errNotFound('Tenant', identity.tenantId);
  }
  if (
    tenant.generation !== identity.tenantGeneration ||
    (tenant.status !== 'active' && !(tenant.status === 'suspended' && !paid))
  )
    return denied('hosted:tenant-active');
  if (capabilities.includes('trade')) {
    return denied('hosted-facts-v1');
  }
  for (const capability of capabilities) {
    if (
      (capability === 'write' || capability === 'external') &&
      !invocation.capabilities[capability]
    ) {
      return denied(`capability:${capability}`);
    }
  }
  const now = context.clock();
  const entitlementRequired = invocation.entitlementRequired ?? true;
  if (
    entitlementRequired &&
    !paid &&
    identity.actor === 'user' &&
    invocation.currentReadWindow !== undefined &&
    !(await invocation.currentReadWindow())
  )
    return denied('entitlement:read-window-expired');
  const entitlement =
    invocation.currentEntitlement === undefined
      ? invocation.entitlement
      : await invocation.currentEntitlement();
  const accepted =
    identity.actor === 'worker' &&
    invocation.acceptedOperation !== undefined &&
    identity.operationId === invocation.acceptedOperation.operationId &&
    invocation.acceptedOperation.deadlineAt > now;
  if (
    entitlementRequired &&
    paid &&
    !accepted &&
    (entitlement === null ||
      entitlement.period.tenantId !== tenant.id ||
      !['hosted-facts-v1', 'hosted-web-v2'].includes(entitlement.plan.productPolicyVersion) ||
      entitlement.period.startsAt > now ||
      entitlement.period.endsAt <= now ||
      !['trial', 'paid'].includes(entitlement.period.status))
  )
    return denied('entitlement:hosted-facts-v1');
  return null;
};

export const contextForHostedTools = (
  invocation: HostedInvocation,
  allowedToolNames: ReadonlySet<string>,
  paid: boolean,
): ToolContext => ({
  ...invocation.context,
  hostedAuthorization: async (name, _input, capabilities) => {
    if (!allowedToolNames.has(name)) return denied('hosted-operation');
    return authorizeHostedInvocation(invocation, capabilities, paid);
  },
});

const Id = z.string().min(1).max(160);
const WatchlistListInput = z.object({}).strict();
const WatchlistGetInput = z.object({ watchlistId: Id }).strict();
const WatchlistCreateInput = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(1000).optional(),
  })
  .strict();
const WatchlistUpdateInput = z
  .object({
    watchlistId: Id,
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const sourceDto = (source: WatchlistMemberSource) => ({
  kind: source.kind,
  status: source.status,
  validFrom: source.validFrom,
  ...(source.validUntil === undefined ? {} : { validUntil: source.validUntil }),
  ...(['manual', 'import'].includes(source.kind) ? { reason: source.reason } : {}),
});

const executeAllowed = async <O>(
  tool: Tool<unknown, O>,
  input: unknown,
  invocation: HostedInvocation,
  paid: boolean,
): Promise<ToolResult<O>> => {
  const authorization = await authorizeHostedInvocation(
    invocation,
    tool.requiredCapabilities,
    paid,
  );
  if (authorization !== null) return authorization;
  return tool.execute(input, contextForHostedTools(invocation, new Set([tool.name]), paid));
};

export const invokeHostedOperation = async (
  operation: string,
  input: unknown,
  invocation: HostedInvocation,
): Promise<ToolResult<unknown>> => {
  try {
    switch (operation) {
      case 'watchlist.list': {
        WatchlistListInput.parse(input);
        const result = await executeAllowed(
          listWatchlistsTool,
          { kind: 'personal' },
          invocation,
          false,
        );
        if (!result.ok) return result;
        return { ok: true, data: result.data };
      }
      case 'watchlist.get': {
        const parsed = WatchlistGetInput.parse(input);
        const result = await executeAllowed(getWatchlistTool, parsed, invocation, false);
        if (!result.ok) return result;
        if (result.data.watchlist.kind !== 'personal')
          return errNotFound('Watchlist', parsed.watchlistId);
        return {
          ok: true,
          data: {
            watchlist: result.data.watchlist,
            members: result.data.members.map(({ member, sources }) => ({
              member,
              sources: sources.map(sourceDto),
            })),
          },
        };
      }
      case 'watchlist.create': {
        const parsed = WatchlistCreateInput.parse(input);
        return executeAllowed(
          createWatchlistTool,
          {
            ...parsed,
            kind: 'personal',
            membershipPolicy: 'mixed',
            enabled: true,
          },
          invocation,
          true,
        );
      }
      case 'watchlist.update': {
        const parsed = WatchlistUpdateInput.parse(input);
        const found = await executeAllowed(
          getWatchlistTool,
          { watchlistId: parsed.watchlistId },
          invocation,
          false,
        );
        if (!found.ok) return found;
        if (found.data.watchlist.kind !== 'personal')
          return errNotFound('Watchlist', parsed.watchlistId);
        return executeAllowed(updateWatchlistTool, parsed, invocation, true);
      }
      case 'account.select':
        return executeAllowed(selectHostedAccountTool, input, invocation, false);
      case 'watchlist.import.preview':
        return executeAllowed(
          previewWatchlistImportTool,
          PreviewWatchlistImportInput.strict().parse(input),
          invocation,
          true,
        );
      case 'watchlist.import.commit': {
        const parsed = CommitWatchlistImportInput.omit({ maxDistinctStocks: true })
          .strict()
          .parse(input);
        const entitlement =
          invocation.currentEntitlement === undefined
            ? invocation.entitlement
            : await invocation.currentEntitlement();
        if (entitlement === null) return denied('entitlement:hosted-facts-v1');
        return executeAllowed(
          commitWatchlistImportTool,
          {
            ...parsed,
            maxDistinctStocks: entitlement.plan.limits.watchlistStocks,
          },
          invocation,
          true,
        );
      }
      case 'watchlist.members.remove':
        return executeAllowed(
          removePersonalWatchlistMembersTool,
          RemovePersonalWatchlistMembersInput.strict().parse(input),
          invocation,
          true,
        );
      case 'feedback.record':
        return executeAllowed(
          recordPersonalWatchFeedbackTool,
          RecordPersonalWatchFeedbackInput.strict().parse(input),
          invocation,
          false,
        );
      case 'feedback.list':
        return executeAllowed(
          listPersonalWatchFeedbackTool,
          ListPersonalWatchFeedbackInput.strict().parse(input),
          invocation,
          false,
        );
      case 'alert.list':
        return executeAllowed(
          listPersonalAlertPlansTool,
          ListPersonalAlertPlansInput.strict().parse(input),
          invocation,
          false,
        );
      case 'alert.preview':
        return executeAllowed(
          previewPersonalAlertPlanTool,
          PreviewPersonalAlertPlanInput.strict().parse(input),
          invocation,
          true,
        );
      case 'alert.save': {
        const parsed = SavePersonalAlertPlanInput.omit({
          maxEnabledRules: true,
          maxDailyNotifications: true,
          minCooldownMinutes: true,
        })
          .strict()
          .parse(input);
        const entitlement =
          invocation.currentEntitlement === undefined
            ? invocation.entitlement
            : await invocation.currentEntitlement();
        if (entitlement === null) return denied('entitlement:hosted-facts-v1');
        return executeAllowed(
          savePersonalAlertPlanTool,
          {
            ...parsed,
            maxEnabledRules: entitlement.plan.limits.enabledRules,
            maxDailyNotifications: 20,
            minCooldownMinutes: 15,
          },
          invocation,
          true,
        );
      }
      case 'alert.remove':
        return executeAllowed(
          removePersonalAlertPlanTool,
          RemovePersonalAlertPlanInput.strict().parse(input),
          invocation,
          false,
        );
      case 'alert.pause':
        return executeAllowed(
          pausePersonalAlertPlanTool,
          RemovePersonalAlertPlanInput.strict().parse(input),
          invocation,
          false,
        );
      case 'report.watchlist-facts.get':
        return executeAllowed(getHostedFactsReportTool, input, invocation, false);
      case 'report.watchlist-facts.list':
        return executeAllowed(listHostedFactsReportsTool, input, invocation, false);
      case 'trigger.list':
        return executeAllowed(listPersonalWatchTriggersTool, input, invocation, false);
      case 'trigger.get':
        return executeAllowed(getPersonalWatchTriggerTool, input, invocation, false);
      default:
        return denied('hosted-facts-v1:operation');
    }
  } catch (error) {
    if (error instanceof z.ZodError) return errInvalidInput('hosted operation input is invalid');
    return { ok: false, error: { kind: 'internal', cause: 'hosted operation failed' } };
  }
};
