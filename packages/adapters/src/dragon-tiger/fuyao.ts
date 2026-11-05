import { ZodError, z } from 'zod';
import type { FuyaoClient } from '../fuyao/client.js';
import { invalidPayloadError } from '../source-error.js';
import type { DragonTigerFetchResult, DragonTigerRawEntry } from './types.js';

/**
 * Fuyao 龙虎榜（GET /api/a-share/special-data/dragon-tiger-list）协议层。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §8；
 * 取证：docs/ddd/fuyao-phase0-special-evidence.md §3（2026-11-03 真实 Key）。
 *
 * 实测契约（Phase 0 fixture dragon-tiger-list.{all,org,hot-money}.json）：
 * - 信封 data 形状：{ timestamp, board_type, trade_date, count, stock_count, stock_items[], hot_money_items[] }；
 *   无分页（count ≤ 数百，单页取全）。
 * - board_type：all（全部）/ org（机构）/ hot_money（游资）；本 adapter 固定 all（与 Eastmoney 主榜口径对齐）。
 * - trade_date 是业务日期（YYYY-MM-DD）；与请求日期不一致 → invalid_payload（binding 边界校验）。
 * - stock_items[] 字段：thscode（可 null，退市股）、ticker、name、change（小数，0.100111 = 10.01%）、
 *   concept_list[{name}]、net_value（净买入元）、net_rate、hot_rank、buy_value、sell_value、
 *   limit_reason（可缺）、range_days（1=当日榜、3=三日榜）、org_net_value / hot_money_net_value（可缺）。
 * - hot_money_items[]：hot_money_name + 相同 stock 行（游资榜专用；all 榜为空数组）。
 * - 契约不提供收盘价与换手率：close / turnover_rate 保持缺省，由 manager 加
 *   close-unavailable / turnover-rate-unavailable warning；不用 0 或 change 反推。
 * - change 已是小数（0.100111），不做 /100 换算（与 limit-up-pool 的 price_change_ratio_pct 不同口径）。
 * - data.timestamp 是数据就绪时间（毫秒戳），不是交易日零点；observedAt 按交易日收盘口径归一。
 * - 1 年窗口（上游文档）；更早日期上游返回 1002/1003 → 结构化错误（不静默吞）。
 */

const PATH = '/api/a-share/special-data/dragon-tiger-list';

const StockItemSchema = z.object({
  thscode: z.string().nullish(),
  ticker: z.string().min(1),
  name: z.string().nullish(),
  change: z.number().nullish(),
  net_value: z.number().nullish(),
  buy_value: z.number().nullish(),
  sell_value: z.number().nullish(),
  limit_reason: z.string().nullish(),
  range_days: z.number().int().nullish(),
});

const DataSchema = z.object({
  timestamp: z.number().nullish(),
  board_type: z.string().nullish(),
  trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().nonnegative().nullish(),
  stock_count: z.number().int().nonnegative().nullish(),
  stock_items: z.array(StockItemSchema).nullish(),
  hot_money_items: z.array(z.record(z.string(), z.unknown())).nullish(),
});

/** 历史日为该交易日收盘时刻（15:00 +08:00），当日为 min(fetchedAt, closeAt)（§6.2）。 */
const tradingDayObservedAt = (date: string, fetchedAt: Date): Date => {
  const closeAt = new Date(`${date}T15:00:00+08:00`);
  return closeAt.getTime() <= fetchedAt.getTime() ? closeAt : fetchedAt;
};

/** YYYY-MM-DD（Asia/Shanghai）→ 上海零点毫秒戳（上游 date_ms 参数口径）。 */
const dateToShanghaiMidnightMs = (date: string): number =>
  new Date(`${date}T00:00:00+08:00`).getTime();

/** thscode 可空（退市股）；空时回退 ticker。ticker 必须 6 位数字，否则剔除该行。 */
const codeOf = (item: z.infer<typeof StockItemSchema>): string | undefined => {
  const ticker = item.ticker.trim();
  if (!/^\d{6}$/.test(ticker)) return undefined;
  return ticker;
};

const mapStockItem = (item: z.infer<typeof StockItemSchema>): DragonTigerRawEntry | undefined => {
  const code = codeOf(item);
  if (code === undefined) return undefined;
  const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : undefined;
  return {
    code,
    ...(name === undefined ? {} : { name }),
    // close / turnover_rate 缺省保持缺省；change 已是小数口径，直接透传。
    ...(item.change == null ? {} : { change_pct: item.change }),
    ...(item.net_value == null ? {} : { net_amount: item.net_value }),
    ...(item.buy_value == null ? {} : { buy_amount: item.buy_value }),
    ...(item.sell_value == null ? {} : { sell_amount: item.sell_value }),
    ...(item.limit_reason == null || item.limit_reason.trim().length === 0
      ? {}
      : { reason: item.limit_reason }),
    ...(item.range_days == null || item.range_days < 1 ? {} : { range_days: item.range_days }),
  };
};

export interface FuyaoDragonTigerSourceOptions {
  readonly client: FuyaoClient;
  readonly clock?: () => Date;
}

/**
 * Fuyao 龙虎榜源（DragonTigerAdapterLike 结构实现）。
 *
 * 错误模型：信封错误（2001/2003 权限、4001 限流、1002/1003 参数）由 FuyaoClient 抛
 * 结构化 SourceExecutionError；Zod 形状不符 → invalid_payload。不做池级 ok:false 吞错
 * （与 Eastmoney dragon-tiger 一致，由 manager 按 handle 循环 fallback）。
 */
export class FuyaoDragonTigerSource {
  readonly name = 'fuyao' as const;

  private readonly client: FuyaoClient;
  private readonly clock: () => Date;

  constructor(options: FuyaoDragonTigerSourceOptions) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
  }

  async fetchList(date: string): Promise<DragonTigerFetchResult> {
    const { data } = await this.client.getData(PATH, {
      board_type: 'all',
      date_ms: dateToShanghaiMidnightMs(date),
    });
    let parsed: z.infer<typeof DataSchema>;
    try {
      parsed = DataSchema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        throw invalidPayloadError(
          `fuyao dragon-tiger parse: data 形状不符（${error.message}）`,
          error,
        );
      }
      throw error;
    }
    // 信封业务日期与请求日期不一致 → invalid_payload（错日不静默当当日榜）。
    if (parsed.trade_date !== date) {
      throw invalidPayloadError(
        `fuyao dragon-tiger 信封日期错配: 返回 ${parsed.trade_date}，请求 ${date}`,
      );
    }
    const fetchedAt = this.clock();
    const entries = (parsed.stock_items ?? [])
      .map(mapStockItem)
      .filter((entry): entry is DragonTigerRawEntry => entry !== undefined);
    return {
      date,
      observedAt: tradingDayObservedAt(date, fetchedAt),
      entries,
    };
  }
}
