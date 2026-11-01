import type { AnalysisContext, ToolContext } from '@luoome/core';

import { type TriangleDataHealth, triangleGate } from '@luoome/core';
import { z } from 'zod';

/**
 * 多空风控三角的**装配**（REQ-M4-02）。
 *
 * ## 唯一不变量：四个角色共享同一个 context
 *
 * PRD 需求 1：「一次分析装配**一个** AnalysisContext，所有角色共享 `contextId` 与 `factIds`」。
 *
 * 这条不变量**由结构保证**：角色执行器的入参是 `TriangleRoleTask`，
 * 它只带 `contextId` + `factIds`，**角色拿不到 context 以外的任何东西**
 * （也不能自己再去查库）。装配方把同一份 task 分发给四个角色。
 *
 * ## 为什么角色执行器是注入的
 *
 * 三角分析需要模型推理，而 `core`/`tools` 都不能发起模型请求
 * （架构硬约束：领域层零 AI 依赖）。所以这里只定义**契约**，
 * 由 surface（DSH 插件 / 测试）注入具体执行器。
 * **测试注入确定性执行器，就能端到端跑完整链路而不需要模型。**
 */

/** 角色名。 */
export const TRIANGLE_ROLES = ['bull', 'bear', 'judge', 'risk-officer'] as const;
export type TriangleRole = (typeof TRIANGLE_ROLES)[number];

/**
 * 发给**单个角色**的任务。
 *
 * ## 刻意只带这些字段
 *
 * - `contextId`：让四个角色指向同一份上下文（可据此事后核对「是不是同一个」）
 * - `factIds`：**唯一的证据入口**（不是文本、不是 fatc 对象副本）
 * - `role`：自己是谁
 *
 * **没有** `parentTools` / `permissions` / `writeScope` 这类字段 ——
 * 「子 agent 只读、不继承父权限」（需求 8）在**类型层**就成立：
 * 角色手里根本没有可写的句柄。
 */
export const TriangleRoleTaskSchema = z
  .object({
    role: z.enum(TRIANGLE_ROLES),
    contextId: z.string().min(1),
    factIds: z.array(z.string().min(1)),
  })
  .strict();
export type TriangleRoleTask = z.infer<typeof TriangleRoleTaskSchema>;

/** 角色执行器：给定任务，产出该角色的原始输出（未校验）。 */
export type TriangleRoleExecutor = (task: TriangleRoleTask, ctx: ToolContext) => Promise<unknown>;

/** 单角色执行的计时与用量。 */
export interface TriangleRoleRun {
  readonly role: TriangleRole;
  /** 真实计时（不是估算）。 */
  readonly elapsedMs: number;
  /** 真实 token 用量；**拿不到就是 `null`**，绝不编造。 */
  readonly tokenUsed: number | null;
  readonly output: unknown;
}

/**
 * 装配一次三角分析。
 *
 * 顺序固定：bull → bear → judge → risk-officer。
 * 后两者依赖前两者的输出（空头要反驳多头、裁决官要并列双方），
 * 但那依赖**通过返回值传递，而不是通过共享可变状态**——每次传递都是显式入参。
 */
export interface TriangleAssemblyResult {
  readonly contextId: string;
  readonly factIds: readonly string[];
  readonly gate: ReturnType<typeof triangleGate>;
  /** 四个角色的产出（门禁拒绝 / 未确认时为空）。 */
  readonly roles: readonly TriangleRoleRun[];
  /** 门禁原因（`allowed=false` 时）。 */
  readonly blocked: { readonly code: string; readonly message: string } | null;
  /** 结果首段（含 tokenUsed / elapsedMs / 降级说明）。门禁拒绝或未确认时为空串。 */
  readonly lead: string;
  /** 是否发生降级，及原因。 */
  readonly degraded: TriangleDegradeReason | null;
  /** 累计 token（拿不到就是 `null`）。 */
  readonly tokenUsed: number | null;
  /** 总耗时（实测）。 */
  readonly elapsedMs: number;
}

/**
 * 执行三角分析。
 *
 * ## 门禁在**装配之前**
 *
 * 数据不可用 / 盘时段内，**不装配 context**（不浪费一次昂贵的上下文构建）。
 */
export const runTriangleAnalysis = async (input: {
  readonly context: AnalysisContext | null;
  readonly dataHealth: TriangleDataHealth;
  readonly marketSession: Parameters<typeof triangleGate>[0]['marketSession'];
  readonly scenario?: Parameters<typeof triangleGate>[0]['scenario'];
  readonly executor: TriangleRoleExecutor;
  readonly now: () => number;
  readonly ctx: ToolContext;
  /**
   * 事前成本预估（需求 6）。**未提供 = 不启用成本确认**（保持既有调用点行为）。
   */
  readonly estimate?: TriangleEstimate;
  /**
   * 用户是否已确认成本。**未确认时一个角色都不跑** ——
   * 不是「返回一个 requiresConfirmation 字段」，而是**执行器调用数为 0**。
   */
  readonly confirmed?: boolean;
  /** 降级阈值；缺省 `DEFAULT_TRIANGLE_BUDGET`。 */
  readonly budget?: TriangleBudget;
}): Promise<TriangleAssemblyResult> => {
  const gate = triangleGate({
    dataHealth: input.dataHealth,
    marketSession: input.marketSession,
    ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
  });

  if (!gate.allowed)
    return {
      contextId: input.context?.id ?? '',
      factIds: input.context?.factIds ?? [],
      gate,
      roles: [],
      blocked: { code: gate.code, message: gate.message },
      lead: '',
      degraded: null,
      tokenUsed: null,
      elapsedMs: 0,
    };

  /**
   * 需求 6：**未确认成本就不启动**。
   *
   * 判定方式是「执行器调用数为 0」，不是「返回一个 requiresConfirmation 字段」——
   * 后者只证明字段存在，证明不了「真的没开始跑」。
   */
  if (input.estimate !== undefined && input.confirmed !== true)
    return {
      contextId: input.context?.id ?? '',
      factIds: input.context?.factIds ?? [],
      gate,
      roles: [],
      blocked: { code: 'cost-not-confirmed', message: '尚未确认预估成本，分析未启动。' },
      lead: '',
      degraded: null,
      tokenUsed: null,
      elapsedMs: 0,
    };

  if (input.context === null) throw new Error('三角分析需要一份已装配的 AnalysisContext');

  const context = input.context;

  /**
   * 需求 7：按**预估上限**判降级，而不是跑到一半才放弃——
   * 后者会让前面已投入的角色白花。
   */
  const degraded =
    input.estimate === undefined
      ? null
      : shouldDegrade({
          estimate: input.estimate,
          budget: input.budget ?? DEFAULT_TRIANGLE_BUDGET,
        });
  // 降级 = 只跑**一个** agent（裁决官，它负责给结论）。
  const rolesToRun: readonly TriangleRole[] =
    degraded === null ? TRIANGLE_ROLES : (['judge'] as const);

  const startedAt = input.now();
  const roles: TriangleRoleRun[] = [];
  for (const role of rolesToRun) {
    // **同一个 contextId + 同一份 factIds** 发给每个角色。
    const task: TriangleRoleTask = {
      role,
      contextId: context.id,
      factIds: [...context.factIds],
    };
    const startedAt = input.now();
    const output = await input.executor(task, input.ctx);
    roles.push({
      role,
      elapsedMs: input.now() - startedAt,
      // 执行器没给用量就是 `null`——**不编**。
      tokenUsed: extractTokenUsed(output),
      output,
    });
  }

  const elapsedMs = input.now() - startedAt;
  // 任何一个角色拿不到用量，整体就是 `null`（不做部分求和——那会低估）。
  const tokenUsed = roles.some((role) => role.tokenUsed === null)
    ? null
    : roles.reduce((sum, role) => sum + (role.tokenUsed ?? 0), 0);

  return {
    contextId: context.id,
    factIds: context.factIds,
    gate,
    roles,
    blocked: null,
    lead: triangleSummaryLead({ tokenUsed, elapsedMs, degraded }),
    degraded,
    tokenUsed,
    elapsedMs,
  };
};

/**
 * 从角色输出里取 `tokenUsed`。
 *
 * **取不到就返回 `null`**，不做任何估算：
 * 编造一个数字比留空危险得多——它会被当真、被计入预算、被拿去调阈值。
 * （本会话的同类教训：`messageCount` 用 `listMessages(limit)` 会静默给出错值。）
 */
export const extractTokenUsed = (output: unknown): number | null => {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as { tokenUsed?: unknown }).tokenUsed;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

// ── 需求 6 / 7 / 5：事前成本、降级、结果首段 ──

/**
 * 事前成本预估（PRD 需求 6）。
 *
 * `estimatedTokenRange` 与 `estimatedDurationMs` 都是**区间**——单点数字会让人
 * 以为是承诺。区间来自「同类分析的历史实测」，这里由调用方注入（本层不查库）。
 */
export const TriangleEstimateSchema = z
  .object({
    estimatedTokenRange: z.object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    }),
    estimatedDurationMs: z.object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    }),
  })
  .strict();
export type TriangleEstimate = z.infer<typeof TriangleEstimateSchema>;

/** 降级阈值：**可注入**，测试里调小即可触发（PRD 需求 7 的 >15 分钟在测试里等不起）。 */
export interface TriangleBudget {
  /** 总 token 预算上限；超出即降级。 */
  readonly maxTokens: number;
  /** 总时长上限（毫秒）；超出即降级。PRD 的 15 分钟 = 900_000。 */
  readonly maxDurationMs: number;
}

export const DEFAULT_TRIANGLE_BUDGET: TriangleBudget = {
  maxTokens: 200_000,
  maxDurationMs: 15 * 60 * 1_000,
};

/** 降级原因（写进结果首段，用户必须能看懂为什么）。 */
export type TriangleDegradeReason = 'token-budget-exceeded' | 'duration-exceeded';

/**
 * 结果首段的**文案**（PRD 需求 5 + 7 的无条件验收）。
 *
 * ## 为什么 `tokenUsed` 为 null 时必须明说
 *
 * PRD：「结果首段含 `tokenUsed` 与 `elapsedMs`」。
 * 拿不到用量时，**留空或写 0 都是撒谎**——留空让人以为忘了写，
 * 写 0 让人以为没花 token。**明说「未获取到」才是诚实的第三种状态。**
 */
export const triangleSummaryLead = (input: {
  readonly tokenUsed: number | null;
  readonly elapsedMs: number;
  readonly degraded: TriangleDegradeReason | null;
  readonly blockedCode?: string | null;
}): string => {
  const parts: string[] = [];
  parts.push(
    input.tokenUsed === null
      ? '本次未获取到 token 用量（上游未提供），其余指标为实测值。'
      : `本次消耗 ${String(input.tokenUsed)} tokens。`,
  );
  parts.push(`用时 ${String(Math.round(input.elapsedMs / 1000))} 秒（实测）。`);
  if (input.degraded !== null) {
    // PRD 明文：「结果首段写明已降级及原因」。
    parts.push(
      input.degraded === 'token-budget-exceeded'
        ? '已降级为单 agent：token 预算超限，四角色并行无法完成。'
        : '已降级为单 agent：超过时长上限，四角色并行无法在时限内完成。',
    );
  }
  return parts.join('');
};

/** 判定是否应当降级（在执行**之前**就按预算决定，而不是跑到一半才放弃）。 */
export const shouldDegrade = (input: {
  readonly estimate: TriangleEstimate;
  readonly budget: TriangleBudget;
}): TriangleDegradeReason | null => {
  // 预估**上限**超预算就降级：等到真的超了才降级，前面的角色投入已经浪费。
  if (input.estimate.estimatedTokenRange.max > input.budget.maxTokens)
    return 'token-budget-exceeded';
  if (input.estimate.estimatedDurationMs.max > input.budget.maxDurationMs)
    return 'duration-exceeded';
  return null;
};
