import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BalanceSheetItemSchema,
  CashFlowStatementItemSchema,
  FINANCIAL_INDICATOR_REGISTRY,
  FinancialIndicatorIdSchema,
  FinancialIndicatorRawItemSchema,
  FinancialSnapshotHashInputSchema,
  FinancialSnapshotQuerySchema,
  FinancialSnapshotSchema,
  financialSnapshotContentHash,
  IncomeStatementItemSchema,
  ValuationSnapshotItemSchema,
} from './financial-snapshot.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../adapters/src/fuyao/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  ).data;

// Domain schemas have no IO; these contract tests read the existing sanitized evidence.
describe('financial snapshot real JSON contracts', () => {
  it.each([
    ['income-statements', IncomeStatementItemSchema],
    ['balance-sheets', BalanceSheetItemSchema],
    ['cash-flow-statements', CashFlowStatementItemSchema],
  ] as const)(
    'validates every archived %s field without silently stripping the actual contract',
    (name, schema) => {
      for (const row of fixture(name).item) {
        expect(schema.parse(row)).toEqual(row);
        expect(row.period).toBe('annual');
        expect(row.fiscal_period).toBe('FY');
      }
    },
  );

  it('accepts quarterly fiscal periods and preserves null, rejecting missing required amount fields', () => {
    const row = {
      ...fixture('income-statements').item[0],
      period: 'quarterly',
      fiscal_period: 'Q3',
      interest_expenses: null,
    };
    expect(IncomeStatementItemSchema.parse(row).interest_expenses).toBeNull();
    const { operating_income: _removed, ...missing } = row;
    expect(IncomeStatementItemSchema.safeParse(missing).success).toBe(false);
    expect(IncomeStatementItemSchema.safeParse({ ...row, fiscal_period: 'Q5' }).success).toBe(
      false,
    );
  });

  it('validates the 23 real indicators with no invented index_name and checks explicit registry categories', () => {
    const raw = fixture('indicators');
    let count = 0;
    for (const ability of raw.abilities) {
      for (const indicator of ability.indicators) {
        expect(FinancialIndicatorRawItemSchema.parse(indicator)).toEqual(indicator);
        const id = FinancialIndicatorIdSchema.parse(indicator.index_id);
        expect(FINANCIAL_INDICATOR_REGISTRY[id].category).toBe(ability.ability);
        count++;
      }
    }
    expect(count).toBe(23);
    expect(FinancialIndicatorIdSchema.safeParse('unknown_metric').success).toBe(false);
    expect(FINANCIAL_INDICATOR_REGISTRY.current_ratio.unit).toBe('ratio');
    expect(FINANCIAL_INDICATOR_REGISTRY.earned_interest_multiple.unit).toBe('times');
    expect(FINANCIAL_INDICATOR_REGISTRY.calculate_operating_income_yoy_growth_ratio.unit).toBe(
      'percent-points',
    );
  });

  it('validates all real valuation fields and preserves synthetic null mutations', () => {
    for (const row of fixture('valuations-snapshot').item) {
      expect(ValuationSnapshotItemSchema.parse(row)).toEqual(row);
      expect(ValuationSnapshotItemSchema.parse({ ...row, pe_ttm: null }).pe_ttm).toBeNull();
    }
  });

  it('keeps query defaults and explicit period/limit/report', () => {
    expect(FinancialSnapshotQuerySchema.parse({ stockId: '600519.SH' })).toEqual({
      stockId: '600519.SH',
      includeStatements: true,
      includeIndicators: true,
      includeValuation: true,
      statementPeriod: 'annual',
      statementLimit: 3,
    });
    expect(
      FinancialSnapshotQuerySchema.parse({
        stockId: '300033.SZ',
        statementPeriod: 'quarterly',
        statementLimit: 4,
        indicatorReport: '2025-1',
      }),
    ).toMatchObject({ statementPeriod: 'quarterly', statementLimit: 4, indicatorReport: '2025-1' });
  });

  it('keeps PIT not-ready and hashes deterministic input without requiring the output hash', () => {
    const input = FinancialSnapshotHashInputSchema.parse({
      stockId: '600519.SH',
      source: 'fuyao',
      viewKind: 'current-vendor-view',
      pitStatus: 'not-ready',
      fetchedAt: new Date('2026-11-04T00:00:00Z'),
      missingFields: ['valuation'],
      issues: [],
    });
    const hash = financialSnapshotContentHash(input);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(financialSnapshotContentHash(input)).toBe(hash);
    expect(financialSnapshotContentHash({ ...input, stockId: '000001.SZ' })).not.toBe(hash);
    const snapshot = FinancialSnapshotSchema.parse({ ...input, rawContentHash: hash });
    expect(financialSnapshotContentHash(snapshot)).toBe(hash);
    expect('rawContentHash' in input).toBe(false);
    expect(FinancialSnapshotSchema.safeParse({ ...snapshot, pitStatus: 'ready' }).success).toBe(
      false,
    );
  });
});
