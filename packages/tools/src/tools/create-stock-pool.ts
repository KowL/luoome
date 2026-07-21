import {
  assertStockPoolInvariants,
  type PoolSource,
  StockPoolSchema,
  type WatchRule,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const PoolSourceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('holdings'), accountId: z.string().min(1) }),
  z.object({ kind: z.literal('manual'), stockIds: z.array(z.string().min(1)).min(1) }),
  z.object({
    kind: z.literal('tactic'),
    tacticId: z.string().min(1),
    lookbackDays: z.number().int().positive().max(365),
    minScore: z.number().min(0).max(100).optional(),
  }),
]);

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
  source: PoolSourceInputSchema,
  rules: z.array(WatchRuleInputSchema).min(1),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(true),
});

export const CreateStockPoolOutput = z.object({
  pool: StockPoolSchema,
});

/**
 * 创建股票池（v0.6 起，write）。
 *
 * 校验链：
 * 1. zod parse（schema 校验）
 * 2. tactic 引用存在性检查（repos.tactic.findById）
 * 3. holdings source 的 accountId 存在性检查（repos.account.findById）
 * 4. assertStockPoolInvariants（rules ≥ 1；tactic source 池的 rules.tactic 一致性）
 * 5. 同 id 已存在 → invalid_input
 * 6. 落库
 */
export const createStockPoolTool = defineTool({
  name: 'create_stock_pool',
  description: '创建股票池（write）；tactic / account 引用不存在会拒绝',
  sideEffect: 'write',
  input: CreateStockPoolInput,
  output: CreateStockPoolOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockPool.findById(input.id);
    if (existing !== null) {
      return errInvalidInput(`stock pool id 已存在: ${input.id}`);
    }

    // tactic 引用校验
    const tacticIds = new Set<string>();
    if (input.source.kind === 'tactic') tacticIds.add(input.source.tacticId);
    for (const rule of input.rules) {
      if (rule.kind === 'tactic') tacticIds.add(rule.tacticId);
    }
    for (const tid of tacticIds) {
      const t = await ctx.repos.tactic.findById(tid);
      if (t === null) return errNotFound('Tactic', tid);
    }

    // holdings source 的 accountId 校验
    if (input.source.kind === 'holdings') {
      const acc = await ctx.repos.account.findById(input.source.accountId);
      if (acc === null) return errNotFound('Account', input.source.accountId);
    }

    const now = ctx.clock();
    const pool = StockPoolSchema.parse({
      id: input.id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      source: input.source satisfies PoolSource,
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
