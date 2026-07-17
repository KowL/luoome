import {
  type Advice,
  type AdviceDecision,
  AdviceDecisionSchema,
  type AdviceOutcome,
  type AdviceRepository,
  AdviceSubjectKindSchema,
  addMoney,
  type Money,
  MoneySchema,
  money,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetAdviceStatsInput = z.object({
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
});

/**
 * 单层决策统计。
 * 注：core 的 AdviceStats.byDecision 类型是无限递归（byDecision 的每个值仍含
 * 必填 byDecision），没有任何有限值能满足它；因此本工具输出一层拍平的
 * byDecision 分解（叶子不再嵌套），字段与 core AdviceStats 其余部分对齐。
 */
const flatStatsSchema = z.object({
  totalAdvices: z.number().int().nonnegative(),
  avgConfidence: z.number().min(0).max(100),
  outcomeRate: z.object({
    followed: z.number().min(0).max(1),
    partiallyFollowed: z.number().min(0).max(1),
    ignored: z.number().min(0).max(1),
  }),
  pnlWhenFollowed: MoneySchema,
  pnlWhenIgnored: MoneySchema,
  /** confidence >= 70 且 followed 且 pnl > 0 的比例（分母：followed 且已记录 pnl 的条数）。 */
  hitRate: z.number().min(0).max(1),
});

export const GetAdviceStatsOutput = flatStatsSchema.extend({
  byDecision: z.record(AdviceDecisionSchema, flatStatsSchema),
});

type FlatStats = z.infer<typeof flatStatsSchema>;

/**
 * core 的 AdviceRepository v0.1 未暴露 outcome 读取方法；
 * db 的 InMemory / Drizzle 实现都提供 getOutcome。这里做结构化类型守护：
 * 有则读取，无则视为「无 outcome 数据」（统计退化为仅 advice 维度，不报错）。
 */
interface OutcomeReader {
  getOutcome(adviceId: string): Promise<AdviceOutcome | null>;
}

const asOutcomeReader = (repo: AdviceRepository): OutcomeReader | null => {
  const candidate = repo as unknown as Partial<OutcomeReader>;
  return typeof candidate.getOutcome === 'function' ? (repo as unknown as OutcomeReader) : null;
};

const computeFlatStats = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): FlatStats => {
  const totalAdvices = advices.length;
  const avgConfidence =
    totalAdvices === 0
      ? 0
      : Math.round((advices.reduce((sum, a) => sum + a.confidence, 0) / totalAdvices) * 100) / 100;

  let followed = 0;
  let partiallyFollowed = 0;
  let ignored = 0;
  let pnlWhenFollowed: Money = money(0);
  let pnlWhenIgnored: Money = money(0);
  let followedWithPnl = 0;
  let hits = 0;

  for (const advice of advices) {
    const outcome = outcomes.get(advice.id);
    if (outcome === undefined) continue;
    if (outcome.outcome === 'followed') followed += 1;
    else if (outcome.outcome === 'partially_followed') partiallyFollowed += 1;
    else ignored += 1;

    if (outcome.pnl === undefined) continue;
    if (outcome.outcome === 'followed') {
      pnlWhenFollowed = addMoney(pnlWhenFollowed, outcome.pnl);
      followedWithPnl += 1;
      if (advice.confidence >= 70 && outcome.pnl > 0) hits += 1;
    } else if (outcome.outcome === 'ignored') {
      pnlWhenIgnored = addMoney(pnlWhenIgnored, outcome.pnl);
    }
  }

  const rate = (n: number): number => (totalAdvices === 0 ? 0 : n / totalAdvices);

  return {
    totalAdvices,
    avgConfidence,
    outcomeRate: {
      followed: rate(followed),
      partiallyFollowed: rate(partiallyFollowed),
      ignored: rate(ignored),
    },
    pnlWhenFollowed,
    pnlWhenIgnored,
    hitRate: followedWithPnl === 0 ? 0 : hits / followedWithPnl,
  };
};

const byDecisionOf = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): Record<AdviceDecision, FlatStats> => {
  const forDecision = (decision: AdviceDecision): FlatStats =>
    computeFlatStats(
      advices.filter((a) => a.decision === decision),
      outcomes,
    );
  return {
    buy: forDecision('buy'),
    sell: forDecision('sell'),
    hold: forDecision('hold'),
    watch: forDecision('watch'),
    avoid: forDecision('avoid'),
  };
};

export const getAdviceStatsTool = defineTool({
  name: 'get_advice_stats',
  description:
    '聚合建议准确率统计（总条数 / 平均信心度 / outcome 比例 / 命中率 / 按决策分解）；' +
    '复盘口径统计包含已过期 advice',
  sideEffect: 'read',
  input: GetAdviceStatsInput,
  output: GetAdviceStatsOutput,
  handler: async (input, ctx) => {
    const advices = await ctx.repos.advice.query({
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      // 统计复盘不应被有效期截断（ARCHITECTURE §6.4），固定包含过期 advice。
      includeExpired: true,
    });

    const outcomes = new Map<string, AdviceOutcome>();
    const reader = asOutcomeReader(ctx.repos.advice);
    if (reader === null) {
      ctx.logger.warn('get_advice_stats: advice repo 不支持 getOutcome，outcome 维度按空统计', {
        tool: 'get_advice_stats',
      });
    } else {
      await Promise.all(
        advices.map(async (advice) => {
          const outcome = await reader.getOutcome(advice.id);
          if (outcome !== null) outcomes.set(advice.id, outcome);
        }),
      );
    }

    return { ...computeFlatStats(advices, outcomes), byDecision: byDecisionOf(advices, outcomes) };
  },
});
