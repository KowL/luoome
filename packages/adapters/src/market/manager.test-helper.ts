import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  MarketCoverage,
  MarketSnapshot,
  MarketSnapshotItem,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import type { SourceResultObservation } from '../source-registry.js';
import { MarketDataManager, type MarketDataManagerOptions } from './manager.js';
import { type AnyMarketCapabilityBinding, MarketSourceRegistry } from './source-registry.js';

/** 与 factory 同契约：resolved 即 success；dataAsOf 有则更新、无则清除。 */
const successObservation = (dataAsOf: Date | undefined): SourceResultObservation =>
  dataAsOf === undefined ? { outcome: 'success' } : { outcome: 'success', dataAsOf };

interface TestMarketSource {
  readonly name: string;
  readonly indexQuoteMode?: 'realtime' | 'delayed';
  fetchQuote(stockCode: string): Promise<Quote>;
  fetchBatchQuotes?(stockIds: readonly string[]): Promise<Quote[]>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  searchStocks?(query: string): Promise<StockSearchCandidate[]>;
  fetchIndexQuotes?(): Promise<readonly IndexQuote[]>;
  fetchIntradayMinutes?(stockId: string): Promise<readonly IntradayMinute[]>;
  fetchMinuteBars?(stockId: string, interval: MinuteBarInterval): Promise<readonly MinuteBar[]>;
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
        observationOf: (quote) => successObservation(quote.observedAt),
      },
      {
        capability: 'daily-bars',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockId, range }) => source.fetchDailyBars(stockId, range),
        observationOf: (bars) => successObservation(bars.at(-1)?.date),
      },
    );
    const fetchBatchQuotes = source.fetchBatchQuotes?.bind(source);
    if (fetchBatchQuotes !== undefined) {
      bindings.push({
        capability: 'batch-quote',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockIds }) => fetchBatchQuotes(stockIds),
        observationOf: (quotes) =>
          successObservation(
            quotes.reduce<Date | undefined>(
              (latest, quote) =>
                latest === undefined || quote.observedAt.getTime() > latest.getTime()
                  ? quote.observedAt
                  : latest,
              undefined,
            ),
          ),
      });
    }
    const searchStocks = source.searchStocks?.bind(source);
    if (searchStocks !== undefined) {
      bindings.push({
        capability: 'search',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ query }) => searchStocks(query),
        observationOf: () => ({ outcome: 'success' }),
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
        observationOf: () => ({ outcome: 'success' }),
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
        observationOf: (snapshot) => successObservation(snapshot.dataAsOf),
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
        observationOf: (indices) =>
          successObservation(
            indices.reduce<Date | undefined>(
              (latest, index) => (latest === undefined || index.ts > latest ? index.ts : latest),
              undefined,
            ),
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
        observationOf: (points) => successObservation(points.at(-1)?.time),
      });
    }
    const fetchMinuteBars = source.fetchMinuteBars?.bind(source);
    if (fetchMinuteBars !== undefined) {
      bindings.push({
        capability: 'minute-bars',
        source: sourceId,
        coverage: TEST_COVERAGE,
        configurationReady: true,
        execute: ({ stockId, interval }) => fetchMinuteBars(stockId, interval),
        observationOf: (bars) => successObservation(bars.at(-1)?.endedAt),
      });
    }
  }
  return new MarketSourceRegistry(bindings, clock);
};
