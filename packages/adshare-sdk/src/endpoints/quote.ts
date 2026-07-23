import { AdshareError } from '../errors.js';
import { type Quote, QuoteSchema } from '../schemas.js';
import { fetchWithAuth } from './stock-basic.js';

export const fetchQuote = async (
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  ts_code: string,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<Quote> => {
  if (ts_code.trim().length === 0) {
    throw new AdshareError('INVALID_INPUT', 'ts_code 不能为空');
  }
  const params = new URLSearchParams({ ts_code });
  const res = await fetchWithAuth(`${url}/quote?${params.toString()}`, apiKey, fetchImpl, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', '行情响应不是有效 JSON', { cause: error });
  }
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const item = payload.data ?? raw;
  if (!item || Array.isArray(item)) {
    throw new AdshareError('NOT_FOUND', `未找到 ${ts_code} 的实时行情`);
  }
  try {
    return QuoteSchema.parse(item);
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', '行情响应格式无效', { cause: error });
  }
};
