import { createHash } from 'node:crypto';
import {
  calculatePortfolioPerformance,
  isHoliday,
  isWeekend,
  PortfolioCashFlowSchema,
  PortfolioCorporateActionSchema,
  PortfolioPerformanceSchema,
  PortfolioPerformanceSnapshotSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const accountIdInput = z.object({ accountId: z.string().min(1).optional() });

export const CreatePortfolioCashFlowInput = z.object({
  id: z.string().min(1).optional(),
  accountId: z.string().min(1),
  occurredAt: z.coerce.date(),
  kind: PortfolioCashFlowSchema.shape.kind,
  amount: z.number().finite().positive(),
  currency: z.string().length(3).default('CNY'),
  stockId: z.string().min(1).optional(),
  source: PortfolioCashFlowSchema.shape.source.default('manual'),
  note: z.string().max(500).optional(),
});
export const CreatePortfolioCashFlowOutput = z.object({
  flow: PortfolioCashFlowSchema,
});
export const createPortfolioCashFlowTool = defineTool({
  name: 'create_portfolio_cash_flow',
  description: '记录账户入金、出金、分红和费用现金流，金额为正数并保留明确类型',
  sideEffect: 'write',
  input: CreatePortfolioCashFlowInput,
  output: CreatePortfolioCashFlowOutput,
  handler: async (input, ctx: ToolContext) => {
    const account = await ctx.repos.account.findById(input.accountId);
    if (account === null) return errNotFound('Account', input.accountId);
    if (account.currency !== input.currency)
      return errInvalidInput('现金流 currency 必须与账户一致');
    const flow = PortfolioCashFlowSchema.parse({
      ...input,
      id: input.id ?? `cash-flow-${globalThis.crypto.randomUUID()}`,
      createdAt: ctx.clock(),
    });
    await ctx.repos.portfolioCashFlow.save(flow);
    return { flow };
  },
});

export const CreatePortfolioCorporateActionInput = z.object({
  id: z.string().min(1).optional(),
  accountId: z.string().min(1),
  stockId: z.string().min(1),
  occurredAt: z.coerce.date(),
  kind: PortfolioCorporateActionSchema.shape.kind,
  ratio: z.number().finite().positive().optional(),
  cashPerShare: z.number().finite().nonnegative().optional(),
  source: PortfolioCorporateActionSchema.shape.source.default('manual'),
  note: z.string().max(500).optional(),
});
export const CreatePortfolioCorporateActionOutput = z.object({
  action: PortfolioCorporateActionSchema,
});
export const createPortfolioCorporateActionTool = defineTool({
  name: 'create_portfolio_corporate_action',
  description: '记录账户范围内的拆股、送转或分红公司行动，供估值和归因重算',
  sideEffect: 'write',
  input: CreatePortfolioCorporateActionInput,
  output: CreatePortfolioCorporateActionOutput,
  handler: async (input, ctx: ToolContext) => {
    const account = await ctx.repos.account.findById(input.accountId);
    if (account === null) return errNotFound('Account', input.accountId);
    const stock = await ctx.repos.stock.findById(input.stockId);
    if (stock === null) return errNotFound('Stock', input.stockId);
    const action = PortfolioCorporateActionSchema.parse({
      ...input,
      id: input.id ?? `corporate-action-${globalThis.crypto.randomUUID()}`,
      createdAt: ctx.clock(),
    });
    await ctx.repos.portfolioCorporateAction.save(action);
    return { action };
  },
});

export const GetAccountPerformanceInput = accountIdInput.extend({
  from: z.coerce.date(),
  to: z.coerce.date(),
  benchmarkStockId: z.string().min(1).optional(),
});
export const GetAccountPerformanceOutput = PortfolioPerformanceSchema;

export const ListPortfolioPerformanceSnapshotsInput = z.object({
  accountId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(30),
});
export const PortfolioPerformanceSnapshotSummarySchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
  currency: z.string().length(3),
  inputFingerprint: z.string().min(1),
  calculatedAt: z.coerce.date(),
  dataAsOf: z.coerce.date().optional(),
  completeness: PortfolioPerformanceSchema.shape.completeness,
  benchmarkStatus: PortfolioPerformanceSchema.shape.benchmarkStatus,
  valuationDays: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  twrPct: z.number().finite().optional(),
  maxDrawdownPct: z.number().finite().optional(),
  totalPnl: z.number().finite().optional(),
});
export const ListPortfolioPerformanceSnapshotsOutput = z.object({
  snapshots: z.array(PortfolioPerformanceSnapshotSummarySchema),
});

export const AuditPortfolioPerformanceSnapshotsInput = z.object({
  accountId: z.string().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  limit: z.coerce.number().int().positive().max(200).default(200),
});

const PortfolioPerformanceSnapshotAuditGapSchema = z.object({
  date: z.string().date(),
  completeness: PortfolioPerformanceSchema.shape.completeness,
  missingStockIds: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const AuditPortfolioPerformanceSnapshotsOutput = z.object({
  audit: z.object({
    accountId: z.string().min(1),
    from: z.coerce.date(),
    to: z.coerce.date(),
    expectedTradingDays: z.number().int().nonnegative(),
    observedTradingDays: z.number().int().nonnegative(),
    missingDates: z.array(z.string().date()),
    snapshotIds: z.array(z.string().min(1)),
    snapshotCount: z.number().int().nonnegative(),
    valuationDayCount: z.number().int().nonnegative(),
    completeDayCount: z.number().int().nonnegative(),
    partialDayCount: z.number().int().nonnegative(),
    unavailableDayCount: z.number().int().nonnegative(),
    completeness: PortfolioPerformanceSchema.shape.completeness,
    dataAsOfFrom: z.coerce.date().optional(),
    dataAsOfTo: z.coerce.date().optional(),
    gaps: z.array(PortfolioPerformanceSnapshotAuditGapSchema),
    warnings: z.array(z.string()),
  }),
});

export const listPortfolioPerformanceSnapshotsTool = defineTool({
  name: 'list_account_performance_snapshots',
  description: '查询账户绩效快照审计摘要，不重新请求行情或重算绩效',
  sideEffect: 'read',
  input: ListPortfolioPerformanceSnapshotsInput,
  output: ListPortfolioPerformanceSnapshotsOutput,
  handler: async (input, ctx: ToolContext) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (accountId.length === 0) return errInvalidInput('缺少 accountId');
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    const snapshots = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(
      accountId,
      input.limit,
    );
    return {
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        accountId: snapshot.accountId,
        from: snapshot.from,
        to: snapshot.to,
        currency: snapshot.currency,
        inputFingerprint: snapshot.inputFingerprint,
        calculatedAt: snapshot.calculatedAt,
        ...(snapshot.dataAsOf === undefined ? {} : { dataAsOf: snapshot.dataAsOf }),
        completeness: snapshot.performance.completeness,
        benchmarkStatus: snapshot.performance.benchmarkStatus,
        valuationDays: snapshot.performance.valuation.length,
        warnings: [...snapshot.performance.warnings],
        ...(snapshot.performance.twrPct === undefined
          ? {}
          : { twrPct: snapshot.performance.twrPct }),
        ...(snapshot.performance.maxDrawdownPct === undefined
          ? {}
          : { maxDrawdownPct: snapshot.performance.maxDrawdownPct }),
        ...(snapshot.performance.totalPnl === undefined
          ? {}
          : { totalPnl: snapshot.performance.totalPnl }),
      })),
    };
  },
});

export const auditPortfolioPerformanceSnapshotsTool = defineTool({
  name: 'audit_account_performance_snapshots',
  description: '审计账户绩效快照区间覆盖、缺失交易日和 partial 原因，不重新请求行情或重算绩效',
  sideEffect: 'read',
  input: AuditPortfolioPerformanceSnapshotsInput,
  output: AuditPortfolioPerformanceSnapshotsOutput,
  handler: async (input, ctx: ToolContext) => {
    if (input.from > input.to) return errInvalidInput('snapshot audit from 不能晚于 to');
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (accountId.length === 0) return errInvalidInput('缺少 accountId');
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const expectedDates = tradingDayKeys(input.from, input.to);
    const snapshots = await ctx.repos.portfolioPerformanceSnapshot.listByAccountAndRange(
      accountId,
      input.from,
      input.to,
      input.limit,
    );
    type DayFact = {
      completeness: import('@luoome/core').PortfolioValuationCompleteness;
      missingStockIds: Set<string>;
      warnings: Set<string>;
    };
    const dayFacts = new Map<string, DayFact>();
    for (const snapshot of snapshots) {
      for (const day of snapshot.performance.valuation) {
        const date = dateKey(day.date);
        if (date < dateKey(input.from) || date > dateKey(input.to)) continue;
        const current = dayFacts.get(date) ?? {
          completeness: 'unavailable',
          missingStockIds: new Set<string>(),
          warnings: new Set<string>(),
        };
        if (completenessRank(day.completeness) > completenessRank(current.completeness)) {
          current.completeness = day.completeness;
        }
        for (const stockId of day.missingStockIds) current.missingStockIds.add(stockId);
        for (const warning of snapshot.performance.warnings) current.warnings.add(warning);
        dayFacts.set(date, current);
      }
    }

    const missingDates = expectedDates.filter((date) => !dayFacts.has(date));
    const observedDates = expectedDates.filter((date) => dayFacts.has(date));
    const completeDayCount = observedDates.filter(
      (date) => dayFacts.get(date)?.completeness === 'complete',
    ).length;
    const partialDayCount = observedDates.filter(
      (date) => dayFacts.get(date)?.completeness === 'partial',
    ).length;
    const unavailableDayCount = expectedDates.length - completeDayCount - partialDayCount;
    const completeness: import('@luoome/core').PortfolioValuationCompleteness =
      expectedDates.length > 0 &&
      missingDates.length === 0 &&
      partialDayCount === 0 &&
      unavailableDayCount === 0
        ? 'complete'
        : observedDates.length === 0
          ? 'unavailable'
          : 'partial';
    const gaps = expectedDates
      .filter((date) => dayFacts.get(date)?.completeness !== 'complete')
      .map((date) => {
        const fact = dayFacts.get(date);
        return {
          date,
          completeness: fact?.completeness ?? 'unavailable',
          missingStockIds: fact === undefined ? [] : [...fact.missingStockIds].sort(),
          warnings: fact === undefined ? ['未找到该估值日的持久化快照'] : [...fact.warnings].sort(),
        };
      });
    const warnings = new Set<string>();
    if (snapshots.length === 0) warnings.add('没有找到覆盖该区间的持久化绩效快照');
    if (snapshots.length >= input.limit) {
      warnings.add(`快照查询达到 limit=${input.limit}，审计结果可能需要提高 limit`);
    }
    if (missingDates.length > 0) warnings.add(`缺少 ${missingDates.length} 个交易日的绩效快照`);
    if (partialDayCount > 0) warnings.add(`有 ${partialDayCount} 个交易日的估值为 partial`);
    if (unavailableDayCount > 0) warnings.add(`有 ${unavailableDayCount} 个交易日的估值不可用`);
    if (expectedDates.length === 0) warnings.add('区间内没有 A 股交易日');
    const dataAsOf = snapshots
      .map((snapshot) => snapshot.dataAsOf)
      .filter((date): date is Date => date !== undefined)
      .sort((left, right) => left.getTime() - right.getTime());
    return {
      audit: {
        accountId,
        from: input.from,
        to: input.to,
        expectedTradingDays: expectedDates.length,
        observedTradingDays: observedDates.length,
        missingDates,
        snapshotIds: snapshots.map((snapshot) => snapshot.id),
        snapshotCount: snapshots.length,
        valuationDayCount: [...dayFacts.keys()].length,
        completeDayCount,
        partialDayCount,
        unavailableDayCount,
        completeness,
        ...(dataAsOf[0] === undefined ? {} : { dataAsOfFrom: dataAsOf[0] }),
        ...(dataAsOf.at(-1) === undefined ? {} : { dataAsOfTo: dataAsOf.at(-1) }),
        gaps,
        warnings: [...warnings],
      },
    };
  },
});

const fetchBars = async (
  stockId: string,
  from: Date,
  to: Date,
  ctx: ToolContext,
): Promise<readonly import('@luoome/core').DailyBar[]> => {
  const cached = await ctx.repos.dailyBar.findInRange(stockId, from, to);
  const cachedDays = new Set(cached.map((bar) => bar.date.toISOString().slice(0, 10)));
  const expectedTradingDays = tradingDayKeys(from, to);
  const cacheComplete = expectedTradingDays.every((day) => cachedDays.has(day));
  if (cacheComplete) return cached;
  try {
    const bars = await ctx.adapters.market.fetchDailyBars(stockId, { start: from, end: to });
    if (bars.length > 0) await ctx.repos.dailyBar.saveMany(bars);
    // Merge the provider response with known local facts. A provider can return a
    // partial range (for example, a suspended stock); never discard cached facts
    // merely because a refresh was attempted.
    return await ctx.repos.dailyBar.findInRange(stockId, from, to);
  } catch (error) {
    ctx.logger.warn('account performance daily-bars unavailable', {
      stockId,
      error: error instanceof Error ? error.message : String(error),
    });
    return cached;
  }
};

const dateKey = (value: Date): string => value.toISOString().slice(0, 10);

const tradingDayKeys = (from: Date, to: Date): string[] => {
  const expectedTradingDays: string[] = [];
  for (
    let cursor = new Date(from);
    cursor <= to;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) expectedTradingDays.push(dateKey(cursor));
  }
  return expectedTradingDays;
};

const completenessRank = (value: import('@luoome/core').PortfolioValuationCompleteness): number =>
  value === 'complete' ? 2 : value === 'partial' ? 1 : 0;

const canonicalDate = (value: Date): string => value.toISOString();

const performanceFingerprint = (input: {
  readonly account: {
    readonly id: string;
    readonly currency: string;
    readonly initialCapital: number;
  };
  readonly from: Date;
  readonly to: Date;
  readonly trades: readonly import('@luoome/core').Trade[];
  readonly holdings: readonly import('@luoome/core').Holding[];
  readonly cashFlows: readonly import('@luoome/core').PortfolioCashFlow[];
  readonly actions: readonly import('@luoome/core').PortfolioCorporateAction[];
  readonly barsByStock: ReadonlyMap<string, readonly import('@luoome/core').DailyBar[]>;
  readonly benchmarkStockId?: string;
  readonly benchmarkBars?: readonly import('@luoome/core').DailyBar[];
}): string => {
  const bars = (rows: readonly import('@luoome/core').DailyBar[]) =>
    [...rows]
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .map((bar) => ({
        stockId: bar.stockId,
        date: canonicalDate(bar.date),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        adjustment: bar.adjustment,
        source: bar.source,
      }));
  const payload = {
    account: input.account,
    from: canonicalDate(input.from),
    to: canonicalDate(input.to),
    trades: [...input.trades]
      .sort(
        (left, right) =>
          left.executedAt.getTime() - right.executedAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((trade) => ({
        ...trade,
        executedAt: canonicalDate(trade.executedAt),
        createdAt: canonicalDate(trade.createdAt),
      })),
    holdings: [...input.holdings]
      .sort((left, right) => left.stockId.localeCompare(right.stockId))
      .map((holding) => ({
        id: holding.id,
        accountId: holding.accountId,
        stockId: holding.stockId,
        quantity: holding.quantity,
        availableQuantity: holding.availableQuantity,
        avgCost: holding.avgCost,
        closedAt:
          holding.closedAt === null || holding.closedAt === undefined
            ? null
            : canonicalDate(holding.closedAt),
      })),
    cashFlows: [...input.cashFlows]
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((flow) => ({
        ...flow,
        occurredAt: canonicalDate(flow.occurredAt),
        createdAt: canonicalDate(flow.createdAt),
      })),
    actions: [...input.actions]
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((action) => ({
        ...action,
        occurredAt: canonicalDate(action.occurredAt),
        createdAt: canonicalDate(action.createdAt),
      })),
    barsByStock: [...input.barsByStock.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stockId, rows]) => ({ stockId, bars: bars(rows) })),
    benchmarkStockId: input.benchmarkStockId ?? null,
    benchmarkBars: input.benchmarkBars === undefined ? null : bars(input.benchmarkBars),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

const dataAsOfFor = (
  barsByStock: ReadonlyMap<string, readonly import('@luoome/core').DailyBar[]>,
  benchmarkBars?: readonly import('@luoome/core').DailyBar[],
): Date | undefined => {
  const latestPerSeries = [
    ...barsByStock.values(),
    ...(benchmarkBars === undefined ? [] : [benchmarkBars]),
  ]
    .map(
      (rows) =>
        [...rows].sort((left, right) => left.date.getTime() - right.date.getTime()).at(-1)?.date,
    )
    .filter((date): date is Date => date !== undefined)
    .sort((left, right) => left.getTime() - right.getTime());
  return latestPerSeries[0];
};

export const getAccountPerformanceTool = defineTool({
  name: 'get_account_performance',
  description: '使用真实交易、现金流、公司行动和日线计算账户估值、TWR、回撤与持仓贡献',
  sideEffect: 'external',
  input: GetAccountPerformanceInput,
  output: GetAccountPerformanceOutput,
  handler: async (input, ctx: ToolContext) => {
    if (input.from > input.to) return errInvalidInput('performance from 不能晚于 to');
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (accountId.length === 0) return errInvalidInput('缺少 accountId');
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    const trades = await ctx.repos.trade.listByAccount(accountId);
    const holdings = await ctx.repos.holding.listByAccount(accountId);
    const cashFlows = await ctx.repos.portfolioCashFlow.listByAccount(accountId);
    const actions = await ctx.repos.portfolioCorporateAction.listByAccount(accountId);
    const stockIds = new Set([
      ...trades.map((trade) => trade.stockId),
      ...holdings.filter((holding) => holding.quantity > 0).map((holding) => holding.stockId),
      ...cashFlows.flatMap((flow) => (flow.stockId === undefined ? [] : [flow.stockId])),
      ...actions.map((action) => action.stockId),
    ]);
    const barsByStock = new Map<string, readonly import('@luoome/core').DailyBar[]>();
    for (const stockId of stockIds) {
      barsByStock.set(stockId, await fetchBars(stockId, input.from, input.to, ctx));
    }
    const benchmarkStockId = input.benchmarkStockId ?? ctx.portfolioBenchmark?.stockId;
    let benchmarkBars: readonly import('@luoome/core').DailyBar[] | undefined;
    if (benchmarkStockId !== undefined) {
      benchmarkBars = await fetchBars(benchmarkStockId, input.from, input.to, ctx);
    }
    const calculated = calculatePortfolioPerformance({
      accountId,
      currency: account.currency,
      initialCapital: account.initialCapital,
      initialHoldings: holdings.filter((holding) => holding.quantity > 0),
      from: input.from,
      to: input.to,
      trades,
      cashFlows,
      corporateActions: actions,
      barsByStock,
      ...(benchmarkBars === undefined ? {} : { benchmarkBars }),
    });
    const performance = PortfolioPerformanceSchema.parse({
      ...calculated,
      ...(benchmarkStockId === undefined ? {} : { benchmarkStockId }),
    });
    const inputFingerprint = performanceFingerprint({
      account,
      from: input.from,
      to: input.to,
      trades,
      holdings,
      cashFlows,
      actions,
      barsByStock,
      ...(benchmarkStockId === undefined ? {} : { benchmarkStockId }),
      ...(benchmarkBars === undefined ? {} : { benchmarkBars }),
    });
    const snapshotId = `portfolio-performance:${accountId}:${input.from.toISOString()}:${input.to.toISOString()}:${inputFingerprint}`;
    const existing = await ctx.repos.portfolioPerformanceSnapshot.findByFingerprint({
      accountId,
      from: input.from,
      to: input.to,
      inputFingerprint,
    });
    const snapshot =
      existing ??
      PortfolioPerformanceSnapshotSchema.parse({
        id: snapshotId,
        accountId,
        from: input.from,
        to: input.to,
        currency: account.currency,
        inputFingerprint,
        calculatedAt: ctx.clock(),
        ...(dataAsOfFor(barsByStock, benchmarkBars) === undefined
          ? {}
          : { dataAsOf: dataAsOfFor(barsByStock, benchmarkBars) }),
        performance,
      });
    if (existing === null) await ctx.repos.portfolioPerformanceSnapshot.save(snapshot);
    return PortfolioPerformanceSchema.parse({
      ...snapshot.performance,
      audit: {
        snapshotId: snapshot.id,
        inputFingerprint: snapshot.inputFingerprint,
        calculatedAt: snapshot.calculatedAt,
        ...(snapshot.dataAsOf === undefined ? {} : { dataAsOf: snapshot.dataAsOf }),
      },
    });
  },
});
