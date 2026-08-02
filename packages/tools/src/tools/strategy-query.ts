import {
  classifyStrategyResult,
  diffStrategyRunViews,
  StrategyResultSchema,
  StrategyResultViewKindSchema,
  StrategyResultViewSchema,
  type StrategyRun,
  StrategyRunDiffRowSchema,
  StrategyRunDiffSchema,
  StrategyRunSchema,
  StrategySchema,
  StrategySignalSchema,
  StrategyVersionSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const StockIdentityViewSchema = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1),
  nameStatus: z.enum(['resolved', 'unavailable']),
});

export const ListStrategyRunsInput = z.object({
  strategyId: z.string().min(1).optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']).optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export const ListStrategyRunsOutput = z.object({
  runs: z.array(StrategyRunSchema),
});

export const listStrategyRunsTool = defineTool({
  name: 'list_strategy_runs',
  description: '查询 StrategyRun 历史（按开始时间倒序，最多返回 limit 条）',
  sideEffect: 'read',
  input: ListStrategyRunsInput,
  output: ListStrategyRunsOutput,
  handler: async (input, ctx) => {
    const runs = await ctx.repos.strategyRun.listRuns({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: input.limit,
    });
    return { runs };
  },
});

/** 可作视图/工作台/比较基准的运行：求值完整或部分数据不足但结果可用的终态。 */
const isUsableBaseline = (run: StrategyRun): boolean =>
  run.status === 'complete' || run.status === 'partial';

export const GetStrategyRunInput = z.object({ runId: z.string().min(1) });
export const GetStrategyRunOutput = z.object({
  run: StrategyRunSchema,
  results: z.array(StrategyResultSchema),
  signals: z.array(StrategySignalSchema),
  stocks: z.array(StockIdentityViewSchema),
  warnings: z.array(z.string()),
});

const stockIdentities = async (
  stockIds: readonly string[],
  ctx: ToolContext,
): Promise<{
  readonly stocks: Array<z.infer<typeof StockIdentityViewSchema>>;
  readonly warnings: string[];
}> => {
  const directory = await ctx.repos.stockUniverse.listCurrent({
    coverage: 'CN_A_SHARES_SH_SZ',
    status: 'all',
  });
  const byId = new Map(directory.map((stock) => [stock.id, stock]));
  const stocks = [];
  const warnings: string[] = [];
  for (const stockId of [...new Set(stockIds)]) {
    const stock = byId.get(stockId) ?? (await ctx.repos.stock.findById(stockId));
    if (stock === null || stock === undefined) {
      stocks.push({ stockId, stockName: '名称暂缺', nameStatus: 'unavailable' as const });
      warnings.push(`本地股票目录无法解析名称: ${stockId}`);
    } else {
      stocks.push({ stockId, stockName: stock.name, nameStatus: 'resolved' as const });
    }
  }
  return { stocks, warnings };
};

export const getStrategyRunTool = defineTool({
  name: 'get_strategy_run',
  description: '查询单次 StrategyRun 及逐股结果与信号',
  sideEffect: 'read',
  input: GetStrategyRunInput,
  output: GetStrategyRunOutput,
  handler: async (input, ctx) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    const results = await ctx.repos.strategyRun.listResults(run.id);
    const signals = await ctx.repos.strategyRun.signalsByRun(run.id);
    const identities = await stockIdentities(
      [...results.map((result) => result.stockId), ...signals.map((signal) => signal.stockId)],
      ctx,
    );
    return {
      run,
      results,
      signals,
      ...identities,
    };
  },
});

export const ListStrategyResultViewsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1).optional(),
  view: StrategyResultViewKindSchema,
  rankingWindow: z.number().int().min(1).max(100).default(20),
  query: z.string().trim().min(1).optional(),
  sort: z.enum(['rank', 'score', 'stock-id']).default('rank'),
  order: z.enum(['asc', 'desc']).default('asc'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(200).default(50),
});
export const ListStrategyResultViewsOutput = z.object({
  run: StrategyRunSchema,
  version: StrategyVersionSchema,
  dataAsOf: z.coerce.date(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  rows: z.array(
    z.object({
      stock: StockIdentityViewSchema,
      view: StrategyResultViewSchema,
    }),
  ),
  warnings: z.array(z.string()),
});

export const listStrategyResultViewsTool = defineTool({
  name: 'list_strategy_result_views',
  description:
    '查询 Strategy 当前或指定运行的股票池、候选池及数据不完整视图；默认基准为最近一次 complete 或 partial 运行',
  sideEffect: 'read',
  input: ListStrategyResultViewsInput,
  output: ListStrategyResultViewsOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const run =
      input.runId === undefined
        ? (await ctx.repos.strategyRun.listRuns({ strategyId: strategy.id, limit: 10 })).find(
            (candidate) => isUsableBaseline(candidate),
          )
        : await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === undefined || run === null) {
      return errNotFound('可用的 StrategyRun（complete/partial）', input.runId ?? strategy.id);
    }
    if (run.strategyId !== strategy.id) {
      return errInvalidInput(`StrategyRun 不属于 Strategy: ${run.id}`);
    }
    const version = await ctx.repos.strategy.findVersionById(run.strategyVersionId);
    if (version === null) return errNotFound('StrategyVersion', run.strategyVersionId);

    let views = (await ctx.repos.strategyRun.listResults(run.id))
      .map((result) => classifyStrategyResult(version.definition, result))
      .filter((view) => view.kind === input.view);
    if (input.view === 'ranking-near-miss' && version.definition.scoring?.top !== undefined) {
      const lastRank = version.definition.scoring.top + input.rankingWindow;
      views = views.filter((view) => (view.result.rank ?? Number.MAX_SAFE_INTEGER) <= lastRank);
    }
    const directory = await stockIdentities(
      views.map((view) => view.result.stockId),
      ctx,
    );
    const identityById = new Map(directory.stocks.map((stock) => [stock.stockId, stock]));
    if (input.query !== undefined) {
      const normalized = input.query.toLowerCase();
      views = views.filter((view) => {
        const stock = identityById.get(view.result.stockId);
        return (
          view.result.stockId.toLowerCase().includes(normalized) ||
          stock?.stockName.toLowerCase().includes(normalized) === true
        );
      });
    }
    const direction = input.order === 'asc' ? 1 : -1;
    views.sort((left, right) => {
      if (input.sort === 'stock-id') {
        return direction * left.result.stockId.localeCompare(right.result.stockId);
      }
      const leftValue = left.result[input.sort] ?? Number.MAX_SAFE_INTEGER;
      const rightValue = right.result[input.sort] ?? Number.MAX_SAFE_INTEGER;
      return (
        direction * (leftValue - rightValue) ||
        left.result.stockId.localeCompare(right.result.stockId)
      );
    });
    const total = views.length;
    const page = views.slice(input.offset, input.offset + input.limit);
    return {
      run,
      version,
      dataAsOf: run.dataAsOf,
      total,
      offset: input.offset,
      limit: input.limit,
      rows: page.map((view) => ({
        stock:
          identityById.get(view.result.stockId) ??
          ({
            stockId: view.result.stockId,
            stockName: '名称暂缺',
            nameStatus: 'unavailable',
          } as const),
        view,
      })),
      warnings: directory.warnings,
    };
  },
});

export const GetStrategyWorkspaceInput = z.object({ strategyId: z.string().min(1) });
export const GetStrategyWorkspaceOutput = z.object({
  strategy: StrategySchema,
  currentVersion: StrategyVersionSchema.optional(),
  latestAttempt: StrategyRunSchema.optional(),
  currentRun: StrategyRunSchema.optional(),
  previousCompleteRun: StrategyRunSchema.optional(),
  overview: z.object({
    selectedCount: z.number().int().nonnegative().optional(),
    ruleNearMissCount: z.number().int().nonnegative().optional(),
    rankingNearMissCount: z.number().int().nonnegative().optional(),
    incompleteCount: z.number().int().nonnegative().optional(),
    enteredCount: z.number().int().nonnegative().optional(),
    exitedCount: z.number().int().nonnegative().optional(),
    maxAbsRankDelta: z.number().int().nonnegative().optional(),
    health: z.enum(['ready', 'never-run', 'running', 'partial', 'failed']),
  }),
  warnings: z.array(z.string()),
});

export const getStrategyWorkspaceTool = defineTool({
  name: 'get_strategy_workspace',
  description: '查询 Strategy 工作台摘要；最近失败或部分运行不会覆盖上一条可用运行',
  sideEffect: 'read',
  input: GetStrategyWorkspaceInput,
  output: GetStrategyWorkspaceOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const [latestAttempt, recentRuns] = await Promise.all([
      ctx.repos.strategyRun.listRuns({ strategyId: strategy.id, limit: 1 }),
      ctx.repos.strategyRun.listRuns({ strategyId: strategy.id, limit: 10 }),
    ]);
    const latest = latestAttempt[0];
    const usableRuns = recentRuns.filter((run) => isUsableBaseline(run));
    const currentRun = usableRuns[0];
    const previousCompleteRun = usableRuns[1];
    const currentVersion =
      strategy.currentVersionId === undefined
        ? undefined
        : await ctx.repos.strategy.findVersionById(strategy.currentVersionId);
    const warnings: string[] = [];
    const health =
      latest === undefined
        ? ('never-run' as const)
        : latest.status === 'complete'
          ? ('ready' as const)
          : latest.status;
    // 仅当最近尝试不可用作基准（失败/进行中）且存在更早的可用运行时才警告；
    // latest 本身是 partial 且被用作基准时属于正常状态，不警告。
    if (latest !== undefined && currentRun !== undefined && !isUsableBaseline(latest)) {
      warnings.push(
        `最近运行${latest.status}，当前结果仍来自 ${currentRun.finishedAt?.toISOString() ?? currentRun.startedAt.toISOString()} 的运行`,
      );
    }

    const overview: z.infer<typeof GetStrategyWorkspaceOutput>['overview'] = { health };
    if (currentRun !== undefined) {
      const version = await ctx.repos.strategy.findVersionById(currentRun.strategyVersionId);
      if (version === null) return errNotFound('StrategyVersion', currentRun.strategyVersionId);
      const views = (await ctx.repos.strategyRun.listResults(currentRun.id)).map((result) =>
        classifyStrategyResult(version.definition, result),
      );
      overview.selectedCount = views.filter((view) => view.kind === 'selected').length;
      overview.ruleNearMissCount = views.filter((view) => view.kind === 'rule-near-miss').length;
      overview.rankingNearMissCount = views.filter(
        (view) => view.kind === 'ranking-near-miss',
      ).length;
      overview.incompleteCount = views.filter((view) => view.kind === 'incomplete').length;
      if (previousCompleteRun !== undefined) {
        const [previousVersion, previousResults] = await Promise.all([
          ctx.repos.strategy.findVersionById(previousCompleteRun.strategyVersionId),
          ctx.repos.strategyRun.listResults(previousCompleteRun.id),
        ]);
        if (previousVersion === null) {
          return errNotFound('StrategyVersion', previousCompleteRun.strategyVersionId);
        }
        const diff = diffStrategyRunViews({
          fromRun: previousCompleteRun,
          toRun: currentRun,
          fromViews: previousResults.map((result) =>
            classifyStrategyResult(previousVersion.definition, result),
          ),
          toViews: views,
        });
        overview.enteredCount = diff.summary.entered;
        overview.exitedCount = diff.summary.exited;
        overview.maxAbsRankDelta = diff.rows.reduce(
          (maximum, row) => Math.max(maximum, Math.abs(row.rankDelta ?? 0)),
          0,
        );
      }
    }
    return {
      strategy,
      ...(currentVersion === undefined || currentVersion === null ? {} : { currentVersion }),
      ...(latest === undefined ? {} : { latestAttempt: latest }),
      ...(currentRun === undefined ? {} : { currentRun }),
      ...(previousCompleteRun === undefined ? {} : { previousCompleteRun }),
      overview,
      warnings,
    };
  },
});

export const CompareStrategyRunsInput = z
  .object({
    strategyId: z.string().min(1),
    fromRunId: z.string().min(1).optional(),
    toRunId: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.fromRunId === undefined) !== (input.toRunId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'fromRunId 与 toRunId 必须同时提供或同时省略',
      });
    }
  });
const StrategyRunDiffWithStocksSchema = StrategyRunDiffSchema.omit({ rows: true }).extend({
  rows: z.array(StrategyRunDiffRowSchema.extend({ stock: StockIdentityViewSchema })),
});
export const CompareStrategyRunsOutput = z.object({
  fromRun: StrategyRunSchema,
  toRun: StrategyRunSchema,
  fromVersion: StrategyVersionSchema,
  toVersion: StrategyVersionSchema,
  diff: StrategyRunDiffWithStocksSchema,
  warnings: z.array(z.string()),
});

export const compareStrategyRunsTool = defineTool({
  name: 'compare_strategy_runs',
  description: '比较同一 Strategy 的两次持久化运行；默认取最近两次可用运行（complete 或 partial）',
  sideEffect: 'read',
  input: CompareStrategyRunsInput,
  output: CompareStrategyRunsOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    let fromRun: StrategyRun | null | undefined;
    let toRun: StrategyRun | null | undefined;
    if (input.fromRunId === undefined || input.toRunId === undefined) {
      const runs = (
        await ctx.repos.strategyRun.listRuns({ strategyId: strategy.id, limit: 10 })
      ).filter((run) => isUsableBaseline(run));
      toRun = runs[0];
      fromRun = runs[1];
      if (fromRun === undefined || toRun === undefined) {
        return errNotFound('StrategyRun diff baseline', strategy.id);
      }
    } else {
      [fromRun, toRun] = await Promise.all([
        ctx.repos.strategyRun.findRunById(input.fromRunId),
        ctx.repos.strategyRun.findRunById(input.toRunId),
      ]);
      if (fromRun === null) return errNotFound('StrategyRun', input.fromRunId);
      if (toRun === null) return errNotFound('StrategyRun', input.toRunId);
    }
    if (fromRun.strategyId !== strategy.id || toRun.strategyId !== strategy.id) {
      return errInvalidInput('两个 StrategyRun 必须属于请求中的同一 Strategy');
    }
    if (fromRun.id === toRun.id) return errInvalidInput('Diff 需要两个不同 StrategyRun');
    if (fromRun.status === 'running' || toRun.status === 'running') {
      return errInvalidInput('running StrategyRun 不能参与 Diff');
    }
    const [fromVersion, toVersion, fromResults, toResults] = await Promise.all([
      ctx.repos.strategy.findVersionById(fromRun.strategyVersionId),
      ctx.repos.strategy.findVersionById(toRun.strategyVersionId),
      ctx.repos.strategyRun.listResults(fromRun.id),
      ctx.repos.strategyRun.listResults(toRun.id),
    ]);
    if (fromVersion === null) return errNotFound('StrategyVersion', fromRun.strategyVersionId);
    if (toVersion === null) return errNotFound('StrategyVersion', toRun.strategyVersionId);
    const diff = diffStrategyRunViews({
      fromRun,
      toRun,
      fromViews: fromResults.map((result) =>
        classifyStrategyResult(fromVersion.definition, result),
      ),
      toViews: toResults.map((result) => classifyStrategyResult(toVersion.definition, result)),
    });
    const identities = await stockIdentities(
      diff.rows.map((row) => row.stockId),
      ctx,
    );
    const identityById = new Map(identities.stocks.map((stock) => [stock.stockId, stock]));
    const warnings = [...identities.warnings];
    if (diff.definitionChanged) {
      warnings.push('定义已变化，以下差异不能单独归因于市场');
    }
    if (fromRun.status !== 'complete' || toRun.status !== 'complete') {
      warnings.push('比较包含非 complete 运行，差异可能不完整');
    }
    return {
      fromRun,
      toRun,
      fromVersion,
      toVersion,
      diff: {
        ...diff,
        rows: diff.rows.map((row) => ({
          ...row,
          stock:
            identityById.get(row.stockId) ??
            ({ stockId: row.stockId, stockName: '名称暂缺', nameStatus: 'unavailable' } as const),
        })),
      },
      warnings,
    };
  },
});

export const StrategySignalsByStockInput = z.object({
  stockId: z.string().min(1),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export const StrategySignalsByStockOutput = z.object({
  stockId: z.string(),
  signals: z.array(StrategySignalSchema),
  total: z.number().int().nonnegative(),
});

export const strategySignalsByStockTool = defineTool({
  name: 'strategy_signals_by_stock',
  description: '按股票查询 StrategySignal 事实；signal 不等于 Advice 或交易',
  sideEffect: 'read',
  input: StrategySignalsByStockInput,
  output: StrategySignalsByStockOutput,
  handler: async (input, ctx) => {
    const signals = await ctx.repos.strategyRun.signalsByStock(input.stockId, input.since);
    return {
      stockId: input.stockId,
      signals: signals.slice(0, input.limit),
      total: signals.length,
    };
  },
});
