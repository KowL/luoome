import {
  assertStrategyAutonomyActionInvariants,
  STRATEGY_AUTONOMY_ACTION_TERMINAL_STATUSES,
  StrategyAutonomyActionKindSchema,
  StrategyAutonomyActionSchema,
  StrategyAutonomyActionStatusSchema,
  type ToolError,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { sanitizeAdviceText } from '../internal/build-advice.js';
import { publishStrategyVersionTool } from './strategy-lifecycle.js';

export const ListStrategyAutonomyActionsInput = z.object({
  strategyId: z.string().min(1).optional(),
  kind: StrategyAutonomyActionKindSchema.optional(),
  status: StrategyAutonomyActionStatusSchema.optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.number().int().positive().max(1000).default(500),
});

export const ListStrategyAutonomyActionsOutput = z.object({
  actions: z.array(StrategyAutonomyActionSchema),
  total: z.number().int().nonnegative(),
});

export const listStrategyAutonomyActionsTool = defineTool({
  name: 'list_strategy_autonomy_actions',
  description: '列出 Strategy 自主管理动作（按 strategy/kind/status/时间过滤）',
  sideEffect: 'read',
  input: ListStrategyAutonomyActionsInput,
  output: ListStrategyAutonomyActionsOutput,
  handler: async (input, ctx) => {
    const listed = await ctx.repos.strategyAutonomyAction.list({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
    });
    const filtered = listed.filter(
      (action) => input.until === undefined || action.createdAt <= input.until,
    );
    const actions = filtered.slice(0, input.limit);
    return { actions, total: filtered.length };
  },
});

export const CreateStrategyAutonomyActionInput = z.object({
  action: StrategyAutonomyActionSchema,
});

export const CreateStrategyAutonomyActionOutput = z.object({
  action: StrategyAutonomyActionSchema,
});

/**
 * workflow-only：自治动作的创建只允许发生在 workflow 编排内（DDD §4），
 * 不进公共 registry / MCP discovery，由 define-workflow 的内部 tool 表接线。
 */
export const createStrategyAutonomyActionTool = defineTool({
  name: 'create_strategy_autonomy_action',
  description: '创建 StrategyAutonomyAction 审计记录（workflow-only）',
  sideEffect: 'write',
  input: CreateStrategyAutonomyActionInput,
  output: CreateStrategyAutonomyActionOutput,
  handler: async (input, ctx) => {
    const action = {
      ...input.action,
      ...(input.action.aiNarrative === undefined
        ? {}
        : // aiNarrative 落库前过既有 prompt-injection 清理（DDD §6）
          { aiNarrative: sanitizeAdviceText(input.action.aiNarrative) }),
    };
    assertStrategyAutonomyActionInvariants(action);
    await ctx.repos.strategyAutonomyAction.save(action);
    return { action };
  },
});

export const TransitionStrategyAutonomyActionInput = z.object({
  id: z.string().min(1),
  expectedStatus: StrategyAutonomyActionStatusSchema,
  status: StrategyAutonomyActionStatusSchema,
  lastError: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative().optional(),
});

export const TransitionStrategyAutonomyActionOutput = z.object({
  action: StrategyAutonomyActionSchema,
});

/** workflow-only：状态转移只做状态机内的真实迁移；补 attempts/lastError 请用 save 路径。 */
export const transitionStrategyAutonomyActionTool = defineTool({
  name: 'transition_strategy_autonomy_action',
  description: '按状态机转移 StrategyAutonomyAction（expectedStatus 乐观并发，workflow-only）',
  sideEffect: 'write',
  input: TransitionStrategyAutonomyActionInput,
  output: TransitionStrategyAutonomyActionOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const terminal = (STRATEGY_AUTONOMY_ACTION_TERMINAL_STATUSES as readonly string[]).includes(
      input.status,
    );
    const action = await ctx.repos.strategyAutonomyAction.updateStatus({
      id: input.id,
      expectedStatus: input.expectedStatus,
      status: input.status,
      updatedAt: now,
      ...(terminal ? { completedAt: now } : {}),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    });
    if (action === null) {
      return errInvalidInput(
        `StrategyAutonomyAction ${input.id} 不存在或 status 已不是 ${input.expectedStatus}`,
      );
    }
    return { action };
  },
});

export const ConfirmStrategyAutonomyActionInput = z.object({
  actionId: z.string().min(1),
});

export const ConfirmStrategyAutonomyActionOutput = z.object({
  action: StrategyAutonomyActionSchema,
});

const toolErrorText = (error: ToolError): string => {
  switch (error.kind) {
    case 'invalid_input':
    case 'invariant_violation':
    case 'lease_lost_before_commit':
      return error.message;
    case 'not_found':
      return `${error.entity} 不存在: ${error.id}`;
    case 'permission_denied':
      return `缺少能力: ${error.required}`;
    case 'adapter_error':
    case 'llm_error':
    case 'internal':
      return error.cause;
  }
};

/**
 * 人工队列确认（DDD §2.2/§4）：仅允许 blocked → confirmed，随后立即执行
 * publish_strategy_version；发布成功转 published，发布失败回 blocked 并记 lastError，
 * 动作留在人工队列等待再次确认或否决。
 */
export const confirmStrategyAutonomyActionTool = defineTool({
  name: 'confirm_strategy_autonomy_action',
  description:
    '人工确认 blocked 的晋级动作并立即发布其候选版本；只改变策略生命周期，不触发任何交易',
  sideEffect: 'write',
  input: ConfirmStrategyAutonomyActionInput,
  output: ConfirmStrategyAutonomyActionOutput,
  handler: async (input, ctx) => {
    const action = await ctx.repos.strategyAutonomyAction.findById(input.actionId);
    if (action === null) return errNotFound('StrategyAutonomyAction', input.actionId);
    if (action.status !== 'blocked') {
      return errInvalidInput(
        `只有 blocked 的 StrategyAutonomyAction 可人工确认: 当前 ${action.status}`,
      );
    }
    if (action.kind !== 'propose-version' || action.strategyVersionId === undefined) {
      return errInvalidInput('只有携带候选版本的 propose-version 动作可确认发布');
    }
    const confirmed = await ctx.repos.strategyAutonomyAction.updateStatus({
      id: action.id,
      expectedStatus: 'blocked',
      status: 'confirmed',
      updatedAt: ctx.clock(),
    });
    if (confirmed === null) {
      return errInvalidInput(`StrategyAutonomyAction ${action.id} 状态已被并发修改`);
    }
    const published = await publishStrategyVersionTool.execute(
      { versionId: action.strategyVersionId, strategyId: action.strategyId },
      ctx,
    );
    if (!published.ok) {
      const rolledBack = await ctx.repos.strategyAutonomyAction.updateStatus({
        id: action.id,
        expectedStatus: 'confirmed',
        status: 'blocked',
        lastError: `确认后发布失败: ${toolErrorText(published.error)}`,
        updatedAt: ctx.clock(),
      });
      if (rolledBack === null) {
        return errInvalidInput(
          `确认后发布失败，且动作 confirmed → blocked 回滚失败（状态已被并发修改）: ${toolErrorText(published.error)}`,
        );
      }
      return published;
    }
    const done = await ctx.repos.strategyAutonomyAction.updateStatus({
      id: action.id,
      expectedStatus: 'confirmed',
      status: 'published',
      updatedAt: ctx.clock(),
      completedAt: ctx.clock(),
    });
    if (done === null) {
      return errInvalidInput('候选版本已发布，但动作 confirmed → published 转移失败，请人工核对');
    }
    try {
      const now = ctx.clock();
      await ctx.repos.strategyAutonomyAction.save({
        id: `publish-${action.id}`,
        kind: 'publish-version',
        status: 'published',
        strategyId: action.strategyId,
        strategyVersionId: action.strategyVersionId,
        trigger: 'weekly-review',
        ruleSnapshot: {
          gate: 'human-confirm',
          publishedVersion: published.data.version.version,
        },
        factReferences: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
    } catch (error) {
      return errInvalidInput(
        `候选版本已发布，但 publish-version 审计动作落库失败，请人工核对: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { action: done };
  },
});

export const RejectStrategyAutonomyActionInput = z.object({
  actionId: z.string().min(1),
});

export const RejectStrategyAutonomyActionOutput = z.object({
  action: StrategyAutonomyActionSchema,
});

/** 人工队列否决（DDD §2.2/§4）：blocked → rejected，候选版本保持未发布。 */
export const rejectStrategyAutonomyActionTool = defineTool({
  name: 'reject_strategy_autonomy_action',
  description: '人工否决 blocked 的晋级动作，其候选版本不发布；不触发任何交易',
  sideEffect: 'write',
  input: RejectStrategyAutonomyActionInput,
  output: RejectStrategyAutonomyActionOutput,
  handler: async (input, ctx) => {
    const action = await ctx.repos.strategyAutonomyAction.findById(input.actionId);
    if (action === null) return errNotFound('StrategyAutonomyAction', input.actionId);
    if (action.status !== 'blocked') {
      return errInvalidInput(
        `只有 blocked 的 StrategyAutonomyAction 可人工否决: 当前 ${action.status}`,
      );
    }
    const now = ctx.clock();
    const rejected = await ctx.repos.strategyAutonomyAction.updateStatus({
      id: action.id,
      expectedStatus: 'blocked',
      status: 'rejected',
      updatedAt: now,
      completedAt: now,
    });
    if (rejected === null) {
      return errInvalidInput(`StrategyAutonomyAction ${action.id} 状态已被并发修改`);
    }
    return { action: rejected };
  },
});
