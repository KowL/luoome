import { quantity as brandQuantity, type DailyBar, type DateRange, money } from '@luoome/core';

import { httpStatusErrorKind, SourceExecutionError } from '../source-error.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_KLINE_URL =
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const DEFAULT_FACTOR_URL = 'https://finance.sina.com.cn/realstock/company';
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

  constructor(options: SinaAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.klineUrl = options.klineUrl ?? DEFAULT_KLINE_URL;
    this.factorUrl = options.factorUrl ?? DEFAULT_FACTOR_URL;
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

export const sinaQfqFactorForDate = factorForDate;
