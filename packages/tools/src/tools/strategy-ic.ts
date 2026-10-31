// T19 / REQ-M3-13：IC / RankIC 只读工具。
//
// 四件事必须由这一层（而不是 core 的纯函数）保证：
//   1. **次日收益**：只取「该日之后的第一根日线」算收益，绝不用当日收益（否则 IC 虚高 = 前视）；
//   2. **vintage 判定**：某日 run 的信号观察若没有唯一 vintage（无观察 / 混合），该日不计入，
//      而不是猜一个口径；
//   3. **零信号日不丢样本**：IC 只需要分数横截面，信号只是贴 vintage 标签的手段。若 run 所属
//      evaluation session 记了 provenance（backfill / prospective），标签就有确定来源，平静日
//      照算；只有 provenance 未知的存量 session 才退回观察判定；
//   4. 缺失日进 `skippedDays`，不补 0。
import {
  computeStrategyIc,
  isObservableStrategySignal,
  readStrategyRunSnapshot,
  type SignalObservationVintage,
  STRATEGY_IC_MIN_SAMPLE_DAYS,
  type StrategyIcDayInput,
  type StrategyIcMissingDay,
  strategyEvaluationSessionVintage,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

const DAY_MS = 86_400_000;

export const GetStrategyIcInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** 最多读取多少个已完成运行（按 startedAt 倒序），默认 250。 */
  limit: z.number().int().min(1).max(1000).default(250),
});

const VintageSummarySchema = z.object({
  vintage: z.enum(['pit', 'restated', 'legacy']),
  status: z.enum(['ok', 'unavailable']),
  unavailableReason: z.enum(['insufficient-sample', 'no-samples']).nullable(),
  minSampleDays: z.number().int().positive(),
  sampleDays: z.number().int().nonnegative(),
  days: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      sampleSize: z.number().int().nonnegative(),
      ic: z.number(),
      rankIc: z.number(),
    }),
  ),
  missingDays: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      reason: z.enum(['insufficient-cross-section', 'constant-scores', 'missing-next-day-return']),
      pairedStocks: z.number().int().nonnegative(),
    }),
  ),
  meanIc: z.number().nullable(),
  meanRankIc: z.number().nullable(),
  stdRankIc: z.number().nullable(),
  ir: z.number().nullable(),
  positiveRatio: z.number().nullable(),
  limitations: z.array(z.string()),
});

export const GetStrategyIcOutput = z.object({
  strategyId: z.string().min(1),
  minSampleDays: z.number().int().positive(),
  /** 每个 vintage 一组；不同 vintage 绝不合并。 */
  groups: z.array(VintageSummarySchema),
  /**
   * 有评分横截面、但该 run 零信号因而拿不到 vintage 的交易日数。
   * 这是**标注限制**，不是"统计上算不出来"：IC 只需要分数，信号只用来贴 vintage 标签。
   * 只在 provenance 也判不出口径时计数（否则该日由 provenanceDays 计入计算）。
   */
  scoreOnlyDays: z.number().int().nonnegative(),
  /**
   * 零信号日但 provenance 判出了 vintage、因而正常参与 IC 的交易日数。
   * scoreOnlyDays + provenanceDays = 有评分横截面且零信号的交易日总数。
   */
  provenanceDays: z.number().int().nonnegative(),
  /** 无法归属 vintage 而被排除的交易日（不猜口径、不补 0）。 */
  skippedDays: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      reason: z.enum([
        'vintage-unknown',
        'vintage-partial',
        'vintage-mixed',
        'vintage-conflict',
        'duplicate-day',
        'results-missing',
      ]),
    }),
  ),
  limitations: z.array(z.string()),
});

/** 次日收益：该日之后第一根日线 vs 该日（或之前最近一根）日线的简单收益。 */
const nextDayReturns = async (
  ctx: Parameters<Parameters<typeof defineTool>[0]['handler']>[1],
  dataAsOf: Date,
  stockIds: readonly string[],
): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  const windowStart = new Date(dataAsOf.getTime() - 10 * DAY_MS);
  const windowEnd = new Date(dataAsOf.getTime() + 10 * DAY_MS);
  for (const stockId of stockIds) {
    const bars = await ctx.repos.dailyBar.findInRange(stockId, windowStart, windowEnd);
    // 不假设 repo 的返回顺序：base 取「<= 该日」里最晚的一根，next 取「> 该日」里最早的一根。
    // （乱序输入测试覆盖了这一点：直接 .find() 会取到数组里先出现的远期 bar，收益就错了。）
    const sorted = [...bars].sort((left, right) => left.date.getTime() - right.date.getTime());
    const base = [...sorted].reverse().find((bar) => bar.date.getTime() <= dataAsOf.getTime());
    const next = sorted.find((bar) => bar.date.getTime() > dataAsOf.getTime());
    if (base === undefined || next === undefined) continue;
    if (base.close === 0) continue;
    result.set(stockId, next.close / base.close - 1);
  }
  return result;
};

export const getStrategyIcTool = defineTool({
  name: 'get_strategy_ic',
  description:
    '按 vintage 分组计算策略 IC / RankIC（评分与次日收益的横截面相关）；样本 <20 交易日返回 unavailable，缺失日不填 0',
  sideEffect: 'read',
  input: GetStrategyIcInput,
  output: GetStrategyIcOutput,
  handler: async (input, ctx) => {
    const runs = await ctx.repos.strategyRun.listRuns({
      strategyId: input.strategyId,
      status: 'complete',
      ...(input.from === undefined ? {} : { since: input.from }),
      ...(input.to === undefined ? {} : { until: input.to }),
      limit: input.limit,
    });
    const filtered = runs.filter(
      (run) => input.versionId === undefined || run.strategyVersionId === input.versionId,
    );
    if (filtered.length === 0)
      return errNotFound('StrategyRun', `${input.strategyId}${input.versionId ?? ''}`);

    const results = await ctx.repos.strategyRun.listResultsByRuns(filtered.map((run) => run.id));
    const resultsByRun = new Map<string, (typeof results)[number][]>();
    for (const row of results) {
      const bucket = resultsByRun.get(row.runId) ?? [];
      bucket.push(row);
      resultsByRun.set(row.runId, bucket);
    }

    const inputs: StrategyIcDayInput[] = [];
    type SkippedReason =
      | 'vintage-unknown'
      | 'vintage-partial'
      | 'vintage-mixed'
      | 'vintage-conflict'
      | 'duplicate-day'
      | 'results-missing';
    const skippedDays: { dataAsOf: Date; reason: SkippedReason }[] = [];
    let scoreOnlyDays = 0;
    let provenanceDays = 0;
    // run → 所属 evaluation session 的 provenance。同一 session 往往有多日 run（回溯轨一天一个），
    // 所以按 sessionId 缓存，避免 N 次查库。
    const originBySession = new Map<string, 'backfill' | 'prospective' | undefined>();
    const provenanceVintageOf = async (
      snapshot: unknown,
    ): Promise<'pit' | 'restated' | undefined> => {
      const sessionId = readStrategyRunSnapshot(snapshot).evaluationSessionId;
      if (sessionId === undefined) return undefined;
      if (!originBySession.has(sessionId)) {
        const session = await ctx.repos.strategyEvaluation.findSessionById(sessionId);
        originBySession.set(sessionId, session?.origin);
      }
      return strategyEvaluationSessionVintage(originBySession.get(sessionId));
    };
    const seenDays = new Set<number>();
    for (const run of filtered) {
      const dayKey = run.dataAsOf.getTime();
      if (seenDays.has(dayKey)) {
        // 同日多 run：按 listRuns（startedAt 倒序）取首个，其余显式记录，不静默丢弃。
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'duplicate-day' });
        continue;
      }
      seenDays.add(dayKey);
      const rows = (resultsByRun.get(run.id) ?? []).filter(
        (row): row is typeof row & { score: number } => row.score !== undefined,
      );
      if (rows.length === 0) {
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'results-missing' });
        continue;
      }
      const scores = rows.map((row) => ({ stockId: row.stockId, score: row.score }));
      const dayInput = async (vintage: SignalObservationVintage): Promise<StrategyIcDayInput> => ({
        dataAsOf: run.dataAsOf,
        vintage,
        scores,
        nextDayReturns: await nextDayReturns(
          ctx,
          run.dataAsOf,
          rows.map((row) => row.stockId),
        ),
      });
      // session provenance 是**创建期事实**，与观察判定并列的第二条 vintage 来源。
      const provenanceVintage = await provenanceVintageOf(run.inputSnapshot);
      // vintage 判定：该 run 的信号观察必须只有唯一口径，否则不猜。
      const signals = await ctx.repos.strategyRun.signalsByRun(run.id);
      const observations =
        signals.length === 0
          ? []
          : await ctx.repos.signalObservation.list({
              sourceKind: 'strategy-signal',
              sourceIds: signals.map((signal) => signal.id),
              limit: 10_000,
            });
      // vintage 按**每条观察**判定，并要求该 run 的**全部信号**都有观察。
      // 反例（曾经的真 bug）：100 个信号只有 1 个有观察时，用那 1 个给整个 run 贴标签
      // = 用 1 个样本给 100 个信号背书。覆盖不全一律 vintage-partial，不猜。
      const observedSignalIds = new Set(observations.map((row) => row.sourceId));
      // 门禁与写入方契约逐字对齐：写入方只对 isObservableStrategySignal 为真的信号产观察，
      // 所以分母也用同一谓词（而不是全部信号）——把"碰巧相等"变成"契约相等"。
      const observableSignals = signals.filter(isObservableStrategySignal);
      const coveredSignals = observableSignals.filter((signal) =>
        observedSignalIds.has(signal.id),
      ).length;
      if (coveredSignals === 0) {
        // 零信号日：横截面有分数，但没有信号可贴 vintage。IC 只需要分数横截面，标签来自
        // session provenance 时照样能算——不能因为标签贴不上就丢掉本来算得出的样本。
        // （信号存在却零观察 = 观察写入失败，仍按 vintage-unknown 跳过，不当成平静日。）
        if (signals.length === 0 && provenanceVintage !== undefined) {
          provenanceDays += 1;
          inputs.push(await dayInput(provenanceVintage));
          continue;
        }
        if (signals.length === 0) scoreOnlyDays += 1;
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'vintage-unknown' });
        continue;
      }
      if (coveredSignals < observableSignals.length) {
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'vintage-partial' });
        continue;
      }
      const vintages = [...new Set(observations.map((row) => row.vintage))];
      if (vintages.length > 1) {
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'vintage-mixed' });
        continue;
      }
      const vintage = vintages[0] as SignalObservationVintage;
      // provenance 与观察口径冲突时不选边：两处都自称事实，说明写入路径出了问题。
      // 尤其不能偏向 pit——那会让 restated 冒充前瞻样本（H8 明令禁止的方向）。
      if (provenanceVintage !== undefined && provenanceVintage !== vintage) {
        skippedDays.push({ dataAsOf: run.dataAsOf, reason: 'vintage-conflict' });
        continue;
      }
      inputs.push(await dayInput(vintage));
    }

    const groups = computeStrategyIc(inputs);
    return {
      strategyId: input.strategyId,
      minSampleDays: STRATEGY_IC_MIN_SAMPLE_DAYS,
      groups,
      scoreOnlyDays,
      provenanceDays,
      skippedDays: skippedDays.sort(
        (left, right) => left.dataAsOf.getTime() - right.dataAsOf.getTime(),
      ),
      limitations: [
        'IC / RankIC 是统计层指标，不构成「策略历史命中」陈述，也不能进 Advice 证据链或复盘「当时依据」。',
        '收益用次日收盘对当日收盘；未复权校正、未扣成本，不等于可实现收益。',
        'IR = mean(RankIC) / std(RankIC)，**样本标准差（n−1）、非年化**：25 日样本年化要乘 √252≈15.87，会把噪声放大成看起来很确定的数字。',
        '不同 vintage 分组各自给数，不合并；缺失日不填 0。',
        '停牌超过收益窗口（前后各 10 天）的股票拿不到次日收益，不会进配对——这可能**系统性偏向流动性好的标的**，与回溯轨「可实现换手受容量约束」属同一类偏差。',
        'vintage 判定要求该 run 全部**可观察**信号都有观察；覆盖不全（vintage-partial）或口径混合（vintage-mixed）的交易日一律跳过，不用部分样本代表整天。',
        '零信号日（有评分横截面、但没有信号可贴 vintage）的 IC 缺失是**标注限制，不是统计上算不出来**：IC 只需要分数横截面，信号只用来判定 vintage。该 run 所属 evaluation session 记了 provenance（backfill / prospective）时，vintage 由 provenance 判定，这类交易日计入 provenanceDays 并正常参与计算；provenance 未知的存量 session 仍计入 scoreOnlyDays 并跳过。',
        'session provenance 判定的 vintage 与信号观察口径冲突（vintage-conflict）时跳过该日，不选边：两处都自称事实说明写入路径有问题，偏向 pit 会让 restated 冒充前瞻样本（H8 冻结口径）。',
        '由 backfill provenance 判定的交易日按 restated 口径统计：只进统计层（IC / 分位 / 换手），不得用于策略历史命中、Advice 证据链或复盘「当时依据」。',
        `有效交易日少于 ${STRATEGY_IC_MIN_SAMPLE_DAYS} 的组返回 unavailable。`,
      ],
    };
  },
});

export type { StrategyIcMissingDay };
