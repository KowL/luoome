import {
  type DailyBar,
  type DailyBarRevision,
  DailyBarSchema,
  dateInShanghai,
  inspectStrategyDefinitionReferences,
  isHoliday,
  isWeekend,
  resolveExpressionPath,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import { deriveStrategyMetaByStock } from '../internal/strategy-meta.js';

const DAY_MS = 86_400_000;
const AvailabilitySchema = z.object({
  status: z.enum(['ready', 'partial', 'unavailable', 'requires-live-data', 'blocked']),
  reasons: z.array(z.string()),
});

export const GetStrategyDataPreflightInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  revisionCutoff: z.coerce.date().optional(),
  benchmarkStockId: z.string().min(1).default('000300.SH'),
});
export const GetStrategyDataPreflightOutput = z.object({
  strategyId: z.string(),
  versionId: z.string(),
  definitionHash: z.string(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  revisionCutoff: z.coerce.date(),
  stockIds: z.array(z.string()),
  requiredLookback: z.number().int().nonnegative(),
  fields: z.array(
    z.object({
      path: z.string(),
      dataSource: z.string(),
      requiredLookback: z.number().int().nonnegative(),
      totalSamples: z.number().int().nonnegative(),
      availableSamples: z.number().int().nonnegative(),
      pitAvailableSamples: z.number().int().nonnegative(),
      coverageRatio: z.number().min(0).max(1),
      pitCoverageRatio: z.number().min(0).max(1),
      firstAvailableAt: z.coerce.date().optional(),
      lastAvailableAt: z.coerce.date().optional(),
      limitations: z.array(z.string()),
    }),
  ),
  stocks: z.array(
    z.object({
      stockId: z.string(),
      totalDays: z.number().int().nonnegative(),
      availableDays: z.number().int().nonnegative(),
      pitAvailableDays: z.number().int().nonnegative(),
      missingFields: z.array(z.string()),
      firstAvailableAt: z.coerce.date().optional(),
      lastAvailableAt: z.coerce.date().optional(),
    }),
  ),
  universe: z.object({
    availableDays: z.number().int().nonnegative(),
    totalDays: z.number().int().nonnegative(),
  }),
  benchmark: z.object({
    stockId: z.string(),
    availableDays: z.number().int().nonnegative(),
    pitAvailableDays: z.number().int().nonnegative(),
    totalDays: z.number().int().nonnegative(),
  }),
  layers: z.object({
    trial: AvailabilitySchema,
    historicalEvaluation: AvailabilitySchema,
    strictBacktest: AvailabilitySchema.extend({
      executionModel: z.literal('next-open-full-rebalance-equal-weight-v1'),
    }),
  }),
  limitations: z.array(z.string()),
});

const barsAt = (revisions: readonly DailyBarRevision[], day: Date, cutoff: Date): DailyBar[] => {
  const latest = new Map<string, DailyBarRevision>();
  for (const row of revisions) {
    if (row.date > day || row.recordedAt > cutoff) continue;
    const key = row.date.toISOString();
    const old = latest.get(key);
    if (
      old === undefined ||
      row.recordedAt > old.recordedAt ||
      (row.recordedAt.getTime() === old.recordedAt.getTime() && row.contentHash > old.contentHash)
    )
      latest.set(key, row);
  }
  return [...latest.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => DailyBarSchema.parse({ ...row, adjustment: 'qfq' }));
};
const coverageStatus = (count: number, total: number): 'ready' | 'partial' | 'unavailable' =>
  total > 0 && count === total ? 'ready' : count > 0 ? 'partial' : 'unavailable';

export const getStrategyDataPreflightTool = defineTool({
  name: 'get_strategy_data_preflight',
  description:
    '按不可变策略字段与指定区间检查本地真实日线修订、PIT 股票池/天梯及基准覆盖；披露试跑/历史评估/严格回测各层限制，不访问即时行情或放宽门禁',
  sideEffect: 'read',
  input: GetStrategyDataPreflightInput,
  output: GetStrategyDataPreflightOutput,
  handler: async (input, ctx) => {
    if (input.from > input.to || input.to.getTime() - input.from.getTime() > 366 * DAY_MS)
      return errInvalidInput('预检区间必须有序且不超过 366 天');
    const [strategy, version] = await Promise.all([
      ctx.repos.strategy.findById(input.strategyId),
      ctx.repos.strategy.findVersionById(input.versionId),
    ]);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (version === null) return errNotFound('StrategyVersion', input.versionId);
    if (version.strategyId !== strategy.id) return errInvalidInput('version 不属于该 Strategy');
    const references = inspectStrategyDefinitionReferences(version.definition);
    if (references.validationErrors.length > 0)
      return errInvalidInput(references.validationErrors.join('; '));
    const cutoff = input.revisionCutoff ?? ctx.clock();
    if (cutoff > ctx.clock()) return errInvalidInput('revisionCutoff 不能在未来');
    const to = new Date(`${dateInShanghai(input.to)}T00:00:00.000Z`);
    const from = new Date(`${dateInShanghai(input.from)}T00:00:00.000Z`);
    const dates: Date[] = [];
    for (let day = from; day <= to; day = new Date(day.getTime() + DAY_MS))
      if (!isWeekend(day) && !isHoliday(day)) dates.push(day);
    if (dates.length === 0) return errInvalidInput('区间内没有 A 股交易日');
    const finalUniverse = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: new Date(to.getTime() + DAY_MS - 1),
    });
    const finalMembers =
      finalUniverse === null
        ? []
        : await ctx.repos.stockUniverse.listSnapshotMembers(finalUniverse.id);
    const stockIds = [...new Set(input.stockIds ?? finalMembers.map((stock) => stock.id))].sort();
    if (stockIds.length === 0) return errInvalidInput('缺少股票样本与 PIT 股票池，请显式选择样本');
    if (stockIds.length > 500 || stockIds.length * dates.length > 100_000)
      return errInvalidInput('预检最多 500 只股票、100000 个股票日，请缩小样本或区间');
    const revisions = await ctx.repos.dailyBar.listRevisionsForStocks({
      stockIds: [...new Set([...stockIds, input.benchmarkStockId])],
      to,
      recordedAt: cutoff,
    });
    const byStock = new Map<string, DailyBarRevision[]>();
    for (const row of revisions) {
      const values = byStock.get(row.stockId) ?? [];
      values.push(row);
      byStock.set(row.stockId, values);
    }
    const fields = references.fields.map((field) => ({
      path: field.path,
      dataSource: field.dataSource,
      requiredLookback: field.requiredLookback ?? 0,
      totalSamples: stockIds.length * dates.length,
      availableSamples: 0,
      pitAvailableSamples: 0,
      coverageRatio: 0,
      pitCoverageRatio: 0,
      firstAvailableAt: undefined as Date | undefined,
      lastAvailableAt: undefined as Date | undefined,
      limitations:
        field.path === 'quote.prevClose'
          ? ['历史 replay 的 quote 不提供 prevClose，该字段历史求值保持 unknown。']
          : [],
    }));
    const stocks = stockIds.map((stockId) => ({
      stockId,
      totalDays: dates.length,
      availableDays: 0,
      pitAvailableDays: 0,
      missingFields: new Set<string>(),
      firstAvailableAt: undefined as Date | undefined,
      lastAvailableAt: undefined as Date | undefined,
    }));
    const membersBySync = new Map<string, typeof finalMembers>();
    if (finalUniverse !== null) membersBySync.set(finalUniverse.id, finalMembers);
    let universeDays = 0;
    let benchmarkDays = 0;
    let benchmarkPitDays = 0;
    for (const day of dates) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (ctx.abortSignal?.aborted) return errInvalidInput('operation_cancelled');
      const dayEnd = new Date(day.getTime() + DAY_MS - 1);
      const pitCutoff = new Date(Math.min(cutoff.getTime(), dayEnd.getTime()));
      const sync = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
        coverage: 'CN_A_SHARES_SH_SZ',
        asOf: dayEnd,
      });
      const members =
        sync === null
          ? []
          : (membersBySync.get(sync.id) ??
            (await ctx.repos.stockUniverse.listSnapshotMembers(sync.id)));
      if (sync !== null) {
        membersBySync.set(sync.id, members);
        universeDays++;
      }
      const identityById = new Map(members.map((stock) => [stock.id, stock] as const));
      const ladder = references.dataSources.includes('limit-up-ladder')
        ? await ctx.repos.limitUpLadderSnapshot.findByDate({
            date: dateInShanghai(day),
            source: 'eastmoney',
          })
        : null;
      const ladderByCode = new Map(
        ladder?.levels
          .flatMap((level) => level.stocks)
          .map((stock) => [stock.code, { ladderLevel: stock.ladderLevel }] as const) ?? [],
      );
      const localBars = stockIds.map((stockId) => ({
        stockId,
        industry: identityById.get(stockId)?.industry,
        bars: barsAt(byStock.get(stockId) ?? [], day, cutoff),
        limitUpLadder: ladderByCode.get(identityById.get(stockId)?.code ?? ''),
      }));
      const pitBars = stockIds.map((stockId) => ({
        stockId,
        industry: identityById.get(stockId)?.industry,
        bars: barsAt(byStock.get(stockId) ?? [], day, pitCutoff),
        limitUpLadder:
          ladder !== null && ladder.asOf <= dayEnd
            ? ladderByCode.get(identityById.get(stockId)?.code ?? '')
            : undefined,
      }));
      const localMeta = deriveStrategyMetaByStock(
        localBars.map(({ limitUpLadder, ...stock }) => ({
          ...stock,
          ...(limitUpLadder === undefined ? {} : { limitUpLadder }),
        })),
      );
      const pitMeta = deriveStrategyMetaByStock(
        pitBars.map(({ limitUpLadder, ...stock }) => ({
          ...stock,
          ...(limitUpLadder === undefined ? {} : { limitUpLadder }),
        })),
      );
      for (const [index, stock] of stocks.entries()) {
        const bars = localBars[index]?.bars ?? [];
        const vintage = pitBars[index]?.bars ?? [];
        const current = bars.at(-1);
        const pitCurrent = vintage.at(-1);
        const context = {
          quote: current,
          indicators: computeSimpleIndicators(bars),
          meta: localMeta.get(stock.stockId),
        };
        const pitContext = {
          quote: pitCurrent,
          indicators: computeSimpleIndicators(vintage),
          meta: pitMeta.get(stock.stockId),
        };
        let available = identityById.has(stock.stockId);
        let pitAvailable = identityById.has(stock.stockId);
        for (const field of fields) {
          const value = resolveExpressionPath(field.path, context);
          const pitValue = resolveExpressionPath(field.path, pitContext);
          const needsBar = field.dataSource === 'quote' || field.dataSource === 'daily-bars';
          const known =
            identityById.has(stock.stockId) &&
            (!needsBar ||
              (current !== undefined && dateInShanghai(current.date) === dateInShanghai(day))) &&
            value !== undefined &&
            value !== null &&
            (typeof value !== 'number' || Number.isFinite(value));
          const pitKnown =
            identityById.has(stock.stockId) &&
            (!needsBar ||
              (pitCurrent !== undefined &&
                dateInShanghai(pitCurrent.date) === dateInShanghai(day))) &&
            pitValue !== undefined &&
            pitValue !== null &&
            (typeof pitValue !== 'number' || Number.isFinite(pitValue));
          if (known) {
            field.availableSamples++;
            field.firstAvailableAt ??= day;
            field.lastAvailableAt = day;
          } else stock.missingFields.add(field.path);
          if (pitKnown) field.pitAvailableSamples++;
          available = available && known;
          pitAvailable = pitAvailable && pitKnown;
        }
        if (available) {
          stock.availableDays++;
          stock.firstAvailableAt ??= day;
          stock.lastAvailableAt = day;
        }
        if (pitAvailable) stock.pitAvailableDays++;
      }
      if (
        barsAt(byStock.get(input.benchmarkStockId) ?? [], day, cutoff)
          .at(-1)
          ?.date.getTime() === day.getTime()
      )
        benchmarkDays++;
      if (
        barsAt(byStock.get(input.benchmarkStockId) ?? [], day, pitCutoff)
          .at(-1)
          ?.date.getTime() === day.getTime()
      )
        benchmarkPitDays++;
    }
    const availableDays = stocks.reduce((sum, stock) => sum + stock.availableDays, 0);
    const pitDays = stocks.reduce((sum, stock) => sum + stock.pitAvailableDays, 0);
    const total = stockIds.length * dates.length;
    return {
      strategyId: strategy.id,
      versionId: version.id,
      definitionHash: version.definitionHash,
      from,
      to,
      revisionCutoff: cutoff,
      stockIds,
      requiredLookback: references.requiredLookback,
      fields: fields.map((field) => ({
        ...field,
        coverageRatio: field.availableSamples / total,
        pitCoverageRatio: field.pitAvailableSamples / total,
      })),
      stocks: stocks.map((stock) => ({ ...stock, missingFields: [...stock.missingFields].sort() })),
      universe: { availableDays: universeDays, totalDays: dates.length },
      benchmark: {
        stockId: input.benchmarkStockId,
        availableDays: benchmarkDays,
        pitAvailableDays: benchmarkPitDays,
        totalDays: dates.length,
      },
      layers: {
        trial: {
          status:
            (strategy.status === 'active' || strategy.status === 'draft') &&
            version.validationStatus === 'valid'
              ? ('requires-live-data' as const)
              : ('blocked' as const),
          reasons: [
            '即时行情能力需由真实试跑验证；本地历史覆盖不代表在线供应商可用。',
            ...(version.validationStatus === 'valid' ? [] : ['版本尚未校验通过。']),
          ],
        },
        historicalEvaluation: {
          status:
            version.validationStatus === 'valid'
              ? coverageStatus(availableDays, total)
              : ('blocked' as const),
          reasons: [
            `本地字段完整股票日 ${availableDays}/${total}；当时已知 PIT 字段完整股票日 ${pitDays}/${total}。`,
            ...(version.validationStatus === 'valid'
              ? []
              : ['版本尚未校验通过，历史执行前必须先校验。']),
            ...(pitDays === total
              ? []
              : ['PIT vintage 不完整，允许研究重放但不能宣称无前视偏差或严格回测合格。']),
          ],
        },
        strictBacktest: {
          status: 'blocked' as const,
          executionModel: 'next-open-full-rebalance-equal-weight-v1' as const,
          reasons: [
            '需要完整持久化 evaluation session、同求值器代码、逐日 PIT universe/revision、执行日可交易性与公司行动、费用/滑点及基准事实；由既有严格回测 gateAudit 逐项判定。',
            ...(benchmarkPitDays === dates.length
              ? []
              : [`基准 PIT 覆盖 ${benchmarkPitDays}/${dates.length}。`]),
          ],
        },
      },
      limitations: [
        '覆盖按请求样本统计；实际执行还会按固定版本的 universe 与风险警示名称筛选，预检不把被排除样本冒充已执行结果。',
        'availableSamples 是本地 revision 在固定 cutoff 下的字段可求值覆盖；pitAvailableSamples 额外限制 recordedAt 不晚于对应交易日日终。日期边界不保证中间连续，应同时查看覆盖计数。',
        '本预检只读本地事实，不下载、造数、执行回测或将缺失当成零。',
        '行业横截面 meta 仅对本次样本计算；换样本不可直接比较分数。',
        ...(universeDays < dates.length ? ['部分交易日缺少 PIT 股票池。'] : []),
      ],
    };
  },
});
