import { assessStrategyInitialPublication, type StrategyAutonomyAction } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';
import { replayStrategyRangeWorkflow } from './replay-strategy-range.js';

/**
 * 自动暂停阈值（docs/ddd/strategy-ai-lifecycle-detailed-design.md §3.1，已冻结）。
 * 只允许通过改代码变更，不做运行期配置（DDD §6 红线）。
 */
export const STRATEGY_AUTONOMY_PAUSE_THRESHOLDS = {
  horizon: 't5',
  minSampleCount: 20,
  minBenchmarkCoverage: 0.9,
  maxAvgExcessReturn: 0,
  maxMedianExcessReturn: 0,
  cooldownDays: 30,
} as const;

/**
 * 提议冷却与自动验证窗口（docs/ddd/strategy-ai-lifecycle-detailed-design.md §3.2/§3.3，
 * 已冻结）。只允许通过改代码变更，不做运行期配置（DDD §6 红线）。
 * 验证窗口与既有事实观察默认窗口同口径（30 个自然日，约 20+ 个交易日，覆盖晋级门
 * ≥20 验证交易日的输入要求）；窗口结束于昨天，避开当日尚未完成的 PIT 数据。
 */
export const STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS = 7;
export const STRATEGY_AUTONOMY_VALIDATION_WINDOW_DAYS = 30;

/**
 * 自动归档与全新策略提议限额（docs/ddd/strategy-ai-lifecycle-detailed-design.md §9，
 * 已冻结）。只允许通过改代码变更，不做运行期配置（DDD §6 红线）。
 */
export const STRATEGY_AUTONOMY_ARCHIVE_MIN_PAUSED_DAYS = 28;
export const STRATEGY_AUTONOMY_NEW_STRATEGY_WEEKLY_LIMIT = 1;

const DAY_MS = 86_400_000;

/** UTC 当日 00:00（与 Web 历史评估 session 的 from/to 口径一致）。 */
const utcMidnight = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const StrategyAutonomyWeeklyInput = z.object({
  mode: z.enum(['manual', 'scheduled']).default('manual'),
});
export type StrategyAutonomyWeeklyInputT = z.infer<typeof StrategyAutonomyWeeklyInput>;

const AutonomyItemSchema = z.object({
  strategyId: z.string().min(1),
  strategyName: z.string().min(1),
  decision: z.enum(['paused', 'kept', 'error']),
  reasons: z.array(z.string()),
  actionId: z.string().min(1).optional(),
  /** AI 解释文本的提供者；AI 未配置/失败时缺省（动作照常完成）。 */
  narrativeProvider: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const ProposalItemSchema = z.object({
  strategyId: z.string().min(1),
  strategyName: z.string().min(1),
  /** validating=已进入自动验证；skipped=当周不提议；failed=已落 failed 审计动作；error=步骤异常。 */
  decision: z.enum(['validating', 'skipped', 'failed', 'error']),
  reasons: z.array(z.string()),
  actionId: z.string().min(1).optional(),
  strategyVersionId: z.string().min(1).optional(),
  evaluationSessionId: z.string().min(1).optional(),
  /** AI 提议的提供者；AI 不可用而当周跳过时缺省。 */
  proposalProvider: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const AutonomyPauseOutput = z.object({
  evaluated: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(AutonomyItemSchema),
});

const ProposalSectionSchema = z.object({
  evaluated: z.number().int().nonnegative(),
  validating: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(ProposalItemSchema),
});

const ValidationItemSchema = z.object({
  actionId: z.string().min(1),
  strategyId: z.string().min(1),
  evaluationSessionId: z.string().min(1).optional(),
  /**
   * advanced=推进后 session 已 complete；already-complete=session 本就是 complete；
   * incomplete=推进后 session 仍未 complete（留待下周续跑）；error=推进失败（已记 lastError）。
   */
  decision: z.enum(['advanced', 'already-complete', 'incomplete', 'error']),
  reasons: z.array(z.string()),
  error: z.string().min(1).optional(),
});

const PromotionItemSchema = z.object({
  actionId: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1).optional(),
  /**
   * published=已自动发布；blocked=晋级门未通过进人工队列；retry=发布失败保留 eligible
   * 下周重试；pending=session 未 complete 不评估；error=步骤异常。
   */
  decision: z.enum(['published', 'blocked', 'retry', 'pending', 'error']),
  reasons: z.array(z.string()),
  error: z.string().min(1).optional(),
});

const ArchiveItemSchema = z.object({
  strategyId: z.string().min(1),
  strategyName: z.string().min(1),
  /** archived=已归档（终态）；kept=不满足归档条件；error=步骤异常。 */
  decision: z.enum(['archived', 'kept', 'error']),
  reasons: z.array(z.string()),
  actionId: z.string().min(1).optional(),
  /** AI 解释文本的提供者；AI 未配置/失败时缺省（动作照常完成）。 */
  narrativeProvider: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

const AutonomyArchiveOutput = AutonomyPauseOutput.extend({
  archive: z.object({
    evaluated: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    items: z.array(ArchiveItemSchema),
  }),
});

const AutonomyProposalOutput = AutonomyArchiveOutput.extend({
  proposals: ProposalSectionSchema,
});

const AutonomyValidationOutput = AutonomyProposalOutput.extend({
  validation: z.object({
    evaluated: z.number().int().nonnegative(),
    advanced: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    items: z.array(ValidationItemSchema),
  }),
});

export const StrategyAutonomyWeeklyOutput = AutonomyValidationOutput.extend({
  promotion: z.object({
    evaluated: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    retry: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    items: z.array(PromotionItemSchema),
  }),
});
export type StrategyAutonomyWeeklyOutputT = z.infer<typeof StrategyAutonomyWeeklyOutput>;

const errorText = (error: {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

interface PauseThresholdStats {
  readonly sampleCount: number;
  readonly benchmarkCoverage: number;
  readonly avgExcessReturn?: number;
  readonly medianExcessReturn?: number;
  readonly blockers: readonly string[];
}

/**
 * 暂停阈值（§3.1）的 T+5 统计读取与判定，自动暂停与自动归档（§9.1）共用：
 * blockers 为空表示命中全部暂停阈值。
 */
const readPauseThresholdStats = async (
  ctx: WorkflowContext,
  strategyId: string,
): Promise<
  | { readonly ok: true; readonly stats: PauseThresholdStats }
  | { readonly ok: false; readonly error: string }
> => {
  const thresholds = STRATEGY_AUTONOMY_PAUSE_THRESHOLDS;
  const facts = await ctx.tools.get_strategy_insight_facts.execute({ strategyId });
  if (!facts.ok) return { ok: false, error: errorText(facts.error) };
  const t5 = facts.data.observations.find((item) => item.horizon === thresholds.horizon);
  const sampleCount = t5?.complete ?? 0;
  const benchmarkCoverage = t5?.benchmarkCoverage ?? 0;
  const avgExcessReturn = t5?.averageExcessReturnPct;
  const medianExcessReturn = t5?.medianExcessReturnPct;
  const blockers: string[] = [];
  if (sampleCount < thresholds.minSampleCount) {
    blockers.push(`完整样本不足（${sampleCount} < ${thresholds.minSampleCount}）`);
  }
  if (benchmarkCoverage < thresholds.minBenchmarkCoverage) {
    blockers.push(
      `benchmark 覆盖不足（${benchmarkCoverage.toFixed(2)} < ${thresholds.minBenchmarkCoverage}）`,
    );
  }
  if (avgExcessReturn === undefined || avgExcessReturn >= thresholds.maxAvgExcessReturn) {
    blockers.push('平均超额收益未显著为负');
  }
  if (medianExcessReturn === undefined || medianExcessReturn >= thresholds.maxMedianExcessReturn) {
    blockers.push('超额收益中位数未显著为负');
  }
  return {
    ok: true,
    stats: {
      sampleCount,
      benchmarkCoverage,
      ...(avgExcessReturn === undefined ? {} : { avgExcessReturn }),
      ...(medianExcessReturn === undefined ? {} : { medianExcessReturn }),
      blockers,
    },
  };
};

/**
 * §3.1 自动暂停（先止损再优化）：对每个 active 用户策略读取 T+5 观察统计，
 * 命中全部冻结阈值且不在冷却窗口内则暂停并落 kind=pause 的审计动作。
 * per-strategy 事实走 get_strategy_insight_facts（确定性 read，不经 AI）；
 * AI 解释文本复用 generate_strategy_insight，provider=facts-only 或失败时 aiNarrative 缺省。
 */
const runAutonomy: WorkflowStep = async (_prev, ctx) => {
  const thresholds = STRATEGY_AUTONOMY_PAUSE_THRESHOLDS;
  const now = ctx.clock();
  const listed = await ctx.tools.list_strategies.execute({
    filter: { status: 'active', owner: 'user' },
  });
  if (!listed.ok) return listed;

  const items: z.infer<typeof AutonomyItemSchema>[] = [];
  for (const strategy of listed.data.strategies) {
    try {
      const evaluated = await readPauseThresholdStats(ctx, strategy.id);
      if (!evaluated.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['观察事实读取失败'],
          error: evaluated.error,
        });
        continue;
      }
      const { sampleCount, benchmarkCoverage, avgExcessReturn, medianExcessReturn, blockers } =
        evaluated.stats;
      if (blockers.length > 0) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'kept',
          reasons: [...blockers],
        });
        continue;
      }
      const cooldownSince = new Date(now.getTime() - thresholds.cooldownDays * DAY_MS);
      const recentPauses = await ctx.tools.list_strategy_autonomy_actions.execute({
        strategyId: strategy.id,
        kind: 'pause',
        since: cooldownSince,
        limit: 1,
      });
      if (!recentPauses.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['冷却窗口历史读取失败'],
          error: errorText(recentPauses.error),
        });
        continue;
      }
      if (recentPauses.data.total > 0) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'kept',
          reasons: [`冷却窗口内（${thresholds.cooldownDays} 个自然日）已存在 pause 动作`],
        });
        continue;
      }

      const paused = await ctx.tools.pause_strategy.execute({ strategyId: strategy.id });
      if (!paused.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['暂停执行失败'],
          error: errorText(paused.error),
        });
        continue;
      }

      let aiNarrative: string | undefined;
      let narrativeProvider: string | undefined;
      const insight = await ctx.tools.generate_strategy_insight.execute({
        strategyId: strategy.id,
      });
      if (insight.ok && insight.data.provider !== 'facts-only') {
        aiNarrative = `${insight.data.insight.headline}：${insight.data.insight.summary}`;
        narrativeProvider = insight.data.provider;
      } else if (!insight.ok) {
        ctx.logger.warn('strategy-autonomy-weekly: AI 解释文本生成失败，aiNarrative 缺省', {
          strategyId: strategy.id,
          error: insight.error,
        });
      }

      const actionId = `strategy-autonomy-action-${globalThis.crypto.randomUUID()}`;
      const created = await ctx.tools.create_strategy_autonomy_action.execute({
        action: {
          id: actionId,
          kind: 'pause',
          status: 'executed',
          strategyId: strategy.id,
          trigger: 'weekly-review',
          ruleSnapshot: {
            sampleCount,
            benchmarkCoverage,
            avgExcessReturn,
            medianExcessReturn,
            thresholds: { ...thresholds },
          },
          ...(aiNarrative === undefined ? {} : { aiNarrative }),
          factReferences: [`strategy-insight-facts:${strategy.id}:${thresholds.horizon}`],
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
      });
      if (!created.ok) {
        // 暂停已生效但审计落库失败：动作不回滚，按单策略失败记录，人工可补查。
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['暂停已生效，审计动作落库失败'],
          ...(narrativeProvider === undefined ? {} : { narrativeProvider }),
          error: errorText(created.error),
        });
        continue;
      }
      items.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        decision: 'paused',
        reasons: [
          `T+5 完整样本 ${sampleCount}、benchmark 覆盖 ${benchmarkCoverage.toFixed(2)}、平均超额 ${(avgExcessReturn as number).toFixed(4)}、中位数超额 ${(medianExcessReturn as number).toFixed(4)} 命中全部暂停阈值`,
        ],
        actionId,
        ...(narrativeProvider === undefined ? {} : { narrativeProvider }),
      });
    } catch (error) {
      items.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        decision: 'error',
        reasons: ['策略处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return AutonomyPauseOutput.parse({
    evaluated: items.length,
    paused: items.filter((item) => item.decision === 'paused').length,
    failed: items.filter((item) => item.decision === 'error').length,
    items,
  });
};

/**
 * §9.1 自动归档（在暂停之后）：对 status=paused 且 owner=user 的策略，满足全部冻结条件
 * 则归档——最近一次 kind=pause 的自治动作（trigger=weekly-review）距今 ≥28 个自然日，
 * 且当前 T+5 统计仍命中全部暂停阈值。执行 archive_strategy（同时移除调度配置）并落
 * kind=archive 动作（创建即 executed，ruleSnapshot 含 pause 五 key + pausedSinceDays）。
 * 人工暂停（无自治 pause 动作）不参与归档；draft/active 策略不在本步骤的列表过滤内。
 */
const runArchival: WorkflowStep = async (prev, ctx) => {
  const carried = AutonomyPauseOutput.parse(prev);
  const now = ctx.clock();
  const listed = await ctx.tools.list_strategies.execute({
    filter: { status: 'paused', owner: 'user' },
  });
  if (!listed.ok) return listed;

  const items: z.infer<typeof ArchiveItemSchema>[] = [];
  for (const strategy of listed.data.strategies) {
    try {
      const pauses = await ctx.tools.list_strategy_autonomy_actions.execute({
        strategyId: strategy.id,
        kind: 'pause',
        limit: 1,
      });
      if (!pauses.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['暂停历史读取失败'],
          error: errorText(pauses.error),
        });
        continue;
      }
      // list 按 createdAt 倒序，取最近一次自治 pause 动作。
      const lastPause = pauses.data.actions[0];
      if (lastPause === undefined) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'kept',
          reasons: ['无自治 pause 动作（人工暂停不参与自动归档）'],
        });
        continue;
      }
      const pausedSinceDays = Math.floor((now.getTime() - lastPause.createdAt.getTime()) / DAY_MS);
      if (pausedSinceDays < STRATEGY_AUTONOMY_ARCHIVE_MIN_PAUSED_DAYS) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'kept',
          reasons: [
            `自治暂停未满 ${STRATEGY_AUTONOMY_ARCHIVE_MIN_PAUSED_DAYS} 个自然日（已 ${pausedSinceDays} 天）`,
          ],
        });
        continue;
      }
      const evaluated = await readPauseThresholdStats(ctx, strategy.id);
      if (!evaluated.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['观察事实读取失败'],
          error: evaluated.error,
        });
        continue;
      }
      const { sampleCount, benchmarkCoverage, avgExcessReturn, medianExcessReturn, blockers } =
        evaluated.stats;
      if (blockers.length > 0) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'kept',
          reasons: blockers.map((blocker) => `当前统计不再满足归档条件：${blocker}`),
        });
        continue;
      }

      const archived = await ctx.tools.archive_strategy.execute({ strategyId: strategy.id });
      if (!archived.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['归档执行失败'],
          error: errorText(archived.error),
        });
        continue;
      }

      let aiNarrative: string | undefined;
      let narrativeProvider: string | undefined;
      const insight = await ctx.tools.generate_strategy_insight.execute({
        strategyId: strategy.id,
      });
      if (insight.ok && insight.data.provider !== 'facts-only') {
        aiNarrative = `${insight.data.insight.headline}：${insight.data.insight.summary}`;
        narrativeProvider = insight.data.provider;
      } else if (!insight.ok) {
        ctx.logger.warn('strategy-autonomy-weekly: AI 解释文本生成失败，aiNarrative 缺省', {
          strategyId: strategy.id,
          error: insight.error,
        });
      }

      const actionId = `strategy-autonomy-action-${globalThis.crypto.randomUUID()}`;
      const created = await ctx.tools.create_strategy_autonomy_action.execute({
        action: {
          id: actionId,
          kind: 'archive',
          status: 'executed',
          strategyId: strategy.id,
          trigger: 'weekly-review',
          ruleSnapshot: {
            sampleCount,
            benchmarkCoverage,
            avgExcessReturn,
            medianExcessReturn,
            thresholds: {
              ...STRATEGY_AUTONOMY_PAUSE_THRESHOLDS,
              minPausedDays: STRATEGY_AUTONOMY_ARCHIVE_MIN_PAUSED_DAYS,
            },
            pausedSinceDays,
          },
          ...(aiNarrative === undefined ? {} : { aiNarrative }),
          factReferences: [
            `strategy-insight-facts:${strategy.id}:${STRATEGY_AUTONOMY_PAUSE_THRESHOLDS.horizon}`,
            `strategy-autonomy-action:${lastPause.id}`,
          ],
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
      });
      if (!created.ok) {
        // 归档已生效但审计落库失败：动作不回滚，按单策略失败记录，人工可补查。
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['归档已生效，审计动作落库失败'],
          ...(narrativeProvider === undefined ? {} : { narrativeProvider }),
          error: errorText(created.error),
        });
        continue;
      }
      items.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        decision: 'archived',
        reasons: [
          `自治暂停已满 ${pausedSinceDays} 天且当前 T+5 统计仍命中全部暂停阈值，归档为终态`,
        ],
        actionId,
        ...(narrativeProvider === undefined ? {} : { narrativeProvider }),
      });
    } catch (error) {
      items.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        decision: 'error',
        reasons: ['策略归档处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return AutonomyArchiveOutput.parse({
    ...carried,
    archive: {
      evaluated: items.length,
      archived: items.filter((item) => item.decision === 'archived').length,
      failed: items.filter((item) => item.decision === 'error').length,
      items,
    },
  });
};

/**
 * §3.2/§3.3 AI 提议 + 自动验证：对每个未被本周暂停的 active 用户策略，
 * 冷却（7 天内已有 propose-version 动作则跳过）→ 事实装配（get_strategy_experiment_context）
 * → AI 提议（generate_strategy_version_proposal，workflow-only）→ definitionHash 去重
 * → create_strategy_version → validate → session → propose-version 动作 → validating。
 * §9.2：AI 也可返回全新策略提议（kind=new-strategy，全局限额每周 1 个），链路为
 * create_strategy（draft）→ 首版本 → validate → session → 动作；首发无基线，
 * 门禁复核走 assessStrategyInitialPublication 而非 assessStrategyPromotion。
 * AI 未配置/调用失败（adapter_error）当周跳过不落动作；AI 输出不合规、版本校验
 * invalid 或 session 创建失败落 failed 动作。session 的逐日推进复用既有 evaluation
 * 作业化机制（replay-strategy-range），本步骤不同步等待。
 */
const runProposals: WorkflowStep = async (prev, ctx) => {
  const autonomy = AutonomyArchiveOutput.parse(prev);
  const now = ctx.clock();
  const pausedThisRun = new Set(
    autonomy.items.filter((item) => item.decision === 'paused').map((item) => item.strategyId),
  );
  const listed = await ctx.tools.list_strategies.execute({
    filter: { status: 'active', owner: 'user' },
  });
  if (!listed.ok) return listed;

  // §9.2 限额：每周最多 1 个全新策略提议（全局限额，跨周次按动作 ruleSnapshot 标记判定）。
  const newStrategySince = new Date(
    now.getTime() - STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS * DAY_MS,
  );
  const recentProposalsAll = await ctx.tools.list_strategy_autonomy_actions.execute({
    kind: 'propose-version',
    since: newStrategySince,
    limit: 1000,
  });
  if (!recentProposalsAll.ok) return recentProposalsAll;
  let newStrategyQuotaUsed =
    recentProposalsAll.data.actions.filter(
      (action) => action.ruleSnapshot?.proposalKind === 'new-strategy',
    ).length >= STRATEGY_AUTONOMY_NEW_STRATEGY_WEEKLY_LIMIT;

  const windowTo = new Date(utcMidnight(now).getTime() - DAY_MS);
  const windowFrom = new Date(
    windowTo.getTime() - (STRATEGY_AUTONOMY_VALIDATION_WINDOW_DAYS - 1) * DAY_MS,
  );

  /** 已创建（或无需）版本后落 failed 审计动作：drafted → failed，保留 lastError。 */
  const recordFailedProposal = async (input: {
    readonly strategyId: string;
    readonly lastError: string;
    readonly ruleSnapshot: Record<string, unknown>;
    readonly factReferences: readonly string[];
    readonly strategyVersionId?: string;
  }): Promise<{ readonly actionId: string; readonly ok: boolean; readonly error?: string }> => {
    const actionId = `strategy-autonomy-action-${globalThis.crypto.randomUUID()}`;
    const created = await ctx.tools.create_strategy_autonomy_action.execute({
      action: {
        id: actionId,
        kind: 'propose-version',
        status: 'drafted',
        strategyId: input.strategyId,
        ...(input.strategyVersionId === undefined
          ? {}
          : { strategyVersionId: input.strategyVersionId }),
        trigger: 'weekly-review',
        ruleSnapshot: input.ruleSnapshot,
        factReferences: [...input.factReferences],
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!created.ok) return { actionId, ok: false, error: errorText(created.error) };
    const transitioned = await ctx.tools.transition_strategy_autonomy_action.execute({
      id: actionId,
      expectedStatus: 'drafted',
      status: 'failed',
      lastError: input.lastError,
    });
    if (!transitioned.ok) return { actionId, ok: false, error: errorText(transitioned.error) };
    return { actionId, ok: true };
  };

  /**
   * 候选版本创建后的公共尾段（调参与全新策略分支共用）：validate → 建验证窗口 session →
   * 落 kind=propose-version 动作（drafted）→ 转移 validating；失败按既有语义落 failed
   * 动作或记 error（已生效的版本/session 不回滚，人工可补查）。
   */
  const startValidation = async (input: {
    readonly strategyId: string;
    readonly strategyName: string;
    readonly candidateId: string;
    readonly candidateVersion: number;
    readonly ruleSnapshot: Record<string, unknown>;
    readonly factReferences: readonly string[];
    readonly proposalProvider: string;
  }): Promise<z.infer<typeof ProposalItemSchema>> => {
    const validated = await ctx.tools.validate_strategy_version.execute({
      versionId: input.candidateId,
      strategyId: input.strategyId,
    });
    if (!validated.ok || validated.data.version.validationStatus !== 'valid') {
      const lastError = !validated.ok
        ? errorText(validated.error)
        : `候选版本校验未通过: ${validated.data.version.validationErrors.join('; ')}`;
      const recorded = await recordFailedProposal({
        strategyId: input.strategyId,
        lastError,
        ruleSnapshot: input.ruleSnapshot,
        factReferences: input.factReferences,
        strategyVersionId: input.candidateId,
      });
      return {
        strategyId: input.strategyId,
        strategyName: input.strategyName,
        decision: recorded.ok ? 'failed' : 'error',
        reasons: [lastError],
        actionId: recorded.actionId,
        strategyVersionId: input.candidateId,
        proposalProvider: input.proposalProvider,
        ...(recorded.error === undefined ? {} : { error: recorded.error }),
      };
    }

    const session = await ctx.tools.start_strategy_evaluation_session.execute({
      strategyId: input.strategyId,
      versionId: input.candidateId,
      from: windowFrom,
      to: windowTo,
    });
    if (!session.ok) {
      const lastError = `验证 session 创建失败: ${errorText(session.error)}`;
      const recorded = await recordFailedProposal({
        strategyId: input.strategyId,
        lastError,
        ruleSnapshot: input.ruleSnapshot,
        factReferences: input.factReferences,
        strategyVersionId: input.candidateId,
      });
      return {
        strategyId: input.strategyId,
        strategyName: input.strategyName,
        decision: recorded.ok ? 'failed' : 'error',
        reasons: [lastError],
        actionId: recorded.actionId,
        strategyVersionId: input.candidateId,
        proposalProvider: input.proposalProvider,
        ...(recorded.error === undefined ? {} : { error: recorded.error }),
      };
    }

    const actionId = `strategy-autonomy-action-${globalThis.crypto.randomUUID()}`;
    const createdAction = await ctx.tools.create_strategy_autonomy_action.execute({
      action: {
        id: actionId,
        kind: 'propose-version',
        status: 'drafted',
        strategyId: input.strategyId,
        strategyVersionId: input.candidateId,
        evaluationSessionId: session.data.session.id,
        trigger: 'weekly-review',
        ruleSnapshot: input.ruleSnapshot,
        factReferences: [...input.factReferences],
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!createdAction.ok) {
      return {
        strategyId: input.strategyId,
        strategyName: input.strategyName,
        decision: 'error',
        reasons: ['版本与验证 session 已生效，审计动作落库失败'],
        strategyVersionId: input.candidateId,
        evaluationSessionId: session.data.session.id,
        proposalProvider: input.proposalProvider,
        error: errorText(createdAction.error),
      };
    }
    const validating = await ctx.tools.transition_strategy_autonomy_action.execute({
      id: actionId,
      expectedStatus: 'drafted',
      status: 'validating',
    });
    if (!validating.ok) {
      return {
        strategyId: input.strategyId,
        strategyName: input.strategyName,
        decision: 'error',
        reasons: ['审计动作 drafted → validating 转移失败'],
        actionId,
        strategyVersionId: input.candidateId,
        evaluationSessionId: session.data.session.id,
        proposalProvider: input.proposalProvider,
        error: errorText(validating.error),
      };
    }
    return {
      strategyId: input.strategyId,
      strategyName: input.strategyName,
      decision: 'validating',
      reasons: [
        `AI 提议版本 v${input.candidateVersion} 校验通过，已创建 ${STRATEGY_AUTONOMY_VALIDATION_WINDOW_DAYS} 天验证窗口的独立评估 session`,
      ],
      actionId,
      strategyVersionId: input.candidateId,
      evaluationSessionId: session.data.session.id,
      proposalProvider: input.proposalProvider,
    };
  };

  const items: z.infer<typeof ProposalItemSchema>[] = [];
  for (const strategy of listed.data.strategies) {
    try {
      if (pausedThisRun.has(strategy.id)) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'skipped',
          reasons: ['本周刚被自动暂停，跳过提议'],
        });
        continue;
      }
      const cooldownSince = new Date(
        now.getTime() - STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS * DAY_MS,
      );
      const recentProposals = await ctx.tools.list_strategy_autonomy_actions.execute({
        strategyId: strategy.id,
        kind: 'propose-version',
        since: cooldownSince,
        limit: 1,
      });
      if (!recentProposals.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['提议冷却历史读取失败'],
          error: errorText(recentProposals.error),
        });
        continue;
      }
      if (recentProposals.data.total > 0) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'skipped',
          reasons: [
            `冷却窗口内（${STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS} 个自然日）已存在 propose-version 动作`,
          ],
        });
        continue;
      }

      const experiment = await ctx.tools.get_strategy_experiment_context.execute({
        strategyId: strategy.id,
      });
      if (!experiment.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['实验上下文装配失败'],
          error: errorText(experiment.error),
        });
        continue;
      }
      const baseVersion = experiment.data.baseVersion;
      if (baseVersion === undefined) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'skipped',
          reasons: ['缺少已发布基线版本，无法提议调参'],
        });
        continue;
      }
      const baseReferences = [
        `strategy:${strategy.id}`,
        `strategy-version:${baseVersion.id}`,
        `definition-hash:${baseVersion.definitionHash}`,
      ];

      const proposed = await ctx.tools.generate_strategy_version_proposal.execute({
        strategyId: strategy.id,
      });
      if (!proposed.ok) {
        if (proposed.error.kind === 'adapter_error') {
          // AI 未配置/调用失败：当周跳过，不落动作（DDD §6；下周冷却窗口外自动重试）。
          items.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            decision: 'skipped',
            reasons: ['AI 不可用，当周跳过提议'],
            error: errorText(proposed.error),
          });
          continue;
        }
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['AI 提议生成失败'],
          error: errorText(proposed.error),
        });
        continue;
      }
      if (!proposed.data.proposed) {
        if (proposed.data.reasonCode === 'invalid-output') {
          const recorded = await recordFailedProposal({
            strategyId: strategy.id,
            lastError: proposed.data.reason,
            ruleSnapshot: {
              baseVersionId: baseVersion.id,
              baseDefinitionHash: baseVersion.definitionHash,
              proposalProvider: proposed.data.provider,
            },
            factReferences: baseReferences,
          });
          items.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            decision: recorded.ok ? 'failed' : 'error',
            reasons: [proposed.data.reason],
            proposalProvider: proposed.data.provider,
            actionId: recorded.actionId,
            ...(recorded.error === undefined ? {} : { error: recorded.error }),
          });
          continue;
        }
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'skipped',
          reasons: [proposed.data.reason],
          proposalProvider: proposed.data.provider,
        });
        continue;
      }
      const proposal = proposed.data.proposal;

      if (proposal.kind === 'new-strategy') {
        // §9.2 全新策略分支：create_strategy（初始 draft，发布前无 schedule）→ 首版本 →
        // 校验 → 验证 session → propose-version 动作；全局限额每周 1 个。
        if (newStrategyQuotaUsed) {
          items.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            decision: 'skipped',
            reasons: [
              `每周全新策略提议全局限额（${STRATEGY_AUTONOMY_NEW_STRATEGY_WEEKLY_LIMIT} 个）已用完`,
            ],
            proposalProvider: proposed.data.provider,
          });
          continue;
        }
        const createdStrategy = await ctx.tools.create_strategy.execute({
          name: proposal.name,
          description: proposal.description,
        });
        if (!createdStrategy.ok) {
          const lastError = `全新策略创建失败: ${errorText(createdStrategy.error)}`;
          const recorded = await recordFailedProposal({
            strategyId: strategy.id,
            lastError,
            ruleSnapshot: {
              proposalKind: 'new-strategy',
              proposalProvider: proposed.data.provider,
            },
            factReferences: baseReferences,
          });
          items.push({
            strategyId: strategy.id,
            strategyName: strategy.name,
            decision: recorded.ok ? 'failed' : 'error',
            reasons: [lastError],
            actionId: recorded.actionId,
            proposalProvider: proposed.data.provider,
            ...(recorded.error === undefined ? {} : { error: recorded.error }),
          });
          continue;
        }
        newStrategyQuotaUsed = true;
        const newStrategy = createdStrategy.data.strategy;
        const newReferences = [`strategy:${newStrategy.id}`, ...proposal.factReferences];
        const newRuleSnapshot = {
          proposalKind: 'new-strategy',
          proposalProvider: proposed.data.provider,
          cooldownDays: STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS,
          validationWindowDays: STRATEGY_AUTONOMY_VALIDATION_WINDOW_DAYS,
        };
        const createdNewVersion = await ctx.tools.create_strategy_version.execute({
          strategyId: newStrategy.id,
          definition: proposal.definition,
          changeSummary: proposal.changeSummary,
          factReferences: proposal.factReferences,
        });
        if (!createdNewVersion.ok) {
          const lastError = `全新策略首个版本创建失败: ${errorText(createdNewVersion.error)}`;
          const recorded = await recordFailedProposal({
            strategyId: newStrategy.id,
            lastError,
            ruleSnapshot: newRuleSnapshot,
            factReferences: newReferences,
          });
          items.push({
            strategyId: newStrategy.id,
            strategyName: newStrategy.name,
            decision: recorded.ok ? 'failed' : 'error',
            reasons: [lastError],
            actionId: recorded.actionId,
            proposalProvider: proposed.data.provider,
            ...(recorded.error === undefined ? {} : { error: recorded.error }),
          });
          continue;
        }
        const newCandidate = createdNewVersion.data.version;
        items.push(
          await startValidation({
            strategyId: newStrategy.id,
            strategyName: newStrategy.name,
            candidateId: newCandidate.id,
            candidateVersion: newCandidate.version,
            ruleSnapshot: {
              ...newRuleSnapshot,
              candidateVersionId: newCandidate.id,
              candidateDefinitionHash: newCandidate.definitionHash,
            },
            factReferences: newReferences,
            proposalProvider: proposed.data.provider,
          }),
        );
        continue;
      }

      const detail = await ctx.tools.get_strategy.execute({ strategyId: strategy.id });
      if (!detail.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['版本历史读取失败'],
          error: errorText(detail.error),
        });
        continue;
      }
      const unpublishedHashes = new Set(
        detail.data.versions
          .filter((version) => version.publishedAt === undefined)
          .map((version) => version.definitionHash),
      );
      if (unpublishedHashes.has(proposal.definitionHash)) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'skipped',
          reasons: ['AI 提议与现有未发布 draft 的 definitionHash 相同，不重复创建'],
          proposalProvider: proposed.data.provider,
        });
        continue;
      }

      const createdVersion = await ctx.tools.create_strategy_version.execute({
        strategyId: strategy.id,
        definition: proposal.definition,
        changeSummary: proposal.changeSummary,
        parentVersionId: baseVersion.id,
        factReferences: proposal.factReferences,
      });
      if (!createdVersion.ok) {
        items.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          decision: 'error',
          reasons: ['候选版本创建失败'],
          proposalProvider: proposed.data.provider,
          error: errorText(createdVersion.error),
        });
        continue;
      }
      const candidate = createdVersion.data.version;
      const ruleSnapshot = {
        baseVersionId: baseVersion.id,
        baseDefinitionHash: baseVersion.definitionHash,
        candidateVersionId: candidate.id,
        candidateDefinitionHash: candidate.definitionHash,
        proposalProvider: proposed.data.provider,
        cooldownDays: STRATEGY_AUTONOMY_PROPOSE_COOLDOWN_DAYS,
        validationWindowDays: STRATEGY_AUTONOMY_VALIDATION_WINDOW_DAYS,
      };
      const factReferences = [...baseReferences, ...proposal.factReferences];

      items.push(
        await startValidation({
          strategyId: strategy.id,
          strategyName: strategy.name,
          candidateId: candidate.id,
          candidateVersion: candidate.version,
          ruleSnapshot,
          factReferences,
          proposalProvider: proposed.data.provider,
        }),
      );
    } catch (error) {
      items.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        decision: 'error',
        reasons: ['策略提议处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return AutonomyProposalOutput.parse({
    ...autonomy,
    proposals: {
      evaluated: items.length,
      validating: items.filter((item) => item.decision === 'validating').length,
      skipped: items.filter((item) => item.decision === 'skipped').length,
      failed: items.filter((item) => item.decision === 'failed' || item.decision === 'error')
        .length,
      items,
    },
  });
};

/**
 * §3.3 验证 session 推进：对所有 status=validating 的 propose 动作推进其 evaluation session。
 * 逐日推进复用 replay-strategy-range 的既有断点续跑序列（与 Web startEvaluationJob 同一
 * workflow，resumeSessionId 续跑；partial/failed session 先 resume 回 running），
 * workflow 支持嵌套调用（先例：run-strategy-schedules → strategy-daily-cycle）。
 * 推进失败给动作补 lastError（原地补丁走 create_strategy_autonomy_action 的 upsert 语义），
 * 不影响其它动作。
 */
const runValidationSessions: WorkflowStep = async (prev, ctx) => {
  const carried = AutonomyProposalOutput.parse(prev);
  const listed = await ctx.tools.list_strategy_autonomy_actions.execute({
    kind: 'propose-version',
    status: 'validating',
    limit: 1000,
  });
  if (!listed.ok) return listed;

  const items: z.infer<typeof ValidationItemSchema>[] = [];
  for (const action of listed.data.actions) {
    try {
      const patchError = async (lastError: string) => {
        await ctx.tools.create_strategy_autonomy_action.execute({
          action: { ...action, lastError, updatedAt: ctx.clock() },
        });
      };
      if (action.evaluationSessionId === undefined) {
        const lastError = 'validating 动作缺少 evaluationSessionId，无法推进验证';
        await patchError(lastError);
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          decision: 'error',
          reasons: [lastError],
          error: lastError,
        });
        continue;
      }
      const sessionId = action.evaluationSessionId;
      const fetched = await ctx.tools.get_strategy_evaluation_session.execute({ sessionId });
      if (!fetched.ok) {
        const lastError = `验证 session 读取失败: ${errorText(fetched.error)}`;
        await patchError(lastError);
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          evaluationSessionId: sessionId,
          decision: 'error',
          reasons: ['验证 session 读取失败'],
          error: lastError,
        });
        continue;
      }
      const session = fetched.data.session;
      if (session === null) {
        const lastError = `验证 session 不存在: ${sessionId}`;
        await patchError(lastError);
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          evaluationSessionId: sessionId,
          decision: 'error',
          reasons: [lastError],
          error: lastError,
        });
        continue;
      }
      if (session.status === 'complete') {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          evaluationSessionId: sessionId,
          decision: 'already-complete',
          reasons: ['验证 session 已完成，无需推进'],
        });
        continue;
      }
      if (session.status !== 'running') {
        // partial/failed 先重置回 running（与 Web retry 端点同一序列）。
        const resumed = await ctx.tools.resume_strategy_evaluation_session.execute({ sessionId });
        if (!resumed.ok) {
          const lastError = `验证 session 续跑失败: ${errorText(resumed.error)}`;
          await patchError(lastError);
          items.push({
            actionId: action.id,
            strategyId: action.strategyId,
            evaluationSessionId: sessionId,
            decision: 'error',
            reasons: ['验证 session 续跑失败'],
            error: lastError,
          });
          continue;
        }
      }
      const replayed = await replayStrategyRangeWorkflow.run(
        {
          strategyId: session.strategyId,
          versionId: session.strategyVersionId,
          from: session.from,
          to: session.to,
          ...(session.stockIds === undefined ? {} : { stockIds: [...session.stockIds] }),
          persist: true,
          owner: `strategy-autonomy-weekly:${sessionId}`,
          resumeSessionId: sessionId,
        },
        ctx,
      );
      if (!replayed.ok) {
        const lastError = `验证 session 逐日推进失败: ${errorText(replayed.error)}`;
        await patchError(lastError);
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          evaluationSessionId: sessionId,
          decision: 'error',
          reasons: ['验证 session 逐日推进失败'],
          error: lastError,
        });
        continue;
      }
      const after = await ctx.tools.get_strategy_evaluation_session.execute({ sessionId });
      const afterStatus = after.ok ? after.data.session?.status : undefined;
      if (afterStatus === 'complete') {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          evaluationSessionId: sessionId,
          decision: 'advanced',
          reasons: [
            `逐日推进完成（${replayed.data.summary.completedDays}/${replayed.data.summary.tradingDays} 个交易日），session 已 complete`,
          ],
        });
        continue;
      }
      items.push({
        actionId: action.id,
        strategyId: action.strategyId,
        evaluationSessionId: sessionId,
        decision: 'incomplete',
        reasons: [`推进后 session 状态为 ${afterStatus ?? '未知'}，留待下次续跑`],
      });
    } catch (error) {
      items.push({
        actionId: action.id,
        strategyId: action.strategyId,
        ...(action.evaluationSessionId === undefined
          ? {}
          : { evaluationSessionId: action.evaluationSessionId }),
        decision: 'error',
        reasons: ['session 推进处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return AutonomyValidationOutput.parse({
    ...carried,
    validation: {
      evaluated: items.length,
      advanced: items.filter(
        (item) => item.decision === 'advanced' || item.decision === 'already-complete',
      ).length,
      incomplete: items.filter((item) => item.decision === 'incomplete').length,
      failed: items.filter((item) => item.decision === 'error').length,
      items,
    },
  });
};

/**
 * §3.4 门禁复核与自动发布：
 * - validating 且 session complete 的动作：复用 get_strategy_experiment_context 的
 *   promotion 装配（assessStrategyPromotion 阈值不动）；
 *   eligible-for-human-review → validating→eligible→publish→published；
 *   blocked → validating→eligible→blocked（状态机无 validating→blocked 直达边），
 *   lastError 记 reasons 摘要；
 * - session 未 complete → 不评估，留在 validating；
 * - eligible 动作（含上周发布失败保留的）：直接重试 publish，失败保持 eligible 并
 *   原地补 attempts+1/lastError（create_strategy_autonomy_action 的 upsert 语义）。
 */
const runPromotionReview: WorkflowStep = async (prev, ctx) => {
  const carried = AutonomyValidationOutput.parse(prev);
  const now = ctx.clock();
  const [validatingListed, eligibleListed] = await Promise.all([
    ctx.tools.list_strategy_autonomy_actions.execute({
      kind: 'propose-version',
      status: 'validating',
      limit: 1000,
    }),
    ctx.tools.list_strategy_autonomy_actions.execute({
      kind: 'propose-version',
      status: 'eligible',
      limit: 1000,
    }),
  ]);
  if (!validatingListed.ok) return validatingListed;
  if (!eligibleListed.ok) return eligibleListed;

  const items: z.infer<typeof PromotionItemSchema>[] = [];

  /** 发布并重试记账：eligible →（publish）→ published；失败保持 eligible 且 attempts+1。 */
  const publishEligible = async (
    action: StrategyAutonomyAction,
  ): Promise<z.infer<typeof PromotionItemSchema>> => {
    if (action.strategyVersionId === undefined) {
      return {
        actionId: action.id,
        strategyId: action.strategyId,
        decision: 'error',
        reasons: ['eligible 动作缺少 strategyVersionId，无法发布'],
      };
    }
    const published = await ctx.tools.publish_strategy_version.execute({
      versionId: action.strategyVersionId,
      strategyId: action.strategyId,
    });
    if (!published.ok) {
      const lastError = `发布失败: ${errorText(published.error)}`;
      await ctx.tools.create_strategy_autonomy_action.execute({
        action: {
          ...action,
          attempts: action.attempts + 1,
          lastError,
          updatedAt: now,
        },
      });
      return {
        actionId: action.id,
        strategyId: action.strategyId,
        strategyVersionId: action.strategyVersionId,
        decision: 'retry',
        reasons: [`发布失败，保留 eligible 下周重试（attempts=${action.attempts + 1}）`],
        error: lastError,
      };
    }
    const transitioned = await ctx.tools.transition_strategy_autonomy_action.execute({
      id: action.id,
      expectedStatus: 'eligible',
      status: 'published',
    });
    if (!transitioned.ok) {
      return {
        actionId: action.id,
        strategyId: action.strategyId,
        strategyVersionId: action.strategyVersionId,
        decision: 'error',
        reasons: ['版本已发布，但动作 eligible → published 转移失败'],
        error: errorText(transitioned.error),
      };
    }
    return {
      actionId: action.id,
      strategyId: action.strategyId,
      strategyVersionId: action.strategyVersionId,
      decision: 'published',
      reasons: [`候选版本已发布并切换为 currentVersion（v${published.data.version.version}）`],
    };
  };

  for (const action of eligibleListed.data.actions) {
    try {
      items.push(await publishEligible(action));
    } catch (error) {
      items.push({
        actionId: action.id,
        strategyId: action.strategyId,
        decision: 'error',
        reasons: ['发布重试处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const action of validatingListed.data.actions) {
    try {
      if (action.strategyVersionId === undefined || action.evaluationSessionId === undefined) {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          decision: 'error',
          reasons: ['validating 动作缺少 strategyVersionId 或 evaluationSessionId'],
        });
        continue;
      }
      const sessionId = action.evaluationSessionId;
      const fetched = await ctx.tools.get_strategy_evaluation_session.execute({ sessionId });
      if (!fetched.ok) {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'error',
          reasons: ['验证 session 读取失败'],
          error: errorText(fetched.error),
        });
        continue;
      }
      const session = fetched.data.session;
      if (session === null) {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'error',
          reasons: [`验证 session 不存在: ${sessionId}`],
        });
        continue;
      }
      if (session.status !== 'complete') {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'pending',
          reasons: [`验证 session 未 complete（当前 ${session.status}），本周期不评估`],
        });
        continue;
      }

      const experiment = await ctx.tools.get_strategy_experiment_context.execute({
        strategyId: action.strategyId,
        candidateVersionId: action.strategyVersionId,
        validationSessionId: sessionId,
      });
      if (!experiment.ok) {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'error',
          reasons: ['晋级门上下文装配失败'],
          error: errorText(experiment.error),
        });
        continue;
      }
      // §9.2：策略无基线版本（AI 全新策略首发）时用首发门禁 assessStrategyInitialPublication
      // 替代晋级门（不查 base/parent/diff）；指标复用 experiment context 的 promotion 装配。
      const assessment =
        experiment.data.baseVersion === undefined
          ? assessStrategyInitialPublication({
              ...(experiment.data.candidateVersion === undefined
                ? {}
                : { candidateVersion: experiment.data.candidateVersion }),
              validation: {
                sessionId: session.id,
                strategyVersionId: session.strategyVersionId,
                status: session.status,
                tradingDays: experiment.data.promotion.metrics.validationTradingDays,
                vintageCoverageRatio: experiment.data.promotion.metrics.vintageCoverageRatio,
              },
              observations: {
                completeObservationCount:
                  experiment.data.promotion.metrics.completeObservationCount,
                benchmarkCoverageRatio: experiment.data.promotion.metrics.benchmarkCoverageRatio,
              },
            })
          : experiment.data.promotion;
      if (assessment.status === 'blocked') {
        const lastError = `晋级门未通过: ${assessment.reasons.join(', ')}`;
        const eligible = await ctx.tools.transition_strategy_autonomy_action.execute({
          id: action.id,
          expectedStatus: 'validating',
          status: 'eligible',
        });
        if (!eligible.ok) {
          items.push({
            actionId: action.id,
            strategyId: action.strategyId,
            strategyVersionId: action.strategyVersionId,
            decision: 'error',
            reasons: ['动作 validating → eligible 转移失败'],
            error: errorText(eligible.error),
          });
          continue;
        }
        const blocked = await ctx.tools.transition_strategy_autonomy_action.execute({
          id: action.id,
          expectedStatus: 'eligible',
          status: 'blocked',
          lastError,
        });
        if (!blocked.ok) {
          items.push({
            actionId: action.id,
            strategyId: action.strategyId,
            strategyVersionId: action.strategyVersionId,
            decision: 'error',
            reasons: ['动作 eligible → blocked 转移失败'],
            error: errorText(blocked.error),
          });
          continue;
        }
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'blocked',
          reasons: [...assessment.reasons],
        });
        continue;
      }

      const eligible = await ctx.tools.transition_strategy_autonomy_action.execute({
        id: action.id,
        expectedStatus: 'validating',
        status: 'eligible',
      });
      if (!eligible.ok) {
        items.push({
          actionId: action.id,
          strategyId: action.strategyId,
          strategyVersionId: action.strategyVersionId,
          decision: 'error',
          reasons: ['动作 validating → eligible 转移失败'],
          error: errorText(eligible.error),
        });
        continue;
      }
      items.push(await publishEligible(eligible.data.action));
    } catch (error) {
      items.push({
        actionId: action.id,
        strategyId: action.strategyId,
        decision: 'error',
        reasons: ['门禁复核处理异常'],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return StrategyAutonomyWeeklyOutput.parse({
    ...carried,
    promotion: {
      evaluated: items.length,
      published: items.filter((item) => item.decision === 'published').length,
      blocked: items.filter((item) => item.decision === 'blocked').length,
      retry: items.filter((item) => item.decision === 'retry').length,
      pending: items.filter((item) => item.decision === 'pending').length,
      failed: items.filter((item) => item.decision === 'error').length,
      items,
    },
  });
};

export const strategyAutonomyWeeklyWorkflow = defineWorkflow<
  StrategyAutonomyWeeklyInputT,
  StrategyAutonomyWeeklyOutputT
>({
  name: 'strategy-autonomy-weekly',
  description:
    '周度策略自治（M2）：自动暂停跑输策略 → 自治暂停满 28 天仍跑输则自动归档 → AI 提议（调参或每周最多 1 个全新策略）并建验证 session → 推进 validating session → 门禁复核（首发用首发门禁，晋级用晋级门；eligible 自动发布、blocked 进人工队列）；逐策略/逐动作隔离失败',
  input: StrategyAutonomyWeeklyInput,
  steps: [runAutonomy, runArchival, runProposals, runValidationSessions, runPromotionReview],
});
