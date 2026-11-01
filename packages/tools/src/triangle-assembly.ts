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
  /** 四个角色的产出（门禁拒绝时为空）。 */
  readonly roles: readonly TriangleRoleRun[];
  /** 门禁原因（`allowed=false` 时）。 */
  readonly blocked: { readonly code: string; readonly message: string } | null;
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
    };

  if (input.context === null) throw new Error('三角分析需要一份已装配的 AnalysisContext');

  const context = input.context;
  const roles: TriangleRoleRun[] = [];
  for (const role of TRIANGLE_ROLES) {
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

  return {
    contextId: context.id,
    factIds: context.factIds,
    gate,
    roles,
    blocked: null,
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
