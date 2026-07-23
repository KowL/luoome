import {
  quantity as brandQuantity,
  type DailyBar,
  type DateRange,
  type Exchange,
  money,
  type Quote,
  type StockSearchCandidate,
} from '@luoome/core';

/**
 * Eastmoney 行情适配器（v0.2 起主力源，覆盖 A 股 + 港股）。
 *
 * 公开 API（无需鉴权）：
 * - 实时快照：https://push2.eastmoney.com/api/qt/stock/get
 *   参数：secid={marketId}.{code}&fields=f43,f44,f45,f46,f47,f48,f60,f169,f170&fltt=2&invt=2
 *   - f43=最新价, f44=最高, f45=最低, f46=今开, f47=成交量(手), f48=成交额(元)
 *   - f60=昨收, f169=涨跌额, f170=涨跌幅(%)
 *   - fltt=2&invt=2 必须带：缺省时价格字段返回 ×100 的整数分（2026-07 实测
 *   - f43=9392 表示 93.92 元），带上后返回 float 元。
 * - 日线 K 线：https://push2his.eastmoney.com/api/qt/stock/kline/get
 *   参数：secid={marketId}.{code}&fields1=...&fields2=...&klt=101&fqt=1&beg=0&end=20500101
 *   返回 klines 是 `"YYYY-MM-DD,open,close,high,low,volume,amount,amplitude,turnoverRate"`
 *   字符串数组。
 *
 * 设计要点：
 * - 内部抛出 EastmoneyAdapterError（继承 Error），由 Manager 接住 + 路由到 fallback。
 *   这样底层错误信号不污染 MarketDataAdapterLike 接口（接口方法只返回数据/抛业务错）。
 * - timeout：默认 5s（与 plan-v0.2-v0.3 §6 硬约束对齐）；测试可通过构造注入。
 * - 不在 adapter 内做缓存（缓存统一在 Manager 层）。
 */

const DEFAULT_TIMEOUT_MS = 5_000;

/** Eastmoney 专用错误。Manager 通过 `instanceof EastmoneyAdapterError` 判断 source。 */
export class EastmoneyAdapterError extends Error {
  override readonly name = 'EastmoneyAdapterError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** stockCode（如 '002594' 或 '002594.SZ'）→ Eastmoney secid。未知交易所抛 EastmoneyAdapterError。 */
const toSecId = (stockCode: string): string => {
  const normalized = stockCode.toUpperCase().trim();
  // 形式 1: '<code>.<exchange>'（如 '002594.SZ'）
  const dot = normalized.lastIndexOf('.');
  if (dot > 0) {
    const code = normalized.slice(0, dot);
    const exchange = normalized.slice(dot + 1);
    return `${exchangeToMarketId(exchange)}.${code}`;
  }
  // 形式 2: 纯代码，按前缀推断交易所（6 位数字 → SH/SZ/BJ；其它走 HK）
  if (/^\d{6}$/.test(normalized)) {
    const first = normalized[0];
    // 6/9 开头 → SH；0/3 开头 → SZ；4/8 开头 → BJ；5 开头 → SZ（基金惯例）
    if (first === '6' || first === '9') return `1.${normalized}`;
    if (first === '0' || first === '3' || first === '5') return `0.${normalized}`;
    if (first === '4' || first === '8') return `0.${normalized}`; // BJ 走 0 通道
    throw new EastmoneyAdapterError(`无法推断交易所: code=${normalized}`);
  }
  // 港股 5 位数字（多数以 0 开头）
  if (/^\d{4,5}$/.test(normalized)) return `116.${normalized.padStart(5, '0')}`;
  throw new EastmoneyAdapterError(`无法识别的 stockCode: ${stockCode}`);
};

const exchangeToMarketId = (exchange: string): string => {
  switch (exchange) {
    case 'SH':
      return '1';
    case 'SZ':
    case 'BJ':
      return '0';
    case 'HK':
      return '116';
    default:
      throw new EastmoneyAdapterError(`Eastmoney 不支持交易所: ${exchange}`);
  }
};

export interface EastmoneyAdapterOptions {
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  /** 测试用：替换 fetch。 */
  readonly fetchImpl?: typeof fetch;
  readonly baseQuoteUrl?: string;
  readonly baseKlineUrl?: string;
  readonly baseSearchUrl?: string;
}

/**
 * Eastmoney snapshot 接口返回的关键字段子集（其它字段略）。
 * 数字字段缺失时 Eastmoney 返回 - 或 null，按 - 处理。
 */
interface EastmoneyQuoteResponse {
  readonly rc: number;
  readonly rt?: number;
  readonly svr?: number;
  readonly lt?: number;
  readonly full?: boolean;
  readonly dlmk?: string;
  readonly data?: {
    readonly f43?: number; // 最新价（fltt=2 后为 float 元）
    readonly f44?: number; // 最高
    readonly f45?: number; // 最低
    readonly f46?: number; // 今开
    readonly f47?: number; // 成交量（手）
    readonly f48?: number; // 成交额（元）
    readonly f60?: number; // 昨收
    readonly f57?: string; // 代码
    readonly f58?: string; // 名称
    readonly f169?: number; // 涨跌额
    readonly f170?: number; // 涨跌幅%
  };
}

interface EastmoneyKlineResponse {
  readonly rc: number;
  readonly data?: {
    readonly code?: string;
    readonly name?: string;
    readonly klines?: readonly string[];
  };
}

/** suggest 接口单条记录（type=14 股票；字段 2026-07 实测）。 */
interface EastmoneySuggestItem {
  readonly Code?: string;
  readonly Name?: string;
  readonly Classify?: string;
  readonly SecurityTypeName?: string;
  readonly QuoteID?: string;
}

interface EastmoneySuggestResponse {
  readonly QuotationCodeTable?: {
    readonly Status?: number;
    readonly TotalCount?: number;
    readonly Data?: readonly EastmoneySuggestItem[] | null;
  };
}

/**
 * suggest 响应 → 候选列表（纯函数，便于测试）。
 * 交易所映射依据 QuoteID 前缀 + Classify（2026-07 实测）：
 *   1.xxxxxx → SH；0.xxxxxx + AStock → SZ；0.xxxxxx + 京A/NEEQ → BJ；
 *   116.xxxxx → HK；105./106./107.xxx → US。
 * 无法映射交易所的条目丢弃（基金 / 债券 / 指数等 type=14 漏网）。
 */
/** Classify 白名单：AStock = A 股，HK = 港股，UsStock = 美股，NEEQ = 北交所/新三板。 */
const ALLOWED_CLASSIFIES: ReadonlySet<string> = new Set(['AStock', 'HK', 'UsStock', 'NEEQ']);

export const parseEastmoneySuggest = (json: EastmoneySuggestResponse): StockSearchCandidate[] => {
  const table = json.QuotationCodeTable;
  if (table?.Status !== 0) {
    throw new EastmoneyAdapterError(`Eastmoney 搜索失败: Status=${table?.Status ?? 'null'}`);
  }
  const items = table.Data ?? [];
  const result: StockSearchCandidate[] = [];
  for (const item of items) {
    if (item.Code === undefined || item.Name === undefined || item.QuoteID === undefined) continue;
    // type=14 仍会漏基金 / 债券等，按 Classify 白名单再过滤一层
    if (!ALLOWED_CLASSIFIES.has(item.Classify ?? '')) continue;
    const exchange = suggestExchange(item);
    if (exchange === undefined) continue;
    result.push({
      id: `${item.Code}.${exchange}`,
      code: item.Code,
      exchange,
      name: item.Name,
    });
  }
  return result;
};

const suggestExchange = (item: EastmoneySuggestItem): Exchange | undefined => {
  const prefix = item.QuoteID?.split('.')[0];
  switch (prefix) {
    case '1':
      return 'SH';
    case '0':
      return item.Classify === 'AStock'
        ? 'SZ'
        : item.SecurityTypeName?.includes('京') === true
          ? 'BJ'
          : undefined;
    case '116':
      return 'HK';
    case '105':
    case '106':
    case '107':
      return 'US';
    default:
      return undefined;
  }
};

const QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f48,f60,f57,f58,f169,f170';
const KLINE_FIELDS = '1,2,3,4,5,6,8,9';
/** suggest 接口公开 token（Eastmoney Web 前端同款，无需鉴权）。 */
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

export class EastmoneyAdapter {
  readonly name = 'eastmoney';

  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseQuoteUrl: string;
  private readonly baseKlineUrl: string;
  private readonly baseSearchUrl: string;

  constructor(options: EastmoneyAdapterOptions = {}) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseQuoteUrl = options.baseQuoteUrl ?? 'https://push2.eastmoney.com/api/qt/stock/get';
    this.baseKlineUrl =
      options.baseKlineUrl ?? 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
    this.baseSearchUrl = options.baseSearchUrl ?? 'https://searchapi.eastmoney.com/api/suggest/get';
  }

  /**
   * 拉单股行情快照。stockCode 可为纯代码或 `<code>.<exchange>`。
   * 抛出 EastmoneyAdapterError；不抛其它异常。
   */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const secid = toSecId(stockCode);
    const url = `${this.baseQuoteUrl}?secid=${secid}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`;
    const json = await this.getJson<EastmoneyQuoteResponse>(url);
    if (json.rc !== 0 || json.data === undefined) {
      throw new EastmoneyAdapterError(`Eastmoney 快照失败: rc=${json.rc} secid=${secid}`);
    }
    const d = json.data;
    const closeRaw = d.f43;
    if (closeRaw === undefined || closeRaw <= 0) {
      throw new EastmoneyAdapterError(`Eastmoney 快照缺价: secid=${secid} f43=${closeRaw}`);
    }
    const volume = typeof d.f47 === 'number' && d.f47 > 0 ? d.f47 * 100 : 0; // 手 → 股
    return {
      stockId: stockCode.includes('.') ? stockCode.toUpperCase() : stockCode.toUpperCase(),
      ts: this.clock(),
      open: money(d.f46 && d.f46 > 0 ? d.f46 : closeRaw),
      high: money(d.f44 && d.f44 > 0 ? d.f44 : closeRaw),
      low: money(d.f45 && d.f45 > 0 ? d.f45 : closeRaw),
      close: money(closeRaw),
      volume,
      source: 'eastmoney',
    };
  }

  /** 批量：简单并发（受 Manager 的 rate limiter 约束）。 */
  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    await Promise.all(
      stockCodes.map(async (code) => {
        try {
          const quote = await this.fetchQuote(code);
          result.set(code, quote);
        } catch (error) {
          // batch 中单条失败不中断整批；Manager 通过 fetchQuote 重试或 fallback。
          if (!(error instanceof EastmoneyAdapterError)) throw error;
        }
      }),
    );
    return result;
  }

  /** 拉日线。range 端点对齐 Eastmoney beg/end 参数。 */
  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const secid = toSecId(stockCode);
    const beg = formatYmd(range.start);
    const end = formatYmd(range.end);
    const url =
      `${this.baseKlineUrl}?secid=${secid}&fields1=${KLINE_FIELDS}` +
      `&fields2=${KLINE_FIELDS}&klt=101&fqt=1&beg=${beg}&end=${end}`;
    const json = await this.getJson<EastmoneyKlineResponse>(url);
    if (json.rc !== 0 || json.data === undefined || json.data.klines === undefined) {
      throw new EastmoneyAdapterError(`Eastmoney 日线失败: rc=${json.rc} secid=${secid}`);
    }
    const stockId = stockCode.includes('.') ? stockCode.toUpperCase() : stockCode.toUpperCase();
    const bars: DailyBar[] = [];
    for (const line of json.data.klines) {
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const [dateStr, openStr, closeStr, highStr, lowStr, volumeStr] = parts;
      if (
        dateStr === undefined ||
        openStr === undefined ||
        closeStr === undefined ||
        highStr === undefined ||
        lowStr === undefined ||
        volumeStr === undefined
      ) {
        continue;
      }
      const open = Number.parseFloat(openStr);
      const close = Number.parseFloat(closeStr);
      const high = Number.parseFloat(highStr);
      const low = Number.parseFloat(lowStr);
      const volume = brandQuantity(Math.round(Number.parseFloat(volumeStr)) * 100); // 手 → 股
      if ([open, close, high, low].some((n) => !Number.isFinite(n) || n <= 0)) continue;
      bars.push({
        stockId,
        date: new Date(`${dateStr}T00:00:00.000Z`),
        open: money(open),
        high: money(high),
        low: money(low),
        close: money(close),
        volume,
        adjFactor: 1.0,
      });
    }
    return bars;
  }

  /**
   * 外部股票搜索（v0.8 起）：suggest 接口 type=14（股票）。
   * 空结果返回 []（合法答案，不算失败）；HTTP 错误 / Status != 0 抛 EastmoneyAdapterError。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const url =
      `${this.baseSearchUrl}?input=${encodeURIComponent(query)}` +
      `&type=14&token=${SEARCH_TOKEN}&count=20`;
    const json = await this.getJson<EastmoneySuggestResponse>(url);
    return parseEastmoneySuggest(json);
  }

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        throw new EastmoneyAdapterError(`HTTP ${res.status} ${res.statusText} url=${url}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof EastmoneyAdapterError) throw error;
      throw new EastmoneyAdapterError(
        `fetch 失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

/** Date → 'YYYYMMDD'。 */
const formatYmd = (d: Date): string => {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
};

// Re-export 类型供 Manager 用
export type { DailyBar, DateRange, Quote };
