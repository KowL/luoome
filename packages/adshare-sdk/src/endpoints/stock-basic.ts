import { AdshareError } from '../errors.js';
import { type StockBasic, StockBasicSchema } from '../schemas.js';

export interface StockBasicOptions {
  readonly timeoutMs: number;
  readonly retries: number;
}

/**
 * 远端 GET 请求（带双认证头、超时、重试）。kline / quote 共用。
 * 任何非 2xx 抛 AdshareError('HTTP_ERROR')，网络错误抛 AdshareError('NETWORK_ERROR')。
 * 仅网络错误与 5xx 会重试；4xx 直接返回给调用方。
 */
export const fetchWithAuth = async (
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
      if (!res.ok && res.status >= 500 && attempt < options.retries) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AdshareError('HTTP_ERROR', `远端 ${res.status} ${text}`, { status: res.status });
      }
      return res;
    } catch (error) {
      lastError = error;
      if (error instanceof AdshareError) throw error;
      if (attempt < options.retries) {
        await delay(200 * 2 ** attempt);
        continue;
      }
      if (isAbortError(error)) {
        throw new AdshareError('TIMEOUT', `远端请求超时（${options.timeoutMs}ms）`, {
          cause: error,
        });
      }
      throw new AdshareError('NETWORK_ERROR', `远端请求失败：${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AdshareError('NETWORK_ERROR', `fetchWithAuth 重试耗尽：${String(lastError)}`);
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用 adshare /stock_basic 搜索股票基本信息。
 * 支持对象数组与字段/值数组（Tushare 风格）两种返回格式。
 */
export async function fetchStockBasic(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  query: { name?: string; ts_code?: string; fields?: string[]; limit?: number },
  options: StockBasicOptions,
): Promise<StockBasic[]> {
  if (!query.name && !query.ts_code) {
    throw new AdshareError('INVALID_INPUT', 'searchStocks 需要 name 或 ts_code 之一');
  }

  const params = new URLSearchParams();
  if (query.name) params.set('name', query.name);
  if (query.ts_code) params.set('ts_code', query.ts_code);
  const fields = query.fields ?? ['ts_code', 'name', 'industry', 'exchange'];
  params.set('fields', fields.join(','));
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const res = await fetchWithAuth(`${url}/stock_basic?${params.toString()}`, apiKey, fetchImpl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', 'stock_basic 响应不是有效 JSON', { cause: error });
  }
  const rows = normalizeRows(raw, fields);

  let parsed: StockBasic[];
  try {
    parsed = rows
      .map((item: Record<string, unknown>) => parseAsObject(item, fields))
      .map((item) => StockBasicSchema.parse(item));
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', 'stock_basic 响应格式无效', { cause: error });
  }

  if (query.limit !== undefined && query.limit > 0) {
    return parsed.slice(0, query.limit);
  }
  return parsed;
}

/** 统一处理对象 / {fields, items} / 数组 三种返回。 */
function normalizeRows(raw: unknown, fields: string[]): Array<Record<string, unknown>> {
  if (raw === null || typeof raw !== 'object') return [];
  const outer = raw as { data?: unknown };
  const data = outer.data ?? outer;

  if (Array.isArray(data)) {
    return data.map((item) =>
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {},
    );
  }

  const container = data as { fields?: string[]; items?: unknown[] };
  if (!Array.isArray(container.items)) return [];
  return container.items.map((row) => rowToObject(row, container.fields ?? fields));
}

function rowToObject(row: unknown, fields: string[]): Record<string, unknown> {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row as Record<string, unknown>;
  }
  if (Array.isArray(row)) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < fields.length && i < row.length; i += 1) {
      const key = fields[i];
      if (key !== undefined) obj[key] = row[i];
    }
    return obj;
  }
  return {};
}

function parseAsObject(item: Record<string, unknown>, _fields: string[]): Record<string, unknown> {
  return item;
}
