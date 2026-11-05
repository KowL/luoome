import type { AnalysisContext, ToolContext } from '@luoome/core';

import {
  BearRationaleSchema,
  BullRationaleSchema,
  JudgeVerdictSchema,
  RiskOfficerVerdictSchema,
  type TriangleDataHealth,
  triangleEvidenceBelongsToSnapshot,
  triangleGate,
} from '@luoome/core';
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
export type TriangleRoleExecutor = (
  task: TriangleRoleTask,
  prior: readonly TriangleRoleRun[],
) => Promise<unknown>;

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

  const persisted = await input.ctx.repos.analysis.findContext(
    input.context.accountId,
    input.context.id,
  );
  if (
    !persisted ||
    persisted.contextHash !== input.context.contextHash ||
    persisted.subject.kind !== input.context.subject.kind ||
    persisted.subject.id !== input.context.subject.id
  )
    throw new Error('三角分析必须引用同账户的持久化事实快照');
  const context = persisted;

  /**
   * 需求 7：按**预估上限**判降级，而不是跑到一半才放弃——
   * 后者会让前面已投入的角色白花。
   */
  /**
   * REQ-M4-02（修订版）：超预算 / 超时 → **拒绝启动**，不降级。
   *
   * ## 为什么不能降级成单 agent
   *
   * 原实现「只跑裁决官」意味着**跳过风险官**——
   * 三角分析的价值就在四角色互相制衡，砍掉三个只剩裁决官，
   * 产出的「结论」没有任何制衡，而且**风控可以被预算绕过**。
   *
   * ⇒ 要么四角色全跑，要么一个都不跑。
   */
  const budgetBreach =
    input.estimate === undefined
      ? null
      : shouldDegrade({
          estimate: input.estimate,
          budget: input.budget ?? DEFAULT_TRIANGLE_BUDGET,
        });
  if (budgetBreach !== null)
    return {
      contextId: context.id,
      factIds: context.factIds,
      gate,
      // **零角色执行**：不是「跑一个」，是「一个都不跑」。
      roles: [],
      blocked: {
        code: budgetBreach,
        message:
          budgetBreach === 'token-budget-exceeded'
            ? '拒绝启动：预估 token 超出预算上限。请缩小分析范围或调整预算后重试。'
            : '拒绝启动：预估时长超出上限。请缩小分析范围或调整预算后重试。',
      },
      lead: '',
      degraded: null,
      tokenUsed: null,
      elapsedMs: 0,
    };

  const startedAt = input.now();
  const roles: TriangleRoleRun[] = [];
  let blocked: TriangleAssemblyResult['blocked'] = null;
  const runtimeBreach = () => {
    const budget = input.budget ?? DEFAULT_TRIANGLE_BUDGET;
    if (input.now() - startedAt > budget.maxDurationMs) return 'time-budget-exceeded';
    if (roles.reduce((sum, run) => sum + (run.tokenUsed ?? 0), 0) > budget.maxTokens)
      return 'token-budget-exceeded';
    return null;
  };
  for (const role of TRIANGLE_ROLES) {
    const breach = runtimeBreach();
    if (breach) {
      blocked = { code: breach, message: '实际执行超出预算，未完成全部角色审查。' };
      break;
    }
    // **同一个 contextId + 同一份 factIds** 发给每个角色。
    const task: TriangleRoleTask = {
      role,
      contextId: context.id,
      factIds: [...context.factIds],
    };
    const startedAt = input.now();
    const output = await input.executor(Object.freeze(task), structuredClone(roles));
    roles.push({
      role,
      elapsedMs: input.now() - startedAt,
      tokenUsed: extractTokenUsed(output),
      output,
    });
    const raw =
      output !== null && typeof output === 'object' && !Array.isArray(output)
        ? Object.fromEntries(Object.entries(output).filter(([key]) => key !== 'tokenUsed'))
        : output;
    const schema = {
      bull: BullRationaleSchema,
      bear: BearRationaleSchema,
      judge: JudgeVerdictSchema,
      'risk-officer': RiskOfficerVerdictSchema,
    }[role];
    const parsed = schema.safeParse(raw);
    if (!parsed.success || !triangleEvidenceBelongsToSnapshot(parsed.data, context.factIds)) {
      blocked = {
        code: 'invalid-role-output',
        message: `${role} 输出或证据引用不属于当前事实快照。`,
      };
      break;
    }
    if (parsed.data.role === 'risk-officer' && parsed.data.status === 'veto') {
      const vetoId = `triangle:${context.id}`;
      if ((await input.ctx.repos.riskVeto.findVetoById(context.accountId, vetoId)) === null)
        await input.ctx.repos.riskVeto.save({
          id: vetoId,
          accountId: context.accountId,
          subject: context.subject,
          contextId: context.id,
          reason: parsed.data.reason,
          factIds: parsed.data.factIds,
          createdAt: input.ctx.clock(),
        });
      blocked = { code: 'risk_officer_veto', message: parsed.data.reason };
    } else if (parsed.data.role === 'risk-officer' && parsed.data.status === 'need-more-data') {
      blocked = { code: 'risk-officer-needs-data', message: parsed.data.reason };
    } else if (parsed.data.role === 'judge' && parsed.data.status === 'need-more-data') {
      blocked = { code: 'judge-needs-data', message: '裁决官列出了尚未解决的事实缺口。' };
    }
  }

  const finalBreach = runtimeBreach();
  if (blocked === null && finalBreach)
    blocked = { code: finalBreach, message: '实际执行超出预算，本次审查不发布结论。' };
  if (blocked === null) {
    const active = await input.ctx.repos.riskVeto.findActiveBySubject({
      accountId: context.accountId,
      subject: context.subject,
    });
    if (active !== null) blocked = { code: 'risk_officer_veto', message: active.veto.reason };
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
    blocked,
    lead: triangleSummaryLead({ tokenUsed, elapsedMs, degraded: null }),
    // 走到这里说明**没有超预算**，也就没有降级——降级这个状态本身已被取消。
    degraded: null,
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
