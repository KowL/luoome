import {
  quantity as brandQuantity,
  type DailyBar,
  type DateRange,
  money,
  type Quote,
} from '@luoome/core';

import { httpStatusErrorKind, SourceExecutionError } from '../source-error.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_KLINE_URL =
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const DEFAULT_FACTOR_URL = 'https://finance.sina.com.cn/realstock/company';
/**
 * 实时快照端点：无 Referer 返回 403（2026-10-05 实测），必须带 finance.sina.com.cn 引用头。
 * 快照只用 ASCII 数值列（名称列 GBK 会乱码，但不读）。
 */
const DEFAULT_HQ_URL = 'https://hq.sinajs.cn/list=';
const SINA_HQ_REFERER = 'https://finance.sina.com.cn';
const MAX_DATALEN = 1023;

export class SinaAdapterError extends SourceExecutionError {
  override readonly name = 'SinaAdapterError';
}

interface SinaRawBar {
  readonly day?: unknown;
  readonly open?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly close?: unknown;
  readonly volume?: unknown;
}

interface SinaFactorItem {
  readonly d?: unknown;
  readonly f?: unknown;
}

interface SinaFactorPayload {
  readonly total?: unknown;
  readonly data?: readonly SinaFactorItem[];
}

export interface SinaAdapterOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly klineUrl?: string;
  readonly factorUrl?: string;
  readonly hqUrl?: string;
  readonly clock?: () => Date;
}

interface FactorPoint {
  readonly date: number;
  readonly factor: number;
}

/**
 * 新浪历史日线适配器。
 *
 * 新浪 K 线接口返回 raw OHLC；qfq.js 提供除权日的前复权因子。两者在
 * adapter 内合成为 qfq DailyBar，raw 数据不会以 qfq 名义进入领域层。
 */
export class SinaAdapter {
  readonly name = 'sina';

  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly klineUrl: string;
  private readonly factorUrl: string;
  private readonly hqUrl: string;
  private readonly clock: () => Date;

  constructor(options: SinaAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.klineUrl = options.klineUrl ?? DEFAULT_KLINE_URL;
    this.factorUrl = options.factorUrl ?? DEFAULT_FACTOR_URL;
    this.hqUrl = options.hqUrl ?? DEFAULT_HQ_URL;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  /**
   * 单股实时快照（quote 第三兜底）：hq.sinajs.cn 文本行
   * `[1]今开 [2]昨收 [3]最新价 [4]最高 [5]最低 [8]成交量(股) [9]成交额(元)
   * [30]日期 [31]时间`（2026-10-05 实盘验证）。停牌 / 缺价抛 no_data 走降级。
   */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const code = toPrefixedCode(stockCode);
    const rows = await this.fetchHqRows([code]);
    const fields = rows.get(code);
    if (fields === undefined) {
      throw new SinaAdapterError('no_data', `no_data: Sina 快照缺行 code=${code}`);
    }
    const quote = buildSinaQuote(stockCode.toUpperCase(), fields, this.clock);
    if (quote === undefined) {
      throw new SinaAdapterError('no_data', `no_data: Sina 快照缺价 code=${code}`);
    }
    return quote;
  }

  /**
   * 原生批量快照（batch-quote capability）：hq.sinajs.cn 逗号拼接多代码一次请求。
   * 无法识别 / 上游未返回 / 缺价的标的只丢弃该只，不伪造占位项。
   */
  async fetchBatchQuotes(stockIds: readonly string[]): Promise<Quote[]> {
    const pairs: Array<{ readonly stockId: string; readonly prefixed: string }> = [];
    for (const code of stockIds) {
      const stockId = code.toUpperCase().trim();
      try {
        pairs.push({ stockId, prefixed: toPrefixedCode(stockId) });
      } catch (error) {
        if (!(error instanceof SinaAdapterError)) throw error;
      }
    }
    if (pairs.length === 0) return [];
    const rows = await this.fetchHqRows(pairs.map((pair) => pair.prefixed));
    const quotes: Quote[] = [];
    for (const { stockId, prefixed } of pairs) {
      const fields = rows.get(prefixed);
      if (fields === undefined) continue;
      const quote = buildSinaQuote(stockId, fields, this.clock);
      if (quote !== undefined) quotes.push(quote);
    }
    return quotes;
  }

  /** hq.sinajs.cn 批量请求 → prefixed code → 逗号分隔字段数组；空行 / 未知代码不进 map。 */
  private async fetchHqRows(codes: readonly string[]): Promise<Map<string, readonly string[]>> {
    const url = `${this.hqUrl}${codes.join(',')}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Referer: SINA_HQ_REFERER },
      });
      if (!response.ok) {
        throw new SinaAdapterError(
          httpStatusErrorKind(response.status),
          `HTTP ${response.status} url=${url}`,
        );
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof SinaAdapterError) throw error;
      const kind =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
          ? 'timeout'
          : 'network';
      throw new SinaAdapterError(kind, `${kind}: Sina hq request failed url=${url}`, error);
    } finally {
      clearTimeout(timeout);
    }
    const rows = new Map<string, readonly string[]>();
    for (const match of text.matchAll(/hq_str_((?:sh|sz)\d{6})="([^"]*)";?/g)) {
      const prefixed = match[1];
      const raw = match[2];
      if (prefixed === undefined || raw === undefined || raw === '') continue;
      rows.set(prefixed, raw.split(','));
    }
    return rows;
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const code = toPrefixedCode(stockCode);
    const rawBars = await this.fetchRawBars(code, range);
    if (rawBars.length === 0) {
      throw new SinaAdapterError('no_data', `no_data: Sina 日线为空 code=${code}`);
    }
    const factors = isIndexCode(stockCode) ? [] : await this.fetchFactors(code);
    const fromMs = range.start.getTime();
    const toMs = range.end.getTime();
    const bars: DailyBar[] = [];
    for (const raw of rawBars) {
      const date = parseDate(raw.day);
      const open = positiveNumber(raw.open);
      const high = positiveNumber(raw.high);
      const low = positiveNumber(raw.low);
      const close = positiveNumber(raw.close);
      const volume = nonnegativeNumber(raw.volume);
      if (
        date === undefined ||
        open === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined ||
        volume === undefined
      ) {
        continue;
      }
      if (date.getTime() < fromMs || date.getTime() > toMs) continue;
      const factor = factors.length === 0 ? 1 : factorForDate(factors, date.getTime());
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new SinaAdapterError(
          'invalid_payload',
          `invalid_adjustment: Sina qfq factor invalid code=${code}`,
        );
      }
      bars.push({
        stockId: stockCode.toUpperCase(),
        date,
        open: money(open / factor),
        high: money(high / factor),
        low: money(low / factor),
        close: money(close / factor),
        // 新浪 volume 已经是股，不再按手转换。
        volume: brandQuantity(Math.round(volume)),
        adjustment: 'qfq',
        source: 'sina',
      });
    }
    if (bars.length === 0) {
      throw new SinaAdapterError('no_data', `no_data: Sina 日线在请求区间内为空 code=${code}`);
    }
    return bars;
  }

  private async fetchRawBars(code: string, range: DateRange): Promise<readonly SinaRawBar[]> {
    const url = new URL(this.klineUrl);
    url.searchParams.set('symbol', code);
    url.searchParams.set('scale', '240');
    url.searchParams.set('ma', 'no');
    url.searchParams.set('datalen', String(dataLength(range)));
    const response = await this.request(url);
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new SinaAdapterError(
        'invalid_payload',
        `invalid_payload: Sina 日线响应不是数组 code=${code}`,
      );
    }
    return payload as SinaRawBar[];
  }

  private async fetchFactors(code: string): Promise<readonly FactorPoint[]> {
    const url = `${this.factorUrl}/${code}/qfq.js`;
    const response = await this.request(url);
    const text = await response.text();
    const match = text.match(/=\s*(\{[\s\S]*?\})\s*(?:;|\/\*)/);
    if (match?.[1] === undefined) {
      throw new SinaAdapterError(
        'invalid_payload',
        `invalid_payload: Sina qfq factor response code=${code}`,
      );
    }
    let payload: SinaFactorPayload;
    try {
      payload = JSON.parse(match[1]) as SinaFactorPayload;
    } catch (error) {
      throw new SinaAdapterError(
        'invalid_payload',
        `invalid_payload: Sina qfq factor JSON code=${code}`,
        error,
      );
    }
    if (!Array.isArray(payload.data) || payload.data.length === 0) {
      throw new SinaAdapterError(
        'unsupported_adjustment',
        `unsupported_adjustment: Sina qfq factor unavailable code=${code}`,
      );
    }
    const points = payload.data.map((item) => {
      const date = parseDate(item.d);
      const factor = positiveNumber(item.f);
      if (date === undefined || factor === undefined) {
        throw new SinaAdapterError(
          'invalid_payload',
          `invalid_payload: Sina qfq factor row code=${code}`,
        );
      }
      return { date: date.getTime(), factor };
    });
    points.sort((a, b) => a.date - b.date);
    return points;
  }

  private async request(url: URL | string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new SinaAdapterError(
          httpStatusErrorKind(response.status),
          `HTTP ${response.status} url=${url}`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof SinaAdapterError) throw error;
      const kind =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
          ? 'timeout'
          : 'network';
      throw new SinaAdapterError(kind, `${kind}: Sina request failed url=${url}`, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

const toPrefixedCode = (stockCode: string): string => {
  const normalized = stockCode.toUpperCase().trim();
  const dot = normalized.lastIndexOf('.');
  if (dot > 0) {
    const code = normalized.slice(0, dot);
    const exchange = normalized.slice(dot + 1).toLowerCase();
    if ((exchange === 'sh' || exchange === 'sz') && /^\d{6}$/.test(code)) {
      return `${exchange}${code}`;
    }
  }
  if (/^\d{6}$/.test(normalized)) {
    return `${normalized[0] === '6' ? 'sh' : 'sz'}${normalized}`;
  }
  throw new SinaAdapterError('unsupported_market', `无法识别 stockCode: ${stockCode}`);
};

const isIndexCode = (stockCode: string): boolean =>
  /^(000001|000300|000688)\.SH$|^(399001|399006)\.SZ$/i.test(stockCode.trim());

const positiveNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const nonnegativeNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(value)) return undefined;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const factorForDate = (points: readonly FactorPoint[], dateMs: number): number => {
  let factor = points[0]?.factor ?? 1;
  for (const point of points) {
    if (point.date > dateMs) break;
    factor = point.factor;
  }
  return factor;
};

const dataLength = (range: DateRange): number => {
  const days = Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / 86_400_000));
  return Math.min(MAX_DATALEN, Math.max(320, Math.ceil(days * 0.75) + 30));
};

/**
 * hq 字段行 → Quote；最新价缺失 / 非正（停牌、盘前无数据）返回 undefined 由调用方降级。
 * volume / amount 新浪已是股 / 元，不做量纲转换。
 */
const buildSinaQuote = (
  stockId: string,
  fields: readonly string[],
  clock: () => Date,
): Quote | undefined => {
  const close = positiveNumber(fields[3]);
  if (close === undefined) return undefined;
  const fetchedAt = clock();
  const upstreamAt = parseSinaHqTime(fields[30], fields[31]);
  const observedAt =
    upstreamAt !== undefined && upstreamAt.getTime() <= fetchedAt.getTime()
      ? upstreamAt
      : fetchedAt;
  const open = positiveNumber(fields[1]);
  const high = positiveNumber(fields[4]);
  const low = positiveNumber(fields[5]);
  const prevClose = positiveNumber(fields[2]);
  const volume = nonnegativeNumber(fields[8]);
  const amount = nonnegativeNumber(fields[9]);
  return {
    stockId,
    observedAt,
    fetchedAt,
    timestampSource: observedAt === fetchedAt ? 'retrieval' : 'upstream',
    ts: observedAt,
    open: money(open ?? close),
    high: money(high ?? close),
    low: money(low ?? close),
    close: money(close),
    volume: volume !== undefined ? brandQuantity(Math.round(volume)) : brandQuantity(0),
    ...(amount !== undefined && amount > 0 ? { amount } : {}),
    ...(prevClose !== undefined ? { prevClose: money(prevClose) } : {}),
    source: 'sina',
  };
};

/** hq 快照日期 + 时间（'YYYY-MM-DD' + 'HH:MM:SS'，上海时区）→ 绝对时间。 */
const parseSinaHqTime = (date: string | undefined, time: string | undefined): Date | undefined => {
  if (
    date === undefined ||
    time === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}:\d{2}$/.test(time)
  ) {
    return undefined;
  }
  const parsed = new Date(`${date}T${time}+08:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const sinaQfqFactorForDate = factorForDate;
