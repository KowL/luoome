import {
  type MarketCoverage,
  type StockUniverseEntry,
  type StockUniverseSnapshot,
  StockUniverseSnapshotSchema,
  type StockUniverseSourceLike,
  stockCode,
} from '@luoome/core';

const DEFAULT_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PAGE_SIZE = 500;
const COVERAGE_FILTER = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

interface EastmoneyUniverseItem {
  readonly f12?: string;
  readonly f13?: number;
  readonly f14?: string;
}

interface EastmoneyUniverseResponse {
  readonly rc?: number;
  readonly data?: {
    readonly total?: number;
    readonly diff?: readonly EastmoneyUniverseItem[] | null;
  } | null;
}

export interface EastmoneyStockUniverseAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
}

export class EastmoneyStockUniverseAdapter implements StockUniverseSourceLike {
  readonly name = 'eastmoney';
  readonly coverage = ['CN_A_SHARES_SH_SZ'] as const;

  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(options: EastmoneyStockUniverseAdapterOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async fetchStockUniverse(coverage: MarketCoverage): Promise<StockUniverseSnapshot> {
    if (coverage !== 'CN_A_SHARES_SH_SZ') {
      throw new Error(`unsupported_market: eastmoney stock universe does not cover ${coverage}`);
    }

    const entries: StockUniverseEntry[] = [];
    let reportedTotal: number | undefined;
    for (let page = 1; ; page += 1) {
      const response = await this.fetchPage(page);
      if (response.rc !== 0 || response.data === null || response.data === undefined) {
        throw new Error(`invalid_payload: eastmoney stock universe page ${page} rc=${response.rc}`);
      }
      if (
        response.data.total === undefined ||
        !Number.isInteger(response.data.total) ||
        response.data.total <= 0
      ) {
        throw new Error(`invalid_payload: eastmoney stock universe page ${page} missing total`);
      }
      if (reportedTotal !== undefined && response.data.total !== reportedTotal) {
        throw new Error('partial_data: eastmoney stock universe total changed during pagination');
      }
      reportedTotal = response.data.total;
      const pageItems = response.data.diff;
      if (!Array.isArray(pageItems)) {
        throw new Error(`partial_data: eastmoney stock universe page ${page} missing diff`);
      }
      for (const item of pageItems) {
        const exchange = item.f13 === 1 ? 'SH' : item.f13 === 0 ? 'SZ' : undefined;
        if (
          exchange === undefined ||
          typeof item.f12 !== 'string' ||
          typeof item.f14 !== 'string'
        ) {
          throw new Error(`invalid_payload: eastmoney stock universe page ${page} has invalid row`);
        }
        const code = stockCode(item.f12);
        entries.push({
          stockId: `${code}.${exchange}`,
          code,
          exchange,
          name: item.f14.trim(),
          listingStatus: 'unknown',
        });
      }
      if (entries.length >= reportedTotal) break;
      if (pageItems.length === 0) {
        throw new Error('partial_data: eastmoney stock universe ended before reported total');
      }
    }

    return StockUniverseSnapshotSchema.parse({
      source: this.name,
      coverage,
      observedAt: this.clock(),
      complete: true,
      reportedTotal,
      entries,
    });
  }

  private async fetchPage(page: number): Promise<EastmoneyUniverseResponse> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('pn', String(page));
    url.searchParams.set('pz', String(this.pageSize));
    url.searchParams.set('po', '1');
    url.searchParams.set('np', '1');
    url.searchParams.set('fid', 'f12');
    url.searchParams.set('fs', COVERAGE_FILTER);
    url.searchParams.set('fields', 'f12,f13,f14');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`network: eastmoney stock universe HTTP ${response.status}`);
      }
      return (await response.json()) as EastmoneyUniverseResponse;
    } catch (error) {
      if (
        error instanceof Error &&
        /^(network|invalid_payload|partial_data):/.test(error.message)
      ) {
        throw error;
      }
      const kind =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
          ? 'timeout'
          : 'network';
      throw new Error(`${kind}: eastmoney stock universe request failed`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
