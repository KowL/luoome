import {
  quantity as brandQuantity,
  type DailyBar,
  type DateRange,
  type Exchange,
  type IndexQuote,
  type MarketSnapshotItem,
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
 * - 全市场快照：https://push2.eastmoney.com/api/qt/clist/get
 *   参数：pn/pz 分页 + fs（市场过滤）+ fields=f12,f13,f14,f2,f3（代码/市场/名称/最新价/涨跌幅）。
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
  readonly baseClistUrl?: string;
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
    readonly f124?: number; // 行情更新时间（Unix 秒）
    readonly f57?: string; // 代码
    readonly f58?: string; // 名称
    readonly f168?: number; // 换手率%
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

/** clist 单条记录（fields=f12,f13,f14,f2,f3；f2/f3 停牌时返回 '-'）。 */
interface EastmoneyClistItem {
  readonly f12?: string; // 代码
  readonly f13?: number; // 市场 id（1=SH，0=SZ）
  readonly f14?: string; // 名称
  readonly f2?: number | string; // 最新价（fltt=2 后为 float 元；'-' 表示无报价）
  readonly f3?: number | string; // 涨跌幅%
}

interface EastmoneyClistResponse {
  readonly rc: number;
  readonly data?: {
    readonly total?: number;
    readonly diff?: readonly EastmoneyClistItem[] | null;
  } | null;
}

/**
 * clist 响应 → 全市场快照条目（纯函数，便于测试）。
 * 本接口 fs 限定沪深 A 股，marketId 只应出现 1/0；其它值（B 股等漏网）丢弃。
 * f2 缺失 / '-' / 非正（停牌）不丢弃条目，仅省略 close/changePct。
 */
export const parseEastmoneyClist = (json: EastmoneyClistResponse): MarketSnapshotItem[] => {
  if (json.rc !== 0) {
    throw new EastmoneyAdapterError(`Eastmoney 全市场快照失败: rc=${json.rc}`);
  }
  const items = json.data?.diff ?? [];
  const result: MarketSnapshotItem[] = [];
  for (const item of items) {
    if (item.f12 === undefined || item.f14 === undefined) continue;
    const exchange = item.f13 === 1 ? 'SH' : item.f13 === 0 ? 'SZ' : undefined;
    if (exchange === undefined) continue;
    const close = typeof item.f2 === 'number' && item.f2 > 0 ? item.f2 : undefined;
    const changePct = typeof item.f3 === 'number' ? item.f3 : undefined;
    result.push({
      id: `${item.f12}.${exchange}`,
      code: item.f12,
      exchange,
      name: item.f14,
      ...(close !== undefined ? { close } : {}),
      ...(changePct !== undefined ? { changePct } : {}),
    });
  }
  return result;
};

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

const QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f48,f60,f57,f58,f124,f168,f169,f170';
const KLINE_FIELDS = '1,2,3,4,5,6,8,9';
/** suggest 接口公开 token（Eastmoney Web 前端同款，无需鉴权）。 */
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/**
 * clist（全市场快照）参数：fs 覆盖深主板(t:6)+创业板(t:80)+沪主板(t:2)+科创板(t:23)。
 * fid=f3 = 按涨跌幅降序；若 AI 来源只取前 N 条，会产生强势股抽样偏置。
 */
const CLIST_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const CLIST_FIELDS = 'f12,f13,f14,f2,f3';
const CLIST_PAGE_SIZE = 500;

/**
 * 主要大盘指数（secid 用 Eastmoney marketId 约定：1=SH，0=SZ）。
 * 名称不写死，以接口 f58 返回为准。
 */
const MAJOR_INDICES = [
  { secid: '1.000001' }, // 上证指数
  { secid: '0.399001' }, // 深证成指
  { secid: '0.399006' }, // 创业板指
  { secid: '1.000300' }, // 沪深300
  { secid: '1.000688' }, // 科创50
] as const;

export class EastmoneyAdapter {
  readonly name = 'eastmoney';
  readonly indexQuoteMode = 'realtime' as const;

  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseQuoteUrl: string;
  private readonly baseKlineUrl: string;
  private readonly baseSearchUrl: string;
  private readonly baseClistUrl: string;

  constructor(options: EastmoneyAdapterOptions = {}) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseQuoteUrl = options.baseQuoteUrl ?? 'https://push2.eastmoney.com/api/qt/stock/get';
    this.baseKlineUrl =
      options.baseKlineUrl ?? 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
    this.baseSearchUrl = options.baseSearchUrl ?? 'https://searchapi.eastmoney.com/api/suggest/get';
    this.baseClistUrl = options.baseClistUrl ?? 'https://push2.eastmoney.com/api/qt/clist/get';
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
    const fetchedAt = this.clock();
    const upstreamAt =
      typeof d.f124 === 'number' && d.f124 > 0 ? new Date(d.f124 * 1000) : undefined;
    const observedAt =
      upstreamAt !== undefined && upstreamAt.getTime() <= fetchedAt.getTime()
        ? upstreamAt
        : fetchedAt;
    return {
      stockId: stockCode.includes('.') ? stockCode.toUpperCase() : stockCode.toUpperCase(),
      observedAt,
      fetchedAt,
      timestampSource: observedAt === fetchedAt ? 'retrieval' : 'upstream',
      ts: observedAt,
      open: money(d.f46 && d.f46 > 0 ? d.f46 : closeRaw),
      high: money(d.f44 && d.f44 > 0 ? d.f44 : closeRaw),
      low: money(d.f45 && d.f45 > 0 ? d.f45 : closeRaw),
      close: money(closeRaw),
      volume,
      ...(typeof d.f48 === 'number' && d.f48 > 0 ? { amount: d.f48 } : {}),
      ...(typeof d.f168 === 'number' && d.f168 >= 0 ? { turnoverRatePct: d.f168 } : {}),
      ...(typeof d.f60 === 'number' && d.f60 > 0 ? { prevClose: money(d.f60) } : {}),
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

  /**
   * 大盘指数实时行情：顺序拉 MAJOR_INDICES 快照（复用 quote 接口）。
   * 容错对齐 batchQuote：单只失败（含 f43 缺失 / <=0）跳过，全部失败抛
   * EastmoneyAdapterError。不用并发：push2 对 5 只齐发会偶发整批拒绝
   * （2026-07 实测）；偶发瞬时拒绝按只原地重试一次。指数低频且调用方
   * 有缓存，顺序 + 重试的耗时可接受。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    const indices: IndexQuote[] = [];
    for (const { secid } of MAJOR_INDICES) {
      try {
        indices.push(await this.fetchIndexQuote(secid));
      } catch (error) {
        if (!(error instanceof EastmoneyAdapterError)) throw error;
        try {
          indices.push(await this.fetchIndexQuote(secid));
        } catch (retryError) {
          if (!(retryError instanceof EastmoneyAdapterError)) throw retryError;
        }
      }
    }
    if (indices.length === 0) {
      throw new EastmoneyAdapterError('Eastmoney 指数行情全部失败');
    }
    return indices;
  }

  /** 拉单只指数快照；f43 缺失或 <=0 视为该只失败。 */
  private async fetchIndexQuote(secid: string): Promise<IndexQuote> {
    const url = `${this.baseQuoteUrl}?secid=${secid}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`;
    const json = await this.getJson<EastmoneyQuoteResponse>(url);
    if (json.rc !== 0 || json.data === undefined) {
      throw new EastmoneyAdapterError(`Eastmoney 指数快照失败: rc=${json.rc} secid=${secid}`);
    }
    const d = json.data;
    if (d.f43 === undefined || d.f43 <= 0) {
      throw new EastmoneyAdapterError(`Eastmoney 指数快照缺价: secid=${secid} f43=${d.f43}`);
    }
    return {
      code: d.f57 ?? secid.split('.')[1] ?? secid,
      name: d.f58 ?? secid,
      close: money(d.f43),
      change: d.f169 ?? 0,
      changePct: d.f170 ?? 0,
      ts: this.clock(),
      source: 'eastmoney',
    };
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
        adjustment: 'qfq',
        source: 'eastmoney',
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

  /**
   * 全市场快照（沪深 A 股，分组刷新候选全集）：clist 分页拉取，一页 500 条，
   * 某页不足页大小或累计达到 total 时停止（全量约 11 页）。
   * 顺序翻页不并发：push2 并发齐发偶发整批拒绝（同 fetchIndexQuotes 实测）。
   * 任一页失败直接抛 EastmoneyAdapterError：返回半拉子全集会让分组刷新误算退出成员。
   */
  async fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    const items: MarketSnapshotItem[] = [];
    for (let page = 1; ; page++) {
      const url =
        `${this.baseClistUrl}?pn=${page}&pz=${CLIST_PAGE_SIZE}&po=1&np=1` +
        `&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(CLIST_FS)}&fields=${CLIST_FIELDS}`;
      const json = await this.getJson<EastmoneyClistResponse>(url);
      const pageItems = parseEastmoneyClist(json);
      items.push(...pageItems);
      const total = json.data?.total;
      if (pageItems.length < CLIST_PAGE_SIZE || (total !== undefined && items.length >= total)) {
        break;
      }
    }
    return items;
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
export type { DailyBar, DateRange, IndexQuote, Quote };
