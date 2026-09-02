import { z } from 'zod';

import { InvariantError } from '../error/index.js';

export const StrategyAutonomyActionKindSchema = z.enum([
  'propose-version',
  'publish-version',
  'pause',
  'archive',
]);
export type StrategyAutonomyActionKind = z.infer<typeof StrategyAutonomyActionKindSchema>;

export const StrategyAutonomyActionStatusSchema = z.enum([
  'drafted',
  'validating',
  'eligible',
  'blocked',
  'confirmed',
  'published',
  'rejected',
  'failed',
  'executed',
]);
export type StrategyAutonomyActionStatus = z.infer<typeof StrategyAutonomyActionStatusSchema>;

/** 首期唯一触发源（DDD §2）。 */
export const StrategyAutonomyActionTriggerSchema = z.enum(['weekly-review']);
export type StrategyAutonomyActionTrigger = z.infer<typeof StrategyAutonomyActionTriggerSchema>;

/** 终态：completedAt 必须且只能在这些状态存在。 */
export const STRATEGY_AUTONOMY_ACTION_TERMINAL_STATUSES = [
  'published',
  'rejected',
  'failed',
  'executed',
] as const satisfies readonly StrategyAutonomyActionStatus[];

/**
 * 状态机（docs/ddd/strategy-ai-lifecycle-detailed-design.md §2.2）。
 * 转移只读 kind/status/ruleSnapshot 等确定性事实字段；aiNarrative 不参与任何转移判定。
 */
export const STRATEGY_AUTONOMY_ACTION_TRANSITIONS: Record<
  StrategyAutonomyActionStatus,
  readonly StrategyAutonomyActionStatus[]
> = {
  drafted: ['validating', 'failed'],
  validating: ['eligible', 'failed'],
  eligible: ['published', 'blocked'],
  blocked: ['confirmed', 'rejected'],
  confirmed: ['published'],
  published: [],
  rejected: [],
  failed: [],
  executed: [],
};

export const assertStrategyAutonomyActionTransition = (
  from: StrategyAutonomyActionStatus,
  to: StrategyAutonomyActionStatus,
): void => {
  if (from === to || !STRATEGY_AUTONOMY_ACTION_TRANSITIONS[from].includes(to)) {
    throw new InvariantError(`StrategyAutonomyAction 不允许 ${from} → ${to} 的状态转移`);
  }
};

/**
 * kind=pause 的 ruleSnapshot 必须包含触发时的完整实测指标与阈值（DDD §2.1），
 * 禁止只记结论。实测 key 与 §3.1 暂停条件一一对应，thresholds 为阈值快照。
 */
export const STRATEGY_AUTONOMY_PAUSE_SNAPSHOT_REQUIRED_KEYS = [
  'sampleCount',
  'benchmarkCoverage',
  'avgExcessReturn',
  'medianExcessReturn',
  'thresholds',
] as const;

/**
 * kind=archive 的 ruleSnapshot 在 pause 五 key 基础上加 pausedSinceDays
 * （docs/ddd/strategy-ai-lifecycle-detailed-design.md §9.1）。
 */
export const STRATEGY_AUTONOMY_ARCHIVE_SNAPSHOT_REQUIRED_KEYS = [
  ...STRATEGY_AUTONOMY_PAUSE_SNAPSHOT_REQUIRED_KEYS,
  'pausedSinceDays',
] as const;

/**
 * Strategy 自主管理动作（提议 / 发布 / 暂停 / 归档）的持久化审计实体（M2-S0）。
 *
 * publish-version 不独立创建：它由 propose-version 的 eligible→published 转移记录，
 * 因此 status 恒为 published；pause 与 archive 创建即终态（executed）。
 */
export const StrategyAutonomyActionSchema = z.object({
  id: z.string().min(1),
  kind: StrategyAutonomyActionKindSchema,
  status: StrategyAutonomyActionStatusSchema,
  strategyId: z.string().min(1),
  /** 提议 / 发布的候选版本；publish-version 创建后不可变。 */
  strategyVersionId: z.string().min(1).optional(),
  evaluationSessionId: z.string().min(1).optional(),
  trigger: StrategyAutonomyActionTriggerSchema,
  /** 触发时的确定性规则与指标快照（纯事实 JSON）。 */
  ruleSnapshot: z.record(z.string(), z.unknown()).optional(),
  /** AI 生成的解释文本；可有可败，失败不阻塞动作。 */
  aiNarrative: z.string().optional(),
  factReferences: z.array(z.string().min(1)).default([]),
  /** 发布重试计数：发布失败保留 eligible 时递增。 */
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().min(1).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
});
export type StrategyAutonomyAction = z.infer<typeof StrategyAutonomyActionSchema>;

const PROPOSE_VERSION_REQUIRES_VERSION_STATUSES: readonly StrategyAutonomyActionStatus[] = [
  'validating',
  'eligible',
  'blocked',
  'confirmed',
  'published',
];

export const assertStrategyAutonomyActionInvariants = (action: StrategyAutonomyAction): void => {
  StrategyAutonomyActionSchema.parse(action);
  if (action.updatedAt < action.createdAt) {
    throw new InvariantError('StrategyAutonomyAction.updatedAt 不能早于 createdAt');
  }
  const terminal = (STRATEGY_AUTONOMY_ACTION_TERMINAL_STATUSES as readonly string[]).includes(
    action.status,
  );
  if (terminal !== (action.completedAt !== undefined)) {
    throw new InvariantError(
      'StrategyAutonomyAction.completedAt 必须且只能在终态（published/rejected/failed/executed）存在',
    );
  }
  if (action.completedAt !== undefined && action.completedAt < action.createdAt) {
    throw new InvariantError('StrategyAutonomyAction.completedAt 不能早于 createdAt');
  }
  if (
    action.kind === 'propose-version' &&
    PROPOSE_VERSION_REQUIRES_VERSION_STATUSES.includes(action.status) &&
    action.strategyVersionId === undefined
  ) {
    throw new InvariantError(
      `propose-version 进入 ${action.status} 必须关联 strategyVersionId（失败应落 failed，不留孤儿）`,
    );
  }
  if (action.kind === 'publish-version') {
    if (action.strategyVersionId === undefined) {
      throw new InvariantError('publish-version 必须关联被发布的 strategyVersionId');
    }
    if (action.status !== 'published') {
      throw new InvariantError(
        'publish-version 由 eligible→published 转移记录，status 必须为 published',
      );
    }
  }
  if (action.kind === 'pause' || action.kind === 'archive') {
    if (action.status !== 'executed') {
      throw new InvariantError(`${action.kind} 创建即终态，status 必须为 executed`);
    }
  }
  if (action.kind === 'publish-version' || action.kind === 'pause' || action.kind === 'archive') {
    if (action.ruleSnapshot === undefined) {
      throw new InvariantError(`${action.kind} 必须携带触发时的 ruleSnapshot`);
    }
  }
  if (action.kind === 'pause' || action.kind === 'archive') {
    const requiredKeys =
      action.kind === 'archive'
        ? STRATEGY_AUTONOMY_ARCHIVE_SNAPSHOT_REQUIRED_KEYS
        : STRATEGY_AUTONOMY_PAUSE_SNAPSHOT_REQUIRED_KEYS;
    const missing = requiredKeys.filter((key) => action.ruleSnapshot?.[key] === undefined);
    if (missing.length > 0) {
      throw new InvariantError(
        `${action.kind} 的 ruleSnapshot 必须包含完整指标与阈值，缺少：${missing.join(', ')}`,
      );
    }
  }
};
