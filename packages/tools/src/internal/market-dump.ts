import type { MarketDumpManagerLike, ToolContext } from '@luoome/core';

/**
 * market-dump tool 内部助手（设计 §5.1 / §5.5）。
 *
 * ToolContext.marketDump 是 core 顶层可选端口；本助手只做取值，
 * tools 层不重复实现「未装配」断言（各 tool 自行转译 ToolError）。
 */

/** MarketDumpManager 的 tool 侧投影（core `MarketDumpManagerLike` 别名）。 */
export type MarketDumpManagerPort = MarketDumpManagerLike;

/** 从 ToolContext 取 market-dump manager 端口；未装配时返回 undefined。 */
export const marketDumpManagerOf = (ctx: ToolContext): MarketDumpManagerPort | undefined =>
  ctx.marketDump;
