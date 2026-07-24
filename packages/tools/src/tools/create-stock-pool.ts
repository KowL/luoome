import { assertStockPoolInvariants, StockPoolSchema, type WatchRule } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const WatchRuleInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tactic'),
    tacticId: z.string().min(1),
    minScore: z.number().min(0).max(100).default(60),
  }),
  z
    .object({
      kind: z.literal('cost-threshold'),
      stopLossPct: z.number().positive().max(1).optional(),
      takeProfitPct: z.number().positive().max(1).optional(),
    })
    .refine((r) => r.stopLossPct !== undefined || r.takeProfitPct !== undefined, {
      message: 'cost-threshold 规则必须至少指定 stopLossPct 或 takeProfitPct',
    }),
  z.object({ kind: z.literal('price-change'), pct: z.number().positive().max(1) }),
]);

export const CreateStockPoolInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'pool.id 必须小写 kebab-case，长度 2-64'),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  /** 成员分组引用（stock_groups.id）；分组必须已存在。 */
  groupId: z.string().min(1),
  rules: z.array(WatchRuleInputSchema).min(1),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(true),
});

export const CreateStockPoolOutput = z.object({
  pool: StockPoolSchema,
});

/**
 * 创建股票池（v0.6 起，write；分组化改造 docs/stock-group-design.md §5/§6）。
 *
 * 校验链：
 * 1. zod parse（schema 校验）
 * 2. 分组存在性检查（repos.stockGroup.findById）
 * 3. tactic 规则引用存在性检查（repos.tactic.findById）
 * 4. assertStockPoolInvariants（rules ≥ 1 等 pool 自身不变量）
 * 5. 同 id 已存在 → invalid_input
 * 6. 落库
 */
export const createStockPoolTool = defineTool({
  name: 'create_stock_pool',
  description: '创建股票池（write）；分组 / tactic 引用不存在会拒绝',
  sideEffect: 'write',
  input: CreateStockPoolInput,
  output: CreateStockPoolOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockPool.findById(input.id);
    if (existing !== null) {
      return errInvalidInput(`stock pool id 已存在: ${input.id}`);
    }

    // 分组存在性校验
    const group = await ctx.repos.stockGroup.findById(input.groupId);
    if (group === null) return errNotFound('StockGroup', input.groupId);

    // tactic 规则引用校验
    const tacticIds = new Set<string>();
    for (const rule of input.rules) {
      if (rule.kind === 'tactic') tacticIds.add(rule.tacticId);
    }
    for (const tid of tacticIds) {
      const t = await ctx.repos.tactic.findById(tid);
      if (t === null) return errNotFound('Tactic', tid);
    }

    const now = ctx.clock();
    const pool = StockPoolSchema.parse({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      groupId: input.groupId,
      rules: input.rules satisfies readonly WatchRule[],
      cooldownMinutes: input.cooldownMinutes,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    });
    assertStockPoolInvariants(pool);
    await ctx.repos.stockPool.save(pool);
    return { pool };
  },
});
