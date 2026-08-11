import {
  quantity as brandQuantity,
  type DailyBar,
  type DateRange,
  type Exchange,
  type IntradayMinute,
  money,
  type Quote,
  type StockSearchCandidate,
} from '@luoome/core';

/**
 * Tencent 行情适配器（v0.2 起备用源，主要覆盖 A 股；港股支持有限）。
 *
 * 公开 API（无需鉴权）：
 * - 实时快照（A 股 + 港股）：
 *   `https://qt.gtimg.cn/q={prefixedCode}` 返回 GBK 文本
 *   或 `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={prefixedCode}` 返回 JSON
 *   为简单起见用 JSON 接口：`https://web.ifzq.gtimg.cn/appstock/app/stockDetail2/marketView?code={prefixedCode}`
 *   实际 JSON 行情接口：`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={prefixedCode},day,,,320,qfq`
 *   返回的 `qfqday` 或 `day` 字段是 K 线数据。
 *
 * 设计要点：
 * - 与 EastmoneyAdapter 抛 TencentAdapterError，Manager 路由 fallback。
 * - stockCode → prefixed code 转换：
 *   - SH → sh600519
 *   - SZ → sz002594
 *   - HK → hk00700
 *   - BJ → bj83xxxx（v0.2 不强求覆盖）
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export class TencentAdapterError extends Error {
  override readonly name = 'TencentAdapterError';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

interface TencentKlineNode {
  /** 元素为 [date, open, close, high, low, volume] 字符串数组（2026-07 实测真实形状）。 */
  readonly qfqday?: readonly (readonly string[])[];
  readonly day?: readonly (readonly string[])[];
}

interface TencentKlineResponse {
  readonly code: number;
  readonly msg?: string;
  /** 以 prefixed code 为 key 的 map（如 data.sh600519.qfqday）。 */
  readonly data?: Readonly<Record<string, TencentKlineNode | undefined>>;
}

const toPrefixedCode = (stockCode: string): string => {
  const normalized = stockCode.toUpperCase().trim();
  const dot = normalized.lastIndexOf('.');
  if (dot > 0) {
    const code = normalized.slice(0, dot);
    const exchange = normalized.slice(dot + 1);
    return `${exchange.toLowerCase()}${code}`;
  }
  if (/^\d{6}$/.test(normalized)) {
    const first = normalized[0];
    if (first === '6' || first === '9') return `sh${normalized}`;
    if (first === '0' || first === '3' || first === '5') return `sz${normalized}`;
    if (first === '4' || first === '8') return `bj${normalized}`;
  }
  if (/^\d{4,5}$/.test(normalized)) return `hk${normalized.padStart(5, '0')}`;
  throw new TencentAdapterError(`无法识别 stockCode: ${stockCode}`);
};

export interface TencentAdapterOptions {
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly baseQuoteUrl?: string;
  readonly baseKlineUrl?: string;
  readonly baseSearchUrl?: string;
  /** qt.gtimg.cn 快照（GBK 文本）：仅用于补昨收，分钟端点无此字段。 */
  readonly baseRtQuoteUrl?: string;
}

const TENCENT_MARKET_TO_EXCHANGE: Readonly<Record<string, Exchange>> = {
  sh: 'SH',
  sz: 'SZ',
  bj: 'BJ',
  hk: 'HK',
  us: 'US',
};

const parseTencentMinuteTime = (date: string, time: string): Date | undefined => {
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) return undefined;
  const iso =
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${time.slice(0, 2)}:${time.slice(2, 4)}:00+08:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * smartbox `v_hint` 文本 → 候选列表（纯函数，便于测试）。
 * 记录形如 `sh~601398~工商银行~gsyh~GP-A`，多条以 `^` 分隔；
 * 第 5 段是类型：GP* = 股票（保留），jj = 基金等（丢弃）；
 * 美股代码带市场后缀（aapl.oq → AAPL）；CJK 以 \uXXXX 转义出现。
 */
export const parseTencentSearchHint = (text: string): StockSearchCandidate[] => {
  const unescaped = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const match = unescaped.match(/v_hint="([^"]*)"/);
  const hint = match?.[1];
  if (hint === undefined || hint.length === 0) return [];
  const result: StockSearchCandidate[] = [];
  for (const record of hint.split('^')) {
    const parts = record.split('~');
    if (parts.length < 5) continue;
    const [marketRaw, codeRaw, name, , type] = parts;
    if (type === undefined || !type.startsWith('GP')) continue;
    const exchange = marketRaw !== undefined ? TENCENT_MARKET_TO_EXCHANGE[marketRaw] : undefined;
    if (exchange === undefined || codeRaw === undefined || name === undefined || name === '') {
      continue;
    }
    // 美股 'aapl.oq' → 'AAPL'；A 股 / 港股为纯数字代码
    const code = codeRaw.split('.')[0]?.toUpperCase() ?? '';
    if (code.length === 0) continue;
    result.push({ id: `${code}.${exchange}`, code, exchange, name });
  }
  return result;
};

export class TencentAdapter {
  readonly name = 'tencent';

  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseQuoteUrl: string;
  private readonly baseKlineUrl: string;
  private readonly baseSearchUrl: string;
  private readonly baseRtQuoteUrl: string;

  constructor(options: TencentAdapterOptions = {}) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseQuoteUrl =
      options.baseQuoteUrl ?? 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
    this.baseKlineUrl =
      options.baseKlineUrl ?? 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
    this.baseSearchUrl = options.baseSearchUrl ?? 'https://smartbox.gtimg.cn/s3/';
    this.baseRtQuoteUrl = options.baseRtQuoteUrl ?? 'https://qt.gtimg.cn/q';
  }

  /**
   * minute 端点原始行：data.<code>.data.data 是 "HHMM price cumVolume cumAmount"
   * 字符串数组（volume 手 / amount 元，均为当日累计口径），date 是交易日期。
   * fetchQuote 与 fetchIntradayMinutes 共用；空数组不抛错（盘前合法空态），由调用方决定。
   */
  private async fetchMinuteRows(
    code: string,
  ): Promise<{ readonly date?: string; readonly rows: readonly string[] }> {
    const url = `${this.baseQuoteUrl}?code=${code}`;
    const json = await this.getJson<{
      data?: { [code: string]: { data?: { date?: string; data?: string[] } } };
    }>(url);
    const minuteNode = json.data?.[code]?.data;
    return {
      ...(minuteNode?.date === undefined ? {} : { date: minuteNode.date }),
      rows: minuteNode?.data ?? [],
    };
  }

  /**
   * 拉快照。取末行价为最新价、首行价为 open、全程最大/最小为 high/low。
   */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const code = toPrefixedCode(stockCode);
    const { date, rows: minutes } = await this.fetchMinuteRows(code);
    if (minutes.length === 0) {
      throw new TencentAdapterError(`Tencent 快照缺价: code=${code}`);
    }
    const prices: number[] = [];
    for (const row of minutes) {
      const price = Number(row.split(' ')[1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      prices.push(price);
    }
    const open = prices[0];
    const close = prices.at(-1);
    // 分钟行第三列是当日累计量（手），取末行即可，求和会重复计数
    const lastVolume = Number(minutes.at(-1)?.split(' ')[2]);
    // 第四列是当日累计成交额（元，2026-08 实测与 qt 快照成交额口径一致）
    const lastAmount = Number(minutes.at(-1)?.split(' ')[3]);
    if (open === undefined || close === undefined) {
      throw new TencentAdapterError(`Tencent 快照缺价: code=${code}`);
    }
    const fetchedAt = this.clock();
    const lastTime = minutes.at(-1)?.split(' ')[0];
    const upstreamAt =
      date === undefined || lastTime === undefined
        ? undefined
        : parseTencentMinuteTime(date, lastTime);
    const observedAt =
      upstreamAt !== undefined && upstreamAt.getTime() <= fetchedAt.getTime()
        ? upstreamAt
        : fetchedAt;
    const rtSnapshot = await this.fetchRtSnapshot(code);
    return {
      stockId: stockCode.toUpperCase(),
      observedAt,
      fetchedAt,
      timestampSource: observedAt === fetchedAt ? 'retrieval' : 'upstream',
      ts: observedAt,
      open: money(open),
      high: money(Math.max(...prices)),
      low: money(Math.min(...prices)),
      close: money(close),
      volume: Number.isFinite(lastVolume) && lastVolume > 0 ? lastVolume * 100 : 0, // 手 → 股
      ...(Number.isFinite(lastAmount) && lastAmount > 0 ? { amount: lastAmount } : {}),
      ...(rtSnapshot.prevClose !== undefined ? { prevClose: money(rtSnapshot.prevClose) } : {}),
      ...(rtSnapshot.turnoverRatePct !== undefined
        ? { turnoverRatePct: rtSnapshot.turnoverRatePct }
        : {}),
      source: 'tencent',
    };
  }

  /**
   * 当日分时分钟序列：与 fetchQuote 同 minute 端点，整行保留累计口径；
   * 时间 / 价格非法的行丢弃。盘前 / 非交易日端点返回空数组（合法空态，不抛错）。
   */
  async fetchIntradayMinutes(stockCode: string): Promise<readonly IntradayMinute[]> {
    const code = toPrefixedCode(stockCode);
    const { date, rows } = await this.fetchMinuteRows(code);
    const points: IntradayMinute[] = [];
    for (const row of rows) {
      const [hhmm, priceRaw, volumeRaw, amountRaw] = row.split(' ');
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price <= 0) continue;
      const time =
        date === undefined || hhmm === undefined ? undefined : parseTencentMinuteTime(date, hhmm);
      if (time === undefined) continue;
      const cumVolume = Number(volumeRaw);
      const cumAmount = Number(amountRaw);
      points.push({
        stockId: stockCode.toUpperCase(),
        time,
        price: money(price),
        cumVolume: Number.isFinite(cumVolume) && cumVolume >= 0 ? cumVolume * 100 : 0, // 手 → 股
        ...(Number.isFinite(cumAmount) && cumAmount >= 0 ? { cumAmount } : {}),
        source: 'tencent',
      });
    }
    return points;
  }

  /**
   * qt.gtimg.cn 快照（best-effort，GBK 文本，~ 分隔）：第 4 段为昨收、第 38 段为
   * 换手率%（2026-08 实测）。分钟端点无这两个字段；失败返回空对象，不拖垮主快照流程。
   */
  private async fetchRtSnapshot(
    code: string,
  ): Promise<{ prevClose?: number; turnoverRatePct?: number }> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseRtQuoteUrl}=${code}`, {
        signal: controller.signal,
      });
      if (!res.ok) return {};
      const buf = await res.arrayBuffer();
      // TS 的 Encoding 联合不含 'gbk'，Bun 运行时支持；qt.gtimg.cn 是 GBK 文本
      const text = new TextDecoder('gbk' as never).decode(buf);
      const parts = text.match(/="([^"]*)"/)?.[1]?.split('~');
      const prev = Number(parts?.[4]);
      const turnover = Number(parts?.[38]);
      return {
        ...(Number.isFinite(prev) && prev > 0 ? { prevClose: prev } : {}),
        ...(Number.isFinite(turnover) && turnover >= 0 ? { turnoverRatePct: turnover } : {}),
      };
    } catch {
      return {};
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    await Promise.all(
      stockCodes.map(async (code) => {
        try {
          result.set(code, await this.fetchQuote(code));
        } catch (error) {
          if (!(error instanceof TencentAdapterError)) throw error;
        }
      }),
    );
    return result;
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const code = toPrefixedCode(stockCode);
    const url = `${this.baseKlineUrl}?param=${code},day,,,320,qfq`;
    const json = await this.getJson<TencentKlineResponse>(url);
    if (json.code !== 0 || json.data === undefined) {
      throw new TencentAdapterError(`Tencent 日线失败: code=${json.code}`);
    }
    const node = json.data[code];
    const rawList = node?.qfqday;
    if (rawList === undefined) {
      throw new TencentAdapterError(`unsupported_adjustment: Tencent qfq 日线不可用 code=${code}`);
    }
    const stockId = stockCode.includes('.') ? stockCode.toUpperCase() : stockCode.toUpperCase();
    const fromMs = range.start.getTime();
    const toMs = range.end.getTime();
    const bars: DailyBar[] = [];
    for (const line of rawList) {
      if (line.length < 6) continue;
      const [dateStr, openStr, closeStr, highStr, lowStr, volumeStr] = line;
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
      const dateMs = Date.parse(`${dateStr} 00:00:00 UTC`);
      if (Number.isNaN(dateMs) || dateMs < fromMs || dateMs > toMs) continue;
      bars.push({
        stockId,
        date: new Date(dateMs),
        open: money(open),
        high: money(high),
        low: money(low),
        close: money(close),
        volume,
        adjustment: 'qfq',
        source: 'tencent',
      });
    }
    return bars;
  }

  /**
   * 外部股票搜索（v0.8 起）：smartbox 接口，GBK 文本 + \uXXXX 转义。
   * 空结果返回 []；HTTP 错误抛 TencentAdapterError。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const url = `${this.baseSearchUrl}?v=2&q=${encodeURIComponent(query)}&t=all`;
    const text = await this.getText(url);
    return parseTencentSearchHint(text);
  }

  private async getText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        throw new TencentAdapterError(`HTTP ${res.status} ${res.statusText} url=${url}`);
      }
      const buf = await res.arrayBuffer();
      // smartbox 标称 GBK，但 CJK 实际以 \uXXXX 转义出现（ASCII 安全），
      // utf-8 解码无损，反转义由 parseTencentSearchHint 负责。
      return new TextDecoder('utf-8').decode(buf);
    } catch (error) {
      if (error instanceof TencentAdapterError) throw error;
      throw new TencentAdapterError(
        `fetch 失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        throw new TencentAdapterError(`HTTP ${res.status} ${res.statusText} url=${url}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof TencentAdapterError) throw error;
      throw new TencentAdapterError(
        `fetch 失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
