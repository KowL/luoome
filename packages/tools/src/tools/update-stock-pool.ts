import {
  assertStockPoolInvariants,
  PoolSourceSchema,
  StockPoolSchema,
  WatchRuleSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const PoolSourcePatchSchema = PoolSourceSchema.optional();
const WatchRulePatchSchema = z.array(WatchRuleSchema).min(1).optional();

export const UpdateStockPoolInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  source: PoolSourcePatchSchema,
  rules: WatchRulePatchSchema,
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  enabled: z.boolean().optional(),
});

export const UpdateStockPoolOutput = z.object({
  pool: StockPoolSchema,
});

/**
 * 更新股票池（v0.6 起，write）。
 *
 * 语义：未提供的字段保持原值；description=null 表示清空。
 * 不变量（同 create_stock_pool）：
 * - tactic 引用存在性
 * - holdings source 的 accountId 存在性
 * - assertStockPoolInvariants
 */
export const updateStockPoolTool = defineTool({
  name: 'update_stock_pool',
  description: '更新股票池（write）；只改传入字段，未传保持原值',
  sideEffect: 'write',
  input: UpdateStockPoolInput,
  output: UpdateStockPoolOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockPool.findById(input.id);
    if (existing === null) return errNotFound('StockPool', input.id);

    const merged = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? input.description === null
          ? { description: undefined }
          : { description: input.description }
        : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.rules !== undefined ? { rules: input.rules } : {}),
      ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: ctx.clock(),
    };

    // tactic 引用校验（覆盖式）
    const tacticIds = new Set<string>();
    if (merged.source.kind === 'tactic') tacticIds.add(merged.source.tacticId);
    for (const rule of merged.rules) {
      if (rule.kind === 'tactic') tacticIds.add(rule.tacticId);
    }
    for (const tid of tacticIds) {
      const t = await ctx.repos.tactic.findById(tid);
      if (t === null) return errNotFound('Tactic', tid);
    }
    if (merged.source.kind === 'holdings') {
      const acc = await ctx.repos.account.findById(merged.source.accountId);
      if (acc === null) return errNotFound('Account', merged.source.accountId);
    }

    const pool = StockPoolSchema.parse(merged);
    try {
      assertStockPoolInvariants(pool);
    } catch (e) {
      return errInvalidInput((e as Error).message);
    }
    await ctx.repos.stockPool.save(pool);
    return { pool };
  },
});
