import { fromEnv } from './config.js';
import { fetchKLine } from './endpoints/kline.js';
import { fetchQuote } from './endpoints/quote.js';
import { fetchStockBasic } from './endpoints/stock-basic.js';
import { AdshareError } from './errors.js';
import type { KLineBar, Quote, StockBasic } from './schemas.js';

export interface AdshareClientOptions {
  readonly url: string;
  readonly apiKey: string;
  /** 测试注入：替换 fetch 实现。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 网络错误 / 5xx 时最大重试次数。 */
  readonly retries?: number;
}

/**
 * Adshare 数据服务 SDK v0.1。
 *
 * 用法：
 *   const client = AdshareClient.fromEnv();
 *   const stocks = await client.searchStocks({ name: '贵州茅台', fields: ['ts_code', 'name', 'industry'] });
 */
export class AdshareClient {
  readonly url: string;
  readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: AdshareClientOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    if (this.url.length === 0) {
      throw new AdshareError('INVALID_INPUT', 'adshare URL 不能为空');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AdshareError('INVALID_INPUT', 'timeoutMs 必须是正数');
    }
    if (!Number.isInteger(this.retries) || this.retries < 0) {
      throw new AdshareError('INVALID_INPUT', 'retries 必须是非负整数');
    }
  }

  static fromEnv(env?: Record<string, string | undefined>): AdshareClient {
    const config = fromEnv(env ?? globalThis.process.env);
    return new AdshareClient(config);
  }

  /**
   * 搜索股票基本信息。
   * 优先使用 name 或 ts_code 查询；两者可单独或同时传入。
   */
  async searchStocks(query: {
    name?: string;
    ts_code?: string;
    fields?: string[];
    limit?: number;
  }): Promise<StockBasic[]> {
    return fetchStockBasic(this.url, this.apiKey, this.fetchImpl, query, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
  }

  /**
   * 拉取 K 线数据。
   */
  async getKLine(query: {
    ts_code: string;
    period: 'D' | 'W';
    start_date?: string;
    end_date?: string;
  }): Promise<KLineBar[]> {
    return fetchKLine(this.url, this.apiKey, this.fetchImpl, query, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
  }

  /**
   * 拉取单只股票实时行情快照。
   */
  async getQuote(ts_code: string): Promise<Quote> {
    return fetchQuote(this.url, this.apiKey, this.fetchImpl, ts_code, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
  }

  /** 健康检查：任意非 5xx 响应视为可达。 */
  async ping(): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await fetchWithRetry(
        this.fetchImpl,
        `${this.url}/health`,
        { method: 'GET', headers: this.headers() },
        this.timeoutMs,
        this.retries,
      );
      return { ok: res.ok, status: res.status };
    } catch (error) {
      throw new AdshareError('NETWORK_ERROR', 'adshare 服务不可达', { cause: error });
    }
  }

  headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

/** 带超时与重试的 fetch。 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  const lastAttempt = retries;
  for (let attempt = 0; attempt <= lastAttempt; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.ok && res.status >= 500 && attempt < lastAttempt) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (error) {
      if (attempt < lastAttempt) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AdshareError('NETWORK_ERROR', 'fetchWithRetry 未返回响应');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
