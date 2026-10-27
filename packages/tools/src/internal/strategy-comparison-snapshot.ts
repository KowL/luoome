import { createHash } from 'node:crypto';
import {
  type DailyBar,
  dateInShanghai,
  inspectStrategyDefinitionReferences,
  type Quote,
  type StrategyVersion,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import {
  createCheckpointStrategyEvaluationDataAdapter,
  createLiveStrategyEvaluationDataAdapter,
} from './strategy-evaluation-data.js';

export const StrategyComparisonInputIdentitySchema = z.object({
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  stockIdChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  dataAsOf: z.coerce.date(),
  capturedAt: z.coerce.date(),
  mode: z.enum(['scan', 'replay']),
  revisionCutoff: z.coerce.date().optional(),
  persisted: z.literal(false),
  reproducibility: z.enum(['memory-only', 'local-revisions']),
  facts: z.array(
    z.object({
      stockId: z.string(),
      status: z.enum(['available', 'missing']),
      quoteAsOf: z.coerce.date().optional(),
      dailyBarsThrough: z.coerce.date().optional(),
    }),
  ),
  limitations: z.array(z.string()),
});

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const override = <T extends object>(original: T, methods: Partial<T>): T =>
  new Proxy(original, {
    get(target, key) {
      const value = Reflect.get(methods, key) ?? Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/** Freeze the union of data requirements before either definition is evaluated. */
export const captureStrategyComparisonSnapshot = async (input: {
  readonly ctx: ToolContext;
  readonly versions: readonly StrategyVersion[];
  readonly stockIds: readonly string[];
  readonly mode: 'scan' | 'replay';
  readonly asOf?: Date;
  readonly revisionCutoff?: Date;
}) => {
  const { ctx } = input;
  const capturedAt = ctx.clock();
  const dataAsOf = input.asOf ?? capturedAt;
  const revisionCutoff = input.mode === 'replay' ? (input.revisionCutoff ?? capturedAt) : undefined;
  const stockIds = [...new Set(input.stockIds)].sort();
  const references = input.versions.map((version) =>
    inspectStrategyDefinitionReferences(version.definition),
  );
  const lookback = Math.max(1, ...references.map((value) => value.requiredLookback));
  const sources = new Set(references.flatMap((value) => value.dataSources));
  const [readStocks, readSync] = await Promise.all([
    ctx.repos.stockUniverse.listCurrent({ coverage: 'CN_A_SHARES_SH_SZ', status: 'active' }),
    input.mode === 'replay'
      ? ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
          coverage: 'CN_A_SHARES_SH_SZ',
          asOf: dataAsOf,
        })
      : ctx.repos.stockUniverse.latestSuccessfulSync({ coverage: 'CN_A_SHARES_SH_SZ' }),
  ]);
  const currentStocks = structuredClone(readStocks);
  const sync = structuredClone(readSync);
  const members =
    sync === null
      ? []
      : structuredClone(await ctx.repos.stockUniverse.listSnapshotMembers(sync.id));
  const revisions =
    input.mode === 'replay' && revisionCutoff !== undefined
      ? structuredClone(
          await ctx.repos.dailyBar.listRevisionsForStocks({
            stockIds,
            to: dataAsOf,
            recordedAt: revisionCutoff,
          }),
        )
      : [];
  const frozenDailyBar = override(ctx.repos.dailyBar, {
    listRevisions: async (query) => revisions.filter((row) => row.stockId === query.stockId),
    listRevisionsForStocks: async (query) =>
      revisions.filter((row) => query.stockIds.includes(row.stockId)),
  });
  const evaluationContext: ToolContext = {
    ...ctx,
    repos: { ...ctx.repos, dailyBar: frozenDailyBar },
  };
  const data =
    input.mode === 'scan'
      ? createLiveStrategyEvaluationDataAdapter(ctx)
      : createCheckpointStrategyEvaluationDataAdapter({
          ctx: evaluationContext,
          mode: 'replay',
          members: [],
          ...(revisionCutoff === undefined ? {} : { revisionCutoff }),
        });
  if (input.mode === 'scan' && sources.has('quote')) await data.preloadQuotes(stockIds, 8);
  const batch = structuredClone(
    await data.load({
      stockIds,
      dataAsOf,
      fetchedAt: capturedAt,
      lookback,
      needsQuote: sources.has('quote'),
      needsDailyBars: sources.has('daily-bars'),
      concurrency: 8,
    }),
  );
  const prepared = new Map(batch.prepared.map((row) => [row.stockId, row]));
  const failures = new Map(batch.failures.map((row) => [row.stockId, row.error]));
  const getPrepared = (stockId: string) => {
    const row = prepared.get(stockId);
    if (row === undefined) throw new Error(failures.get(stockId) ?? 'snapshot_stock_unavailable');
    return row;
  };
  let ladder:
    | Awaited<ReturnType<NonNullable<ToolContext['limitUpLadder']>['fetchLadder']>>
    | undefined;
  let ladderFailure: unknown;
  let historicalLadder: Awaited<
    ReturnType<ToolContext['repos']['limitUpLadderSnapshot']['findByDate']>
  > = null;
  if (sources.has('limit-up-ladder')) {
    try {
      if (input.mode === 'replay') {
        historicalLadder = structuredClone(
          await ctx.repos.limitUpLadderSnapshot.findByDate({
            date: dateInShanghai(dataAsOf),
            source: 'eastmoney',
          }),
        );
      } else if (ctx.limitUpLadder !== undefined) {
        ladder = structuredClone(
          await ctx.limitUpLadder.fetchLadder({
            date: dateInShanghai(dataAsOf),
            source: 'eastmoney',
            days: 15,
            includeUncategorized: false,
            includeStar: false,
            includeBse: false,
            includeST: false,
          }),
        );
      }
    } catch (error) {
      ladderFailure = error;
    }
  }
  const snapshotHash = hash({
    stockIds,
    dataAsOf,
    capturedAt,
    mode: input.mode,
    revisionCutoff,
    members: members.length === 0 ? currentStocks : members,
    batch,
    revisions,
    ladder,
    historicalLadder,
    ladderFailed: ladderFailure !== undefined,
  });
  const identity = StrategyComparisonInputIdentitySchema.parse({
    snapshotHash,
    stockIdChecksum: hash(stockIds),
    dataAsOf,
    capturedAt,
    mode: input.mode,
    revisionCutoff,
    persisted: false,
    reproducibility: input.mode === 'replay' ? 'local-revisions' : 'memory-only',
    facts: stockIds.map((stockId) => ({
      stockId,
      status: prepared.has(stockId) ? 'available' : 'missing',
      quoteAsOf: prepared.get(stockId)?.quote?.observedAt ?? prepared.get(stockId)?.quote?.ts,
      dailyBarsThrough: prepared.get(stockId)?.bars.at(-1)?.date,
    })),
    limitations: [
      '快照 hash 标识本次实际输入；不包含供应商可重新下载承诺，试跑不写正式运行或 operational current。',
      'dataAsOf 是统一求值截面，不能替代逐股 quoteAsOf/dailyBarsThrough 的实际事实时间。',
      ...(input.mode === 'scan'
        ? [
            '即时行情与日线在一次采集窗口内取得；两侧共用相同对象，供应商之间不保证同一原子交易时刻。原始输入仅保留在本次内存。',
          ]
        : [
            '历史重放固定本地 revisionCutoff；后补修订不等于当时已知 PIT 事实，须另检查 vintage 覆盖。',
          ]),
    ],
  });
  const market = override(ctx.adapters.market, {
    batchQuote: async (ids) =>
      new Map(
        ids.flatMap((id) => {
          const quote = prepared.get(id)?.quote;
          return quote === undefined ? [] : [[id, quote] as const];
        }),
      ),
    fetchQuote: async (id): Promise<Quote> => {
      const quote = getPrepared(id).quote;
      if (quote === undefined) throw new Error('snapshot_quote_unavailable');
      return quote;
    },
    fetchDailyBars: async (id): Promise<DailyBar[]> => [...getPrepared(id).bars],
  });
  const frozen: ToolContext = {
    ...ctx,
    clock: () => new Date(capturedAt),
    adapters: { ...ctx.adapters, market },
    repos: {
      ...ctx.repos,
      stockUniverse: override(ctx.repos.stockUniverse, {
        listCurrent: async () => (input.mode === 'replay' ? members : currentStocks),
        latestSuccessfulSync: async () => sync,
        latestSnapshotAtOrBefore: async () => sync,
        listSnapshotMembers: async () => members,
      }),
      dailyBar: frozenDailyBar,
      limitUpLadderSnapshot: override(ctx.repos.limitUpLadderSnapshot, {
        findByDate: async () => {
          if (ladderFailure !== undefined) throw ladderFailure;
          return historicalLadder;
        },
      }),
    },
    ...(ctx.limitUpLadder === undefined
      ? {}
      : {
          limitUpLadder: override(ctx.limitUpLadder, {
            fetchLadder: async () => {
              if (ladderFailure !== undefined) throw ladderFailure;
              if (ladder === undefined) throw new Error('snapshot_ladder_unavailable');
              return ladder;
            },
          }),
        }),
  };
  return { ctx: frozen, identity, stockIds, universeAvailable: sync !== null };
};
