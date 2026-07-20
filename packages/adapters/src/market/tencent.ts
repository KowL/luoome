import {
  quantity as brandQuantity,
  type DailyBar,
  type DateRange,
  money,
  type Quote,
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
}

export class TencentAdapter {
  readonly name = 'tencent';

  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseQuoteUrl: string;
  private readonly baseKlineUrl: string;

  constructor(options: TencentAdapterOptions = {}) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseQuoteUrl =
      options.baseQuoteUrl ?? 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
    this.baseKlineUrl =
      options.baseKlineUrl ?? 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
  }

  /**
   * 拉快照。Tencent 公开接口的实时行情主要在 minute 端点；
   * 真正可用的快照接口走 qt.gtimg.cn 文本（GBK），解析复杂，v0.2 直接抛错降级。
   * 实战由 Eastmoney 主源负责；Tencent 仅作日线 fallback。
   */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const code = toPrefixedCode(stockCode);
    const url = `${this.baseQuoteUrl}?code=${code}`;
    const json = await this.getJson<{ data?: { data?: { now?: number; open?: number } } }>(url);
    const now = json.data?.data?.now;
    if (now === undefined || now <= 0) {
      throw new TencentAdapterError(`Tencent 快照缺价: code=${code}`);
    }
    const open = json.data?.data?.open ?? now;
    if (open <= 0) {
      throw new TencentAdapterError(`Tencent 快照 open 异常: code=${code} open=${open}`);
    }
    const stockId = stockCode.includes('.') ? stockCode.toUpperCase() : stockCode.toUpperCase();
    return {
      stockId,
      ts: this.clock(),
      open: money(open),
      high: money(now),
      low: money(now),
      close: money(now),
      volume: 0, // minute 接口不直接给量；调用方应优先走 Eastmoney
      source: 'tencent',
    };
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
    const rawList = node?.qfqday ?? node?.day;
    if (rawList === undefined) {
      throw new TencentAdapterError(`Tencent 日线空数据: code=${code}`);
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
        adjFactor: 1.0,
      });
    }
    return bars;
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
