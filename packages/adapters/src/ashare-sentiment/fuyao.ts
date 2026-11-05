import { ZodError, z } from 'zod';
import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError } from '../source-error.js';
import type { AShareSentimentRawEntry, AShareSentimentRawPool } from './types.js';

/**
 * Fuyao 情绪池（封板 GET /api/a-share/special-data/limit-up-pool /
 * 炸板 GET /api/a-share/special-data/limit-break-pool）协议层。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §7.2；
 * 取证：docs/ddd/fuyao-phase0-special-evidence.md §2.1/§2.2（2026-11-03 真实 Key）。
 *
 * 实测契约（Phase 0 fixture limit-up-pool.page{1,2}.json / limit-break-pool.page1.json）：
 * - 信封 data 形状：{ timestamp, pagination{total,pages,size,page}, item[] }。
 * - 分页：page < pages 推进；超页返回空 item 而非错误（炸板池实测 page=2 → item=[]），
 *   终止以 pages 为准，不能以空页当错误、也不能以空页当"还有数据"。
 * - data.timestamp 是数据就绪/采样时间（请求时刻），不是交易日零点；
 *   业务日期由请求参数 date_ms（上海零点毫秒）决定；observedAt 按交易日收盘口径归一。
 * - 封板池 item 字段：thscode、ticker、name、is_st、is_new、last_price、
 *   price_change_ratio_pct（已乘 100 的百分数，19.9367 = 19.9367%）、limit_up_time（HH:MM 无秒）、
 *   limit_up_reason（可空）、continue_day_text、continue_day_cnt（1–4）、seal_money、
 *   max_seal_money、open_times（可空，未开板为 null）。
 * - 炸板池 item 字段：thscode、ticker、name、last_price、price_change_ratio_pct、
 *   open_times、turnover_ratio_pct、turnover、first_seal_time（HH:MM）、last_seal_time（HH:MM）。
 * - ST/20cm 与主板 10cm 混在同一池内，不能按涨跌幅推断板数；ladderLevel 用 continue_day_cnt。
 * - 炸板池上游同样只支持近期窗口（与 Eastmoney 30 天口径对齐）；超窗按 unsupported_date 池返回。
 */

const SEALED_PATH = '/api/a-share/special-data/limit-up-pool';
const BROKEN_PATH = '/api/a-share/special-data/limit-break-pool';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const PaginationSchema = z.object({
  total: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  page: z.number().int().positive(),
});

const SealedItemSchema = z.object({
  thscode: z.string().nullish(),
  ticker: z.string().min(1),
  name: z.string().nullish(),
  is_st: z.boolean().nullish(),
  last_price: z.number().nullish(),
  price_change_ratio_pct: z.number().nullish(),
  limit_up_time: z.string().nullish(),
  limit_up_reason: z.string().nullish(),
  continue_day_cnt: z.number().int().nullish(),
  seal_money: z.number().nullish(),
  open_times: z.number().int().nullish(),
});

const BrokenItemSchema = z.object({
  thscode: z.string().nullish(),
  ticker: z.string().min(1),
  name: z.string().nullish(),
  last_price: z.number().nullish(),
  price_change_ratio_pct: z.number().nullish(),
  open_times: z.number().int().nullish(),
  turnover_ratio_pct: z.number().nullish(),
  turnover: z.number().nullish(),
  first_seal_time: z.string().nullish(),
  last_seal_time: z.string().nullish(),
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

/** 炸板池只支持最近 30 天（含今天，Asia/Shanghai 口径），与 Eastmoney 存量口径对齐。 */
const brokenPoolSupports = (date: string, now: Date): boolean => {
  const cutoff = new Date(now.getTime() + SHANGHAI_OFFSET_MS - THIRTY_DAYS_MS)
    .toISOString()
    .slice(0, 10);
  return date >= cutoff;
};

const exchangeFor = (code: string): 'SH' | 'SZ' | undefined => {
  if (/^(?:6|68)\d{5}$/.test(code)) return 'SH';
  if (/^(?:0|3)\d{5}$/.test(code)) return 'SZ';
  return undefined;
};

const mapSealedItem = (raw: Record<string, unknown>): AShareSentimentRawEntry | undefined => {
  const parsed = SealedItemSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  const ticker = item.ticker.trim();
  const exchange = exchangeFor(ticker);
  if (exchange === undefined) return undefined;
  const name =
    typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : ticker;
  return {
    stockId: `${ticker}.${exchange}`,
    name,
    ladderLevel:
      item.continue_day_cnt != null && item.continue_day_cnt >= 1 ? item.continue_day_cnt : 1,
    sealAmount: item.seal_money != null && item.seal_money >= 0 ? item.seal_money : null,
    openCount: item.open_times != null && item.open_times >= 0 ? item.open_times : null,
    concepts: [],
  };
};

const mapBrokenItem = (raw: Record<string, unknown>): AShareSentimentRawEntry | undefined => {
  const parsed = BrokenItemSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  const ticker = item.ticker.trim();
  const exchange = exchangeFor(ticker);
  if (exchange === undefined) return undefined;
  const name =
    typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : ticker;
  return {
    stockId: `${ticker}.${exchange}`,
    name,
    // 炸板池股票当日未封住，ladderLevel 记 1（首板尝试）；openCount 用实测 open_times。
    ladderLevel: 1,
    sealAmount: null,
    openCount: item.open_times != null && item.open_times >= 0 ? item.open_times : null,
    concepts: [],
  };
};

export interface FuyaoAShareSentimentSourceOptions {
  readonly client: FuyaoClient;
  readonly clock?: () => Date;
}

/**
 * Fuyao 情绪池源（AShareSentimentPoolSource 结构实现）。
 *
 * 池级失败返回 ok:false 池（存量结果契约），不抛错；观测分类由 binding 的 observationOf 承担。
 * 信封错误（2001/2003 权限、4001 限流）由 FuyaoClient 抛结构化 SourceExecutionError，
 * 在池边界归一为存量 errorKind 词表（network_error / http_error / invalid_response）。
 */
export class FuyaoAShareSentimentSource {
  readonly name = 'fuyao' as const;

  private readonly client: FuyaoClient;
  private readonly clock: () => Date;

  constructor(options: FuyaoAShareSentimentSourceOptions) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
  }

  fetchSealedPool(input: {
    readonly date: string;
    readonly coverage: 'CN_A_SHARES_SH_SZ';
  }): Promise<AShareSentimentRawPool> {
    return this.fetchPool('sealed', input.date);
  }

  fetchBrokenPool(input: {
    readonly date: string;
    readonly coverage: 'CN_A_SHARES_SH_SZ';
  }): Promise<AShareSentimentRawPool> {
    return this.fetchPool('broken', input.date);
  }

  private async fetchPool(
    kind: 'sealed' | 'broken',
    date: string,
  ): Promise<AShareSentimentRawPool> {
    if (kind === 'broken' && !brokenPoolSupports(date, this.clock())) {
      return {
        ok: false,
        fetchedAt: this.clock(),
        errorKind: 'unsupported_date',
        errorMessage: 'fuyao broken pool only supports the most recent 30 days',
      };
    }
    try {
      const entries = await this.fetchAllPages(kind, date);
      const fetchedAt = this.clock();
      return {
        ok: true,
        observedAt: tradingDayObservedAt(date, fetchedAt),
        fetchedAt,
        entries,
      };
    } catch (error) {
      return {
        ok: false,
        fetchedAt: this.clock(),
        errorKind: poolErrorKindOf(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 分页读尽：page < pages 推进；超页空 item 是合法终止信号（炸板池实测），
   * 不能当错误、也不能当"还有数据"。封顶 MAX_PAGES 防上游 pagination 撒谎死循环。
   */
  private async fetchAllPages(
    kind: 'sealed' | 'broken',
    date: string,
  ): Promise<AShareSentimentRawEntry[]> {
    const path = kind === 'sealed' ? SEALED_PATH : BROKEN_PATH;
    const dateMs = dateToShanghaiMidnightMs(date);
    const entries: AShareSentimentRawEntry[] = [];
    let page = 1;
    let pages = 1;
    do {
      const { data } = await this.client.getData(path, {
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
            `fuyao ${kind}-pool parse: data 形状不符（${error.message}）`,
            error,
          );
        }
        throw error;
      }
      pages = parsed.pagination.pages;
      const mapItem = kind === 'sealed' ? mapSealedItem : mapBrokenItem;
      for (const raw of parsed.item) {
        const entry = mapItem(raw);
        if (entry !== undefined) entries.push(entry);
      }
      page += 1;
    } while (page <= pages && page <= MAX_PAGES);
    return entries;
  }
}

/** 传输错误 → 情绪池存量 errorKind 词表（与 Eastmoney 池边界口径一致）。 */
const poolErrorKindOf = (error: unknown): 'network_error' | 'http_error' | 'invalid_response' => {
  const kind = (error as { readonly kind?: unknown }).kind;
  if (kind === 'network' || kind === 'timeout') return 'network_error';
  if (kind === 'invalid_payload') return 'invalid_response';
  return 'http_error';
};
