import type { DailyBar, DateRange, MarketDataAdapterLike, Quote } from '@luoome/core';

/**
 * 行情数据源接口（ARCHITECTURE §4.7）。
 * 继承 core 的 MarketDataAdapterLike 投影，保持结构兼容：
 * ToolContext.adapters.market 可直接接受本接口实现。
 */
export interface MarketDataAdapter extends MarketDataAdapterLike {
  /** 数据源名（如 'mock' / 'eastmoney'）。 */
  readonly name: string;
  /** 拉单只股票实时行情（stockCode 可为 Stock.id 或 Stock.code）。 */
  fetchQuote(stockCode: string): Promise<Quote>;
  /** 批量拉行情，key 为入参原样代码。 */
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  /** 拉日线（v0.1 mock 固定返回 60 根）。 */
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
}
