import {
  assertStockGroupInvariants,
  GroupRefreshPolicySchema,
  GroupResolverSchema,
  StockGroupSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import { validateGroupResolverRefs } from '../internal/stock-group.js';

export const CreateStockGroupInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'group.id 必须小写 kebab-case，长度 2-64'),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  /** 成员解析器：manual / holdings / formula / llm（docs/stock-group-design.md §1）。 */
  resolver: GroupResolverSchema,
  refreshPolicy: GroupRefreshPolicySchema.default('daily'),
  enabled: z.boolean().default(true),
});

export const CreateStockGroupOutput = z.object({
  group: StockGroupSchema,
});

/**
 * 创建股票分组（分组化起，write；docs/stock-group-design.md §6）。
 *
 * 校验链：
 * 1. zod parse（resolver 形状 / llm.prompt 长度 / maxMembers 区间等 schema 约束）
 * 2. 同 id 已存在 → invalid_input
 * 3. resolver 跨实体引用校验（formula.tacticId / holdings.accountId / manual.stockIds 存在性）
 * 4. assertStockGroupInvariants → 落库
 *
 * 注：本 input schema 同时是 web chat 创建分组 draft 的契约（spec §8 可选二期）。
 */
export const createStockGroupTool = defineTool({
  name: 'create_stock_group',
  description: '创建股票分组（write）；resolver 引用（tactic/account/stock）不存在会拒绝',
  sideEffect: 'write',
  input: CreateStockGroupInput,
  output: CreateStockGroupOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockGroup.findById(input.id);
    if (existing !== null) {
      return errInvalidInput(`stock group id 已存在: ${input.id}`);
    }

    const refError = await validateGroupResolverRefs(input.resolver, ctx);
    if (refError !== null) return refError;

    const now = ctx.clock();
    const group = StockGroupSchema.parse({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      resolver: input.resolver,
      refreshPolicy: input.refreshPolicy,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    });
    assertStockGroupInvariants(group);
    await ctx.repos.stockGroup.save(group);
    return { group };
  },
});
