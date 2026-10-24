import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { PluginAutomationGrantSchema } from '@luoome/core';
import type { PluginPrincipal } from '@luoome/tools';
import { createPluginOperationService } from '@luoome/tools';
import { z } from 'zod';
import { createDshIdentity, dshScheduleHash } from './dsh-identity.js';
import { createScheduledOperationInvoker } from './operations.js';
import { toolResultJsonSchema } from './tools.js';

export const MANUAL_OPERATION_TOOL = 'luoome_confirmed_operation';
export const SCHEDULED_OPERATION_TOOL = 'luoome_scheduled_operation';
const manualInput = z
  .object({ id: z.uuid(), tool: z.string().min(1).max(120), input: z.unknown() })
  .strict();
const scheduledInput = z
  .object({
    grantId: z.string().min(1).max(200),
    grantVersion: z.number().int().positive(),
    tool: z.string().min(1).max(120),
    accountId: z.string().min(1).max(200),
    input: z.unknown(),
  })
  .strict();
const preparedInput = z.object({
  operationId: z.string(),
  state: z.string(),
  input: z.unknown(),
  expiresAt: z.number(),
  confirmationToken: z.string().optional(),
});
type Ticket =
  | { readonly principal: PluginPrincipal; readonly id: string; readonly token: string | null }
  | { readonly scheduled: true };

export const createDshOperationHost = (
  ctx: Context,
  options: Omit<Parameters<typeof createPluginOperationService>[0], 'validateGrant'> & {
    readonly profile: string;
    readonly principalForSession: (sessionId: string) => PluginPrincipal | null;
    readonly automationsEnabled?: boolean;
  },
) => {
  const identity = createDshIdentity(ctx, options);
  const service = createPluginOperationService({
    ...options,
    validateGrant: identity.validateGrant,
  });
  const invokeScheduled = createScheduledOperationInvoker(service, identity.scheduled);
  const tickets = new Map<ToolExecutionToken, Ticket>();
  const lifetime = new AbortController();
  const automationsEnabled = options.automationsEnabled === true;
  const owned = (execution: ToolExecution) =>
    execution.name === MANUAL_OPERATION_TOOL || execution.name === SCHEDULED_OPERATION_TOOL;
  const removers: (() => void)[] = [];
  let disposed = false;
  try {
    removers.push(
      ctx.on('tools/pre-execute', async (execution, next) => {
        if (!owned(execution)) return next();
        const previous = await next();
        if (previous.kind === 'deny' || previous.kind === 'cancel') return previous;
        const principal = identity.principal(execution.agent);
        if (disposed || !principal || execution.signal.aborted)
          return { kind: 'deny', reason: 'A live, top-level authorized session is required' };
        if (execution.name === SCHEDULED_OPERATION_TOOL) {
          const parsed = scheduledInput.safeParse(execution.arguments);
          if (
            !automationsEnabled ||
            !parsed.success ||
            !(await identity.scheduled(
              { ...execution, signal: AbortSignal.any([execution.signal, lifetime.signal]) },
              parsed.data,
            ))
          )
            return {
              kind: 'deny',
              reason: 'Scheduled execution is disabled or has no matching durable delivery',
            };
          tickets.set(execution.token, { scheduled: true });
          return previous;
        }
        const parsed = manualInput.safeParse(execution.arguments);
        if (!parsed.success) return { kind: 'deny', reason: 'Invalid operation envelope' };
        const prepared = await service.prepare(principal, parsed.data);
        if (!prepared.ok)
          return { kind: 'deny', reason: 'Operation cannot be prepared under current authority' };
        const value = preparedInput.parse(prepared.data);
        if (!value.confirmationToken) {
          if (value.state === 'pending')
            return {
              kind: 'deny',
              reason:
                'Pending operation already exists; use its original confirmation or query its state',
            };
          tickets.set(execution.token, { principal, id: value.operationId, token: null });
          return previous;
        }
        const approval = ctx.get('approval');
        if (!approval || !execution.agent) {
          await service.cancel(principal, {
            id: value.operationId,
            token: value.confirmationToken,
          });
          return { kind: 'deny', reason: 'An approval service is required' };
        }
        // Keep an unforgeable execution ticket: a later pre-execute listener cannot replace this approval with allow.
        let outcome: ApprovalOutcome;
        try {
          let taskReason = '';
          if (parsed.data.tool === 'configure_plugin_automation') {
            const { grant } = z.object({ grant: PluginAutomationGrantSchema }).parse(value.input);
            if (grant.enabled) {
              const task = (await ctx.schedule.catalog()).find(
                (row) =>
                  row.id === grant.identity.taskId && row.sessionId === grant.identity.sessionId,
              );
              if (
                !task ||
                dshScheduleHash(task) !== grant.scheduleHash ||
                !(await identity.validateGrant(grant))
              ) {
                await service.cancel(principal, {
                  id: value.operationId,
                  token: value.confirmationToken,
                });
                return {
                  kind: 'deny',
                  reason: 'Current task metadata does not match the frozen grant',
                };
              }
              const {
                prompt: _prompt,
                lastDelivery: _lastDelivery,
                status: _status,
                ...summary
              } = task;
              taskReason = `；宿主任务与时间规则：${JSON.stringify(summary)}`;
            } else taskReason = '；撤销此任务授权';
          }
          outcome = await approval.request({
            agent: execution.agent,
            toolName: execution.name,
            callId: execution.callId,
            reason: `确认账户 ${principal.accountId} 的 ${parsed.data.tool} 操作（${value.operationId}）。有效期至 ${new Date(value.expiresAt).toISOString()}。冻结参数：${JSON.stringify(value.input)}${taskReason}${previous.kind === 'ask' && previous.reason ? `；${previous.reason}` : ''}`,
            signal: AbortSignal.any([execution.signal, lifetime.signal]),
          });
        } catch {
          await service.cancel(principal, {
            id: value.operationId,
            token: value.confirmationToken,
          });
          return { kind: 'deny', reason: 'Operation approval could not be committed' };
        }
        if (outcome !== 'allowed-once' || execution.signal.aborted || disposed) {
          await service.cancel(principal, {
            id: value.operationId,
            token: value.confirmationToken,
          });
          return { kind: 'deny', reason: `Operation approval: ${outcome}` };
        }
        tickets.set(execution.token, {
          principal,
          id: value.operationId,
          token: value.confirmationToken,
        });
        return { kind: 'allow' };
      }),
    );
    removers.push(
      ctx.tools.guard((execution) => {
        if (!owned(execution)) return;
        const principal = identity.principal(execution.agent);
        const ticket = tickets.get(execution.token);
        if (
          disposed ||
          !principal ||
          !ticket ||
          (!('scheduled' in ticket) &&
            (principal.userId !== ticket.principal.userId ||
              principal.accountId !== ticket.principal.accountId))
        )
          return 'Missing current operation approval or scheduled authority';
      }),
    );
    removers.push(
      ctx.on('tools/result', (execution) => {
        tickets.delete(execution.token);
      }),
    );
    const output = {
      schema: toolResultJsonSchema,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    };
    removers.push(
      ctx.tools.register({
        name: MANUAL_OPERATION_TOOL,
        description:
          '准备并逐次确认投资操作或定时授权；必须经当前会话的宿主审批。原始领域参数校验和业务回执继续生效。',
        parameters: JSON.parse(JSON.stringify(z.toJSONSchema(manualInput, { io: 'input' }))),
        output,
        execute: async (_input, execution) => {
          const ticket = tickets.get(execution.token);
          tickets.delete(execution.token);
          const principal = identity.principal(execution.agent);
          if (
            !ticket ||
            'scheduled' in ticket ||
            disposed ||
            !principal ||
            principal.userId !== ticket.principal.userId ||
            principal.accountId !== ticket.principal.accountId
          )
            return {
              ok: false,
              error: { kind: 'permission_denied', required: 'approved operation ticket' },
            };
          return ticket.token === null
            ? service.get(ticket.principal, ticket.id)
            : service.confirm(
                ticket.principal,
                { id: ticket.id, token: ticket.token },
                execution.signal,
              );
        },
      }),
    );
    removers.push(
      ctx.tools.register({
        name: SCHEDULED_OPERATION_TOOL,
        description:
          '执行已有持久授权对应的本次 DSH 提醒；任务身份和发生时间从宿主投递历史核验，参数不能携带身份。',
        parameters: JSON.parse(JSON.stringify(z.toJSONSchema(scheduledInput, { io: 'input' }))),
        output,
        execute: async (input, execution) => {
          const ticket = tickets.get(execution.token);
          tickets.delete(execution.token);
          if (!ticket || !('scheduled' in ticket) || disposed || !automationsEnabled)
            return {
              ok: false,
              error: { kind: 'permission_denied', required: 'enabled scheduled authority' },
            };
          return invokeScheduled(
            { ...execution, signal: AbortSignal.any([execution.signal, lifetime.signal]) },
            input,
          );
        },
      }),
    );
  } catch (error) {
    for (const remove of removers.reverse()) remove();
    service.dispose();
    throw error;
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort('DSH operation host disposed');
    for (const remove of removers.reverse()) remove();
    tickets.clear();
    service.dispose();
  };
  ctx.effect(() => dispose);
  return { service, identity, dispose };
};
