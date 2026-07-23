import type {
  DailyBar,
  DateRange,
  MarketDataAdapterLike,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';

/**
 * 行情数据源接口（ARCHITECTURE §4.7）。
 * 继承 core 的 MarketDataAdapterLike 投影，保持结构兼容：
 * ToolContext.adapters.market 可直接接受本接口实现。
 */
export interface MarketDataAdapter extends MarketDataAdapterLike {
  /** 数据源名（如 'eastmoney' / 'tencent'）。 */
  readonly name: string;
  /** 拉单只股票实时行情（stockCode 可为 Stock.id 或 Stock.code）。 */
  fetchQuote(stockCode: string): Promise<Quote>;
  /** 批量拉行情，key 为入参原样代码。 */
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  /** 拉取指定区间日线。 */
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  /** 外部股票搜索（v0.8 起；Manager 路由到实现了该方法的源）。 */
  searchStocks?(query: string): Promise<StockSearchCandidate[]>;
}
