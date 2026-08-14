import {
  type MarketCoverage,
  type StockUniverseEntry,
  type StockUniverseSnapshot,
  StockUniverseSnapshotSchema,
  type StockUniverseSourceLike,
  stockCode,
} from '@luoome/core';

const DEFAULT_COUNT_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount';
const DEFAULT_DATA_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const EXCHANGES = ['sh_a', 'sz_a'] as const;

interface SinaStockItem {
  readonly symbol?: unknown;
  readonly code?: unknown;
  readonly name?: unknown;
}

export interface SinaStockUniverseAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly countUrl?: string;
  readonly dataUrl?: string;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
}

/** 新浪行情中心的沪深 A 股目录；只把目录作为身份事实，不从停牌报价推断 listingStatus。 */
export class SinaStockUniverseAdapter implements StockUniverseSourceLike {
  readonly name = 'sina';
  readonly coverage = ['CN_A_SHARES_SH_SZ'] as const;

  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly countUrl: string;
  private readonly dataUrl: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(options: SinaStockUniverseAdapterOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.countUrl = options.countUrl ?? DEFAULT_COUNT_URL;
    this.dataUrl = options.dataUrl ?? DEFAULT_DATA_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(this.pageSize) || this.pageSize <= 0) {
      throw new Error('invalid_config: sina stock universe pageSize must be positive');
    }
  }

  async fetchStockUniverse(coverage: MarketCoverage): Promise<StockUniverseSnapshot> {
    if (coverage !== 'CN_A_SHARES_SH_SZ') {
      throw new Error(`unsupported_market: sina stock universe does not cover ${coverage}`);
    }

    const entries: StockUniverseEntry[] = [];
    const seen = new Set<string>();
    for (const node of EXCHANGES) {
      const reportedTotal = await this.fetchCount(node);
      const marketEntries = await this.fetchMarket(node, reportedTotal);
      for (const entry of marketEntries) {
        if (seen.has(entry.stockId)) {
          throw new Error(`invalid_payload: sina duplicate stockId ${entry.stockId}`);
        }
        seen.add(entry.stockId);
        entries.push(entry);
      }
    }

    if (entries.length === 0) {
      throw new Error('invalid_payload: sina stock universe returned no entries');
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

  private async fetchCount(node: (typeof EXCHANGES)[number]): Promise<number> {
    const response = await this.request(this.countUrl, { node });
    const text = await response.text();
    let raw: unknown = text.trim();
    try {
      raw = JSON.parse(text);
    } catch {
      // Older Sina gateways return a quoted number or plain text rather than JSON.
    }
    const normalized = typeof raw === 'string' ? raw.replace(/^"|"$/g, '').trim() : raw;
    const total = typeof normalized === 'number' ? normalized : Number(normalized);
    if (!Number.isInteger(total) || total <= 0) {
      throw new Error(`invalid_payload: sina ${node} count is invalid`);
    }
    return total;
  }

  private async fetchMarket(
    node: (typeof EXCHANGES)[number],
    reportedTotal: number,
  ): Promise<StockUniverseEntry[]> {
    const entries: StockUniverseEntry[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request(this.dataUrl, {
        page: String(page),
        num: String(this.pageSize),
        sort: 'symbol',
        asc: '1',
        node,
        symbol: '',
        _s_r_a: 'page',
      });
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) {
        throw new Error(`invalid_payload: sina ${node} page ${page} is not an array`);
      }
      for (const item of payload) {
        entries.push(mapItem(item, node));
      }
      if (entries.length >= reportedTotal) break;
      if (payload.length === 0) {
        throw new Error(
          `partial_data: sina ${node} ended at ${entries.length}/${reportedTotal} entries`,
        );
      }
    }
    if (entries.length !== reportedTotal) {
      throw new Error(
        `partial_data: sina ${node} returned ${entries.length}/${reportedTotal} entries`,
      );
    }
    return entries;
  }

  private async request(url: string, params: Readonly<Record<string, string>>): Promise<Response> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target, { signal: controller.signal });
      if (!response.ok) throw new Error(`network: sina HTTP ${response.status}`);
      return response;
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
      throw new Error(`${kind}: sina stock universe request failed`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const mapItem = (value: unknown, node: (typeof EXCHANGES)[number]): StockUniverseEntry => {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`invalid_payload: sina ${node} row is not an object`);
  }
  const item = value as SinaStockItem;
  if (
    typeof item.symbol !== 'string' ||
    typeof item.code !== 'string' ||
    typeof item.name !== 'string'
  ) {
    throw new Error(`invalid_payload: sina ${node} row is missing identity fields`);
  }
  const symbol = item.symbol.trim().toLowerCase();
  const expectedPrefix = node === 'sh_a' ? 'sh' : 'sz';
  if (!new RegExp(`^${expectedPrefix}\\d{6}$`).test(symbol) || item.code !== symbol.slice(2)) {
    throw new Error(`invalid_payload: sina ${node} symbol/code mismatch`);
  }
  const code = stockCode(item.code);
  const exchange = node === 'sh_a' ? 'SH' : 'SZ';
  const name = item.name.trim();
  if (name.length === 0) throw new Error(`invalid_payload: sina ${node} row has empty name`);
  return {
    stockId: `${code}.${exchange}`,
    code,
    exchange,
    name,
    listingStatus: 'unknown',
  };
};
