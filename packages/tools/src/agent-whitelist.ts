import type { AgentCallableTool, ToolContext } from '@luoome/core';
import type { Registry } from './registry.js';

export const AGENT_V1_TOOL_NAMES = [
  'list_holdings',
  'get_holding',
  'batch_quote',
  'list_strategies',
  'get_strategy',
  'list_strategy_runs',
  'get_strategy_run',
  'strategy_signals_by_stock',
  'list_watchlists',
  'get_watchlist',
  'list_watchlist_changes',
  'list_alert_plans',
  'list_watch_triggers',
  'get_advice',
  'get_advice_stats',
  'list_trades',
  'list_research_notes',
] as const;

const APPROVED_EXTERNAL_TOOLS: ReadonlySet<string> = new Set(['batch_quote']);

export const buildAgentCallableTools = (
  registry: Registry,
  ctx: ToolContext,
): AgentCallableTool[] =>
  AGENT_V1_TOOL_NAMES.map((name) => {
    const registered = registry.get(name);
    if (registered === undefined) {
      throw new Error(`agent_run 白名单引用未注册 tool: ${name}`);
    }
    const allowed =
      registered.sideEffect === 'read' ||
      (registered.sideEffect === 'external' && APPROVED_EXTERNAL_TOOLS.has(registered.name));
    if (!allowed) {
      throw new Error(
        `agent_run 白名单禁止 sideEffect=${registered.sideEffect} tool: ${registered.name}`,
      );
    }
    return {
      name: registered.name,
      description: registered.description,
      inputSchema: registered.inputSchema,
      execute: async (input) => {
        const result = await registered.execute(input, ctx);
        return {
          ok: result.ok,
          output: result.ok ? result.data : { error: result.error },
        };
      },
    };
  });
