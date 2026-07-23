import { z } from 'zod';

import type { Tool } from './define-tool.js';
import { addHoldingTool } from './tools/add-holding.js';
import { addTradeTool } from './tools/add-trade.js';
import { analyzePositionTool } from './tools/analyze-position.js';
import { analyzeStockTool } from './tools/analyze-stock.js';
import { batchQuoteTool } from './tools/batch-quote.js';
import { closeHoldingTool } from './tools/close-holding.js';
import { computeIndicatorsTool } from './tools/compute-indicators.js';
import { createStockGroupTool } from './tools/create-stock-group.js';
import { createStockPoolTool } from './tools/create-stock-pool.js';
import { deleteStockGroupTool } from './tools/delete-stock-group.js';
import { deleteStockPoolTool } from './tools/delete-stock-pool.js';
import { fetchQuoteTool } from './tools/fetch-quote.js';
import { getAccountTool } from './tools/get-account.js';
import { getAdviceTool } from './tools/get-advice.js';
import { getAdviceStatsTool } from './tools/get-advice-stats.js';
import { getConfidenceCalibrationTool } from './tools/get-confidence-calibration.js';
import { getHoldingTool } from './tools/get-holding.js';
import { getStockGroupTool } from './tools/get-stock-group.js';
import { getTacticTool } from './tools/get-tactic.js';
import { listAccountsTool } from './tools/list-accounts.js';
import { listHoldingsTool } from './tools/list-holdings.js';
import { listStockGroupsTool } from './tools/list-stock-groups.js';
import { listStockPoolsTool } from './tools/list-stock-pools.js';
import { listTacticsTool } from './tools/list-tactics.js';
import { marketOutlookTool } from './tools/market-outlook.js';
import { recordAdviceOutcomeTool } from './tools/record-advice-outcome.js';
import { refreshStockGroupTool } from './tools/refresh-stock-group.js';
import { resolveLlmGroupTool } from './tools/resolve-llm-group.js';
import { runTacticTool } from './tools/run-tactic.js';
import { saveWatchTriggerTool } from './tools/save-watch-trigger.js';
import { scoreSignalsTool } from './tools/score-signals.js';
import { searchStocksTool } from './tools/search-stocks.js';
import { sendNotificationTool } from './tools/send-notification.js';
import { syncQuotesTool } from './tools/sync-quotes.js';
import { tacticSignalsByStockTool } from './tools/tactic-signals-by-stock.js';
import { tacticSignalsByTacticTool } from './tools/tactic-signals-by-tactic.js';
import { updateHoldingTool } from './tools/update-holding.js';
import { updateStockGroupTool } from './tools/update-stock-group.js';
import { updateStockPoolTool } from './tools/update-stock-pool.js';

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
        `sideEffect: '${t.sideEffect}' },`,
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

/** v0.1 全量工具表：6 read + 2 advice（plan.md 跨包契约）。 */
export const toolRegistry: Registry = createRegistry([
  listAccountsTool,
  getAccountTool,
  listHoldingsTool,
  getHoldingTool,
  getAdviceTool,
  getAdviceStatsTool,
  getConfidenceCalibrationTool,
  analyzeStockTool,
  analyzePositionTool,
  fetchQuoteTool,
  batchQuoteTool,
  syncQuotesTool,
  searchStocksTool,
  computeIndicatorsTool,
  // v0.3 新增：战法 + 通知 + 大盘观点 + outcome 回填
  listTacticsTool,
  getTacticTool,
  runTacticTool,
  scoreSignalsTool,
  tacticSignalsByStockTool,
  tacticSignalsByTacticTool,
  recordAdviceOutcomeTool,
  sendNotificationTool,
  marketOutlookTool,
  // v0.5 新增：持仓 / 交易录入（write）
  addTradeTool,
  addHoldingTool,
  updateHoldingTool,
  closeHoldingTool,
  // v0.6 新增：股票池 CRUD（write）+ 触发落库（write，workflow 内部）+ 列池（read）
  listStockPoolsTool,
  createStockPoolTool,
  updateStockPoolTool,
  deleteStockPoolTool,
  saveWatchTriggerTool,
  // 分组化起（docs/stock-group-design.md §6）：分组 CRUD + 刷新 + LLM 解析
  listStockGroupsTool,
  getStockGroupTool,
  createStockGroupTool,
  updateStockGroupTool,
  deleteStockGroupTool,
  refreshStockGroupTool,
  resolveLlmGroupTool,
]);
