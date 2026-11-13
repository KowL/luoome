import type { LimitUpBoardAdapterLike, LimitUpBoardPoolResult } from '@luoome/core';
import { z } from 'zod';
import type { FuyaoClient } from './client.js';
import { parseFuyaoDataEnvelope } from './envelope.js';

/**
 * fuyao 涨跌停 / 炸板池（https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/）。
 *
 * 只读取池成员关系与上游给出的连板计数，不在这里推导收益、行业或复权价格。
 * `date_ms` 是 Asia/Shanghai 当日零点毫秒戳；分页按 `data.pagination.pages` 拉全。
 */

const THSCODE = /^\d{6}\.(SH|SZ|BJ)$/;
/** 覆盖范围固定沪深；北交所成员丢弃，不让 .BJ 行污染 SH/SZ 事实。 */
const IN_COVERAGE = /^\d{6}\.(SH|SZ)$/;
const MAX_PAGES = 20;
const PAGE_SIZE = 200;

const LimitUpRowSchema = z
  .object({
    thscode: z.string().regex(THSCODE),
    ticker: z.string().optional(),
    name: z.string().optional(),
    is_st: z.boolean().optional(),
    continue_day_cnt: z.number().int().min(1).max(50).optional(),
    open_times: z.number().int().nonnegative().nullable().optional(),
    limit_up_time: z.string().optional(),
  })
  .passthrough();

const BreakRowSchema = z
  .object({
    thscode: z.string().regex(THSCODE),
    ticker: z.string().optional(),
    name: z.string().optional(),
    open_times: z.number().int().nonnegative().optional(),
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

const shanghaiMidnightMs = (date: string): number => {
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(ms)) throw new Error(`无效交易日：${date}`);
  return ms;
};

interface Page<T> {
  readonly items: T[];
  readonly timestamp: Date | undefined;
}

export class FuyaoLimitUpAdapter implements LimitUpBoardAdapterLike {
  readonly name = 'fuyao-limit-up';

  constructor(
    private readonly client: FuyaoClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async fetchPages<T>(
    path: string,
    date: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<Page<T>> {
    const items: T[] = [];
    let timestamp: Date | undefined;
    let pages = 1;
    for (let page = 1; page <= Math.min(pages, MAX_PAGES); page += 1) {
      const raw = await this.client.getRaw(path, {
        date_ms: shanghaiMidnightMs(date),
        page,
        size: PAGE_SIZE,
      });
      const envelope = parseFuyaoDataEnvelope(raw);
      timestamp ??= envelope.timestamp;
      const parsed = PaginationSchema.safeParse(envelope.data.pagination);
      if (!parsed.success) {
        throw new Error(`fuyao ${label}: pagination 形状不符（${parsed.error.message}）`);
      }
      pages = parsed.data.pages;
      const rows = z.array(z.unknown()).safeParse(envelope.data.item);
      if (!rows.success) {
        throw new Error(`fuyao ${label}: data.item 不是数组（${rows.error.message}）`);
      }
      for (const row of rows.data) {
        const item = schema.safeParse(row);
        if (!item.success) {
          throw new Error(`fuyao ${label}: 行形状不符（${item.error.message}）`);
        }
        items.push(item.data);
      }
      if (items.length >= parsed.data.total) break;
    }
    return { items, timestamp };
  }

  async fetchLimitUpPool(date: string): Promise<LimitUpBoardPoolResult> {
    const fetchedAt = this.clock();
    const page = await this.fetchPages(
      '/api/a-share/special-data/limit-up-pool',
      date,
      LimitUpRowSchema,
      'limit-up-pool',
    );
    return {
      date,
      rows: page.items
        .filter((row) => IN_COVERAGE.test(row.thscode))
        .map((row) => ({
          stockId: row.thscode,
          ...(row.continue_day_cnt === undefined ? {} : { continueDayCnt: row.continue_day_cnt }),
        })),
      publishedAt: page.timestamp ?? fetchedAt,
      fetchedAt,
    };
  }

  async fetchLimitBreakPool(date: string): Promise<{
    readonly stockIds: readonly string[];
    readonly publishedAt: Date;
    readonly fetchedAt: Date;
  }> {
    const fetchedAt = this.clock();
    const page = await this.fetchPages(
      '/api/a-share/special-data/limit-break-pool',
      date,
      BreakRowSchema,
      'limit-break-pool',
    );
    return {
      stockIds: page.items.map((row) => row.thscode).filter((code) => IN_COVERAGE.test(code)),
      publishedAt: page.timestamp ?? fetchedAt,
      fetchedAt,
    };
  }
}
