import type { ToolContext, ToolResult } from '@luoome/core';
import { createRegistry, privateResearchTools, selectExposedTools, type Tool } from '@luoome/tools';
import { z } from 'zod';

const ReadConfig = z
  .object({
    allowlist: z.array(z.string().trim().min(1).max(120)),
    denylist: z.array(z.string().trim().min(1).max(120)).default([]),
    exposeResearch: z.boolean().default(false),
    exposeTrade: z.literal(false).default(false),
  })
  .strict();

export interface ReadSurface {
  descriptors(): ReturnType<ReturnType<typeof createRegistry>['toMCP']>;
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult<unknown>>;
  dispose(): void;
}

export const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export const invalidInput = (message: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message, issues: [] },
});

export const createReadSurface = (options: {
  readonly config: unknown;
  readonly tools: readonly Tool[];
  readonly context: () => ToolContext | Promise<ToolContext>;
  readonly accountId?: string;
}): ReadSurface => {
  if (process.env.LUOOME_EXPOSE_TRADE === 'true')
    throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed in the DSH plugin');
  const config = ReadConfig.parse(options.config);
  const registry = createRegistry(options.tools);
  for (const name of config.allowlist) {
    if (registry.get(name) === undefined) throw new Error(`Unknown configured tool: ${name}`);
  }
  const selected = createRegistry(
    selectExposedTools(options.tools, new Set(['read']), {
      allowlist: new Set(config.allowlist),
      denylist: new Set([
        ...config.denylist,
        ...(config.exposeResearch ? [] : privateResearchTools),
      ]),
    }),
  );
  const accountBound = new Set(
    selected
      .toMCP()
      .flatMap((descriptor) =>
        Object.hasOwn(descriptor.inputSchema.properties ?? {}, 'accountId')
          ? [descriptor.name]
          : [],
      ),
  );
  let disposed = false;
  return {
    descriptors: () => (disposed ? [] : selected.toMCP()),
    async invoke(name, input, signal) {
      const tool = selected.get(name);
      if (disposed || tool === undefined) return denied('read tool allowlist');
      if (signal.aborted) return denied('active request');
      try {
        const ctx = await options.context();
        if (disposed || signal.aborted) return denied('active request');
        let boundInput = input;
        if (
          options.accountId !== undefined &&
          input !== null &&
          typeof input === 'object' &&
          !Array.isArray(input)
        ) {
          const raw = input as Record<string, unknown>;
          if (raw.accountId !== undefined && raw.accountId !== options.accountId)
            return denied('current owner account');
          if (accountBound.has(name)) boundInput = { ...raw, accountId: options.accountId };
        }
        const result = await tool.execute(boundInput, {
          ...ctx,
          abortSignal:
            ctx.abortSignal === undefined ? signal : AbortSignal.any([signal, ctx.abortSignal]),
        });
        // DSH canonical values must be JSON; the domain still returns Date instances.
        return JSON.parse(JSON.stringify(result)) as ToolResult<unknown>;
      } catch {
        return { ok: false, error: { kind: 'internal', cause: 'Read execution unavailable' } };
      }
    },
    dispose() {
      disposed = true;
    },
  };
};
