// @luoome/adapters 生产入口：只导出真实行情、真实 LLM 与通知适配器。
// LLM

export * from './ashare-sentiment/eastmoney.js';
export * from './ashare-sentiment/factory.js';
export * from './ashare-sentiment/manager.js';
export * from './ashare-sentiment/types.js';
export * from './audit/file.js';
// 基本面 PIT mock（仅显式测试注入，永不自动装配）
export * from './fundamental/factory.js';
export * from './fundamental/mock.js';
export * from './limit-up-ladder/eastmoney.js';
export * from './limit-up-ladder/factory.js';
export * from './limit-up-ladder/manager.js';
// 连板天梯（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md）
export * from './limit-up-ladder/types.js';
export * from './llm/agent-runtime.js';
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
export * from './market/sina.js';
export * from './market/source-registry.js';
export * from './market/tencent.js';
export * from './market/tushare.js';
export * from './market/types.js';
// 通知（v0.3 起）
export * from './notification/index.js';
export * from './research-embedding/index.js';
export * from './research-vault/index.js';
// 股票目录
export * from './stock-universe/eastmoney.js';
export * from './stock-universe/factory.js';
export * from './stock-universe/manager.js';
export * from './stock-universe/sina.js';
export * from './stock-universe/tushare.js';
// tushare 官方 HTTP API 客户端
export * from './tushare/client.js';
export * from './tushare/envelope.js';
