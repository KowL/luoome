import { AdshareError } from '../errors.js';
import { type KLineBar, KLineBarSchema } from '../schemas.js';
import { fetchWithAuth } from './stock-basic.js';

export interface FetchKLineQuery {
  readonly ts_code: string;
  readonly period: 'D' | 'W';
  readonly start_date?: string;
  readonly end_date?: string;
}

export const fetchKLine = async (
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  query: FetchKLineQuery,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<KLineBar[]> => {
  if (query.ts_code.trim().length === 0) {
    throw new AdshareError('INVALID_INPUT', 'ts_code 不能为空');
  }
  if (query.period !== 'D' && query.period !== 'W') {
    throw new AdshareError('INVALID_INPUT', `不支持的 K 线周期：${String(query.period)}`);
  }
  const params = new URLSearchParams({ ts_code: query.ts_code });
  if (query.start_date) params.set('start_date', query.start_date);
  if (query.end_date) params.set('end_date', query.end_date);

  const path = query.period === 'W' ? '/weekly' : '/daily';
  const res = await fetchWithAuth(`${url}${path}?${params.toString()}`, apiKey, fetchImpl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', 'K 线响应不是有效 JSON', { cause: error });
  }
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(payload.data) ? payload.data : [];

  let bars: KLineBar[];
  try {
    bars = list.map((item: unknown) => KLineBarSchema.parse(item));
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', 'K 线响应格式无效', { cause: error });
  }
  if (bars.length === 0) {
    throw new AdshareError('NOT_FOUND', `未找到 ${query.ts_code} 的 K 线数据`);
  }
  return bars;
};
