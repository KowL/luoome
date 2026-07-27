import type { LimitUpLadderAdapterLike, LimitUpLadderRawEntry } from './types.js';

/**
 * Eastmoney 涨停股池（getTopicZTPool）天梯 adapter（主源）。
 *
 * 公开 API 无鉴权；pool 条目天然带齐天梯所需字段：
 * - c 代码 / n 名称 / p 最新价（×1000）/ zdp 涨跌幅（×100）
 * - lbc 连板数（首板=1）/ fbt 首次封板 / lbt 最后封板（HHMMSS int）/ hybk 行业板块
 * 无涨停原因字段（reason 由 manager 归一为 '--' 哨兵），无 high（不做 §6.4 修正触发）。
 * 与 market/eastmoney.ts 同族（push2 系）。
 */

const BASE_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
/** 公开 ut token（与 eastmoney 网页端一致，非私有凭据）。 */
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DEFAULT_TIMEOUT_MS = 10_000;

/** fbt/lbt 为 HHMMSS int（92500 → 09:25:00；142842 → 14:28:42）；0/null 视为缺失。 */
const formatPoolTime = (v: unknown): string | undefined => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return undefined;
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
};

/** p 为最新价 ×1000；非法值返回 undefined。 */
const asPrice = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v / 1000 : undefined;

/** zdp 为涨跌幅 ×100（百分数）；转为小数（9.98 → 0.0998）。 */
const asChangePct = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v / 100 : undefined;

export class EastmoneyLimitUpLadderAdapter implements LimitUpLadderAdapterLike {
  readonly name = 'eastmoney' as const;

  constructor(
    private readonly fetchImpl?: typeof fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** days 忽略：连板数由 pool 的 lbc 直接给出，不需要样本窗口。 */
  async fetchLadder(
    date: string,
    _opts?: { readonly days?: number },
  ): Promise<{ readonly date: string; readonly entries: LimitUpLadderRawEntry[] }> {
    const ymd = date.replaceAll('-', '');
    const url =
      `${BASE_URL}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500` + `&sort=fbt:asc&date=${ymd}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await (this.fetchImpl ?? fetch)(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `eastmoney zt-pool 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`eastmoney zt-pool HTTP ${res.status}`);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error) {
      throw new Error(`eastmoney zt-pool 响应不是有效 JSON: ${String(error)}`);
    }
    const data = (raw as Record<string, unknown>).data as
      | Record<string, unknown>
      | null
      | undefined;
    // 非交易日 / 无数据：data 为 null 或 pool 缺失 → 空梯队
    const pool = Array.isArray(data?.pool) ? (data.pool as unknown[]) : [];

    const entries: LimitUpLadderRawEntry[] = [];
    for (const item of pool) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.c !== 'string' || obj.c.length === 0) continue;
      const close = asPrice(obj.p);
      if (close === undefined) continue;
      const changePct = asChangePct(obj.zdp);
      const preClose =
        changePct !== undefined && changePct > -1 ? close / (1 + changePct) : undefined;
      const level =
        typeof obj.lbc === 'number' && Number.isInteger(obj.lbc) && obj.lbc >= 1
          ? obj.lbc
          : undefined;
      entries.push({
        code: obj.c,
        ...(typeof obj.n === 'string' && obj.n.trim().length > 0 ? { name: obj.n } : {}),
        ...(typeof obj.hybk === 'string' && obj.hybk.trim().length > 0
          ? { industry: obj.hybk }
          : {}),
        ...(level === undefined ? {} : { level, limit_up_days: level }),
        ...(formatPoolTime(obj.fbt) === undefined ? {} : { first_time: formatPoolTime(obj.fbt) }),
        ...(formatPoolTime(obj.lbt) === undefined ? {} : { final_time: formatPoolTime(obj.lbt) }),
        close,
        ...(preClose === undefined ? {} : { pre_close: preClose }),
        ...(changePct === undefined ? {} : { change_pct: changePct }),
        limit_up_date: date,
      });
    }
    return { date, entries };
  }
}
