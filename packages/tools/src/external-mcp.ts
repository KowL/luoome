import { ReadOnlyMcpClient } from '@luoome/adapters';
import type { AgentCallableTool, ToolContext } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError } from './define-tool.js';

export interface ExternalMcpCallable {
  readonly callable: AgentCallableTool;
  readonly service: string;
  readonly inputSchema: Record<string, unknown>;
  authorized(): Promise<boolean>;
}

export const discoverExternalMcpTools = async (
  configPath: string,
  ctx: ToolContext,
  scenario: string,
): Promise<ExternalMcpCallable[]> => {
  const client = new ReadOnlyMcpClient(configPath, ctx.logger);
  const remote = await client.discover(scenario, ctx.abortSignal);
  return remote.map((entry) => {
    const tool = defineTool({
      name: entry.name,
      description: entry.description,
      sideEffect: 'external',
      input: z.record(z.string(), z.unknown()).superRefine((input, context) => {
        if (!entry.validate(input))
          context.addIssue({ code: 'custom', message: 'Input does not match the MCP tool schema' });
      }),
      output: z.unknown(),
      handler: async (input) => {
        if (!(await entry.authorized()))
          return {
            ok: false as const,
            error: { kind: 'permission_denied' as const, required: `mcp:${entry.service}` },
          };
        try {
          return await entry.call(input, ctx.abortSignal);
        } catch {
          return errAdapterError(
            `mcp:${entry.service}`,
            'Read-only MCP call failed or its authorization changed',
            true,
          );
        }
      },
    });
    return {
      service: entry.service,
      inputSchema: entry.inputSchema,
      authorized: entry.authorized,
      callable: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input) => {
          const result = await tool.execute(input, ctx);
          return { ok: result.ok, output: result.ok ? result.data : { error: result.error } };
        },
      },
    };
  });
};
