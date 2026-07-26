import { AdshareError } from '../errors.js';
import { fetchWithAuth } from './stock-basic.js';

/**
 * adshare `/market/limit-up/ladder` endpoint（Phase 1）。
 *
 * 协议层职责（docs/ddd/limit-up-ladder-detailed-design.md §3）：
 * - 只做 HTTP GET + 协议映射；不做修正 / 过滤 / 缓存。
 * - 请求：`date` 必须是 int 形态 `YYYYMMDD`（远端 FastAPI int 解析，`YYYY-MM-DD` 会 422）。
 * - 响应是已组装好的梯队：`{ success, date, total, maxLevel, levels: [{ level, name, count, stocks: [...] }] }`，
 *   entry 字段为 camelCase（`firstTime` / `changePct` / `limitUpDate` / `price`）。
 *   本层负责拍平 levels → entries、camelCase → snake_case 映射，
 *   并由 `changePct` 反推 `pre_close`（远端不给 pre_close / high；manager 的 pct 与修正逻辑依赖 pre_close）。
 * - `success === false` 抛 `AdshareError('HTTP_ERROR')`；4xx/5xx/网络错误由 fetchWithAuth 抛出。
 * - 有数据但条目全部解析失败抛 `AdshareError('PARSE_ERROR')`。
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
  readonly date: string; // YYYY-MM-DD（发送前转成 YYYYMMDD）
  readonly days?: number; // 默认 15
}

export interface LimitUpLadderResponse {
  readonly date: string;
  readonly entries: RawLimitUpEntry[];
}

/** 空字符串视为缺失（远端用 '' 表示无数据）。 */
const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

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
  const params = new URLSearchParams({ date: query.date.replaceAll('-', '') });
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

  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (payload.success === false) {
    throw new AdshareError(
      'HTTP_ERROR',
      `limit-up/ladder 远端返回 success=false：${String(payload.message ?? 'unknown')}`,
    );
  }
  const date = typeof payload.date === 'string' ? payload.date : query.date;
  const levels = Array.isArray(payload.levels) ? payload.levels : [];

  const entries: RawLimitUpEntry[] = [];
  const parseErrors: string[] = [];
  let seen = 0;
  for (const lv of levels) {
    const parent = typeof lv === 'object' && lv !== null ? (lv as Record<string, unknown>) : {};
    const parentLevel = typeof parent.level === 'number' ? parent.level : undefined;
    const stocks = Array.isArray(parent.stocks) ? parent.stocks : [];
    for (const item of stocks) {
      seen += 1;
      const obj =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
      // 最少必须有 code + price
      if (typeof obj.code !== 'string' || obj.code.trim().length === 0) {
        parseErrors.push(`index ${seen - 1}: missing or empty code`);
        continue;
      }
      if (typeof obj.price !== 'number') {
        parseErrors.push(`index ${seen - 1}: missing or non-numeric price`);
        continue;
      }
      const changePct = typeof obj.changePct === 'number' ? obj.changePct : undefined;
      // 远端不给 pre_close：由 changePct 反推，保证 manager 的 pct / 修正式有输入
      const preClose =
        changePct !== undefined && 1 + changePct > 0 ? obj.price / (1 + changePct) : undefined;
      entries.push({
        code: obj.code.trim(),
        name: nonEmpty(obj.name),
        industry: nonEmpty(obj.industry),
        level: typeof obj.level === 'number' ? obj.level : parentLevel,
        first_time: nonEmpty(obj.firstTime),
        final_time: nonEmpty(obj.finalTime),
        reason: nonEmpty(obj.reason),
        close: obj.price,
        pre_close: preClose,
        change_pct: changePct,
        limit_up_date: nonEmpty(obj.limitUpDate),
      });
    }
  }

  if (entries.length === 0 && seen > 0) {
    // 有数据但全解析失败 → 抛 parse_error 并附上第一行错误
    throw new AdshareError(
      'PARSE_ERROR',
      `limit-up/ladder 响应条目解析全部失败，首错：${parseErrors[0] ?? 'unknown'}`,
    );
  }

  return { date, entries };
};
