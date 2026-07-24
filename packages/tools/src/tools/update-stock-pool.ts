import { assertStockPoolInvariants, StockPoolSchema, type WatchRule } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

/**
 * 规则入参（docs/.../§9.1）：
 * - 接受可选 id（缺省服务端生成；带 id 的视为已有规则保留身份）
 * - 删除后的重建不复用旧 id（避免 cooldown 与历史归因错乱）
 */
const BaseRuleFields = {
  id: z.string().min(1).optional(),
  priority: z.enum(['urgent', 'important', 'normal']).optional(),
};

const WatchRulePatchSchema = z.discriminatedUnion('kind', [
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
    level: z.number().positive(),
    side: z.enum(['above', 'below']),
  }),
]);

export const UpdateStockPoolInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  /** 换绑成员分组（stock_groups.id）；分组必须已存在。 */
  groupId: z.string().min(1).optional(),
  rules: z.array(WatchRulePatchSchema).min(1).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  enabled: z.boolean().optional(),
  /** v0.7 策略预警：方案级配置（可选）。 */
  logic: z.enum(['ANY', 'ALL']).optional(),
  triggerMode: z.enum(['on-enter', 'repeat', 'daily-first']).optional(),
  priority: z.enum(['urgent', 'important', 'normal']).nullable().optional(),
  dailyNotificationLimit: z.number().int().min(1).max(500).optional(),
  notifyOnRecovery: z.boolean().optional(),
});

export const UpdateStockPoolOutput = z.object({
  pool: StockPoolSchema,
});

/**
 * 为缺省 id 的规则生成稳定 id；同时保留旧规则的 id 不变（§9.1 patch 语义）。
 */
const ensureRuleIdsForUpdate = (
  rules: ReadonlyArray<z.infer<typeof WatchRulePatchSchema>>,
): ReadonlyArray<z.infer<typeof WatchRulePatchSchema> & { id: string }> =>
  rules.map((r) => ({
    ...r,
    id: r.id ?? `r_${globalThis.crypto.randomUUID().slice(0, 8)}`,
  }));

/**
 * 更新股票池（v0.6 起，write；v0.7 策略预警扩展）。
 *
 * 语义（同 create）：
 * - 未提供的字段保持原值；description=null 表示清空
 * - rules 整体替换：带 id 的保留身份，无 id 的视为新增
 * - 不变量校验 + 落库
 */
export const updateStockPoolTool = defineTool({
  name: 'update_stock_pool',
  description:
    '更新股票池（write）；rules 整体替换（按 id 保留身份，未传 id 视为新增）；策略预警字段可选',
  sideEffect: 'write',
  input: UpdateStockPoolInput,
  output: UpdateStockPoolOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockPool.findById(input.id);
    if (existing === null) return errNotFound('StockPool', input.id);

    if (input.groupId !== undefined) {
      const group = await ctx.repos.stockGroup.findById(input.groupId);
      if (group === null) return errNotFound('StockGroup', input.groupId);
    }

    // 规则处理：仅当 rules 提供时重新生成 id（保留旧规则的 id）
    let rules: readonly WatchRule[] = existing.rules;
    if (input.rules !== undefined) {
      const withIds = ensureRuleIdsForUpdate(input.rules);
      // 校验 id 在新数组内唯一
      const seen = new Set<string>();
      for (const r of withIds) {
        if (seen.has(r.id)) {
          return errInvalidInput(`rules[].id 重复: ${r.id}`);
        }
        seen.add(r.id);
      }
      rules = withIds as unknown as readonly WatchRule[];

      // tactic 引用校验（覆盖式）
      const tacticIds = new Set<string>();
      for (const rule of rules) {
        if (rule.kind === 'tactic') tacticIds.add(rule.tacticId);
      }
      for (const tid of tacticIds) {
        const t = await ctx.repos.tactic.findById(tid);
        if (t === null) return errNotFound('Tactic', tid);
      }
    }

    const merged = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? input.description === null
          ? { description: undefined }
          : { description: input.description }
        : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.rules !== undefined ? { rules } : {}),
      ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.logic !== undefined ? { logic: input.logic } : {}),
      ...(input.triggerMode !== undefined ? { triggerMode: input.triggerMode } : {}),
      ...(input.priority === null
        ? { priority: undefined }
        : input.priority !== undefined
          ? { priority: input.priority }
          : {}),
      ...(input.dailyNotificationLimit !== undefined
        ? { dailyNotificationLimit: input.dailyNotificationLimit }
        : {}),
      ...(input.notifyOnRecovery !== undefined ? { notifyOnRecovery: input.notifyOnRecovery } : {}),
      updatedAt: ctx.clock(),
    };

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
