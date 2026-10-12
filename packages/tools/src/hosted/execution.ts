import { createHash } from 'node:crypto';
import {
  InvariantError,
  TenantExecutionLeaseSchema,
  TenantExecutionRequestSchema,
  TenantOperationReceiptSchema,
  TenantOutboxSchema,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput } from '../define-tool.js';

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};
export const hashHostedInput = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

const tenantRepository = (ctx: ToolContext) => {
  if (ctx.repos.hostedTenant === undefined)
    throw new InvariantError('tenant execution repository missing');
  return ctx.repos.hostedTenant;
};
const workerDenied = (ctx: ToolContext): ToolResult<never> | null =>
  ctx.identity?.mode === 'hosted' && ctx.identity.actor === 'worker'
    ? null
    : {
        ok: false,
        error: { kind: 'permission_denied', required: 'actor:worker' },
      };
const OperationInput = z.object({ operationId: z.string().min(1).max(160) }).strict();

export const persistTenantExecutionRequestTool = defineTool({
  name: 'persist_tenant_execution_request',
  description: '持久化租户私有任务输入；控制库仅保存引用和摘要',
  sideEffect: 'write',
  input: TenantExecutionRequestSchema,
  output: TenantExecutionRequestSchema,
  handler: async (input, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || input.generation !== ctx.identity.tenantGeneration) {
      return errInvalidInput('execution generation mismatch');
    }
    if (hashHostedInput(input.input) !== input.inputHash)
      return errInvalidInput('execution input hash mismatch');
    await tenantRepository(ctx).putExecutionRequest(input);
    return input;
  },
});
export const getTenantExecutionRequestTool = defineTool({
  name: 'get_tenant_execution_request',
  description: '读取本租户已经持久化的任务输入',
  sideEffect: 'read',
  input: OperationInput,
  output: TenantExecutionRequestSchema.nullable(),
  handler: (input, ctx) => tenantRepository(ctx).getExecutionRequest(input.operationId),
});
export const getTenantOperationReceiptTool = defineTool({
  name: 'get_tenant_operation_receipt',
  description: '读取已提交业务回执，恢复时复用结果',
  sideEffect: 'read',
  input: OperationInput,
  output: TenantOperationReceiptSchema.nullable(),
  handler: (input, ctx) => tenantRepository(ctx).getReceipt(input.operationId),
});
export const claimTenantExecutionTool = defineTool({
  name: 'claim_tenant_execution',
  description: '为 worker 领取租户本地 fence，保护跨库恢复后的业务提交',
  sideEffect: 'write',
  input: OperationInput.extend({
    generation: z.number().int().positive(),
    attemptId: z.string().min(1),
  }),
  output: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('claimed'), lease: TenantExecutionLeaseSchema }),
    z.object({ kind: z.literal('completed'), receipt: TenantOperationReceiptSchema }),
    z.object({ kind: z.literal('busy') }),
  ]),
  handler: async (input, ctx) => {
    const denied = workerDenied(ctx);
    if (denied !== null) return denied;
    if (ctx.identity?.mode !== 'hosted' || input.generation !== ctx.identity.tenantGeneration) {
      return errInvalidInput('execution generation mismatch');
    }
    return tenantRepository(ctx).claimExecution({ ...input, now: ctx.clock(), leaseMs: 120_000 });
  },
});
export const renewTenantExecutionTool = defineTool({
  name: 'renew_tenant_execution',
  description: '续租同一租户本地执行身份',
  sideEffect: 'write',
  input: OperationInput.extend({
    generation: z.number().int().positive(),
    fence: z.number().int().positive(),
    attemptId: z.string().min(1),
  }),
  output: z.object({ renewed: z.boolean() }),
  handler: async (input, ctx) => {
    const denied = workerDenied(ctx);
    if (denied !== null) return denied;
    return {
      renewed: await tenantRepository(ctx).renewExecution({
        ...input,
        now: ctx.clock(),
        leaseMs: 120_000,
      }),
    };
  },
});
export const listTenantResultOutboxTool = defineTool({
  name: 'list_tenant_result_outbox',
  description: '读取本租户未确认的结果事件供平台幂等结算',
  sideEffect: 'read',
  input: z.object({}).strict(),
  output: z.object({ events: z.array(TenantOutboxSchema) }),
  handler: async (_input, ctx) => {
    const denied = workerDenied(ctx);
    if (denied !== null) return denied;
    return { events: [...(await tenantRepository(ctx).listOutbox())] };
  },
});
export const acknowledgeTenantResultOutboxTool = defineTool({
  name: 'acknowledge_tenant_result_outbox',
  description: '平台确认结算后标记租户 outbox；重复确认保持幂等',
  sideEffect: 'write',
  input: z.object({ eventId: z.string().min(1) }).strict(),
  output: z.object({ acknowledged: z.literal(true) }),
  handler: async (input, ctx) => {
    const denied = workerDenied(ctx);
    if (denied !== null) return denied;
    await tenantRepository(ctx).ackOutbox(input.eventId, ctx.clock());
    return { acknowledged: true as const };
  },
});

export const hostedExecutionToolNames: ReadonlySet<string> = new Set(
  [
    persistTenantExecutionRequestTool,
    getTenantExecutionRequestTool,
    getTenantOperationReceiptTool,
    claimTenantExecutionTool,
    renewTenantExecutionTool,
    listTenantResultOutboxTool,
    acknowledgeTenantResultOutboxTool,
  ].map((tool) => tool.name),
);
