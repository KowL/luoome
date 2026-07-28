import {
  type ListingStatus,
  type MarketCoverage,
  type StockUniverseEntry,
  type StockUniverseSnapshot,
  StockUniverseSnapshotSchema,
  type StockUniverseSourceLike,
  stockCode,
} from '@luoome/core';

import { type TushareConfig, tushareQuery } from '../tushare/client.js';

const FIELDS = [
  'ts_code',
  'symbol',
  'name',
  'area',
  'industry',
  'market',
  'list_date',
  'delist_date',
] as const;

const STATUS_MAP = {
  L: 'listed',
  P: 'suspended',
  D: 'delisted',
} as const satisfies Record<string, ListingStatus>;

export interface TushareStockUniverseAdapterOptions {
  readonly config: TushareConfig;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
}

export class TushareStockUniverseAdapter implements StockUniverseSourceLike {
  readonly name = 'tushare';
  readonly coverage = ['CN_A_SHARES_SH_SZ'] as const;

  private readonly config: TushareConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(options: TushareStockUniverseAdapterOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async fetchStockUniverse(coverage: MarketCoverage): Promise<StockUniverseSnapshot> {
    if (coverage !== 'CN_A_SHARES_SH_SZ') {
      throw new Error(`unsupported_market: tushare stock universe does not cover ${coverage}`);
    }

    const entries: StockUniverseEntry[] = [];
    for (const status of ['L', 'P', 'D'] as const) {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await tushareQuery(
          'stock_basic',
          { list_status: status },
          this.config,
          this.fetchImpl,
          FIELDS,
        );
      } catch (error) {
        throw new Error(`partial_data: tushare stock_basic ${status} failed`, { cause: error });
      }
      for (const row of rows) {
        const entry = mapRow(row, STATUS_MAP[status]);
        if (entry !== null) entries.push(entry);
      }
    }

    return StockUniverseSnapshotSchema.parse({
      source: this.name,
      coverage,
      observedAt: this.clock(),
      complete: true,
      reportedTotal: entries.length,
      entries,
    });
  }
}

const mapRow = (
  row: Readonly<Record<string, unknown>>,
  listingStatus: ListingStatus,
): StockUniverseEntry | null => {
  if (
    typeof row.ts_code !== 'string' ||
    typeof row.symbol !== 'string' ||
    typeof row.name !== 'string'
  ) {
    throw new Error('invalid_payload: tushare stock_basic row is missing identity fields');
  }
  const suffix = row.ts_code.split('.')[1]?.toUpperCase();
  const exchange = suffix === 'SH' ? 'SH' : suffix === 'SZ' ? 'SZ' : undefined;
  if (exchange === undefined) return null;
  const code = stockCode(row.symbol);
  if (row.ts_code.toUpperCase() !== `${code}.${exchange}`) {
    throw new Error(`invalid_payload: tushare ts_code mismatch ${row.ts_code}`);
  }
  const industry =
    typeof row.industry === 'string' && row.industry.trim().length > 0
      ? row.industry.trim()
      : undefined;
  const listDate = parseYmd(row.list_date);
  const delistDate = parseYmd(row.delist_date);
  return {
    stockId: `${code}.${exchange}`,
    code,
    exchange,
    name: row.name.trim(),
    listingStatus,
    ...(industry === undefined ? {} : { industry }),
    ...(listDate === undefined ? {} : { listDate }),
    ...(delistDate === undefined ? {} : { delistDate }),
  };
};

const parseYmd = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? undefined : date;
};
