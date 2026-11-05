import type {
  FinancialIndicatorSet,
  FinancialSnapshot,
  FinancialSnapshotQuery,
  FinancialStatement,
  FinancialStatementPeriod,
  ValuationSnapshot,
} from '@luoome/core';

export interface FinancialSnapshotManagerLike {
  readonly name: 'financial-snapshot';
  readonly sources: readonly string[];
  fetchSnapshot(query: FinancialSnapshotQuery): Promise<FinancialSnapshotResultLike>;
  status(): readonly import('@luoome/core').SourceStatus[];
}

export interface FinancialSnapshotResultLike {
  readonly ok: boolean;
  readonly data?: FinancialSnapshot;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'financial-snapshot';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

type StatementCapability = {
  readonly request: {
    readonly thscode: string;
    readonly period: FinancialStatementPeriod;
    readonly limit: number;
  };
  readonly result: FinancialStatement[];
};

export type FinancialSnapshotCapabilityMap = {
  'financial-income-statements': StatementCapability;
  'financial-balance-sheets': StatementCapability;
  'financial-cash-flow-statements': StatementCapability;
  'financial-indicators': {
    readonly request: { readonly thscode: string; readonly report: string };
    readonly result: FinancialIndicatorSet;
  };
  'valuation-snapshot': {
    readonly request: { readonly thscode: string };
    readonly result: ValuationSnapshot;
  };
};
