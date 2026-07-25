import { AdshareError } from '../errors.js';
import { fetchWithAuth } from './stock-basic.js';

/**
 * adshare `/market/limit-up/ladder` endpoint（Phase 1）。
 *
 * 协议层职责（docs/ddd/limit-up-ladder-detailed-design.md §3）：
 * - 只做 HTTP GET + Zod 解析；不做修正 / 过滤 / 缓存。
 * - 字段名与 adshare 远端 JSON 一致（snake_case）；core 层映射到小写蛇形。
 * - 4xx 直接抛 `AdshareError('HTTP_ERROR')`；5xx / 网络错误由 fetchWithAuth 重试后抛
 *   `AdshareError('HTTP_ERROR')` 或 `AdshareError('NETWORK_ERROR')`。
 * - 响应 schema 校验失败抛 `AdshareError('PARSE_ERROR')`。
 */

export interface RawLimitUpEntry {
  readonly code: string;
  readonly name?: string | undefined;
  readonly industry?: string | undefined;
  readonly level?: number | undefined; // undefined 表示 adshare 未返回
  readonly limit_up_days?: number | undefined;
  readonly first_time?: string | undefined;
  readonly final_time?: string | undefined;
  readonly reason?: string | undefined;
  readonly close: number;
  readonly pre_close?: number | undefined;
  readonly change_pct?: number | undefined;
  readonly limit_up_date?: string | undefined;
  readonly high?: number | undefined;
}

export interface FetchLimitUpLadderQuery {
  readonly date: string; // YYYY-MM-DD
  readonly days?: number; // 默认 15
}

export interface LimitUpLadderResponse {
  readonly date: string;
  readonly entries: RawLimitUpEntry[];
}

/**
 * 调 adshare `/market/limit-up/ladder`。
 * 路径与 ruo 旧实现一致（adshare 后端固化，luoome 不改协议）。
 */
export const fetchLimitUpLadder = async (
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  query: FetchLimitUpLadderQuery,
  options: { readonly timeoutMs: number; readonly retries: number },
): Promise<LimitUpLadderResponse> => {
  if (query.date && !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    throw new AdshareError('INVALID_INPUT', `date 必须为 YYYY-MM-DD，实际 "${query.date}"`);
  }
  const params = new URLSearchParams({ date: query.date });
  if (query.days !== undefined) {
    params.set('days', String(query.days));
  }
  const res = await fetchWithAuth(
    `${url}/market/limit-up/ladder?${params.toString()}`,
    apiKey,
    fetchImpl,
    {
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    },
  );

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', 'limit-up/ladder 响应不是有效 JSON', { cause: error });
  }

  // adshare 两种常见返回形态：{ data: { date, items: [] } } 或 { date, items: [] }
  // 也可能是 { date, entries: [] } 或直接数组 []
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const date = typeof payload.date === 'string' ? payload.date : query.date;
  const fields = Array.isArray(payload.fields) ? (payload.fields as string[]) : null;

  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (Array.isArray(payload.data)) {
    items = payload.data;
  } else if (Array.isArray(payload.entries)) {
    items = payload.entries;
  } else if (Array.isArray(payload.items)) {
    // { fields, items } 形式（与 stock_basic 同款）
    items = payload.items;
  } else {
    items = [];
  }

  if (!Array.isArray(items)) {
    throw new AdshareError('PARSE_ERROR', 'limit-up/ladder 响应 data/items 字段不是数组');
  }

  // 逐条解析，拒绝畸形条目但不死在第一条
  const normalizeItem = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object') return {};
    if (!Array.isArray(item)) return item as Record<string, unknown>;
    if (fields === null) return {};
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < fields.length && j < item.length; j += 1) {
      const key = fields[j];
      if (key !== undefined) obj[key] = item[j];
    }
    return obj;
  };

  const entries: RawLimitUpEntry[] = [];
  const parseErrors: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const obj = normalizeItem(items[i]);
    if (Object.keys(obj).length === 0) {
      parseErrors.push(`index ${i}: not an object`);
      continue;
    }
    // 最少必须有 code + close
    if (typeof obj.code !== 'string' || obj.code.trim().length === 0) {
      parseErrors.push(`index ${i}: missing or empty code`);
      continue;
    }
    if (typeof obj.close !== 'number') {
      parseErrors.push(`index ${i}: missing or non-numeric close`);
      continue;
    }
    entries.push({
      code: String(obj.code).trim(),
      name: typeof obj.name === 'string' ? obj.name : undefined,
      industry: typeof obj.industry === 'string' ? obj.industry : undefined,
      level: typeof obj.level === 'number' ? obj.level : undefined,
      limit_up_days: typeof obj.limit_up_days === 'number' ? obj.limit_up_days : undefined,
      first_time: typeof obj.first_time === 'string' ? obj.first_time : undefined,
      final_time: typeof obj.final_time === 'string' ? obj.final_time : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      close: obj.close,
      pre_close: typeof obj.pre_close === 'number' ? obj.pre_close : undefined,
      change_pct: typeof obj.change_pct === 'number' ? obj.change_pct : undefined,
      limit_up_date: typeof obj.limit_up_date === 'string' ? obj.limit_up_date : undefined,
      high: typeof obj.high === 'number' ? obj.high : undefined,
    });
  }

  if (entries.length === 0 && items.length > 0) {
    // 有数据但全解析失败 → 抛 parse_error 并附上第一行错误
    throw new AdshareError(
      'PARSE_ERROR',
      `limit-up/ladder 响应条目解析全部失败，首错：${parseErrors[0] ?? 'unknown'}`,
    );
  }

  return { date, entries };
};
