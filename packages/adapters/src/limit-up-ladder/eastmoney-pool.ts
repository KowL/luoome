/**
 * Eastmoney 涨停股池（getTopicZTPool）enricher。
 *
 * 背景：adshare 天梯 / 明细 / limit_list 的 firstTime / finalTime / industry
 * 实测（2026-07 多个交易日）全部为空；eastmoney 公开涨停池有
 * fbt（首次封板）/ lbt（最后封板）/ hybk（行业板块），按 code 补齐。
 *
 * 设计要点：
 * - 只 enrich，不做过滤、不做 level 判定（仍是 manager / adshare 的职责）
 * - 失败向上抛，由 manager 捕获降级为 warn——封板时间是增强字段，不阻断主流程
 * - 公开 API 无鉴权；与 market/eastmoney.ts 同族（push2 系）
 */

/** 单只股票的补齐字段（HH:MM:SS / 行业名）。 */
export interface LimitUpPoolEnrichment {
  readonly firstTime?: string | undefined;
  readonly finalTime?: string | undefined;
  readonly industry?: string | undefined;
}

export interface LimitUpPoolEnricherLike {
  readonly name: string;
  fetchPool(date: string): Promise<ReadonlyMap<string, LimitUpPoolEnrichment>>;
}

const BASE_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
/** 公开 ut token（与 eastmoney 网页端一致，非私有凭据）。 */
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DEFAULT_TIMEOUT_MS = 5_000;

/** fbt/lbt 为 HHMMSS int（92500 → 09:25:00；142842 → 14:28:42）；0/null 视为缺失。 */
const formatPoolTime = (v: unknown): string | undefined => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return undefined;
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
};

export class EastmoneyLimitUpPoolEnricher implements LimitUpPoolEnricherLike {
  readonly name = 'eastmoney-zt-pool' as const;

  constructor(
    private readonly fetchImpl?: typeof fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetchPool(date: string): Promise<ReadonlyMap<string, LimitUpPoolEnrichment>> {
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

    const raw = (await res.json()) as Record<string, unknown>;
    const data = raw.data as Record<string, unknown> | null | undefined;
    // 非交易日 / 无数据：data 为 null 或 pool 缺失 → 空表（调用方按无补齐处理）
    const pool = Array.isArray(data?.pool) ? (data.pool as unknown[]) : [];
    const out = new Map<string, LimitUpPoolEnrichment>();
    for (const item of pool) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.c !== 'string' || obj.c.length === 0) continue;
      out.set(obj.c, {
        firstTime: formatPoolTime(obj.fbt),
        finalTime: formatPoolTime(obj.lbt),
        industry: typeof obj.hybk === 'string' && obj.hybk.trim().length > 0 ? obj.hybk : undefined,
      });
    }
    return out;
  }
}
