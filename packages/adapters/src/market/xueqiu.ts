import {
  type DailyBar,
  type DateRange,
  dateInShanghai,
  money,
  type Quote,
  QuoteSchema,
} from '@luoome/core';

import {
  httpStatusErrorKind,
  invalidPayloadError,
  isAbortError,
  noDataError,
  permissionError,
  SourceExecutionError,
  sourceErrorKindOf,
  unsupportedMarketError,
  upstreamError,
} from '../source-error.js';

const HOME_URL = 'https://www.xueqiu.com/';
const API_BASE = 'https://stock.xueqiu.com/v5/stock/';
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const SESSION_TTL_MS = 30 * 60_000;
const USER_AGENT = 'Mozilla/5.0';

export interface XueqiuAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface VisitorSession {
  readonly cookie: string;
  readonly expiresAt: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const symbolFor = (stockId: string): string => {
  const match = /^(\d{6})\.(SH|SZ)$/.exec(stockId);
  if (!match) throw unsupportedMarketError('雪球行情目前仅支持带 SH/SZ 后缀的沪深股票');
  return `${match[2]}${match[1]}`;
};

const numeric = (value: unknown, label: string, minimum = Number.NEGATIVE_INFINITY): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw invalidPayloadError(`雪球 ${label} 不是有效数值`);
  }
  return value;
};

const price = (value: unknown, label: string): ReturnType<typeof money> => {
  const result = numeric(value, label);
  if (result <= 0) throw noDataError(`雪球 ${label} 尚无有效价格`);
  return money(result);
};

/** 雪球 volume 已以股计量；不沿用腾讯/东财的手转股乘数。 */
export const parseXueqiuQuote = (raw: unknown, stockId: string, fetchedAt: Date): Quote => {
  const row = record(raw);
  if (!row || row.symbol !== symbolFor(stockId)) {
    throw invalidPayloadError('雪球报价股票代码与请求不符');
  }
  const hasTimestamp = row.timestamp !== undefined && row.timestamp !== null;
  const observedAt = hasTimestamp ? new Date(numeric(row.timestamp, 'timestamp', 1)) : fetchedAt;
  if (!Number.isFinite(observedAt.getTime())) throw invalidPayloadError('雪球行情时间无效');
  const optional: Record<string, number> = {};
  for (const [from, to, nonnegative] of [
    ['amount', 'amount', true],
    ['turnover_rate', 'turnoverRatePct', true],
    ['last_close', 'prevClose', true],
    ['total_shares', 'totalShares', true],
    ['float_shares', 'floatShares', true],
    ['market_capital', 'totalMarketCap', true],
    ['float_market_capital', 'floatMarketCap', true],
    ['pe_forecast', 'peDynamic', false],
    ['pe_ttm', 'peTtm', false],
    ['pe_lyr', 'peStatic', false],
    ['ps_ttm', 'psTtm', false],
    ['pb', 'pb', false],
  ] as const) {
    if (row[from] !== undefined && row[from] !== null) {
      optional[to] = numeric(row[from], from, nonnegative ? 0 : Number.NEGATIVE_INFINITY);
    }
  }
  const parsed = QuoteSchema.safeParse({
    stockId,
    observedAt,
    fetchedAt,
    timestampSource: hasTimestamp ? 'upstream' : 'retrieval',
    ts: observedAt,
    open: price(row.open, 'open'),
    high: price(row.high, 'high'),
    low: price(row.low, 'low'),
    close: price(row.current, 'current'),
    volume: numeric(row.volume, 'volume', 0),
    ...optional,
    source: 'xueqiu',
  });
  if (!parsed.success) throw invalidPayloadError('雪球报价不满足行情契约');
  return parsed.data;
};

/** column/item 按列名解码，交易所日期统一投影为 UTC 日期标签。 */
export const parseXueqiuDailyBars = (raw: unknown, stockId: string): DailyBar[] => {
  const data = record(raw);
  if (!data || data.symbol !== symbolFor(stockId)) {
    throw invalidPayloadError('雪球日 K 股票代码与请求不符');
  }
  const columns = data.column;
  const items = data.item;
  if (
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === 'string') ||
    new Set(columns).size !== columns.length ||
    !Array.isArray(items)
  ) {
    throw invalidPayloadError('雪球日 K 列定义或数据行无效');
  }
  const indices = new Map(columns.map((column, index) => [column as string, index]));
  for (const field of ['timestamp', 'volume', 'open', 'high', 'low', 'close']) {
    if (!indices.has(field)) throw invalidPayloadError(`雪球日 K 缺少 ${field} 列`);
  }
  const bars = new Map<string, DailyBar>();
  for (const item of items) {
    if (!Array.isArray(item) || item.length !== columns.length) {
      throw invalidPayloadError('雪球日 K 数据行与列定义不匹配');
    }
    const get = (field: string): unknown => item[indices.get(field) as number];
    const timestamp = new Date(numeric(get('timestamp'), '日 K timestamp', 1));
    if (!Number.isFinite(timestamp.getTime())) throw invalidPayloadError('雪球日 K 日期无效');
    const day = dateInShanghai(timestamp);
    if (bars.has(day)) throw invalidPayloadError('雪球日 K 同一交易日重复');
    const bar: DailyBar = {
      stockId,
      date: new Date(`${day}T00:00:00Z`),
      open: price(get('open'), '日 K open'),
      high: price(get('high'), '日 K high'),
      low: price(get('low'), '日 K low'),
      close: price(get('close'), '日 K close'),
      volume: numeric(get('volume'), '日 K volume', 0),
      adjustment: 'qfq',
      source: 'xueqiu',
    };
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw invalidPayloadError('雪球日 K 高低价关系无效');
    }
    bars.set(day, bar);
  }
  return [...bars.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
};

export class XueqiuAdapter {
  readonly name = 'xueqiu';
  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private session: VisitorSession | undefined;
  private sessionLoading: Promise<VisitorSession> | undefined;

  constructor(options: XueqiuAdapterOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async fetchQuote(stockId: string): Promise<Quote> {
    const query = new URLSearchParams({ symbol: symbolFor(stockId), extend: 'detail' });
    const data = record(await this.getJson(`${API_BASE}quote.json?${query}`));
    return parseXueqiuQuote(data?.quote, stockId, this.clock());
  }

  async fetchDailyBars(stockId: string, range: DateRange): Promise<DailyBar[]> {
    const symbol = symbolFor(stockId);
    if (
      !Number.isFinite(range.start.getTime()) ||
      !Number.isFinite(range.end.getTime()) ||
      range.start.getTime() > range.end.getTime()
    ) {
      throw invalidPayloadError('雪球日 K 请求日期范围无效');
    }
    const startDay = dateInShanghai(range.start);
    const endDay = dateInShanghai(range.end);
    let cursor = Date.parse(`${endDay}T00:00:00+08:00`) + 86_400_000 - 1;
    const collected = new Map<string, DailyBar>();
    for (let page = 0; page < MAX_PAGES; page++) {
      // before 是雪球前复权口径；缺数据时不以 normal/after 冒充 qfq。
      const query = new URLSearchParams({
        symbol,
        begin: String(cursor),
        period: 'day',
        type: 'before',
        count: String(-PAGE_SIZE),
        indicator: 'kline',
      });
      const bars = parseXueqiuDailyBars(
        await this.getJson(`${API_BASE}chart/kline.json?${query}`),
        stockId,
      );
      if (bars.length === 0) return [...collected.values()].sort(byDate);
      const cursorDay = dateInShanghai(new Date(cursor));
      for (const bar of bars) {
        const day = bar.date.toISOString().slice(0, 10);
        if (day > cursorDay) throw invalidPayloadError('雪球日 K 返回了游标之后的数据');
        if (day >= startDay && day <= endDay) collected.set(day, bar);
      }
      const oldestDay = (bars[0] as DailyBar).date.toISOString().slice(0, 10);
      if (oldestDay <= startDay) return [...collected.values()].sort(byDate);
      const next = Date.parse(`${oldestDay}T00:00:00+08:00`) - 1;
      if (next >= cursor) throw invalidPayloadError('雪球日 K 分页游标未前进');
      cursor = next;
    }
    throw new SourceExecutionError('partial_data', '雪球日 K 达到分页上限，未返回截断历史');
  }

  private async request(
    url: string,
    cookie?: string,
    json = true,
  ): Promise<{ readonly headers: Headers; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'user-agent': USER_AGENT,
          referer: HOME_URL,
          accept: json ? 'application/json' : 'text/html',
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
      if (!response.ok) {
        throw new SourceExecutionError(
          httpStatusErrorKind(response.status),
          `雪球 HTTP ${response.status}`,
        );
      }
      if (!json) {
        await response.arrayBuffer();
        return { headers: response.headers, body: undefined };
      }
      try {
        return { headers: response.headers, body: await response.json() };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw invalidPayloadError('雪球响应不是有效 JSON');
      }
    } catch (error) {
      if (error instanceof SourceExecutionError) throw error;
      throw new SourceExecutionError(
        controller.signal.aborted || isAbortError(error) ? 'timeout' : 'network',
        '雪球行情请求未完成',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async visitorSession(): Promise<VisitorSession> {
    if (this.session && this.session.expiresAt > this.clock().getTime()) return this.session;
    if (this.sessionLoading) return this.sessionLoading;
    this.sessionLoading = this.bootstrap().finally(() => {
      this.sessionLoading = undefined;
    });
    return this.sessionLoading;
  }

  private async bootstrap(): Promise<VisitorSession> {
    const { headers } = await this.request(HOME_URL, undefined, false);
    const now = this.clock().getTime();
    const cookies = new Map<string, { value: string; expiresAt: number }>();
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      if (!pair) continue;
      const equal = pair.indexOf('=');
      const name = pair.slice(0, equal).trim();
      const value = pair.slice(equal + 1).trim();
      if (equal < 1 || !/^[a-zA-Z0-9_-]+$/.test(name) || /[\s;\r\n]/.test(value)) continue;
      const attrs = new Map(
        attributes.map((attribute) => {
          const index = attribute.indexOf('=');
          return index < 0
            ? [attribute.trim().toLowerCase(), '']
            : [attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()];
        }),
      );
      // 只把合法父域 cookie 发送到 stock.xueqiu.com；不传播 www 的 host-only cookie。
      if (attrs.get('domain')?.toLowerCase().replace(/^\./, '') !== 'xueqiu.com') continue;
      if (attrs.has('path') && !'/v5/stock/'.startsWith(attrs.get('path') as string)) continue;
      let expiresAt = now + SESSION_TTL_MS;
      if (attrs.has('max-age')) {
        const seconds = Number(attrs.get('max-age'));
        if (!Number.isFinite(seconds)) continue;
        expiresAt = Math.min(expiresAt, now + seconds * 1000);
      } else if (attrs.has('expires')) {
        const expires = Date.parse(attrs.get('expires') as string);
        if (Number.isFinite(expires)) expiresAt = Math.min(expiresAt, expires);
      }
      if (expiresAt <= now) cookies.delete(name);
      else cookies.set(name, { value, expiresAt });
    }
    if (cookies.size === 0) throw permissionError('雪球未提供可用的访客会话');
    const session: VisitorSession = {
      cookie: [...cookies].map(([name, { value }]) => `${name}=${value}`).join('; '),
      expiresAt: Math.min(...[...cookies.values()].map((cookie) => cookie.expiresAt)),
    };
    this.session = session;
    return session;
  }

  private async getJson(url: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.visitorSession();
      try {
        const { body } = await this.request(url, session.cookie);
        const envelope = record(body);
        if (!envelope || !('error_code' in envelope)) throw invalidPayloadError('雪球响应信封无效');
        if (String(envelope.error_code) === '400016') throw permissionError('雪球访客会话已失效');
        if (String(envelope.error_code) !== '0') throw upstreamError('雪球接口返回业务错误');
        if (!record(envelope.data)) throw invalidPayloadError('雪球响应缺少 data 对象');
        return envelope.data;
      } catch (error) {
        if (attempt === 0 && sourceErrorKindOf(error) === 'permission') {
          if (this.session === session) this.session = undefined;
          continue;
        }
        throw error;
      }
    }
    throw permissionError('雪球访客会话重建后仍不可用');
  }
}

const byDate = (left: DailyBar, right: DailyBar): number =>
  left.date.getTime() - right.date.getTime();
