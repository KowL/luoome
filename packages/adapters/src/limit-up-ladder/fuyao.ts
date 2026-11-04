import { ZodError, z } from 'zod';
import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError } from '../source-error.js';
import type { LimitUpLadderFetchResult, LimitUpLadderRawEntry } from './types.js';

/**
 * Fuyao 连板天梯（GET /api/a-share/special-data/limit-up-pool）协议层。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §7.1/§7.2；
 * 取证：docs/ddd/fuyao-phase0-special-evidence.md §2.1（2026-11-03 真实 Key）。
 *
 * 实测契约（Phase 0 fixture limit-up-pool.page{1,2}.json）：
 * - 信封 data 形状：{ timestamp, pagination{total,pages,size,page}, item[] }。
 * - 分页：page < pages 推进；缺分页、错日、部分页失败不得转成正常空池（§7.2）。
 * - data.timestamp 是数据就绪/采样时间（请求时刻），不是交易日零点；
 *   业务日期由请求参数 date_ms（上海零点毫秒）决定；observedAt 按交易日收盘口径归一。
 * - item 字段映射（§7.2）：
 *   thscode/ticker/name → 身份与名称；continue_day_cnt → level/limit_up_days；
 *   limit_up_time（HH:MM 无秒）→ first_time，补 :00 为 HH:MM:SS；last_price → close/rawClose；
 *   price_change_ratio_pct（已乘 100）→ change_pct = value / 100；limit_up_reason → reason。
 * - ST/20cm 与主板 10cm 混在同一池内，不能按涨跌幅推断板数（§2.1 实测）。
 * - seal_money/open_times/is_st 保留在情绪原始层，不塞入天梯实体（§7.2）。
 * - 无 high 字段，不做 §6.4 收盘价修正触发（与 Eastmoney 池一致）。
 * - 无行业字段：industry 缺省，由 manager 归一为 unclassified 哨兵。
 *
 * 天梯矩阵端点（limit-up-ladder，30 日 window）只用于近期展示与交叉核验，
 * 不回写当时快照（§7.3）；本 adapter 以涨停池为准，矩阵交叉核验留给后续独立 capability。
 */

const PATH = '/api/a-share/special-data/limit-up-pool';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const PaginationSchema = z.object({
  total: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  page: z.number().int().positive(),
});

const PoolItemSchema = z.object({
  thscode: z.string().nullish(),
  ticker: z.string().min(1),
  name: z.string().nullish(),
  is_st: z.boolean().nullish(),
  last_price: z.number().nullish(),
  price_change_ratio_pct: z.number().nullish(),
  limit_up_time: z.string().nullish(),
  limit_up_reason: z.string().nullish(),
  continue_day_cnt: z.number().int().nullish(),
});

const PoolDataSchema = z.object({
  timestamp: z.number().nullish(),
  pagination: PaginationSchema,
  item: z.array(z.record(z.string(), z.unknown())),
});

/** 历史日为该交易日收盘时刻（15:00 +08:00），当日为 min(fetchedAt, closeAt)（§6.2）。 */
const tradingDayObservedAt = (date: string, fetchedAt: Date): Date => {
  const closeAt = new Date(`${date}T15:00:00+08:00`);
  return closeAt.getTime() <= fetchedAt.getTime() ? closeAt : fetchedAt;
};

/** YYYY-MM-DD（Asia/Shanghai）→ 上海零点毫秒戳（上游 date_ms 参数口径）。 */
const dateToShanghaiMidnightMs = (date: string): number =>
  new Date(`${date}T00:00:00+08:00`).getTime();

/** limit_up_time 实测为 HH:MM（无秒）；补 :00 为 HH:MM:SS。非法形状视为缺失。 */
const formatLimitUpTime = (value: string | null | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return undefined;
  return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
};

const mapPoolItem = (
  raw: Record<string, unknown>,
  date: string,
): LimitUpLadderRawEntry | undefined => {
  const parsed = PoolItemSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  const code = item.ticker.trim();
  if (!/^\d{6}$/.test(code)) return undefined;
  // close 缺失或非法的条目剔除（与 Eastmoney parseLimitUpLadderPool 口径一致）。
  if (item.last_price == null || item.last_price <= 0) return undefined;
  const changePct =
    item.price_change_ratio_pct == null ? undefined : item.price_change_ratio_pct / 100;
  const preClose =
    changePct !== undefined && changePct > -1 ? item.last_price / (1 + changePct) : undefined;
  const level =
    item.continue_day_cnt != null && item.continue_day_cnt >= 1 ? item.continue_day_cnt : undefined;
  const firstTime = formatLimitUpTime(item.limit_up_time);
  return {
    code,
    ...(typeof item.name === 'string' && item.name.trim().length > 0
      ? { name: item.name.trim() }
      : {}),
    ...(level === undefined ? {} : { level, limit_up_days: level }),
    ...(firstTime === undefined ? {} : { first_time: firstTime }),
    ...(typeof item.limit_up_reason === 'string' && item.limit_up_reason.trim().length > 0
      ? { reason: item.limit_up_reason.trim() }
      : {}),
    close: item.last_price,
    ...(preClose === undefined ? {} : { pre_close: preClose }),
    ...(changePct === undefined ? {} : { change_pct: changePct }),
    limit_up_date: date,
  };
};

export interface FuyaoLimitUpLadderSourceOptions {
  readonly client: FuyaoClient;
  readonly clock?: () => Date;
}

/**
 * Fuyao 连板天梯源（LimitUpLadderAdapterLike 结构实现）。
 *
 * 错误模型：信封错误（2001/2003 权限、4001 限流、1002/1003 参数）由 FuyaoClient 抛
 * 结构化 SourceExecutionError；Zod 形状不符 → invalid_payload。不做池级 ok:false 吞错，
 * 由 manager 按 handle 循环 fallback（与 Eastmoney ladder 一致）。
 */
export class FuyaoLimitUpLadderSource {
  readonly name = 'fuyao' as const;

  private readonly client: FuyaoClient;
  private readonly clock: () => Date;

  constructor(options: FuyaoLimitUpLadderSourceOptions) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
  }

  /** days 忽略：连板数由 pool 的 continue_day_cnt 直接给出，不需要样本窗口。 */
  async fetchLadder(
    date: string,
    _opts?: { readonly days?: number },
  ): Promise<LimitUpLadderFetchResult> {
    const entries = await this.fetchAllPages(date);
    const fetchedAt = this.clock();
    return {
      date,
      observedAt: tradingDayObservedAt(date, fetchedAt),
      entries,
    };
  }

  /**
   * 分页读尽并核对 pagination.total/pages/page/size（§7.2）：
   * page < pages 推进；缺分页（Zod 失败）→ invalid_payload，不转成正常空池；
   * 封顶 MAX_PAGES 防上游 pagination 撒谎死循环。
   */
  private async fetchAllPages(date: string): Promise<LimitUpLadderRawEntry[]> {
    const dateMs = dateToShanghaiMidnightMs(date);
    const entries: LimitUpLadderRawEntry[] = [];
    let page = 1;
    let pages = 1;
    do {
      const { data } = await this.client.getData(PATH, {
        date_ms: dateMs,
        page,
        size: PAGE_SIZE,
      });
      let parsed: z.infer<typeof PoolDataSchema>;
      try {
        parsed = PoolDataSchema.parse(data);
      } catch (error) {
        if (error instanceof ZodError) {
          throw invalidPayloadError(
            `fuyao limit-up-pool parse: data 形状不符（${error.message}）`,
            error,
          );
        }
        throw error;
      }
      pages = parsed.pagination.pages;
      for (const raw of parsed.item) {
        const entry = mapPoolItem(raw, date);
        if (entry !== undefined) entries.push(entry);
      }
      page += 1;
    } while (page <= pages && page <= MAX_PAGES);
    return entries;
  }
}
