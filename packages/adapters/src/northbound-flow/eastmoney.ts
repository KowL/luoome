import { upstreamError } from '../source-error.js';
import type { NorthboundFlowRawEntry } from './types.js';

/**
 * Eastmoney 北向资金日级历史流协议层（主源）。
 *
 * 最终选用端点（真实请求冒烟验证 2026-08-22）：
 *   https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY
 * 参考项目用的 push2 kamt.rtmin / push2his kamt.kline 在 2024-08 交易所口径变更后
 * 只剩盘中分钟零值 / 常量字段，已无日级净流入，故弃用。
 *
 * 报表字段（MUTUAL_TYPE "001"=沪股通、"003"=深股通，每交易日每通道一行）：
 * - TRADE_DATE 交易日 / NET_DEAL_AMT 净买入 / BUY_AMT 买入 / SELL_AMT 卖出 / DEAL_AMT 成交总额
 * - 金额单位均为百万元，本模块统一 ×1e6 换算为元
 * - 2024-08-16 起交易所不再披露北向每日净买入：NET_DEAL_AMT/BUY_AMT/SELL_AMT 为 null
 *   （历史日期仍有值），DEAL_AMT 始终有值；本模块原样透传 null，不估算
 * 与 dragon-tiger/eastmoney.ts 同族（datacenter-web 报表系）。
 *
 * 本模块只保留 URL 模板与字段映射纯函数；HTTP 由 eastmoney/client.ts 承担，
 * 方法归属在 eastmoney/source.ts（docs/ddd/source-pluggability-and-observation-design.md §4.2）。
 */

const BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const REPORT_NAME = 'RPT_MUTUAL_DEAL_HISTORY';
const COLUMNS = 'MUTUAL_TYPE,TRADE_DATE,NET_DEAL_AMT,BUY_AMT,SELL_AMT,DEAL_AMT';
/** 沪股通 / 深股通（北向两个通道）。 */
export const NORTHBOUND_CHANNELS = ['001', '003'] as const;
export type NorthboundChannel = (typeof NORTHBOUND_CHANNELS)[number];
/** 上游金额单位：百万元 → 元。 */
const MILLION = 1_000_000;

/** 单通道分页 URL（按 TRADE_DATE 倒序取最近 days 行）。 */
export const northboundChannelUrl = (
  channel: NorthboundChannel,
  endDate: string,
  days: number,
): string => {
  const filter = encodeURIComponent(`(MUTUAL_TYPE="${channel}")(TRADE_DATE<='${endDate}')`);
  return (
    `${BASE_URL}?reportName=${REPORT_NAME}&columns=${COLUMNS}&source=WEB&CLIENT=WEB` +
    `&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=${days}&pageNumber=1&filter=${filter}`
  );
};

/** 单通道行级原始数据（金额已换算为元，date 为 YYYY-MM-DD）。 */
export interface NorthboundChannelRow {
  readonly date: string;
  readonly net: number | null;
  readonly buy: number | null;
  readonly sell: number | null;
  readonly deal: number;
}

/** 百万元 → 元；null / 非法值 → null（null = 未披露口径）。 */
const asAmountOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v * MILLION : null;

/**
 * 单通道报表响应 → 行级数据。
 * 报表层业务错误（success=false，列名错误等）抛 upstream_error；
 * 无数据（result=null）→ 空数组，不抛错；缺日期 / 缺成交额的行剔除。
 */
export const parseNorthboundChannel = (raw: unknown): NorthboundChannelRow[] => {
  const body = raw as Record<string, unknown>;
  if (body.success === false) {
    throw upstreamError(`eastmoney northbound-flow 报表错误: ${String(body.message)}`);
  }
  const result = body.result as Record<string, unknown> | null | undefined;
  const rows = Array.isArray(result?.data) ? (result.data as unknown[]) : [];

  const out: NorthboundChannelRow[] = [];
  for (const item of rows) {
    const obj = item as Record<string, unknown>;
    const date = typeof obj.TRADE_DATE === 'string' ? obj.TRADE_DATE.slice(0, 10) : undefined;
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const deal = asAmountOrNull(obj.DEAL_AMT);
    if (deal === null) continue;
    out.push({
      date,
      net: asAmountOrNull(obj.NET_DEAL_AMT),
      buy: asAmountOrNull(obj.BUY_AMT),
      sell: asAmountOrNull(obj.SELL_AMT),
      deal,
    });
  }
  return out;
};

/** 沪 / 深通道行按日期合并（金额求和，date ASC），截断到最近 days 个交易日。 */
export const mergeNorthboundChannels = (
  rows: readonly NorthboundChannelRow[],
  days: number,
): NorthboundFlowRawEntry[] => {
  const byDate = new Map<string, { net: number[]; buy: number[]; sell: number[]; deal: number }>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? { net: [], buy: [], sell: [], deal: 0 };
    if (row.net !== null) bucket.net.push(row.net);
    if (row.buy !== null) bucket.buy.push(row.buy);
    if (row.sell !== null) bucket.sell.push(row.sell);
    bucket.deal += row.deal;
    byDate.set(row.date, bucket);
  }

  const sum = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);

  return [...byDate.entries()]
    .map(([date, b]) => ({
      date,
      net_amount: sum(b.net),
      buy_amount: sum(b.buy),
      sell_amount: sum(b.sell),
      deal_amount: b.deal,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-days);
};
