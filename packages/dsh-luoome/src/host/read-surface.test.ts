import { defineTool, toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createReadSurface } from './read-surface.js';

const signal = () => new AbortController().signal;

describe('plugin read execution boundary', () => {
  it('binds account-scoped reads to the configured owner and forwards cancellation to tools', async () => {
    const ctx = await buildTestContext();
    const controller = new AbortController();
    const observed = defineTool({
      name: 'read_cancellation',
      description: 'fixture',
      sideEffect: 'read',
      input: z.object({}),
      output: z.object({ bound: z.boolean() }),
      handler: (_input, context) => ({ bound: context.abortSignal === controller.signal }),
    });
    const surface = createReadSurface({
      accountId: ctx.user.defaultAccountId,
      config: { allowlist: ['get_account', 'read_cancellation'] },
      tools: [...toolRegistry.all(), observed],
      context: () => ctx,
    });
    expect(await surface.invoke('get_account', {}, controller.signal)).toMatchObject({
      ok: true,
      data: { account: { id: ctx.user.defaultAccountId } },
    });
    expect(
      await surface.invoke('get_account', { accountId: 'foreign-account' }, controller.signal),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(await surface.invoke('read_cancellation', {}, controller.signal)).toEqual({
      ok: true,
      data: { bound: true },
    });
    controller.abort();
    expect(await surface.invoke('get_account', {}, controller.signal)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });

  it('matches domain JSON output, including Dates, without changing the domain context', async () => {
    const ctx = await buildTestContext();
    const surface = createReadSurface({
      config: { allowlist: ['list_accounts'] },
      tools: toolRegistry.all(),
      context: () => ctx,
    });
    const result = await surface.invoke('list_accounts', {}, signal());
    expect(result).toEqual(
      JSON.parse(JSON.stringify(await toolRegistry.get('list_accounts')?.execute({}, ctx))),
    );
    expect((await ctx.repos.account.list())[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('denies all non-read capabilities even when named and checks execution as well as discovery', async () => {
    const context = vi.fn();
    const combined = defineTool({
      name: 'combined_read',
      description: 'fixture',
      sideEffect: 'read',
      requiredCapabilities: ['read', 'external'],
      input: z.object({}),
      output: z.object({}),
      handler: () => ({}),
    });
    const names = [
      'create_account',
      'add_trade',
      'record_decision_trade',
      'claim_analysis_jobs',
      'fetch_quote',
      'combined_read',
    ];
    const surface = createReadSurface({
      config: { allowlist: names },
      tools: [...toolRegistry.all(), combined],
      context,
    });
    expect(surface.descriptors()).toEqual([]);
    for (const name of [...names, 'missing_tool'])
      expect(await surface.invoke(name, {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
    expect(context).not.toHaveBeenCalled();
  });

  it('keeps research opt-in and denylist stronger than allowlist', () => {
    const tools = toolRegistry.all();
    const context = vi.fn();
    const config = {
      allowlist: ['get_research_document', 'list_accounts'],
      denylist: ['list_accounts'],
    };
    expect(createReadSurface({ config, tools, context }).descriptors()).toEqual([]);
    expect(
      createReadSurface({ config: { ...config, exposeResearch: true }, tools, context })
        .descriptors()
        .map((t) => t.name),
    ).toEqual(['get_research_document']);
  });

  it('requires an explicit list, rejects trade opt-in, and preserves empty-list denial', () => {
    const context = vi.fn();
    const tools = toolRegistry.all();
    expect(() => createReadSurface({ config: {}, tools, context })).toThrow();
    expect(() =>
      createReadSurface({ config: { allowlist: [], exposeTrade: true }, tools, context }),
    ).toThrow();
    expect(() => createReadSurface({ config: { allowlist: ['missing'] }, tools, context })).toThrow(
      'Unknown configured tool',
    );
    expect(createReadSurface({ config: { allowlist: [] }, tools, context }).descriptors()).toEqual(
      [],
    );
  });

  it('does not allow callers to expand a constructed surface by mutating its config', async () => {
    const config = { allowlist: ['list_accounts'] };
    const context = vi.fn();
    const surface = createReadSurface({ config, context, tools: toolRegistry.all() });
    config.allowlist.push('create_account');
    expect(await surface.invoke('create_account', {}, signal())).toMatchObject({ ok: false });
    expect(context).not.toHaveBeenCalled();
  });

  it('preserves the trade environment startup gate before context acquisition', () => {
    const context = vi.fn();
    vi.stubEnv('LUOOME_EXPOSE_TRADE', 'true');
    try {
      expect(() =>
        createReadSurface({ config: { allowlist: [] }, context, tools: toolRegistry.all() }),
      ).toThrow('LUOOME_EXPOSE_TRADE=true');
      expect(context).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rechecks cancellation and disposal after asynchronous context acquisition', async () => {
    const ctx = await buildTestContext();
    for (const action of ['abort', 'dispose']) {
      let release: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handler = vi.fn(() => ({}));
      const tool = defineTool({
        name: 'read_fixture',
        description: 'fixture',
        sideEffect: 'read',
        input: z.object({}),
        output: z.object({}),
        handler,
      });
      const surface = createReadSurface({
        config: { allowlist: [tool.name] },
        tools: [tool],
        context: async () => {
          await ready;
          return ctx;
        },
      });
      const abort = new AbortController();
      const pending = surface.invoke(tool.name, {}, abort.signal);
      if (action === 'abort') abort.abort();
      else surface.dispose();
      release?.();
      expect(await pending).toMatchObject({ ok: false });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('sanitizes context failures and preserves domain validation failures', async () => {
    const surface = createReadSurface({
      config: { allowlist: ['get_account'] },
      tools: toolRegistry.all(),
      context: () => {
        throw new Error('/private/secrets');
      },
    });
    expect(JSON.stringify(await surface.invoke('get_account', {}, signal()))).not.toContain(
      '/private/secrets',
    );
    const ctx = await buildTestContext();
    const valid = createReadSurface({
      config: { allowlist: ['get_account'] },
      tools: toolRegistry.all(),
      context: () => ctx,
    });
    expect(await valid.invoke('get_account', { accountId: 123 }, signal())).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input' },
    });
  });
});
