import type { AgentCallableTool, ToolContext } from '@luoome/core';
import type { Registry } from './registry.js';

export const APPROVED_EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'fetch_quote',
  'batch_quote',
  'get_account_performance',
  'search_research_documents_hybrid',
]);

export const buildAgentCallableTools = (
  registry: Registry,
  ctx: ToolContext,
  readToolNames: readonly string[],
): AgentCallableTool[] =>
  readToolNames.map((name) => {
    const registered = registry.get(name);
    if (registered === undefined) {
      throw new Error(`agent 白名单引用未注册 tool: ${name}`);
    }
    const allowed =
      registered.sideEffect === 'read' ||
      (registered.sideEffect === 'external' && APPROVED_EXTERNAL_TOOLS.has(registered.name));
    if (!allowed) {
      throw new Error(
        `agent 白名单禁止 sideEffect=${registered.sideEffect} tool: ${registered.name}`,
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
