/**
 * Test-only deterministic fixtures and fakes.
 *
 * This subpath is intentionally separate from the production package entry.
 */

// MarketDataManager 的 stub 源装配（probe / 路由类集成测试用）
export * from '../market/manager.test-helper.js';
export * from './deterministic.js';
export * from './fake-llm.js';
export * from './fake-market.js';
export * from './fixtures.js';
