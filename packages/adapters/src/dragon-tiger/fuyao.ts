import type { DragonTigerFlowDay, DragonTigerFlowRangeDays } from '@luoome/core';
import { z } from 'zod';

import type { FuyaoEnvelopeData } from '../fuyao/envelope.js';
import { invalidPayloadError } from '../source-error.js';

/**
 * 同花顺（fuyao）龙虎榜跨交易日取数源。
 *
 * 只服务「资金流向拓扑」：按交易日拉全榜（board_type=all），上游同一行同时带
 * concept_list / org_net_value / hot_money_net_value，因此全部 / 机构 / 游资三种口径
 * 由一次请求覆盖，不需要按 board_type 重复拉三遍。
 *
 * 语义要点：
 * - range_days 必须过滤：1 日榜与 3 日榜是不同统计窗口，混用会把同一笔资金算两次；
 * - 同一股票同区间只保留一行（上游同一股票可能同时出现在 1 日榜与 3 日榜）；
 * - 日期以 data.trade_date 为准，req 与 resp 不一致时按 invalid_payload 拒绝，
 *   避免把错日数据挂到别的交易日上。
 */

export const DRAGON_TIGER_BOARD_PATH = '/api/a-share/special-data/dragon-tiger-list';
export const TRADING_DAYS_PATH = '/api/a-share/calendar/trading-days';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

const BoardPayloadSchema = z.object({
  trade_date: dateString,
  stock_items: z.array(z.record(z.string(), z.unknown())).nullish(),
});

const BoardItemSchema = z.object({
  thscode: z.string().nullish(),
  ticker: z.string().nullish(),
  name: z.string().nullish(),
  change: z.number().nullish(),
  concept_list: z.array(z.object({ name: z.string().nullish() })).nullish(),
  net_value: z.number().nullish(),
  buy_value: z.number().nullish(),
  sell_value: z.number().nullish(),
  amount: z.number().nullish(),
  range_days: z.number().nullish(),
  org_net_value: z.number().nullish(),
  hot_money_net_value: z.number().nullish(),
});

const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidPayloadError(`fuyao ${label} 解析失败（${parsed.error.message}）`, parsed.error);
  }
  return parsed.data;
};

/** `data.stock_items[]` 一行 → 概念聚合输入；无法判定代码 / 区间不符的行返回 undefined。 */
const mapBoardItem = (
  raw: Record<string, unknown>,
  rangeDays: DragonTigerFlowRangeDays,
): DragonTigerFlowDay['stocks'][number] | undefined => {
  const item = parseOrThrow(BoardItemSchema, raw, 'dragon-tiger stock_items');
  if ((item.range_days ?? rangeDays) !== rangeDays) return undefined;
  const ticker = item.ticker?.trim();
  const fromThscode = item.thscode?.split('.')[0];
  const code = ticker !== undefined && ticker.length > 0 ? ticker : fromThscode;
  if (code === undefined || !/^\d{6}$/.test(code)) return undefined;
  const concepts: string[] = [];
  for (const concept of item.concept_list ?? []) {
    const name = concept.name?.trim();
    if (name === undefined || name.length === 0 || concepts.includes(name)) continue;
    concepts.push(name);
  }
  return {
    code,
    name: item.name?.trim() || code,
    changePct: item.change ?? 0,
    netAmount: item.net_value ?? 0,
    orgNetAmount: item.org_net_value ?? 0,
    hotNetAmount: item.hot_money_net_value ?? 0,
    buyAmount: item.buy_value ?? 0,
    sellAmount: item.sell_value ?? 0,
    amount: item.amount ?? 0,
    concepts,
  };
};

/**
 * 龙虎榜 board 信封 → 单个交易日证据。
 * 上游 trade_date 与请求日不一致 → invalid_payload（不静默改挂）。
 */
export const parseDragonTigerBoardPayload = (
  envelope: FuyaoEnvelopeData,
  expectedDate: string,
  rangeDays: DragonTigerFlowRangeDays,
): DragonTigerFlowDay => {
  const payload = parseOrThrow(BoardPayloadSchema, envelope.data, 'dragon-tiger board');
  if (payload.trade_date !== expectedDate) {
    throw invalidPayloadError(
      `fuyao dragon-tiger 日期错配: 返回 ${payload.trade_date}，请求 ${expectedDate}`,
    );
  }
  const stocks: DragonTigerFlowDay['stocks'] = [];
  const seen = new Set<string>();
  for (const row of payload.stock_items ?? []) {
    const stock = mapBoardItem(row, rangeDays);
    if (stock === undefined || seen.has(stock.code)) continue;
    seen.add(stock.code);
    stocks.push(stock);
  }
  return { date: payload.trade_date, stocks };
};

/** 交易日历信封 → 升序 `YYYY-MM-DD`（上游 date 为 `YYYYMMDD`）。 */
export const parseTradingDaysPayload = (envelope: FuyaoEnvelopeData): string[] => {
  const dates: string[] = [];
  for (const row of envelope.items) {
    const value = typeof row.date === 'string' ? row.date : '';
    if (!/^\d{8}$/.test(value)) continue;
    dates.push(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
  }
  return dates.sort();
};

/** 源的最小能力面（测试注入 fake client 用）。 */
export interface FuyaoDragonTigerClientLike {
  get(path: string, params: Readonly<Record<string, string | number>>): Promise<FuyaoEnvelopeData>;
}

export interface FuyaoDragonTigerFlowSourceOptions {
  readonly client: FuyaoDragonTigerClientLike;
}

export class FuyaoDragonTigerFlowSource {
  readonly name = 'fuyao';
  private readonly client: FuyaoDragonTigerClientLike;

  constructor(options: FuyaoDragonTigerFlowSourceOptions) {
    this.client = options.client;
  }

  /** 闭区间交易日（升序）。 */
  async fetchTradingDays(startDate: string, endDate: string): Promise<string[]> {
    const envelope = await this.client.get(TRADING_DAYS_PATH, {
      start_date: startDate.replaceAll('-', ''),
      end_date: endDate.replaceAll('-', ''),
    });
    return parseTradingDaysPayload(envelope);
  }

  /** 单交易日全榜（rangeDays 过滤后）。 */
  async fetchBoard(date: string, rangeDays: DragonTigerFlowRangeDays): Promise<DragonTigerFlowDay> {
    const envelope = await this.client.get(DRAGON_TIGER_BOARD_PATH, { board_type: 'all', date });
    return parseDragonTigerBoardPayload(envelope, date, rangeDays);
  }
}

/** 生产环境构造：client 由 assembly factory 注入（adapter 不读 process.env）。 */
