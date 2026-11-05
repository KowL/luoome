import type {
  FinancialIndicator,
  FinancialIndicatorSet,
  FinancialSnapshot,
  FinancialSnapshotHashInput,
  FinancialSnapshotQuery,
  FinancialStatement,
  FinancialStatementType,
  SourceStatus,
  ValuationSnapshot,
} from '@luoome/core';
import {
  BalanceSheetItemSchema,
  CashFlowStatementItemSchema,
  FINANCIAL_INDICATOR_REGISTRY,
  FinancialIndicatorIdSchema,
  FinancialIndicatorRawItemSchema,
  financialSnapshotContentHash,
  IncomeStatementItemSchema,
  ValuationSnapshotItemSchema,
} from '@luoome/core';
import { ZodError, z } from 'zod';
import type { FuyaoClient } from '../fuyao/client.js';
import { normalizeFuyaoThscode, translateFuyaoError } from '../fuyao/source.js';
import { invalidPayloadError, noDataError, SourceExecutionError } from '../source-error.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import type { FinancialSnapshotCapabilityMap } from './types.js';

export interface FuyaoFinancialSnapshotAdapterOptions {
  readonly client: FuyaoClient;
  readonly clock?: () => Date;
}

const StatementDataSchema = z.object({ item: z.array(z.record(z.string(), z.unknown())) });
const IndicatorDataSchema = z.object({
  thscode: z.string().min(1),
  report: z.string().min(1),
  abilities: z.array(
    z.object({ ability: z.string().min(1), indicators: z.array(FinancialIndicatorRawItemSchema) }),
  ),
});
const ValuationDataSchema = z.object({
  total: z.number().int().nonnegative(),
  item: z.array(ValuationSnapshotItemSchema),
});
const statementDefinitions = [
  {
    capability: 'financial-income-statements',
    type: 'income-statement',
    path: 'income-statements',
    field: 'incomeStatements',
  },
  {
    capability: 'financial-balance-sheets',
    type: 'balance-sheet',
    path: 'balance-sheets',
    field: 'balanceSheets',
  },
  {
    capability: 'financial-cash-flow-statements',
    type: 'cash-flow-statement',
    path: 'cash-flow-statements',
    field: 'cashFlowStatements',
  },
] as const;
type StatementRequest = FinancialSnapshotCapabilityMap['financial-income-statements']['request'];

export class FuyaoFinancialSnapshotAdapter {
  readonly name = 'fuyao-financial-snapshot' as const;
  private readonly client: FuyaoClient;
  private readonly clock: () => Date;
  private readonly registry: SourceRegistry<FinancialSnapshotCapabilityMap>;

  constructor(options: FuyaoFinancialSnapshotAdapterOptions) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
    const metadata = {
      source: 'fuyao',
      coverage: ['CN_A_SHARES_SH_SZ'],
      configurationReady: true,
    } as const;
    const bindings: AnyBinding<FinancialSnapshotCapabilityMap>[] = statementDefinitions.map(
      (definition) => ({
        ...metadata,
        capability: definition.capability,
        execute: (request: StatementRequest) =>
          this.fetchStatements(definition.type, definition.path, request),
        observationOf: (rows: readonly FinancialStatement[]) =>
          rows.length === 0
            ? { outcome: 'failure', kind: 'no_data' }
            : {
                outcome: 'success',
                dataAsOf: new Date(Math.max(...rows.map((row) => row.periodEnd.getTime()))),
              },
      }),
    );
    bindings.push({
      ...metadata,
      capability: 'financial-indicators',
      execute: ({ thscode, report }) => this.fetchIndicators(thscode, report),
      observationOf: (result) =>
        result.indicators.length === 0
          ? { outcome: 'failure', kind: 'no_data' }
          : { outcome: 'success' },
    });
    // Valuation metadata timestamp is not a trustworthy observation time.
    bindings.push({
      ...metadata,
      capability: 'valuation-snapshot',
      execute: ({ thscode }) => this.fetchValuation(thscode),
      observationOf: () => ({ outcome: 'success' }),
    });
    this.registry = new SourceRegistry(bindings, this.clock);
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  private execute<C extends keyof FinancialSnapshotCapabilityMap>(
    capability: C,
    request: FinancialSnapshotCapabilityMap[C]['request'],
  ): Promise<FinancialSnapshotCapabilityMap[C]['result']> {
    const handle = this.registry.sources(capability)[0];
    if (handle === undefined) throw new Error(`missing financial capability: ${capability}`);
    return handle.execute(request);
  }

  async fetchSnapshot(query: FinancialSnapshotQuery): Promise<FinancialSnapshot> {
    const thscode = normalizeFuyaoThscode(query.stockId);
    const fetchedAt = this.clock();
    const missingFields: string[] = [];
    let statements: FinancialSnapshot['statements'];
    let indicators: FinancialIndicatorSet | undefined;
    let valuation: ValuationSnapshot | undefined;
    let periodEnd: Date | undefined;
    let reportDate: Date | undefined;

    if (query.includeStatements) {
      const attempts = await Promise.allSettled(
        statementDefinitions.map(async (definition) => {
          const result = await this.optionalData(() =>
            this.execute(definition.capability, {
              thscode,
              period: query.statementPeriod,
              limit: query.statementLimit,
            }),
          );
          return result ?? [];
        }),
      );
      const rows = attempts.map((attempt) => {
        if (attempt.status === 'rejected') throw attempt.reason;
        return attempt.value;
      });
      statements = {
        incomeStatements: rows[0],
        balanceSheets: rows[1],
        cashFlowStatements: rows[2],
      };
      for (const [index, definition] of statementDefinitions.entries()) {
        if (rows[index]?.length === 0) missingFields.push(`statements.${definition.field}`);
      }
      const first = rows.flat()[0];
      periodEnd = first?.periodEnd;
      reportDate = first?.reportDate;
      if (rows.every((items) => items.length === 0)) missingFields.push('statements');
    }
    if (query.includeIndicators) {
      const report = query.indicatorReport ?? this.deriveLatestReport(query.statementPeriod);
      indicators = await this.optionalData(() =>
        this.execute('financial-indicators', { thscode, report }),
      );
      if (indicators === undefined || indicators.indicators.length === 0)
        missingFields.push('indicators');
    }
    if (query.includeValuation) {
      valuation = await this.optionalData(() => this.execute('valuation-snapshot', { thscode }));
      if (valuation === undefined) missingFields.push('valuation');
    }
    const input: FinancialSnapshotHashInput = {
      stockId: thscode,
      source: 'fuyao',
      viewKind: 'current-vendor-view',
      pitStatus: 'not-ready',
      fetchedAt,
      ...(periodEnd === undefined ? {} : { periodEnd }),
      ...(reportDate === undefined ? {} : { reportDate }),
      ...(statements === undefined ? {} : { statements }),
      ...(indicators === undefined ? {} : { indicators }),
      ...(valuation === undefined ? {} : { valuation }),
      missingFields,
      issues: [],
    };
    return { ...input, rawContentHash: financialSnapshotContentHash(input) };
  }

  private async optionalData<T>(fetchData: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fetchData();
    } catch (error) {
      if (error instanceof SourceExecutionError && error.kind === 'no_data') return undefined;
      throw error;
    }
  }

  private async fetchStatements(
    type: FinancialStatementType,
    path: string,
    request: StatementRequest,
  ): Promise<FinancialStatement[]> {
    try {
      const result = await this.client.getData(`/api/a-share/financials/${path}`, request);
      const data = StatementDataSchema.parse(result.data);
      if (data.item.length > request.limit)
        throw invalidPayloadError('fuyao statement limit mismatch');
      return data.item.map((item) => {
        const schema =
          type === 'income-statement'
            ? IncomeStatementItemSchema
            : type === 'balance-sheet'
              ? BalanceSheetItemSchema
              : CashFlowStatementItemSchema;
        const {
          thscode,
          ticker,
          period,
          fiscal_year,
          fiscal_period,
          report_date_ms,
          period_end_ms,
          currency,
          ...fields
        } = schema.parse(item);
        if (
          thscode !== request.thscode ||
          ticker !== request.thscode.split('.')[0] ||
          period !== request.period
        )
          throw invalidPayloadError('fuyao statement identity/period mismatch');
        return {
          statementType: type,
          stockId: thscode,
          period,
          fiscalYear: fiscal_year,
          fiscalPeriod: fiscal_period === 'FY' ? 4 : Number(fiscal_period.slice(1)),
          periodEnd: new Date(period_end_ms),
          reportDate: new Date(report_date_ms),
          currency,
          fields,
        };
      });
    } catch (error) {
      throw this.parseError(error, path);
    }
  }

  private async fetchIndicators(thscode: string, report: string): Promise<FinancialIndicatorSet> {
    try {
      const result = await this.client.getData('/api/a-share/financials/indicators', {
        thscode,
        report,
      });
      const data = IndicatorDataSchema.parse(result.data);
      if (data.thscode !== thscode || data.report !== report)
        throw invalidPayloadError('fuyao indicators identity/report mismatch');
      const indicators: FinancialIndicator[] = data.abilities.flatMap((ability) =>
        ability.indicators.map((raw) => {
          const id = FinancialIndicatorIdSchema.safeParse(raw.index_id);
          if (!id.success)
            throw invalidPayloadError(`fuyao indicators schema drift: ${raw.index_id}`);
          const entry = FINANCIAL_INDICATOR_REGISTRY[id.data];
          const value = raw.value === null ? null : Number(raw.value);
          if (
            entry.category !== ability.ability ||
            (raw.value !== null && (raw.value.trim() === '' || !Number.isFinite(value)))
          )
            throw invalidPayloadError(`fuyao invalid indicator: ${raw.index_id}`);
          return {
            indicatorId: id.data,
            category: entry.category,
            unit: entry.unit,
            value,
            rawValue: raw.value,
          };
        }),
      );
      return { stockId: data.thscode, report: data.report, indicators };
    } catch (error) {
      throw this.parseError(error, 'indicators');
    }
  }

  private async fetchValuation(thscode: string): Promise<ValuationSnapshot> {
    try {
      const result = await this.client.getData('/api/a-share/valuations/snapshot', {
        thscodes: thscode,
      });
      const data = ValuationDataSchema.parse(result.data);
      if (data.item.length === 0) throw noDataError('fuyao valuation empty');
      const matches = data.item.filter((item) => item.thscode === thscode);
      const item = matches[0];
      if (matches.length !== 1 || item === undefined || item.ticker !== thscode.split('.')[0])
        throw invalidPayloadError('fuyao valuation identity mismatch');
      return {
        stockId: item.thscode,
        ticker: item.ticker,
        name: item.name,
        peTtm: item.pe_ttm,
        peMrq: item.pe_mrq,
        pbMrq: item.pb_mrq,
        psTtm: item.ps_ttm,
        pcfTtm: item.pcf_ttm,
      };
    } catch (error) {
      throw this.parseError(error, 'valuation');
    }
  }

  private parseError(error: unknown, endpoint: string): Error {
    if (error instanceof ZodError)
      return invalidPayloadError(`fuyao ${endpoint} schema drift`, error);
    return translateFuyaoError(error);
  }

  private deriveLatestReport(period: 'annual' | 'quarterly'): string {
    const now = this.clock();
    return `${now.getFullYear()}-${period === 'annual' ? 4 : Math.ceil((now.getMonth() + 1) / 3)}`;
  }
}
