import { z } from 'zod';

import type { Tool } from './define-tool.js';
import { addHoldingTool } from './tools/add-holding.js';
import { addStockEventTool } from './tools/add-stock-event.js';
import { addTradeTool } from './tools/add-trade.js';
import { agentRunTool } from './tools/agent-run.js';
import {
  createAlertPlanTool,
  deleteAlertPlanTool,
  listAlertPlansTool,
  updateAlertPlanTool,
} from './tools/alert-plan.js';
import { analyzePositionTool } from './tools/analyze-position.js';
import { analyzeStockTool } from './tools/analyze-stock.js';
import { batchQuoteTool } from './tools/batch-quote.js';
import {
  appendChatMessageTool,
  createChatSessionTool,
  deleteChatSessionTool,
  getChatSessionTool,
  listChatSessionsTool,
  renameChatSessionTool,
} from './tools/chat-session.js';
import { closeHoldingTool } from './tools/close-holding.js';
import { computeIndicatorsTool } from './tools/compute-indicators.js';
import { createAccountTool } from './tools/create-account.js';
import { deleteStockEventTool } from './tools/delete-stock-event.js';
import { fetchIndexQuotesTool } from './tools/fetch-index-quotes.js';
import { fetchQuoteTool } from './tools/fetch-quote.js';
import { getAccountTool } from './tools/get-account.js';
import { getAdviceTool } from './tools/get-advice.js';
import { getAdviceStatsTool } from './tools/get-advice-stats.js';
import { getAShareSentimentTool } from './tools/get-ashare-sentiment.js';
import { getConfidenceCalibrationTool } from './tools/get-confidence-calibration.js';
import { getHoldingTool } from './tools/get-holding.js';
import { getMarketDataStatusTool } from './tools/get-market-data-status.js';
import { getPreviousClosesTool } from './tools/get-previous-closes.js';
import { getReportTool } from './tools/get-report.js';
import { getStockMarketViewTool } from './tools/get-stock-market-view.js';
import { getStockUniverseStatusTool } from './tools/get-stock-universe-status.js';
import { getWatchStatusTool } from './tools/get-watch-status.js';
import { limitUpLadderCompareTool, limitUpLadderTool } from './tools/limit-up-ladder.js';
import { listAccountsTool } from './tools/list-accounts.js';
import { listHoldingsTool } from './tools/list-holdings.js';
import { listReportsTool } from './tools/list-reports.js';
import { listStockEventsTool } from './tools/list-stock-events.js';
import { listTradesTool } from './tools/list-trades.js';
import { listWatchTriggersTool } from './tools/list-watch-triggers.js';
import { listWorkflowRunsTool } from './tools/list-workflow-runs.js';
import { marketOutlookTool } from './tools/market-outlook.js';
import { recordAdviceOutcomeTool } from './tools/record-advice-outcome.js';
import { renderReportTool } from './tools/render-report.js';
import {
  archiveResearchTopicTool,
  buildResearchBriefTool,
  createResearchDocumentTool,
  createResearchTopicTool,
  getResearchDocumentTool,
  getResearchTopicTool,
  getStockResearchViewTool,
  importLocalResearchDocumentTool,
  importRemoteResearchDocumentTool,
  linkResearchDocumentTool,
  listResearchDocumentsTool,
  listResearchTopicsTool,
  searchResearchDocumentsTool,
  syncResearchVaultTool,
} from './tools/research-vault.js';
import { runStrategyTool } from './tools/run-strategy.js';
import { searchStocksTool } from './tools/search-stocks.js';
import { sendNotificationTool } from './tools/send-notification.js';
import { setWatchTriggerFeedbackTool } from './tools/set-watch-trigger-feedback.js';
import {
  completeStrategyObservationsTool,
  listPendingStrategyObservationsTool,
} from './tools/signal-observation.js';
import {
  compareStrategyDefinitionsTool,
  proposeStrategyVersionDraftTool,
  trialStrategyVersionTool,
} from './tools/strategy-definition.js';
import {
  generateStrategyInsightTool,
  getStrategyInsightFactsTool,
} from './tools/strategy-insight.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  deleteStrategyTool,
  getStrategyTool,
  listStrategiesTool,
  pauseStrategyTool,
  publishStrategyVersionTool,
  resumeStrategyTool,
  validateStrategyVersionTool,
} from './tools/strategy-lifecycle.js';
import {
  compareStrategyRunsTool,
  getStrategyRunTool,
  getStrategyWorkspaceTool,
  listStrategyResultViewsTool,
  listStrategyRunsTool,
  strategySignalsByStockTool,
} from './tools/strategy-query.js';
import { getStrategyScheduleTool, setStrategyScheduleTool } from './tools/strategy-schedule.js';
import { syncDailyBarsTool } from './tools/sync-daily-bars.js';
import { syncQuotesTool } from './tools/sync-quotes.js';
import { syncStockEventsTool } from './tools/sync-stock-events.js';
import { syncStockUniverseTool } from './tools/sync-stock-universe.js';
import { updateHoldingTool } from './tools/update-holding.js';
import { updateStockEventTool } from './tools/update-stock-event.js';
import {
  addWatchlistMemberTool,
  archiveWatchlistMemberTool,
  archiveWatchlistTool,
  createWatchlistTool,
  getWatchlistTool,
  listWatchlistChangesTool,
  listWatchlistsTool,
  updateWatchlistMemberTool,
  updateWatchlistTool,
} from './tools/watchlist.js';

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
  listChatSessionsTool,
  getChatSessionTool,
  createChatSessionTool,
  renameChatSessionTool,
  deleteChatSessionTool,
  appendChatMessageTool,
  agentRunTool,
  listAccountsTool,
  createAccountTool,
  getAccountTool,
  listHoldingsTool,
  listTradesTool,
  getHoldingTool,
  getAdviceTool,
  getAdviceStatsTool,
  getConfidenceCalibrationTool,
  getWatchStatusTool,
  analyzeStockTool,
  analyzePositionTool,
  fetchQuoteTool,
  batchQuoteTool,
  fetchIndexQuotesTool,
  syncQuotesTool,
  syncDailyBarsTool,
  getPreviousClosesTool,
  searchStocksTool,
  computeIndicatorsTool,
  // Strategy / Watchlist / AlertPlan 是唯一公开研究与盯盘模型。
  listStrategiesTool,
  getStrategyTool,
  createStrategyTool,
  deleteStrategyTool,
  createStrategyVersionTool,
  compareStrategyDefinitionsTool,
  proposeStrategyVersionDraftTool,
  trialStrategyVersionTool,
  validateStrategyVersionTool,
  publishStrategyVersionTool,
  pauseStrategyTool,
  resumeStrategyTool,
  runStrategyTool,
  listStrategyRunsTool,
  getStrategyRunTool,
  listStrategyResultViewsTool,
  getStrategyWorkspaceTool,
  compareStrategyRunsTool,
  strategySignalsByStockTool,
  listPendingStrategyObservationsTool,
  completeStrategyObservationsTool,
  getStrategyInsightFactsTool,
  generateStrategyInsightTool,
  getStrategyScheduleTool,
  setStrategyScheduleTool,
  listWatchlistsTool,
  getWatchlistTool,
  createWatchlistTool,
  updateWatchlistTool,
  archiveWatchlistTool,
  addWatchlistMemberTool,
  updateWatchlistMemberTool,
  archiveWatchlistMemberTool,
  listWatchlistChangesTool,
  listAlertPlansTool,
  createAlertPlanTool,
  updateAlertPlanTool,
  deleteAlertPlanTool,
  recordAdviceOutcomeTool,
  sendNotificationTool,
  marketOutlookTool,
  // Phase 1：连板天梯（docs/ddd/limit-up-ladder-detailed-design.md §7）
  limitUpLadderTool,
  limitUpLadderCompareTool,
  // v0.5 新增：持仓 / 交易录入（write）
  addTradeTool,
  addHoldingTool,
  updateHoldingTool,
  closeHoldingTool,
  listWatchTriggersTool,
  // v0.7 策略预警：触发反馈（write）
  setWatchTriggerFeedbackTool,
  // ruo 迁移 Phase 1：研究档案 + 公司事件 + 运行状态（docs/ddd/ruo-feature-migration-detailed-design.md §7）
  listStockEventsTool,
  addStockEventTool,
  updateStockEventTool,
  listResearchTopicsTool,
  getResearchTopicTool,
  createResearchTopicTool,
  createResearchDocumentTool,
  importLocalResearchDocumentTool,
  importRemoteResearchDocumentTool,
  linkResearchDocumentTool,
  archiveResearchTopicTool,
  buildResearchBriefTool,
  listResearchDocumentsTool,
  getResearchDocumentTool,
  searchResearchDocumentsTool,
  getStockResearchViewTool,
  syncResearchVaultTool,
  deleteStockEventTool,
  syncStockEventsTool,
  syncStockUniverseTool,
  getMarketDataStatusTool,
  getAShareSentimentTool,
  listWorkflowRunsTool,
  getReportTool,
  listReportsTool,
  renderReportTool,
  // 个股行情查看 Phase 1（docs/ddd/stock-market-view-detailed-design.md §10）
  getStockMarketViewTool,
  getStockUniverseStatusTool,
]);
