import {
  classifyStrategyResult,
  diffStrategyRunViews,
  getStrategyRunDataHealth,
  isPublishableOperationalRun,
  type Quote,
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
import { resolveQuotes } from '../internal/resolve-quotes.js';
import {
  hydrateStrategyRunTimeline,
  readStrategyOperationalBaseline,
} from '../internal/strategy-run-timeline.js';
import {
  readStrategySignalsByStock,
  StrategySignalScopeSchema,
} from '../internal/strategy-signal-scope.js';

export const StockIdentityViewSchema = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1),
  nameStatus: z.enum(['resolved', 'unavailable']),
});

export const ListStrategyRunsInput = z.object({
  strategyId: z.string().min(1).optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']).optional(),
  scope: z.enum(['operational', 'evaluation']).optional(),
  publication: z.enum(['published', 'withheld', 'non-publishing']).optional(),
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
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.publication === undefined ? {} : { publication: input.publication }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: input.limit,
    });
    return { runs };
  },
});

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
      warnings: [
        ...identities.warnings,
        ...(isPublishableOperationalRun(run)
          ? []
          : [`该运行不会进入 operational current：${run.publication?.status ?? 'legacy/unknown'}`]),
      ],
    };
  },
});

export const ListStrategyResultViewsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1).optional(),
  view: StrategyResultViewKindSchema,
  rankingWindow: z.number().int().min(1).max(100).default(20),
  query: z.string().trim().min(1).optional(),
  sort: z.enum(['rank', 'score', 'stock-id', 'price', 'change-pct']).default('rank'),
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
      quote: z
        .object({
          price: z.number(),
          changePct: z.number().optional(),
          observedAt: z.coerce.date().optional(),
        })
        .optional(),
    }),
  ),
  warnings: z.array(z.string()),
});

const quoteChangePct = (quote: Quote | undefined): number | undefined => {
  if (quote === undefined) return undefined;
  const ratio =
    quote.prevClose !== undefined && quote.prevClose !== 0
      ? quote.close / quote.prevClose - 1
      : quote.open !== 0
        ? quote.close / quote.open - 1
        : undefined;
  if (ratio === undefined) return undefined;
  return Math.round(ratio * 100 * 100) / 100;
};

export const listStrategyResultViewsTool = defineTool({
  name: 'list_strategy_result_views',
  description:
    '查询 Strategy 当前或指定运行的股票池、候选池及数据不完整视图；默认基准为最近一次已完成且结果可用的运行；行情实时拉取，上游失败回退本地快照',
  sideEffect: 'external',
  input: ListStrategyResultViewsInput,
  output: ListStrategyResultViewsOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const run =
      input.runId === undefined
        ? await ctx.repos.strategyRun.findLatestPublishedRun(strategy.id)
        : await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === undefined || run === null) {
      return errNotFound('可用的完成运行', input.runId ?? strategy.id);
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
    // 排序键仍用本地快照：排序需要全量行，对全池实时拉取代价过大；
    // 仅当前页的展示值走实时拉取。
    const quoteByStockForSort =
      input.sort === 'price' || input.sort === 'change-pct'
        ? await ctx.repos.quote.latestByStocks(views.map((view) => view.result.stockId))
        : new Map();
    const direction = input.order === 'asc' ? 1 : -1;
    views.sort((left, right) => {
      if (input.sort === 'stock-id') {
        return direction * left.result.stockId.localeCompare(right.result.stockId);
      }
      if (input.sort === 'price' || input.sort === 'change-pct') {
        const leftQuote = quoteByStockForSort.get(left.result.stockId);
        const rightQuote = quoteByStockForSort.get(right.result.stockId);
        const leftValue =
          input.sort === 'price'
            ? (leftQuote?.close ?? Number.MAX_SAFE_INTEGER)
            : (quoteChangePct(leftQuote) ?? Number.MAX_SAFE_INTEGER);
        const rightValue =
          input.sort === 'price'
            ? (rightQuote?.close ?? Number.MAX_SAFE_INTEGER)
            : (quoteChangePct(rightQuote) ?? Number.MAX_SAFE_INTEGER);
        return (
          direction * (leftValue - rightValue) ||
          left.result.stockId.localeCompare(right.result.stockId)
        );
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
    const resolvedQuotes = await resolveQuotes(
      ctx,
      page.map((view) => view.result.stockId),
      { context: 'display' },
    );
    const quoteByStock = new Map(
      resolvedQuotes.flatMap((item) =>
        item.status === 'ok' ? [[item.stockId, item.quote] as const] : [],
      ),
    );
    return {
      run,
      version,
      dataAsOf: run.dataAsOf,
      total,
      offset: input.offset,
      limit: input.limit,
      rows: page.map((view) => {
        const quote = quoteByStock.get(view.result.stockId);
        return {
          stock:
            identityById.get(view.result.stockId) ??
            ({
              stockId: view.result.stockId,
              stockName: '名称暂缺',
              nameStatus: 'unavailable',
            } as const),
          view,
          quote:
            quote === undefined
              ? undefined
              : {
                  price: quote.close,
                  changePct: quoteChangePct(quote),
                  observedAt: quote.observedAt,
                },
        };
      }),
      warnings: [
        ...directory.warnings,
        ...(isPublishableOperationalRun(run)
          ? []
          : [`该运行不会进入 operational current：${run.publication?.status ?? 'legacy/unknown'}`]),
      ],
    };
  },
});

export const GetStrategyWorkspaceInput = z.object({ strategyId: z.string().min(1) });
export const GetStrategyWorkspaceOutput = z.object({
  strategy: StrategySchema,
  currentVersion: StrategyVersionSchema.optional(),
  latestAttempt: StrategyRunSchema.optional(),
  currentRun: StrategyRunSchema.optional(),
  previousRun: StrategyRunSchema.optional(),
  overview: z.object({
    selectedCount: z.number().int().nonnegative().optional(),
    ruleNearMissCount: z.number().int().nonnegative().optional(),
    rankingNearMissCount: z.number().int().nonnegative().optional(),
    incompleteCount: z.number().int().nonnegative().optional(),
    enteredCount: z.number().int().nonnegative().optional(),
    exitedCount: z.number().int().nonnegative().optional(),
    maxAbsRankDelta: z.number().int().nonnegative().optional(),
    health: z.enum(['ready', 'never-run', 'running', 'partial', 'withheld', 'failed']),
  }),
  warnings: z.array(z.string()),
});

export const getStrategyWorkspaceTool = defineTool({
  name: 'get_strategy_workspace',
  description:
    '查询 Strategy 工作台摘要；仅 published operational run 进入 current，未发布运行保留诊断状态',
  sideEffect: 'read',
  input: GetStrategyWorkspaceInput,
  output: GetStrategyWorkspaceOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const baseline = await readStrategyOperationalBaseline(ctx, strategy);
    const latest = baseline.latestAttempt?.run;
    const currentEntry = baseline.current;
    const previousEntry = baseline.previous;
    const currentRun = currentEntry?.run;
    const previousRun = previousEntry?.run;
    const currentVersion =
      strategy.currentVersionId === undefined
        ? undefined
        : await ctx.repos.strategy.findVersionById(strategy.currentVersionId);
    const warnings: string[] = [];
    const health =
      latest === undefined
        ? ('never-run' as const)
        : latest.status === 'running'
          ? ('running' as const)
          : latest.status === 'failed'
            ? ('failed' as const)
            : latest.publication?.status === 'withheld'
              ? ('withheld' as const)
              : latest.summary?.schemaVersion === 4 && latest.publication === undefined
                ? ('withheld' as const)
                : getStrategyRunDataHealth(latest) === 'partial'
                  ? ('partial' as const)
                  : ('ready' as const);
    if (
      latest?.publication?.status === 'withheld' ||
      (latest?.summary?.schemaVersion === 4 && latest.publication === undefined)
    ) {
      warnings.push(
        `最近运行未发布：${latest.publication?.reasons.join(', ') || 'publication-missing'}`,
      );
    }
    // 最近尝试不是当前可发布基准且存在更早的 published run 时，明确展示回退状态。
    if (latest !== undefined && currentRun !== undefined && !isPublishableOperationalRun(latest)) {
      warnings.push(
        `最近运行${latest.status}，当前结果仍来自 ${currentRun.finishedAt?.toISOString() ?? currentRun.startedAt.toISOString()} 的运行`,
      );
    }

    const overview: z.infer<typeof GetStrategyWorkspaceOutput>['overview'] = { health };
    if (currentEntry !== undefined) {
      const version = currentEntry.version;
      if (version === null)
        return errNotFound('StrategyVersion', currentEntry.run.strategyVersionId);
      const views = currentEntry.results.map((result) =>
        classifyStrategyResult(version.definition, result),
      );
      overview.selectedCount = views.filter((view) => view.kind === 'selected').length;
      overview.ruleNearMissCount = views.filter((view) => view.kind === 'rule-near-miss').length;
      overview.rankingNearMissCount = views.filter(
        (view) => view.kind === 'ranking-near-miss',
      ).length;
      overview.incompleteCount = views.filter((view) => view.kind === 'incomplete').length;
      if (previousEntry !== undefined) {
        const previousVersion = previousEntry.version;
        const previousResults = previousEntry.results;
        if (previousVersion === null) {
          return errNotFound('StrategyVersion', previousEntry.run.strategyVersionId);
        }
        const diff = diffStrategyRunViews({
          fromRun: previousEntry.run,
          toRun: currentEntry.run,
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
      ...(previousRun === undefined ? {} : { previousRun }),
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
    allowCrossScope: z.boolean().default(false),
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
  description: '比较同一 Strategy 的两次持久化可用运行；数据缺失不会被推断为股票池进出',
  sideEffect: 'read',
  input: CompareStrategyRunsInput,
  output: CompareStrategyRunsOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    let fromRun: StrategyRun | null | undefined;
    let toRun: StrategyRun | null | undefined;
    let baselineTimeline: Awaited<ReturnType<typeof readStrategyOperationalBaseline>> | undefined;
    if (input.fromRunId === undefined || input.toRunId === undefined) {
      baselineTimeline = await readStrategyOperationalBaseline(ctx, strategy);
      toRun = baselineTimeline.current?.run;
      fromRun = baselineTimeline.previous?.run;
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
    if (fromRun.scope !== toRun.scope && !input.allowCrossScope) {
      return errInvalidInput('不同 scope 的 StrategyRun 需要显式 allowCrossScope=true 才能比较');
    }
    const hydrated =
      baselineTimeline === undefined
        ? await hydrateStrategyRunTimeline(ctx, [fromRun, toRun])
        : undefined;
    const fromEntry = baselineTimeline?.previous ?? hydrated?.byRunId.get(fromRun.id);
    const toEntry = baselineTimeline?.current ?? hydrated?.byRunId.get(toRun.id);
    const fromVersion = fromEntry?.version ?? null;
    const toVersion = toEntry?.version ?? null;
    const fromResults = fromEntry?.results ?? [];
    const toResults = toEntry?.results ?? [];
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
    if (!isPublishableOperationalRun(fromRun)) {
      warnings.push(
        `fromRun 非 published operational：${fromRun.publication?.status ?? 'legacy/unknown'}`,
      );
    }
    if (!isPublishableOperationalRun(toRun)) {
      warnings.push(
        `toRun 非 published operational：${toRun.publication?.status ?? 'legacy/unknown'}`,
      );
    }
    if (diff.definitionChanged) {
      warnings.push('定义已变化，以下差异不能单独归因于市场');
    }
    if (
      getStrategyRunDataHealth(fromRun) !== 'complete' ||
      getStrategyRunDataHealth(toRun) !== 'complete'
    ) {
      warnings.push('比较包含数据不完整运行；缺失标的只标记 data-unavailable，不推断进出股票池');
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
  scope: StrategySignalScopeSchema.default('operational'),
  evaluationSessionId: z.string().min(1).optional(),
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
    if (input.scope === 'evaluation' && input.evaluationSessionId === undefined) {
      return errInvalidInput('evaluation signal 读取必须显式提供 evaluationSessionId');
    }
    if (input.scope === 'operational' && input.evaluationSessionId !== undefined) {
      return errInvalidInput('operational signal 读取不能携带 evaluationSessionId');
    }
    const signals = await readStrategySignalsByStock(ctx, {
      stockId: input.stockId,
      scope: input.scope,
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.evaluationSessionId === undefined
        ? {}
        : { evaluationSessionId: input.evaluationSessionId }),
    });
    return {
      stockId: input.stockId,
      signals: signals.slice(0, input.limit),
      total: signals.length,
    };
  },
});
