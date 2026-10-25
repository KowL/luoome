import type { Context } from '@deepseek-ai/cordis';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { PluginAutomationGrantSchema, PluginCapabilitySchema } from '@luoome/core';
import type { PluginPrincipal } from '@luoome/tools';
import { createPluginOperationService } from '@luoome/tools';
import { z } from 'zod';
import { AUTOMATION_CATALOG_TOOL, createAutomationCatalog } from './automation-catalog.js';
import { createDshIdentity, dshScheduleHash } from './dsh-identity.js';
import { createScheduledOperationInvoker } from './operations.js';
import { toolResultJsonSchema } from './tools.js';

export const MANUAL_OPERATION_TOOL = 'luoome_confirmed_operation';
export const SCHEDULED_OPERATION_TOOL = 'luoome_scheduled_operation';
const manualInput = z
  .object({
    id: z
      .uuid()
      .describe('Required top-level UUID for this operation; use a new UUID for a new operation'),
    tool: z.string().min(1).max(120),
    input: z.unknown().optional(),
    inputJson: z
      .string()
      .min(2)
      .describe(
        'Preferred for native calls: JSON.stringify of the business input object. Preserve JSON null, numbers and arrays; never use placeholder strings. Supply exactly one of inputJson or input.',
      )
      .optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'input') !== Object.hasOwn(value, 'inputJson'), {
    path: ['inputJson'],
    message: 'Supply exactly one of input or inputJson',
  });
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
  requiredCapabilities: z.array(PluginCapabilitySchema),
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
  const refusedRequests = new WeakMap<NonNullable<ToolExecution['agent']>, number | null>();
  const requestKey = (agent: NonNullable<ToolExecution['agent']>): number | null => {
    for (let index = agent.session.seq - 1; index >= agent.session.inheritedEventCount; index--) {
      const event = agent.session.eventAt(SessionSeq(index));
      if (
        event?.type === 'turn/start' ||
        (event?.type === 'user/message' && event.data.source.kind === 'user')
      )
        return event.seq;
    }
    return null;
  };
  const refused = (execution: ToolExecution) =>
    execution.agent !== undefined &&
    refusedRequests.has(execution.agent) &&
    refusedRequests.get(execution.agent) === requestKey(execution.agent);
  const lifetime = new AbortController();
  const automationsEnabled = options.automationsEnabled === true;
  const automationCatalog = createAutomationCatalog({
    ...options,
    tasks: () => ctx.schedule.catalog(),
  });
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
        if (refused(execution))
          return {
            kind: 'deny',
            reason:
              'This request’s write plan was rejected. A new explicit user request is required; changing tool or operation id cannot bypass the rejection.',
          };
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
        if (!parsed.success)
          return {
            kind: 'deny',
            reason: `Invalid operation envelope: ${JSON.stringify(
              parsed.error.issues.map((issue) => ({
                path: issue.path,
                code: issue.code,
                // 只回显越界的键名，不回显提交值。
                ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys } : {}),
              })),
            )}. The envelope accepts only id, tool and exactly one of input or inputJson; business parameters belong inside input or inputJson.`,
          };
        let input = parsed.data.input;
        if (Object.hasOwn(parsed.data, 'inputJson')) {
          try {
            input = JSON.parse(parsed.data.inputJson as string);
          } catch {
            return { kind: 'deny', reason: 'Invalid operation inputJson: expected a JSON object' };
          }
          if (input === null || typeof input !== 'object' || Array.isArray(input))
            return { kind: 'deny', reason: 'Invalid operation inputJson: expected a JSON object' };
        }
        const prepared = await service.prepare(principal, {
          id: parsed.data.id,
          tool: parsed.data.tool,
          input,
        });
        if (!prepared.ok)
          return {
            kind: 'deny',
            reason: `Operation cannot be prepared: ${JSON.stringify(prepared.error)}`,
          };
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
            reason: `确认账户 ${principal.accountId} 的 ${parsed.data.tool} 操作（${value.operationId}）。${options.policies.find((policy) => policy.tool.name === parsed.data.tool)?.tool.description ?? '确认精确任务授权'}。所需能力：${value.requiredCapabilities.join(' + ')}。有效期至 ${new Date(value.expiresAt).toISOString()}。冻结参数：${JSON.stringify(value.input)}${taskReason}${previous.kind === 'ask' && previous.reason ? `；${previous.reason}` : ''}`,
            signal: AbortSignal.any([execution.signal, lifetime.signal]),
          });
        } catch {
          await service.cancel(principal, {
            id: value.operationId,
            token: value.confirmationToken,
          });
          return { kind: 'deny', reason: 'Operation approval could not be committed' };
        }
        if (
          outcome !== 'allowed-once' ||
          execution.signal.aborted ||
          disposed ||
          refused(execution)
        ) {
          if (execution.agent) refusedRequests.set(execution.agent, requestKey(execution.agent));
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
          refused(execution) ||
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
    const operations = service.descriptors();
    if (options.policies.some((policy) => policy.scheduled)) {
      removers.push(
        ctx.tools.register({
          name: AUTOMATION_CATALOG_TOOL,
          description:
            '读取宿主现有日程、精确定义哈希、账户绑定调用模板与持久授权。只读，不创建日程或授权；授权仍需 configure_plugin_automation 的原生审批。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output,
          execute: async (input, execution) => {
            const principal = identity.principal(execution.agent);
            if (
              disposed ||
              !principal ||
              execution.signal.aborted ||
              !z.object({}).strict().safeParse(input).success
            )
              return {
                ok: false,
                error: { kind: 'permission_denied', required: 'live owner session' },
              };
            return {
              ok: true,
              data: { ...(await automationCatalog(principal)), automationsEnabled },
            };
          },
        }),
      );
    }
    const parameters = JSON.parse(JSON.stringify(z.toJSONSchema(manualInput, { io: 'input' })));
    // MiniMax can omit nested nulls before returning native tool arguments.
    // A JSON string preserves them; decode before the same domain validation and approval.
    parameters.properties.inputJson.contentMediaType = 'application/json';
    if (operations.length > 0) {
      // Keep field types directly under input for providers that only inspect properties.
      // The outer oneOf still binds each tool to its exact input and required fields.
      const fields = new Map<string, Map<string, unknown>>();
      for (const { inputSchema } of operations) {
        for (const [name, schema] of Object.entries(inputSchema.properties ?? {})) {
          const variants = fields.get(name) ?? new Map<string, unknown>();
          variants.set(JSON.stringify(schema), schema);
          fields.set(name, variants);
        }
      }
      parameters.properties.input = {
        type: 'object',
        properties: Object.fromEntries(
          [...fields].map(([name, variants]) => {
            const schemas = [...variants.values()];
            return [name, schemas.length === 1 ? schemas[0] : { anyOf: schemas }];
          }),
        ),
        additionalProperties: true,
      };
      parameters.properties.tool.enum = operations.map(({ name }) => name);
      parameters.properties.inputJson.contentSchema = {
        anyOf: operations.map(({ inputSchema }) => inputSchema),
      };
      parameters.oneOf = operations.flatMap(({ name, description, inputSchema }) =>
        [
          { input: inputSchema },
          { inputJson: { ...parameters.properties.inputJson, contentSchema: inputSchema } },
        ].map((payload) => ({
          type: 'object',
          description,
          properties: {
            id: parameters.properties.id,
            tool: { type: 'string', const: name },
            ...payload,
          },
          required: ['id', 'tool', ...Object.keys(payload)],
          additionalProperties: false,
        })),
      );
    }
    removers.push(
      ctx.tools.register({
        name: MANUAL_OPERATION_TOOL,
        description:
          '准备并逐次确认投资操作或定时授权。id 必须为 UUID，tool 为操作名。原生调用优先提供 inputJson（业务参数对象 JSON.stringify 后的字符串，schema 见 contentSchema），以保留 null/数字/数组；也可用 input 对象，二者必须且只能提供一个。必须经当前会话宿主审批；解析后的原始领域参数校验和业务回执继续生效。',
        // Nested Zod schemas carry non-wire annotations too; detach the whole envelope.
        parameters: JSON.parse(JSON.stringify(parameters)),
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
