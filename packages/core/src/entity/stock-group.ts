import { z } from 'zod';

import { InvariantError } from '../error/index.js';

/**
 * 股票分组 + 成员快照（docs/stock-group-design.md §1）。
 *
 * 设计要点：
 * - 分组（StockGroup）只回答「成员是谁」，与盯盘池（StockPool）解耦；pool 通过 groupId 引用 group
 * - 成员来源 = GroupResolver（discriminated union on `kind`）：
 *   manual（手动列表）/ holdings（持仓活视图，无快照）/ formula（战法 DSL 每日重算）/ llm（LLM 每日产出）
 *   strategy 为文档层面预留 kind，本期不实现（spec「明确不做」）
 * - 动态分组统一「生产者 + 快照」模型：刷新在盘外写快照，hot path 只读快照，resolver 永不进 hot path
 * - 成员快照（GroupMemberSnapshot）只增不改：一次刷新 = 一批（同 refreshId），
 *   当前成员 = 最新 refreshId 那一批；历史批次全保留，支撑复盘与成员变化检测
 */

// ---------- 枚举 ----------

/** 分组刷新策略：daily = 每日盘外刷新；manual = 仅手动触发。manual/holdings resolver 无实际刷新动作，字段保留统一。 */
export type GroupRefreshPolicy = 'daily' | 'manual';

export const GroupRefreshPolicySchema = z.enum(['daily', 'manual']);

// ---------- GroupResolver（discriminated union on `kind`） ----------

/** A 手动分组：固定股票列表（如「半导体」板块）。 */
export const ManualGroupResolverSchema = z.object({
  kind: z.literal('manual'),
  stockIds: z.array(z.string().min(1)).min(1),
});

/** 持仓分组：活视图，查询时现算（无快照）。显式绑定账户（消除「默认账户」歧义）。 */
export const HoldingsGroupResolverSchema = z.object({
  kind: z.literal('holdings'),
  accountId: z.string().min(1),
});

/** B 公式动态分组：成员 = 该战法近 lookbackDays 天命中信号（score ≥ minScore）的 distinct stockId。 */
export const FormulaGroupResolverSchema = z.object({
  kind: z.literal('formula'),
  tacticId: z.string().min(1),
  lookbackDays: z.number().int().positive().max(365),
  minScore: z.number().min(0).max(100).optional(),
});

/** D LLM 提示词分组：LLM 按 prompt 每日盘外产出成员写快照（如龙头战法、一进二）。 */
export const LlmGroupResolverSchema = z.object({
  kind: z.literal('llm'),
  /** 提示词；长度 1-2000。 */
  prompt: z.string().min(1).max(2000),
  /** 单次刷新成员上限；缺省 20，区间 [1, 100]。 */
  maxMembers: z.number().int().min(1).max(100).default(20),
  /** 缺省走系统默认 LLM。 */
  model: z.string().min(1).optional(),
});

// C strategy resolver：文档层面预留 kind，本期不实现（spec「明确不做」），不在 union 中占位。

export const GroupResolverSchema = z.discriminatedUnion('kind', [
  ManualGroupResolverSchema,
  HoldingsGroupResolverSchema,
  FormulaGroupResolverSchema,
  LlmGroupResolverSchema,
]);

export type GroupResolver = z.infer<typeof GroupResolverSchema>;
/** resolver.kind === 'formula' / 'llm' 时的窄化类型（z.narrow 派生，避免重复定义）。 */
export type FormulaGroupResolver = Extract<GroupResolver, { kind: 'formula' }>;
export type LlmGroupResolver = Extract<GroupResolver, { kind: 'llm' }>;
export type ManualGroupResolver = Extract<GroupResolver, { kind: 'manual' }>;
export type HoldingsGroupResolver = Extract<GroupResolver, { kind: 'holdings' }>;

// ---------- StockGroup ----------

export const StockGroupSchema = z.object({
  /** slug，kebab-case（与 pool / 战法 id 规则一致）。 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, {
    message: 'group.id 必须小写 kebab-case，长度 2-64',
  }),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  resolver: GroupResolverSchema,
  refreshPolicy: GroupRefreshPolicySchema.default('daily'),
  enabled: z.boolean().default(true),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type StockGroup = z.infer<typeof StockGroupSchema>;

// ---------- GroupMemberSnapshot ----------

/**
 * 成员快照：一次刷新 = 一批（同一 refreshId）。
 * reason = 进入理由：formula = 信号分数说明，llm = 模型 rationale。
 */
export const GroupMemberSnapshotSchema = z.object({
  /** uuid。 */
  id: z.string().min(1),
  groupId: z.string().min(1),
  stockId: z.string().min(1),
  /** 同一批刷新共享；当前成员 = 最新 refreshId 那一批。 */
  refreshId: z.string().min(1),
  reason: z.string().min(1).max(500),
  createdAt: z.coerce.date(),
});

export type GroupMemberSnapshot = z.infer<typeof GroupMemberSnapshotSchema>;

// ---------- 不变量 ----------

/**
 * 分组不变量（docs/stock-group-design.md §1）：
 * - id slug 合法（schema 已 regex，runtime 兜底长度）
 * - llm.prompt 1-2000 / maxMembers ∈ [1, 100]（schema 已约束）
 * - updatedAt ≥ createdAt
 *
 * 跨实体校验不在此断言（entity 层拿不到 repo），放 tool 层（同 stock-pool.ts 口径）：
 * - formula.tacticId / holdings.accountId 引用存在性（create_stock_group / update_stock_group）
 * - manual.stockIds 的股票存在性（llm 产出逐条 search_stocks 校验，spec §4）
 */
export const assertStockGroupInvariants = (group: StockGroup): void => {
  if (group.id.length < 2 || group.id.length > 64) {
    throw new InvariantError(`group.id 长度 2-64，实际 ${group.id.length}`);
  }
  if (group.updatedAt.getTime() < group.createdAt.getTime()) {
    throw new InvariantError('group.updatedAt < group.createdAt');
  }
};
