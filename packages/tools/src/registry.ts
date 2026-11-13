import { z } from 'zod';

import type { Tool } from './define-tool.js';
import { addTradeTool } from './tools/add-trade.js';
import { analyzePositionTool } from './tools/analyze-position.js';
import { analyzeStockTool } from './tools/analyze-stock.js';
import { computeIndicatorsTool } from './tools/compute-indicators.js';
import { saveDecisionReviewTool } from './tools/decision-review.js';
import { dragonTigerListTool } from './tools/dragon-tiger.js';
import { dragonTigerFlowTool } from './tools/dragon-tiger-flow.js';
import { fetchIndexQuotesTool } from './tools/fetch-index-quotes.js';
import { fetchQuoteTool } from './tools/fetch-quote.js';
import { getAccountOverviewTool } from './tools/get-account-overview.js';
import { getAdviceTool } from './tools/get-advice.js';
import { getStockMarketViewTool } from './tools/get-stock-market-view.js';
import { getStrategySignalsTool } from './tools/get-strategy-signals.js';
import { limitUpLadderTool } from './tools/limit-up-ladder.js';
import { listTradesTool } from './tools/list-trades.js';
import { listWatchPlansTool } from './tools/list-watch-plans.js';
import { getMarketRoomOverviewTool } from './tools/market-room-overview.js';
import { getMarketRoomSectorsTool } from './tools/market-room-sectors.js';
import {
  collectMarketSnapshotTool,
  getMarketSnapshotBatchTool,
} from './tools/market-snapshot-batch.js';
import { fetchNewsTool } from './tools/news.js';
import { northboundFlowTool } from './tools/northbound-flow.js';
import { getAccountPerformanceTool } from './tools/portfolio-performance.js';
import { searchResearchDocumentsTool } from './tools/research-vault.js';
import { runStrategyTool } from './tools/run-strategy.js';
import { runStrategyBacktestTool } from './tools/run-strategy-backtest.js';
import { saveAlertPlanTool } from './tools/save-alert-plan.js';
import { saveResearchDocumentTool } from './tools/save-research-document.js';
import { saveStrategyVersionTool } from './tools/save-strategy-version.js';
import { searchStocksTool } from './tools/search-stocks.js';
import { fetchSectorQuotesTool } from './tools/sector-quote.js';
import { getStrategyTool, listStrategiesTool } from './tools/strategy-lifecycle.js';
import { saveTradingPlanTool } from './tools/trading-plan.js';
import { updateHoldingTool } from './tools/update-holding.js';
import { updateWatchlistMembersTool } from './tools/update-watchlist-members.js';
import { createWatchlistTool, getWatchlistTool, listWatchlistsTool } from './tools/watchlist.js';

/** MCP tools/list 的单个工具描述（inputSchema 为 JSON Schema draft 2020-12）。 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** OpenAI function calling 的单个工具描述。 */
export interface OpenAIToolDescriptor {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface Registry {
  all(): readonly Tool[];
  get(name: string): Tool | undefined;
  toMCP(): McpToolDescriptor[];
  toOpenAI(): OpenAIToolDescriptor[];
  toTypeScript(): string;
}

/**
 * zod 4 → JSON Schema。取 input 侧（transform 的 pre-transform 类型）；
 * 无法表达的构造（如 z.coerce.date）降级为 {}（any），保证永不抛异常。
 */
const inputJsonSchema = (tool: Tool): Record<string, unknown> =>
  z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;

const renderTypeScript = (tools: readonly Tool[]): string => {
  const names = tools.map((t) => `  | '${t.name}'`).join('\n');
  const metaEntries = tools
    .map(
      (t) =>
        `    '${t.name}': { description: ${JSON.stringify(t.description)}, ` +
        `sideEffect: '${t.sideEffect}', requiredCapabilities: ${JSON.stringify(t.requiredCapabilities)} },`,
    )
    .join('\n');

  return `// 由 @luoome/tools toolRegistry.toTypeScript() 生成，请勿手改。
// v0.1 共 ${tools.length} 个 tool；input 的 JSON Schema 见 toMCP()。

export type LuoomeToolName =
${names};

export type LuoomeSideEffect = 'read' | 'write' | 'external' | 'advice' | 'trade';

export interface LuoomeToolMeta {
  readonly description: string;
  readonly sideEffect: LuoomeSideEffect;
  readonly requiredCapabilities: readonly LuoomeSideEffect[];
}

export declare const luoomeToolMeta: {
${metaEntries}
};

export interface LuoomeToolCall<N extends LuoomeToolName = LuoomeToolName> {
  readonly name: N;
  readonly input: unknown;
}
`;
};

/** 创建 registry；重名直接抛错（装配期错误，不进 ToolResult 错误模型）。 */
export const createRegistry = (tools: readonly Tool[]): Registry => {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`createRegistry: duplicate tool name "${tool.name}"`);
    }
    byName.set(tool.name, tool);
  }

  return {
    all: () => tools,
    get: (name) => byName.get(name),
    toMCP: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputJsonSchema(tool),
      })),
    toOpenAI: () =>
      tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: inputJsonSchema(tool),
        },
      })),
    toTypeScript: () => renderTypeScript(tools),
  };
};

/** v0.1 全量工具表：6 read + 2 advice（docs/archive/plan.md 跨包契约）。 */
export const toolRegistry: Registry = createRegistry([
  getAccountOverviewTool,
  listTradesTool,
  getAdviceTool,
  saveDecisionReviewTool,
  analyzeStockTool,
  analyzePositionTool,
  saveTradingPlanTool,
  fetchQuoteTool,
  fetchIndexQuotesTool,
  searchStocksTool,
  computeIndicatorsTool,
  // Strategy / Watchlist / AlertPlan 是唯一公开研究与盯盘模型。
  listStrategiesTool,
  getStrategyTool,
  saveStrategyVersionTool,
  runStrategyTool,
  getAccountPerformanceTool,
  runStrategyBacktestTool,
  getStrategySignalsTool,
  // M2：Strategy 自主管理动作（list 只读；confirm/reject 为 blocked 人工队列写入口；
  // 创建/转移为 workflow-only，不进公共 registry）
  listWatchlistsTool,
  getWatchlistTool,
  createWatchlistTool,
  updateWatchlistMembersTool,
  listWatchPlansTool,
  saveAlertPlanTool,
  // Phase 1：连板天梯（docs/ddd/limit-up-ladder-detailed-design.md §7）
  limitUpLadderTool,
  // 龙虎榜（只读；东方财富数据中心公开报表）
  dragonTigerListTool,
  // 龙虎榜资金流向拓扑（只读；同花顺龙虎榜跨交易日概念聚合）
  dragonTigerFlowTool,
  // 北向资金历史流（只读；东方财富数据中心公开报表）
  northboundFlowTool,
  // 财经要闻（只读；东方财富公开新闻 API）
  fetchNewsTool,
  // 研究笔记保存（合并 create_research_document + save_report）
  saveResearchDocumentTool,
  // 行业板块行情（只读；东方财富 push2 板块列表公开 API）
  fetchSectorQuotesTool,
  // v0.5 新增：持仓 / 交易录入（write）
  addTradeTool,
  updateHoldingTool,
  // v0.7 策略预警：触发反馈（write）
  // ruo 迁移 Phase 1：研究档案 + 运行状态（docs/ddd/ruo-feature-migration-detailed-design.md §7）
  searchResearchDocumentsTool,
  // 个股行情查看 Phase 1（docs/ddd/stock-market-view-detailed-design.md §10）
  getStockMarketViewTool,
  // 盘中全市场批次（ticket #35）：采集发布（external+write）与只读最近批次
  collectMarketSnapshotTool,
  getMarketSnapshotBatchTool,
  // 作战室总览（ticket #36）：只读最近批次 + 既有情绪 / 指数契约
  getMarketRoomOverviewTool,
  // 板块盘中榜（ticket #38）：只读批次 + 目录成分 + 当日天梯
  getMarketRoomSectorsTool,
]);
