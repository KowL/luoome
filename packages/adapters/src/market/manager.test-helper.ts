import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  MarketCoverage,
  MarketSnapshot,
  MarketSnapshotItem,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';

import { MarketDataManager, type MarketDataManagerOptions } from './manager.js';
import { type AnyMarketCapabilityBinding, MarketSourceRegistry } from './source-registry.js';

interface TestMarketSource {
  readonly name: string;
  readonly indexQuoteMode?: 'realtime' | 'delayed';
  fetchQuote(stockCode: string): Promise<Quote>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  searchStocks?(query: string): Promise<StockSearchCandidate[]>;
  fetchIndexQuotes?(): Promise<readonly IndexQuote[]>;
  fetchIntradayMinutes?(stockId: string): Promise<readonly IntradayMinute[]>;
  fetchMarketSnapshot?(): Promise<readonly MarketSnapshotItem[]>;
  fetchMarketSnapshotEnvelope?(): Promise<MarketSnapshot>;
}

interface TestMarketDataManagerOptions
  extends Omit<MarketDataManagerOptions, 'registry' | 'clock'> {
  readonly primary?: TestMarketSource;
  readonly fallback?: TestMarketSource;
  readonly finalFallback?: TestMarketSource;
  readonly additionalSource?: TestMarketSource;
  readonly clock?: () => Date;
}

const TEST_COVERAGE = [
  'CN_A_SHARES_SH_SZ',
  'CN_A_SHARES_BJ',
  'HK_EQUITIES',
  'US_EQUITIES',
] as const satisfies readonly MarketCoverage[];

export const createTestMarketDataManager = (
  options: TestMarketDataManagerOptions,
): MarketDataManager => {
  const {
    primary,
    fallback,
    finalFallback,
    additionalSource,
    clock = (): Date => new Date(),
    ...managerOptions
  } = options;
  const sources = [primary, fallback, finalFallback, additionalSource].filter(
    (source): source is TestMarketSource => source !== undefined && source.name !== 'disabled',
  );
  return new MarketDataManager({
    ...managerOptions,
    clock,
    registry: testRegistry(sources, clock),
  });
};

const testRegistry = (
  sources: readonly TestMarketSource[],
  clock: () => Date,
): MarketSourceRegistry => {
  const bindings: AnyMarketCapabilityBinding[] = [];
  const seenNames = new Map<string, number>();
  for (const source of sources) {
    const occurrence = seenNames.get(source.name) ?? 0;
    seenNames.set(source.name, occurrence + 1);
    const sourceId = occurrence === 0 ? source.name : `${source.name}#${occurrence + 1}`;
    bindings.push(
      {
        capability: 'quote',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockId }) => source.fetchQuote(stockId),
        dataAsOf: (quote) => quote.observedAt,
      },
      {
        capability: 'daily-bars',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockId, range }) => source.fetchDailyBars(stockId, range),
        dataAsOf: (bars) => bars.at(-1)?.date,
      },
    );
    const searchStocks = source.searchStocks?.bind(source);
    if (searchStocks !== undefined) {
      bindings.push({
        capability: 'search',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ query }) => searchStocks(query),
      });
    }
    const fetchMarketSnapshot = source.fetchMarketSnapshot?.bind(source);
    if (fetchMarketSnapshot !== undefined) {
      bindings.push({
        capability: 'market-snapshot',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: () => fetchMarketSnapshot(),
      });
    }
    const fetchMarketSnapshotEnvelope = source.fetchMarketSnapshotEnvelope?.bind(source);
    if (fetchMarketSnapshotEnvelope !== undefined) {
      bindings.push({
        capability: 'market-snapshot-envelope',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: () => fetchMarketSnapshotEnvelope(),
      });
    }
    const fetchIndexQuotes = source.fetchIndexQuotes?.bind(source);
    if (fetchIndexQuotes !== undefined) {
      const capability =
        source.indexQuoteMode === 'delayed'
          ? ('delayed-index' as const)
          : ('realtime-index' as const);
      bindings.push({
        capability,
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: () => fetchIndexQuotes(),
        dataAsOf: (indices) =>
          indices.reduce<Date | undefined>(
            (latest, index) => (latest === undefined || index.ts > latest ? index.ts : latest),
            undefined,
          ),
      });
    }
    const fetchIntradayMinutes = source.fetchIntradayMinutes?.bind(source);
    if (fetchIntradayMinutes !== undefined) {
      bindings.push({
        capability: 'intraday-minutes',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockId }) => fetchIntradayMinutes(stockId),
        dataAsOf: (points) => points.at(-1)?.time,
      });
    }
  }
  return new MarketSourceRegistry(bindings, clock);
};
