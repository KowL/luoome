// native market external surface 的行为测试（M2a）：精确白名单、fail-closed 装配、
// 失败/取消/超时语义与 dispose 边界。只使用 fixture tool 与 registry 名单，不联网。
import { defineTool, errAdapterError, privateResearchTools, toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  assertExternalMarketAllowlist,
  createMarketSurface,
  DEFAULT_MARKET_TIMEOUT_MS,
  registerMarketTools,
} from './market-surface.js';
import { DEFAULT_MARKET_TOOL_ALLOWLIST, DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';

const signal = (): AbortSignal => new AbortController().signal;

const failureTool = defineTool({
  name: 'fixture_external_failure',
  description: 'fixture external failure',
  sideEffect: 'external',
  input: z.object({}),
  output: z.object({}),
  handler: () => errAdapterError('fixture', 'upstream down', true),
});

const dateTool = defineTool({
  name: 'fixture_external_date',
  description: 'fixture external date',
  sideEffect: 'external',
  input: z.object({}),
  output: z.object({ at: z.coerce.date() }),
  handler: () => ({ at: new Date('2026-07-02T01:00:00.000Z') }),
});

const emptyListTool = defineTool({
  name: 'fixture_external_empty',
  description: 'fixture external empty result',
  sideEffect: 'external',
  input: z.object({}),
  output: z.object({ items: z.array(z.string()), warnings: z.array(z.string()) }),
  handler: () => ({ items: [], warnings: ['empty-list'] }),
});

const hangingTool = defineTool({
  name: 'fixture_external_hanging',
  description: 'fixture that never resolves',
  sideEffect: 'external',
  input: z.object({}),
  output: z.object({}),
  handler: () => new Promise<Record<string, never>>(() => {}),
});

const slowTool = defineTool({
  name: 'fixture_external_slow',
  description: 'fixture resolving later',
  sideEffect: 'external',
  input: z.object({}),
  output: z.object({}),
  handler: () =>
    new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 100)),
});

const throwingTool = {
  name: 'fixture_external_throw',
  description: 'fixture that throws synchronously',
  sideEffect: 'external' as const,
  requiredCapabilities: ['external'] as const,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  execute: async () => {
    throw new Error('/private/secrets/leak');
  },
};

const fixtures = [
  failureTool,
  dateTool,
  emptyListTool,
  hangingTool,
  slowTool,
  throwingTool,
] as const;

const surfaceFor = async (config: unknown, tools = [...toolRegistry.all(), ...fixtures]) => {
  const context = await buildTestContext();
  return createMarketSurface({ config, tools, context: () => context });
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('market external allowlist reconciliation', () => {
  it('default allowlist matches the real registry as external-only tools', () => {
    const privateResearch = new Set<string>(privateResearchTools);
    for (const name of DEFAULT_MARKET_TOOL_ALLOWLIST) {
      const tool = toolRegistry.get(name);
      expect(tool, `market tool ${name} must exist`).toBeDefined();
      expect(tool?.sideEffect, `${name} must be external`).toBe('external');
      expect(tool?.requiredCapabilities, `${name} must require only external`).toEqual([
        'external',
      ]);
      expect(privateResearch.has(name), `${name} must not be private research`).toBe(false);
    }
    expect([...DEFAULT_MARKET_TOOL_ALLOWLIST]).toEqual([
      'fetch_index_quotes',
      'get_ashare_sentiment',
      'fetch_quote',
      'batch_quote',
      'trial_strategy_version',
      'run_strategy_research_comparison',
      'get_stock_market_view',
      'fetch_news',
    ]);
    // fetch_news 访问第三方新闻源，归为 external 后才能进入 external surface（需求 §4.2/§5-3）。
    expect(toolRegistry.get('fetch_news')?.sideEffect).toBe('external');
    expect(DEFAULT_MARKET_TOOL_ALLOWLIST).toContain('fetch_news');
    expect(DEFAULT_READ_TOOL_ALLOWLIST).not.toContain('fetch_news');
    expect(DEFAULT_MARKET_TOOL_ALLOWLIST).not.toContain('send_notification');
    expect(DEFAULT_MARKET_TOOL_ALLOWLIST).not.toContain('sync_quotes');
  });

  it('read and market default lists do not overlap and keep their own capability class', () => {
    const market = new Set(DEFAULT_MARKET_TOOL_ALLOWLIST);
    for (const name of DEFAULT_READ_TOOL_ALLOWLIST)
      expect(market.has(name), `read tool ${name} must not be in market list`).toBe(false);
    for (const name of DEFAULT_READ_TOOL_ALLOWLIST)
      expect(toolRegistry.get(name)?.sideEffect).toBe('read');
  });
});

describe('market surface configuration', () => {
  it('exposes exactly the configured external allowlist', async () => {
    const surface = await surfaceFor({ allowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST] });
    expect(
      surface
        .descriptors()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...DEFAULT_MARKET_TOOL_ALLOWLIST].sort());
    surface.dispose();
  });

  it('rejects unknown, non-external and write-capable names at assembly', async () => {
    const context = await buildTestContext();
    const tools = [...toolRegistry.all(), ...fixtures];
    const cases = [
      ['missing_market_tool', 'Unknown configured market tool'],
      ['list_accounts', 'not external'],
      ['record_advice', 'not external'],
      ['add_trade', 'not external'],
      ['record_decision_trade', 'not external'],
      ['create_account', 'not external'],
      ['get_stock_minute_bars', 'unsupported capabilities'],
    ] as const;
    for (const [name, message] of cases)
      expect(() =>
        createMarketSurface({ config: { allowlist: [name] }, tools, context: () => context }),
      ).toThrow(message);
    expect(() => assertExternalMarketAllowlist(['import_remote_research_document'], tools)).toThrow(
      'unsupported capabilities',
    );
  });

  it('keeps an explicit empty allowlist as zero tools', async () => {
    const surface = await surfaceFor({ allowlist: [] });
    expect(surface.descriptors()).toEqual([]);
    expect(await surface.invoke('fetch_quote', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    surface.dispose();
  });

  it('denies any tool that is not in the frozen exposure snapshot, including by name', async () => {
    const context = vi.fn();
    const surface = createMarketSurface({
      config: { allowlist: ['fetch_quote'] },
      tools: toolRegistry.all(),
      context,
    });
    for (const name of [
      'send_notification',
      'record_advice',
      'sync_quotes',
      'add_trade',
      'list_accounts',
      'missing_market_tool',
    ])
      expect(await surface.invoke(name, {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
    expect(context).not.toHaveBeenCalled();
    surface.dispose();
  });

  it('does not let private research names opt in through the market allowlist', async () => {
    const surface = await surfaceFor({ allowlist: ['search_research_documents_hybrid'] });
    expect(surface.descriptors()).toEqual([]);
    expect(await surface.invoke('search_research_documents_hybrid', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    surface.dispose();
  });

  it('keeps denylist stronger than allowlist', async () => {
    const surface = await surfaceFor({
      allowlist: ['fetch_quote'],
      denylist: ['fetch_quote'],
    });
    expect(surface.descriptors()).toEqual([]);
    expect(await surface.invoke('fetch_quote', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    surface.dispose();
  });

  it('does not allow callers to expand a constructed surface by mutating config', async () => {
    const config = { allowlist: ['fetch_quote'] };
    const surface = await surfaceFor(config);
    config.allowlist.push('send_notification');
    expect(surface.descriptors().map((tool) => tool.name)).toEqual(['fetch_quote']);
    expect(await surface.invoke('send_notification', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    surface.dispose();
  });

  it('preserves the trade startup gate', async () => {
    vi.stubEnv('LUOOME_EXPOSE_TRADE', 'true');
    const context = await buildTestContext();
    expect(() =>
      createMarketSurface({
        config: { allowlist: ['fetch_quote'] },
        tools: toolRegistry.all(),
        context: () => context,
      }),
    ).toThrow('LUOOME_EXPOSE_TRADE=true');
  });
});

describe('market surface execution semantics', () => {
  it('preserves domain failures instead of fabricating an empty success', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_failure'] });
    expect(await surface.invoke('fixture_external_failure', {}, signal())).toEqual({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'fixture',
        cause: 'upstream down',
        recoverable: true,
      },
    });
    surface.dispose();
  });

  it('keeps legitimate empty-result success semantics and JSON-encodes Dates', async () => {
    const surface = await surfaceFor({
      allowlist: ['fixture_external_empty', 'fixture_external_date'],
    });
    expect(await surface.invoke('fixture_external_empty', {}, signal())).toEqual({
      ok: true,
      data: { items: [], warnings: ['empty-list'] },
    });
    const dated = await surface.invoke('fixture_external_date', {}, signal());
    if (!dated.ok) throw new Error('date fixture failed');
    expect(dated.data).toEqual({ at: '2026-07-02T01:00:00.000Z' });
    surface.dispose();
  });

  it('sanitizes thrown execution errors', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_throw'] });
    const result = await surface.invoke('fixture_external_throw', {}, signal());
    expect(result).toMatchObject({ ok: false, error: { kind: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('/private/secrets');
    surface.dispose();
  });

  it('refuses already-aborted calls and aborts in-flight calls without calling handlers twice', async () => {
    const context = await buildTestContext();
    const calls = vi.fn();
    const tool = defineTool({
      name: 'fixture_external_abortable',
      description: 'fixture abortable',
      sideEffect: 'external',
      input: z.object({}),
      output: z.object({}),
      handler: async () => {
        calls();
        return {};
      },
    });
    const surface = createMarketSurface({
      config: { allowlist: [tool.name] },
      tools: [tool],
      context: () => context,
    });
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await surface.invoke(tool.name, {}, preAborted.signal)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'active request' },
    });
    expect(calls).not.toHaveBeenCalled();

    const slow = createMarketSurface({
      config: { allowlist: ['fixture_external_slow'] },
      tools: [...fixtures],
      context: () => context,
    });
    const abort = new AbortController();
    const started = Date.now();
    const pending = slow.invoke('fixture_external_slow', {}, abort.signal);
    setTimeout(() => abort.abort(), 10);
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'active request' },
    });
    expect(Date.now() - started).toBeLessThan(500);
    slow.dispose();
    surface.dispose();
  });

  it('bounds hanging external calls with a clear timeout error', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_hanging'], timeoutMs: 25 });
    const started = Date.now();
    const result = await surface.invoke('fixture_external_hanging', {}, signal());
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', adapter: 'market-surface', recoverable: true },
    });
    if (!result.ok) expect((result.error as { cause?: string }).cause).toBe('timeout after 25ms');
    expect(elapsed).toBeLessThan(1000);
    surface.dispose();
  });

  it('reports the caller deadline as a provider timeout, not an authorization failure', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_hanging'] });
    const result = await surface.invoke('fixture_external_hanging', {}, AbortSignal.timeout(20));
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'market-surface',
        cause: 'Market request deadline exceeded',
        recoverable: true,
      },
    });
    surface.dispose();
  });

  it('uses the default timeout bound and lets later calls proceed after a timeout', async () => {
    expect(DEFAULT_MARKET_TIMEOUT_MS).toBe(30_000);
    const surface = await surfaceFor({
      allowlist: ['fixture_external_hanging', 'fixture_external_date'],
      timeoutMs: 20,
    });
    expect(await surface.invoke('fixture_external_hanging', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error' },
    });
    expect(await surface.invoke('fixture_external_date', {}, signal())).toMatchObject({ ok: true });
    surface.dispose();
  });

  it('denies old closures and clears discovery after dispose', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_date'] });
    expect((await surface.invoke('fixture_external_date', {}, signal())).ok).toBe(true);
    surface.dispose();
    expect(surface.descriptors()).toEqual([]);
    expect(await surface.invoke('fixture_external_date', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });
});

describe('market runtime registration', () => {
  it('registers configured tools into the host runtime and revokes them on unregister', async () => {
    const surface = await surfaceFor({ allowlist: ['fixture_external_date'] });
    const registered: string[] = [];
    const removed: string[] = [];
    const runtime = {
      register(definition: { name: string }) {
        registered.push(definition.name);
        return () => removed.push(definition.name);
      },
    } as unknown as Parameters<typeof registerMarketTools>[0];
    const remove = registerMarketTools(runtime, surface);
    expect(registered).toEqual(['fixture_external_date']);
    remove();
    expect(removed).toEqual(['fixture_external_date']);
    expect(await surface.invoke('fixture_external_date', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });

  it('rolls back partially registered market tools when a later registration fails', async () => {
    const surface = await surfaceFor({
      allowlist: ['fixture_external_date', 'fixture_external_empty'],
    });
    const registered: string[] = [];
    const removed: string[] = [];
    const runtime = {
      register(definition: { name: string }) {
        if (definition.name === 'fixture_external_empty') throw new Error('runtime refused');
        registered.push(definition.name);
        return () => removed.push(definition.name);
      },
    } as unknown as Parameters<typeof registerMarketTools>[0];
    expect(() => registerMarketTools(runtime, surface)).toThrow('runtime refused');
    expect(registered).toEqual(['fixture_external_date']);
    expect(removed).toEqual(['fixture_external_date']);
    expect(await surface.invoke('fixture_external_date', {}, signal())).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });
});
