import { assertStockPoolInvariants, StockPoolSchema, type WatchRule } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

/**
 * 规则入参（docs/ddd/strategy-alert-detailed-design.md §9.1）：
 * - 接受可选 id（缺省服务端生成 `r_${uuid8}`）与 priority
 * - price-change 增加 direction（默认 'any' 兼容旧配置）
 * - 新增 price-level 变体
 */
const BaseRuleFields = {
  id: z.string().min(1).optional(),
  priority: z.enum(['urgent', 'important', 'normal']).optional(),
};

const WatchRuleInputSchema = z.discriminatedUnion('kind', [
  z.object({
    ...BaseRuleFields,
    kind: z.literal('tactic'),
    tacticId: z.string().min(1),
    minScore: z.number().min(0).max(100).default(60),
  }),
  z
    .object({
      ...BaseRuleFields,
      kind: z.literal('cost-threshold'),
      stopLossPct: z.number().positive().max(1).optional(),
      takeProfitPct: z.number().positive().max(1).optional(),
    })
    .refine((r) => r.stopLossPct !== undefined || r.takeProfitPct !== undefined, {
      message: 'cost-threshold 规则必须至少指定 stopLossPct 或 takeProfitPct',
    }),
  z.object({
    ...BaseRuleFields,
    kind: z.literal('price-change'),
    pct: z.number().positive().max(1),
    direction: z.enum(['up', 'down', 'any']).default('any'),
  }),
  z.object({
    ...BaseRuleFields,
    kind: z.literal('price-level'),
    level: z.number().refine((n) => Number.isFinite(n) && n > 0),
    side: z.enum(['above', 'below']),
  }),
]);

export const CreateStockPoolInput = z.object({
  /** slug；省略时服务端自动生成（用户无需关心 id）。 */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'pool.id 必须小写 kebab-case，长度 2-64')
    .optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  /** 成员分组引用（stock_groups.id）；分组必须已存在。 */
  groupId: z.string().min(1),
  rules: z.array(WatchRuleInputSchema).min(1),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(true),
  /** v0.7 策略预警（docs/.../§9.1）：方案级配置。 */
  logic: z.enum(['ANY', 'ALL']).default('ANY'),
  triggerMode: z.enum(['on-enter', 'repeat', 'daily-first']).default('on-enter'),
  priority: z.enum(['urgent', 'important', 'normal']).optional(),
  dailyNotificationLimit: z.number().int().min(1).max(500).default(20),
  notifyOnRecovery: z.boolean().default(false),
});

export const CreateStockPoolOutput = z.object({
  pool: StockPoolSchema,
});

/** 为缺省 id 的规则生成稳定 id，pool 内唯一。删除/重建不复用 id。 */
const ensureRuleIds = (
  rules: ReadonlyArray<z.infer<typeof WatchRuleInputSchema>>,
): ReadonlyArray<z.infer<typeof WatchRuleInputSchema> & { id: string }> =>
  rules.map((r) => ({
    ...r,
    id: r.id ?? `r_${globalThis.crypto.randomUUID().slice(0, 8)}`,
  }));

/**
 * 创建股票池（v0.6 起，write；分组化改造 docs/stock-group-design.md §5/§6；
 * v0.7 策略预警扩展）。
 *
 * 校验链：
 * 1. zod parse（schema 校验）
 * 2. 分组存在性检查（repos.stockGroup.findById）
 * 3. tactic 规则引用存在性检查（repos.tactic.findById）
 * 4. 规则内 id 唯一性校验
 * 5. assertStockPoolInvariants
 * 6. 同 id 已存在 → invalid_input
 * 7. 落库
 */
export const createStockPoolTool = defineTool({
  name: 'create_stock_pool',
  description:
    '创建股票池（write）；分组 / tactic 引用不存在会拒绝；支持 ANY/ALL、触发模式、优先级、price-level',
  sideEffect: 'write',
  input: CreateStockPoolInput,
  output: CreateStockPoolOutput,
  handler: async (input, ctx) => {
    const id = input.id ?? `pool-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const existing = await ctx.repos.stockPool.findById(id);
    if (existing !== null) {
      return errInvalidInput(`stock pool id 已存在: ${id}`);
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

    // 生成规则 id 并校验唯一
    const rules = ensureRuleIds(input.rules);
    const seen = new Set<string>();
    for (const r of rules) {
      if (seen.has(r.id)) {
        return errInvalidInput(`rules[].id 重复: ${r.id}`);
      }
      seen.add(r.id);
    }

    const now = ctx.clock();
    const pool = StockPoolSchema.parse({
      id,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      groupId: input.groupId,
      // rules 中包含 id 字段，StockPoolSchema 接 WatchRule（zod 解析时 id 不出现在 union 上，但满足 Record），
      // 由于 discriminated union 解析后字段都被保留，所以此 cast 仅补回 id 字段的类型提示。
      rules: rules as unknown as readonly WatchRule[],
      cooldownMinutes: input.cooldownMinutes,
      enabled: input.enabled,
      logic: input.logic,
      triggerMode: input.triggerMode,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      dailyNotificationLimit: input.dailyNotificationLimit,
      notifyOnRecovery: input.notifyOnRecovery,
      createdAt: now,
      updatedAt: now,
    });
    assertStockPoolInvariants(pool);
    await ctx.repos.stockPool.save(pool);
    return { pool };
  },
});
