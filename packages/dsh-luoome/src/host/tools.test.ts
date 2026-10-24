import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { renderToolsSdk, renderToolsSdkPy, ToolRuntime } from '@deepseek-ai/dsh-tools';
import { defineTool, toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createReadSurface } from './read-surface.js';
import { registerReadTools } from './tools.js';

const runtime = () => {
  const ctx = new Context();
  // Prompt assembly is not under test; policy/dispatch/schema validation use the actual DSH service.
  ctx.provide('systemPrompt', { tools: () => () => undefined });
  return { ctx, tools: new ToolRuntime(ctx) };
};

describe('installed DSH tool pipeline', () => {
  it('registers a compatible read schema and round-trips the domain ToolResult', async () => {
    const { tools } = runtime();
    const domain = await buildTestContext();
    const surface = createReadSurface({
      config: { allowlist: ['list_accounts'] },
      tools: toolRegistry.all(),
      context: () => domain,
    });
    const remove = registerReadTools(tools, surface);
    expect(
      tools
        .schemas()
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      surface
        .descriptors()
        .map((t) => t.name)
        .sort(),
    );
    const result = await tools.execute({
      callId: ToolCallId('read-1'),
      name: 'list_accounts',
      arguments: {},
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(result.value).toEqual(
      await surface.invoke('list_accounts', {}, new AbortController().signal),
    );
    remove();
    remove();
    expect(tools.schemas()).toEqual([]);
    expect(await surface.invoke('list_accounts', {}, new AbortController().signal)).toMatchObject({
      ok: false,
    });
  });

  it('preserves every full input schema in raw registration and renders PTC declarations', () => {
    const { tools } = runtime();
    const context = vi.fn();
    const surface = createReadSurface({
      config: { allowlist: toolRegistry.all().map((t) => t.name), exposeResearch: true },
      tools: toolRegistry.all(),
      context,
    });
    const remove = registerReadTools(tools, surface);
    for (const descriptor of surface.descriptors()) {
      expect(tools.schemas().find((t) => t.name === descriptor.name)?.parameters).toEqual(
        JSON.parse(JSON.stringify(descriptor.inputSchema)),
      );
    }
    expect(() => renderToolsSdk(tools.schemas().map((s) => ({ ...s, output: {} })))).not.toThrow();
    expect(() =>
      renderToolsSdkPy(tools.schemas().map((s) => ({ ...s, output: {} }))),
    ).not.toThrow();
    expect(context).not.toHaveBeenCalled();
    remove();
  });

  it('enforces original constraints, refinements, defaults and transforms through the native runtime', async () => {
    const { tools } = runtime();
    const ctx = await buildTestContext();
    const handler = vi.fn((input) => input);
    const input = z
      .object({
        code: z
          .string()
          .min(3)
          .regex(/^[A-Z]+$/),
        count: z.number().int().min(1).max(5).default(2),
        values: z.record(z.string().min(2), z.number().positive()),
        end: z.number(),
        at: z.coerce.date(),
      })
      .strict()
      .refine((v) => v.end >= v.count, 'end precedes count');
    const tool = defineTool({
      name: 'constrained',
      description: 'fixture',
      sideEffect: 'read',
      input,
      output: input,
      handler,
    });
    const surface = createReadSurface({
      config: { allowlist: [tool.name] },
      tools: [tool],
      context: () => ctx,
    });
    const remove = registerReadTools(tools, surface);
    const valid = { code: 'ABC', values: { good: 1 }, end: 4, at: '2026-10-24T00:00:00Z' };
    for (const patch of [
      { code: 'AB' },
      { code: 'abc' },
      { count: 6 },
      { count: 1.5 },
      { values: { x: 1 } },
      { values: { good: -1 } },
      { end: 1 },
      { at: 'invalid' },
      { extra: true },
    ]) {
      const result = await tools.execute({
        callId: ToolCallId('invalid'),
        name: tool.name,
        arguments: { ...valid, ...patch },
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      expect(result.value).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    }
    expect(handler).not.toHaveBeenCalled();
    const result = await tools.execute({
      callId: ToolCallId('valid'),
      name: tool.name,
      arguments: valid,
      signal: new AbortController().signal,
    });
    expect(result.value).toMatchObject({
      ok: true,
      data: { count: 2, at: new Date(valid.at).toISOString() },
    });
    expect(handler.mock.calls[0]?.[0].at).toBeInstanceOf(Date);
    remove();
  });

  it('denies ask without an approval service before executing the domain tool', async () => {
    const { ctx, tools } = runtime();
    const context = vi.fn();
    const surface = createReadSurface({
      config: { allowlist: ['list_accounts'] },
      tools: toolRegistry.all(),
      context,
    });
    const remove = registerReadTools(tools, surface);
    ctx.on('tools/pre-execute', async () => ({
      kind: 'ask' as const,
      reason: 'approval required',
    }));
    const result = await tools.execute({
      callId: ToolCallId('ask-1'),
      name: 'list_accounts',
      arguments: {},
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(context).not.toHaveBeenCalled();
    remove();
  });

  it('rolls back its own registrations when a tool name collides', () => {
    const { tools } = runtime();
    const first = createReadSurface({
      config: { allowlist: ['list_accounts'] },
      tools: toolRegistry.all(),
      context: vi.fn(),
    });
    const remove = registerReadTools(tools, first);
    const listAccounts = toolRegistry.get('list_accounts');
    if (!listAccounts) throw new Error('Missing list_accounts fixture');
    const second = createReadSurface({
      config: { allowlist: ['list_accounts_alias', 'list_accounts'] },
      tools: [{ ...listAccounts, name: 'list_accounts_alias' }, listAccounts],
      context: vi.fn(),
    });
    expect(() => registerReadTools(tools, second)).toThrow();
    expect(tools.schemas().map((t) => t.name)).toEqual(['list_accounts']);
    expect(second.descriptors()).toEqual([]);
    remove();
  });
});
