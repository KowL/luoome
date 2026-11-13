import type {
  LimitUpLadderBand,
  LimitUpLadderMatrixDay,
  LimitUpLadderMatrixStock,
  LimitUpLadderWindow,
  LimitUpMarketStatistics,
  LimitUpPoolEntry,
} from '@luoome/core';
import { LIMIT_UP_LADDER_BANDS } from '@luoome/core';
import { z } from 'zod';

import { invalidPayloadError } from '../source-error.js';
import type { FuyaoClient } from './client.js';
import { type FuyaoDataEnvelope, parseFuyaoDataEnvelope } from './envelope.js';

/**
 * fuyao 涨停市场三端点聚合源（https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/）。
 *
 * - `limit-up-pool`：所选交易日逐股明细（分页拉全）
 * - `limit-up-statistics`：同一交易日的封板率 / 开板家数 / 板位档位与晋级率
 * - `limit-up-ladder`：**无日期入参**的近 30 个交易日连板矩阵
 *
 * 语义要点：
 * - 覆盖固定沪深：`.BJ` 行丢弃，不让北交所成员污染 SH/SZ 事实（与 fuyao 涨跌停池同口径）
 * - 三个端点互相独立：任一失败只让该维度为 null 并带上错误串，由 manager 决定是否整体失败
 * - 缺值一律 null（上游明确允许 null 的字段）；不把缺失当 0，也不用文本反推板数
 * - 天梯日期的两种上游写法（YYYYMMDD / YYYY-MM-DD）统一归一为带连字符
 */

const IN_COVERAGE = /^\d{6}\.(SH|SZ)$/;
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

export const LIMIT_UP_POOL_PATH = '/api/a-share/special-data/limit-up-pool';
export const LIMIT_UP_STATISTICS_PATH = '/api/a-share/special-data/limit-up-statistics';
export const LIMIT_UP_LADDER_PATH = '/api/a-share/special-data/limit-up-ladder';

/** 上游板位键 → core 档位；`seven_over` 是「7 板及以上」合并档。 */
const BAND_FROM_UPSTREAM: Readonly<Record<string, LimitUpLadderBand>> = {
  two_board: 'two',
  three_board: 'three',
  four_board: 'four',
  five_board: 'five',
  six_board: 'six',
  seven_over: 'seven_plus',
};

const hhmmOrNull = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || /^\d{2}:\d{2}$/.test(value), '时间必须为 HH:MM');

const percentOrNull = z
  .number()
  .nullish()
  .transform((value) => (value == null || !Number.isFinite(value) ? null : value / 100))
  .refine((value) => value === null || (value >= -0.35 && value <= 0.35), '涨跌幅越界');

const PoolRowSchema = z
  .object({
    thscode: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
    ticker: z.string().nullish(),
    name: z.string().nullish(),
    is_st: z.boolean().nullish(),
    is_new: z.boolean().nullish(),
    last_price: z.number().nullish(),
    price_change_ratio_pct: percentOrNull,
    limit_up_time: hhmmOrNull,
    limit_up_reason: z.string().nullish(),
    continue_day_text: z.string().nullish(),
    continue_day_cnt: z.number().int().min(1).max(50),
    seal_money: z.number().nonnegative(),
    max_seal_money: z.number().nonnegative(),
    open_times: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const PaginationSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    page: z.number().int().positive(),
  })
  .passthrough();

const StatisticsSchema = z
  .object({
    trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seal_rate: z.number().min(0).max(1).nullish(),
    open_stock_count: z.number().int().nonnegative(),
    limit_up_stock_count: z.number().int().nonnegative(),
    touched_limit_up_stock_count: z.number().int().nonnegative(),
    page_boards: z.array(
      z.object({
        board_level: z.enum(['one', 'two', 'three', 'four', 'five_plus']),
        stock_count: z.number().int().nonnegative(),
        promotion_rate: z.number().min(0).max(1).nullish(),
      }),
    ),
    exact_boards: z.array(
      z.object({
        board_num: z.number().int().min(2),
        stock_count: z.number().int().nonnegative(),
      }),
    ),
  })
  .passthrough();

const LadderStockSchema = z
  .object({
    thscode: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
    ticker: z.string().nullish(),
    name: z.string().nullish(),
    board_num: z.number().int().min(2),
    seal_nextday: z.boolean().nullish(),
  })
  .passthrough();

const LadderDaySchema = z
  .object({
    date: z.union([z.string().regex(/^\d{8}$/), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
    boards: z.record(z.string(), z.array(LadderStockSchema)).nullish(),
  })
  .passthrough();

const LadderSchema = z
  .object({
    window: z
      .object({
        length: z.number().int().positive(),
        date_list: z.array(
          z.union([z.string().regex(/^\d{8}$/), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
        ),
        board_caps: z.record(z.string(), z.number().int().nonnegative()).nullish(),
      })
      .passthrough(),
    item: z.array(LadderDaySchema),
  })
  .passthrough();

/** 上游日期 `YYYYMMDD` / `YYYY-MM-DD` → `YYYY-MM-DD`。 */
const normalizeDate = (value: string): string =>
  value.includes('-') ? value : `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;

const shanghaiMidnightMs = (date: string): number => {
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(ms)) throw new Error(`无效交易日：${date}`);
  return ms;
};

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

const codeOf = (thscode: string, ticker: string | null | undefined): string =>
  ticker !== null && ticker !== undefined && /^\d{6}$/.test(ticker)
    ? ticker
    : (thscode.split('.')[0] as string);

const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidPayloadError(`fuyao ${label} 解析失败（${parsed.error.message}）`, parsed.error);
  }
  return parsed.data;
};

const toPoolEntry = (row: z.infer<typeof PoolRowSchema>): LimitUpPoolEntry => ({
  stockId: row.thscode,
  code: codeOf(row.thscode, row.ticker),
  name: blankToNull(row.name) ?? codeOf(row.thscode, row.ticker),
  isSt: row.is_st ?? false,
  isNew: row.is_new ?? false,
  price:
    row.last_price === null || row.last_price === undefined || row.last_price <= 0
      ? null
      : row.last_price,
  changePct: row.price_change_ratio_pct,
  limitUpTime: row.limit_up_time,
  openTimes: row.open_times ?? null,
  reason: blankToNull(row.limit_up_reason),
  continueDayText: blankToNull(row.continue_day_text) ?? `${row.continue_day_cnt}连板`,
  continueDayCnt: row.continue_day_cnt,
  sealMoney: row.seal_money,
  maxSealMoney: row.max_seal_money,
});

const toLadderStock = (row: z.infer<typeof LadderStockSchema>): LimitUpLadderMatrixStock => ({
  stockId: row.thscode,
  code: codeOf(row.thscode, row.ticker),
  name: blankToNull(row.name) ?? codeOf(row.thscode, row.ticker),
  boardNum: row.board_num,
  sealedNextDay: row.seal_nextday ?? null,
});

const toLadderDay = (row: z.infer<typeof LadderDaySchema>): LimitUpLadderMatrixDay => {
  const byBand = new Map<LimitUpLadderBand, LimitUpLadderMatrixStock[]>();
  for (const [key, stocks] of Object.entries(row.boards ?? {})) {
    const band = BAND_FROM_UPSTREAM[key];
    if (band === undefined) continue;
    byBand.set(band, stocks.filter((stock) => IN_COVERAGE.test(stock.thscode)).map(toLadderStock));
  }
  return {
    date: normalizeDate(row.date),
    bands: LIMIT_UP_LADDER_BANDS.map((band) => ({ band, stocks: byBand.get(band) ?? [] })),
  };
};

/** 三个维度各自的结果；失败维度为 null 并附错误串。 */
export interface LimitUpMarketSections {
  readonly date: string;
  readonly pool: { readonly total: number; readonly entries: LimitUpPoolEntry[] } | null;
  readonly poolError: string | null;
  readonly statistics: LimitUpMarketStatistics | null;
  readonly statisticsError: string | null;
  readonly ladder: LimitUpLadderWindow | null;
  readonly ladderError: string | null;
  /** 三个端点里最大的上游数据就绪时刻；全缺为 null。 */
  readonly dataAsOf: Date | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class FuyaoLimitUpMarketSource {
  readonly name = 'fuyao';

  constructor(private readonly client: FuyaoClient) {}

  private async poolPages(date: string): Promise<{
    readonly total: number;
    readonly entries: LimitUpPoolEntry[];
    readonly timestamp: Date | undefined;
  }> {
    const entries: LimitUpPoolEntry[] = [];
    let total = 0;
    let timestamp: Date | undefined;
    let pages = 1;
    for (let page = 1; page <= Math.min(pages, MAX_PAGES); page += 1) {
      const envelope: FuyaoDataEnvelope = parseFuyaoDataEnvelope(
        await this.client.getRaw(LIMIT_UP_POOL_PATH, {
          date_ms: shanghaiMidnightMs(date),
          page,
          size: PAGE_SIZE,
          sort_field: 'continue_day_cnt',
          sort_dir: 'desc',
        }),
      );
      timestamp ??= envelope.timestamp;
      const pagination = parseOrThrow(
        PaginationSchema,
        envelope.data.pagination,
        'limit-up-pool pagination',
      );
      pages = pagination.pages;
      total = pagination.total;
      const rows = parseOrThrow(z.array(PoolRowSchema), envelope.data.item, 'limit-up-pool item');
      for (const row of rows) {
        if (!IN_COVERAGE.test(row.thscode)) continue;
        entries.push(toPoolEntry(row));
      }
      if (entries.length >= total) break;
    }
    return { total, entries, timestamp };
  }

  private async statistics(date: string): Promise<{
    readonly statistics: LimitUpMarketStatistics;
    readonly timestamp: Date | undefined;
  }> {
    const envelope = parseFuyaoDataEnvelope(
      await this.client.getRaw(LIMIT_UP_STATISTICS_PATH, { date }),
    );
    const raw = parseOrThrow(StatisticsSchema, envelope.data, 'limit-up-statistics');
    if (raw.trade_date !== date) {
      throw invalidPayloadError(
        `fuyao limit-up-statistics 信封日期错配: 返回 ${raw.trade_date}，请求 ${date}`,
      );
    }
    return {
      statistics: {
        tradeDate: raw.trade_date,
        sealRate: raw.seal_rate ?? null,
        openStockCount: raw.open_stock_count,
        limitUpStockCount: raw.limit_up_stock_count,
        touchedLimitUpStockCount: raw.touched_limit_up_stock_count,
        pageBoards: raw.page_boards.map((board) => ({
          level: board.board_level,
          stockCount: board.stock_count,
          promotionRate: board.promotion_rate ?? null,
        })),
        exactBoards: raw.exact_boards.map((board) => ({
          boardNum: board.board_num,
          stockCount: board.stock_count,
        })),
      },
      timestamp: envelope.timestamp,
    };
  }

  private async ladder(): Promise<{
    readonly ladder: LimitUpLadderWindow;
    readonly timestamp: Date | undefined;
  }> {
    const envelope = parseFuyaoDataEnvelope(await this.client.getRaw(LIMIT_UP_LADDER_PATH));
    const raw = parseOrThrow(LadderSchema, envelope.data, 'limit-up-ladder');
    const boardCaps = {
      two: 0,
      three: 0,
      four: 0,
      five: 0,
      six: 0,
      seven_plus: 0,
    } as Record<LimitUpLadderBand, number>;
    for (const [key, value] of Object.entries(raw.window.board_caps ?? {})) {
      const band = BAND_FROM_UPSTREAM[key];
      if (band === undefined) continue;
      boardCaps[band] = value;
    }
    return {
      ladder: {
        length: raw.window.length,
        dateList: raw.window.date_list.map(normalizeDate),
        boardCaps,
        days: raw.item.map(toLadderDay),
      },
      timestamp: envelope.timestamp,
    };
  }

  /**
   * 并发拉取三个端点；单端点失败只记录错误，不影响其它维度。
   *
   * 全部失败时仍返回成功结构（三个 null），由 manager 判定是否整体报错 —— 这样
   * manager 能区分「上游全挂」与「某一维缺数据」，不必在此处复制判定逻辑。
   */
  async fetchMarket(date: string): Promise<LimitUpMarketSections> {
    const [poolR, statisticsR, ladderR] = await Promise.allSettled([
      this.poolPages(date),
      this.statistics(date),
      this.ladder(),
    ]);

    const timestamps: Date[] = [];
    const pool = poolR.status === 'fulfilled' ? poolR.value : null;
    const statistics = statisticsR.status === 'fulfilled' ? statisticsR.value : null;
    const ladder = ladderR.status === 'fulfilled' ? ladderR.value : null;
    for (const section of [pool, statistics, ladder]) {
      if (section?.timestamp !== undefined) timestamps.push(section.timestamp);
    }
    const dataAsOf =
      timestamps.length === 0
        ? null
        : new Date(Math.max(...timestamps.map((timestamp) => timestamp.getTime())));

    return {
      date,
      pool: pool === null ? null : { total: pool.total, entries: pool.entries },
      poolError: poolR.status === 'rejected' ? messageOf(poolR.reason) : null,
      statistics: statistics?.statistics ?? null,
      statisticsError: statisticsR.status === 'rejected' ? messageOf(statisticsR.reason) : null,
      ladder: ladder?.ladder ?? null,
      ladderError: ladderR.status === 'rejected' ? messageOf(ladderR.reason) : null,
      dataAsOf,
    };
  }
}
