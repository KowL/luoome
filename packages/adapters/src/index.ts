// @luoome/adapters 生产入口：只导出真实行情、真实 LLM 与通知适配器。
// LLM

export * from './ashare-sentiment/eastmoney.js';
export * from './ashare-sentiment/factory.js';
export * from './ashare-sentiment/manager.js';
export * from './ashare-sentiment/types.js';
export * from './audit/file.js';
// 龙虎榜（东方财富数据中心公开报表）
export * from './dragon-tiger/eastmoney.js';
export * from './dragon-tiger/factory.js';
// 龙虎榜资金流向拓扑（同花顺龙虎榜：概念 / 机构 / 游资字段）
export * from './dragon-tiger/flow-factory.js';
export * from './dragon-tiger/flow-manager.js';
export * from './dragon-tiger/fuyao.js';
export * from './dragon-tiger/manager.js';
export * from './dragon-tiger/types.js';
// Eastmoney 单一 source（HTTP 管道 + coercion + 全能力委托）
export * from './eastmoney/client.js';
export * from './eastmoney/coercion.js';
export * from './eastmoney/source.js';
// 基本面 PIT mock（仅显式测试注入，永不自动装配）
// fuyao（同花顺金融数据 API）行情源
export * from './fuyao/client.js';
export * from './fuyao/envelope.js';
export * from './fuyao/limit-up.js';
export * from './fuyao/limit-up-market.js';
export * from './fuyao/market-dump.js';
export * from './fuyao/source.js';
// 全市场 Parquet dump（日 K / 复权因子）
export * from './limit-up/factory.js';
export * from './limit-up-ladder/eastmoney.js';
export * from './limit-up-ladder/factory.js';
export * from './limit-up-ladder/manager.js';
// 连板天梯（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md）
export * from './limit-up-ladder/types.js';
// 涨停市场看板（涨停池 + 涨停统计 + 近 30 日连板矩阵，同花顺）
export * from './limit-up-market/factory.js';
export * from './limit-up-market/manager.js';
export * from './llm/ai-sdk-adapter.js';
export * from './llm/manager.js';
export * from './llm/model-catalog.js';
export * from './llm/provider-quirks.js';
export * from './llm/schema.js';
export * from './llm/stack.js';
export * from './llm/types.js';
// 行情
export * from './market/cache.js';
export * from './market/eastmoney.js';
export * from './market/factory.js';
export * from './market/manager.js';
export * from './market/manifest.js';
export * from './market/request-coordinator.js';
export * from './market/sina.js';
export * from './market/source-registry.js';
export * from './market/tencent.js';
export * from './market/tushare.js';
export * from './market/types.js';
export * from './market-dump/factory.js';
export * from './market-dump/parquet.js';
export * from './mcp/client.js';
export * from './news/10jqka.js';
// 财经要闻（东方财富公开新闻 API）
export * from './news/eastmoney.js';
export * from './news/factory.js';
export * from './news/manager.js';
export * from './news/types.js';
// 北向资金历史流（东方财富数据中心公开报表）
export * from './northbound-flow/eastmoney.js';
export * from './northbound-flow/factory.js';
export * from './northbound-flow/manager.js';
export * from './northbound-flow/types.js';
// 通知（v0.3 起）
export * from './notification/index.js';
export * from './research-vault/index.js';
// 行业 / 概念目录与成分（扶摇同花顺指数目录）
export * from './sector-catalog/factory.js';
// 行业板块行情（东方财富 push2 板块列表公开 API）
export * from './sector-quote/eastmoney.js';
export * from './sector-quote/factory.js';
export * from './sector-quote/manager.js';
export * from './sector-quote/types.js';
// 数据源可插拔与统一观测（泛型核心 + 结构化错误）
export * from './source-error.js';
export * from './source-registry.js';
// 股票目录
export * from './stock-universe/eastmoney.js';
export * from './stock-universe/factory.js';
export * from './stock-universe/manager.js';
export * from './stock-universe/sina.js';
export * from './stock-universe/tushare.js';
// tushare 官方 HTTP API 客户端
export * from './tushare/client.js';
export * from './tushare/envelope.js';
