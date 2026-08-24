import { asAmount, asRatio, asString } from '../eastmoney/coercion.js';
import type { DragonTigerRawEntry, DragonTigerRawSeat } from './types.js';

/**
 * Eastmoney 龙虎榜（RPT_DAILYBILLBOARD_DETAILS）协议层（主源）。
 *
 * 数据中心公开报表 API 无鉴权；按 TRADE_DATE 过滤当日上榜条目：
 * - SECURITY_CODE 代码 / SECURITY_NAME_ABBR 名称 / CLOSE_PRICE 收盘价
 * - CHANGE_RATE 涨跌幅（百分数）/ TURNOVERRATE 换手率（百分数）
 * - EXPLANATION 上榜原因（EXPLAIN 为机构席位摘要，作次选）
 * - BILLBOARD_NET_AMT 龙虎榜净额 / BILLBOARD_BUY_AMT 买入 / BILLBOARD_SELL_AMT 卖出
 * - ACCUM_AMOUNT 当日总成交额
 * 与 market/eastmoney.ts 不同族（datacenter-web 报表系，非 push2 行情系）。
 *
 * 本模块只保留 URL 模板与字段映射纯函数；HTTP 由 eastmoney/client.ts 承担，
 * 方法归属在 eastmoney/source.ts（docs/ddd/source-pluggability-and-observation-design.md §4.2）。
 */

const BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const REPORT_NAME = 'RPT_DAILYBILLBOARD_DETAILS';
const BUY_SEAT_REPORT_NAME = 'RPT_BILLBOARD_DAILYDETAILSBUY';
const SELL_SEAT_REPORT_NAME = 'RPT_BILLBOARD_DAILYDETAILSSELL';
/** 单日上榜条目约几十至一百余条；500 足以单页取全。 */
const PAGE_SIZE = 500;

/** 龙虎榜报表 URL（按 TRADE_DATE 过滤，净额降序）。 */
export const dragonTigerListUrl = (date: string): string => {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  return (
    `${BASE_URL}?reportName=${REPORT_NAME}&columns=ALL&source=WEB&CLIENT=WEB` +
    `&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&pageSize=${PAGE_SIZE}&pageNumber=1` +
    `&filter=${filter}`
  );
};

/** 龙虎榜买入 / 卖出营业部席位报表 URL。 */
export const dragonTigerSeatUrl = (date: string, side: 'buy' | 'sell'): string => {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const reportName = side === 'buy' ? BUY_SEAT_REPORT_NAME : SELL_SEAT_REPORT_NAME;
  const sortColumn = side === 'buy' ? 'BUY' : 'SELL';
  return (
    `${BASE_URL}?reportName=${reportName}&columns=ALL&source=WEB&CLIENT=WEB` +
    `&sortColumns=${sortColumn}&sortTypes=-1&pageSize=5000&pageNumber=1&filter=${filter}`
  );
};

const asIdentifier = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
};

/**
 * 龙虎榜报表响应 → 原始条目。非交易日 / 无数据（result 为 null 或 data 缺失）→ 空数组；
 * 缺代码 / 代码非 6 位 / 收盘价非法的条目剔除。
 */
export const parseDragonTigerReport = (raw: unknown): DragonTigerRawEntry[] => {
  const result = (raw as Record<string, unknown>).result as
    | Record<string, unknown>
    | null
    | undefined;
  const rows = Array.isArray(result?.data) ? (result.data as unknown[]) : [];

  const entries: DragonTigerRawEntry[] = [];
  for (const item of rows) {
    const obj = item as Record<string, unknown>;
    const code = asString(obj.SECURITY_CODE);
    if (code === undefined || !/^\d{6}$/.test(code)) continue;
    const close = asAmount(obj.CLOSE_PRICE);
    if (close === undefined || close <= 0) continue;
    const tradeDate = typeof obj.TRADE_DATE === 'string' ? obj.TRADE_DATE.slice(0, 10) : undefined;
    const name = asString(obj.SECURITY_NAME_ABBR);
    const changePct = asRatio(obj.CHANGE_RATE);
    const turnoverRate = asRatio(obj.TURNOVERRATE);
    const reason = asString(obj.EXPLANATION) ?? asString(obj.EXPLAIN);
    const netAmount = asAmount(obj.BILLBOARD_NET_AMT);
    const buyAmount = asAmount(obj.BILLBOARD_BUY_AMT);
    const sellAmount = asAmount(obj.BILLBOARD_SELL_AMT);
    const amount = asAmount(obj.ACCUM_AMOUNT);
    const tradeId = asIdentifier(obj.TRADE_ID);
    entries.push({
      code,
      ...(name === undefined ? {} : { name }),
      close,
      ...(changePct === undefined ? {} : { change_pct: changePct }),
      ...(turnoverRate === undefined ? {} : { turnover_rate: turnoverRate }),
      ...(reason === undefined ? {} : { reason }),
      ...(netAmount === undefined ? {} : { net_amount: netAmount }),
      ...(buyAmount === undefined ? {} : { buy_amount: buyAmount }),
      ...(sellAmount === undefined ? {} : { sell_amount: sellAmount }),
      ...(amount === undefined ? {} : { amount }),
      ...(tradeId === undefined ? {} : { trade_id: tradeId }),
      ...(tradeDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
        ? {}
        : { trade_date: tradeDate }),
    });
  }
  return entries;
};

/** 解析买入 / 卖出营业部席位报表。 */
export const parseDragonTigerSeatReport = (
  raw: unknown,
  side: 'buy' | 'sell',
): DragonTigerRawSeat[] => {
  const result = (raw as Record<string, unknown>).result as
    | Record<string, unknown>
    | null
    | undefined;
  const rows = Array.isArray(result?.data) ? (result.data as unknown[]) : [];
  const seats: DragonTigerRawSeat[] = [];
  for (const item of rows) {
    const obj = item as Record<string, unknown>;
    const code = asString(obj.SECURITY_CODE);
    const name = asString(obj.OPERATEDEPT_NAME);
    const amount = asAmount(side === 'buy' ? obj.BUY : obj.SELL);
    if (code === undefined || !/^\d{6}$/.test(code) || name === undefined || amount === undefined) {
      continue;
    }
    const tradeId = asIdentifier(obj.TRADE_ID);
    const reason = asString(obj.EXPLANATION);
    seats.push({
      code,
      ...(tradeId === undefined ? {} : { trade_id: tradeId }),
      ...(reason === undefined ? {} : { reason }),
      name,
      amount,
    });
  }
  return seats;
};

const entryKey = (entry: {
  readonly code: string;
  readonly trade_id?: string | undefined;
  readonly reason?: string | undefined;
}): string => `${entry.trade_id ?? ''}|${entry.code}|${entry.reason ?? ''}`;

/** 将席位明细按股票 / 上榜原因 / 交易 ID 关联回主榜单。 */
export const attachDragonTigerSeats = (
  entries: DragonTigerRawEntry[],
  buySeats: DragonTigerRawSeat[],
  sellSeats: DragonTigerRawSeat[],
): DragonTigerRawEntry[] => {
  const buyByKey = new Map<string, DragonTigerRawSeat[]>();
  const sellByKey = new Map<string, DragonTigerRawSeat[]>();
  for (const seat of buySeats) {
    const list = buyByKey.get(entryKey(seat)) ?? [];
    list.push(seat);
    buyByKey.set(entryKey(seat), list);
  }
  for (const seat of sellSeats) {
    const list = sellByKey.get(entryKey(seat)) ?? [];
    list.push(seat);
    sellByKey.set(entryKey(seat), list);
  }
  return entries.map((entry) => {
    const buy = buyByKey.get(entryKey(entry)) ?? [];
    const sell = sellByKey.get(entryKey(entry)) ?? [];
    return {
      ...entry,
      ...(buy.length === 0 ? {} : { buy_seats: buy }),
      ...(sell.length === 0 ? {} : { sell_seats: sell }),
    };
  });
};
