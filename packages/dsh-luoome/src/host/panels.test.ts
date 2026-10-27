// M4 面板宿主数据路由测试（需求 §7、plugin 详细设计 §4.2 HTTP）。
//
// 只覆盖宿主侧契约：认证拒绝透传、panel 白名单、固定映射、ToolResult 原样投影、
// 404/405、无写能力。真实 UI/浏览器一致性由 infra/dsh/panels-browser-acceptance.ts 验证。
import {
  buildStrategySchedule,
  type StrategyDslV1,
  type StrategyRun,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createMarketSurface } from './market-surface.js';
import {
  createPanelStateHandler,
  createStockDetailHandler,
  createStockHistoryHandler,
  PANEL_NAMES,
  PANEL_PLANS,
  projectPanelTool,
} from './panels.js';
import { createReadSurface } from './read-surface.js';

const now = new Date('2026-10-22T02:00:00Z');
const FIXED_AS_OF = new Date('2026-10-25T04:00:00Z');

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'positive-close', name: '正价格', when: 'quote.close > 0', evidence: ['收盘价'] },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const seedStrategy = async (ctx: ToolContext) => {
  await ctx.repos.strategy.create({
    id: 'direction-a',
    name: '隔离验收策略',
    description: '面板验收用合成策略',
    owner: 'user',
    status: 'active',
    currentVersionId: 'direction-a-v1',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: 'direction-a-v1',
    strategyId: 'direction-a',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  const run: StrategyRun = {
    id: 'direction-a-run',
    strategyId: 'direction-a',
    strategyVersionId: 'direction-a-v1',
    mode: 'scan',
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: now,
    startedAt: now,
    finishedAt: now,
    status: 'complete',
    scope: 'operational',
    inputSnapshot: { stockIds: ['600519.SH'], universeKind: 'explicit' },
    providerStatuses: [],
    summary: { selected: 1 },
    publication: { status: 'published', reasons: [], decidedAt: now },
  };
  await ctx.repos.strategyRun.commitRun({
    run,
    results: [
      {
        runId: run.id,
        stockId: '600519.SH',
        selected: true,
        score: 60,
        evidence: ['quote:600519.SH'],
        ruleEvaluations: [],
        dataAsOf: now,
      },
    ],
    signals: [],
  });
};

const seedScheduleAndSubscription = async (ctx: ToolContext) => {
  await ctx.repos.strategySchedule.save(
    buildStrategySchedule({
      strategyId: 'direction-a',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      now,
    }),
  );
  await ctx.repos.strategyWatchlistSubscription.save({
    id: 'direction-a-subscription',
    strategyId: 'direction-a',
    watchlistId: 'watchlist-a',
    sourceKey: 'strategy:direction-a',
    status: 'active',
    createdBy: ctx.user.id,
    createdAt: now,
    updatedAt: now,
  });
};

const readNames = (): string[] => {
  const names = new Set<string>();
  for (const panel of PANEL_NAMES) {
    for (const call of PANEL_PLANS[panel].read) names.add(call.name);
  }
  // strategies 面板对目录里每条策略派生 workspace/schedule/subscriptions 三次读取，
  // 它们不在 PANEL_PLANS.read 里，但同样必须在 read surface allowlist 内。
  names.add('get_strategy_workspace');
  names.add('get_strategy_schedule');
  names.add('list_strategy_watchlist_subscriptions');
  return [...names];
};

const marketNames = (): string[] => {
  const names = new Set<string>();
  for (const panel of PANEL_NAMES) {
    for (const call of PANEL_PLANS[panel].market) names.add(call.name);
  }
  return [...names];
};

const setup = async (
  options: {
    readonly allowlist?: readonly string[];
    readonly marketAllowlist?: readonly string[];
    readonly admit?: () => Response | null | undefined;
  } = {},
) => {
  const ctx = await buildTestContext({ clock: () => now });
  const contextCalls = vi.fn(() => ctx);
  const read = createReadSurface({
    config: { allowlist: [...(options.allowlist ?? readNames())] },
    tools: toolRegistry.all(),
    context: contextCalls,
  });
  // 默认零 market 工具：overview 的 external 调用必须原样返回 permission_denied，
  // 而不是被面板路由吞掉或伪造为空成功。
  const market = createMarketSurface({
    config: { allowlist: [...(options.marketAllowlist ?? [])] },
    tools: toolRegistry.all(),
    context: contextCalls,
  });
  const admit = vi.fn(options.admit ?? (() => null));
  const handle = createPanelStateHandler({
    read,
    market,
    admit,
    now: () => FIXED_AS_OF,
    marketTimeoutMs: 50,
  });
  const stockHandle = createStockDetailHandler({ market, admit, now: () => FIXED_AS_OF });
  const historyHandle = createStockHistoryHandler({ market, admit, now: () => FIXED_AS_OF });
  return { ctx, read, market, admit, contextCalls, handle, stockHandle, historyHandle };
};

const stateRequest = (panel?: string, extra = ''): Request =>
  new Request(
    `https://dsh.example/api/luoome/state${panel === undefined ? '' : `?panel=${panel}${extra}`}`,
  );

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const toolNamesOf = (body: Record<string, unknown>): string[] =>
  Array.isArray(body.tools)
    ? body.tools.map((tool) => String((tool as { name?: unknown }).name))
    : [];

describe('panel state route', () => {
  it('serves the fixed overview mapping with no-store and projects ToolResult verbatim', async () => {
    const { handle } = await setup();
    const response = await handle(stateRequest('overview'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await bodyOf(response);
    expect(body.panel).toBe('overview');
    expect(body.asOf).toBe(FIXED_AS_OF.toISOString());
    expect(toolNamesOf(body)).toEqual([
      ...PANEL_PLANS.overview.read.map((call) => call.name),
      ...PANEL_PLANS.overview.market.map((call) => call.name),
    ]);
    const tools = body.tools as { name: string; ok: boolean; data?: unknown; error?: unknown }[];
    const accounts = tools.find((tool) => tool.name === 'list_accounts');
    expect(accounts?.ok).toBe(true);
    expect(((accounts?.data ?? {}) as { total?: number }).total).toBeGreaterThan(0);
    for (const call of PANEL_PLANS.overview.market) {
      const entry = tools.find((tool) => tool.name === call.name);
      expect(entry?.ok).toBe(false);
      expect(((entry?.error ?? {}) as { kind?: string }).kind).toBe('permission_denied');
    }
    // 服务端派生的固定输入（当日 A 股交易日）不接受 HTTP 覆盖，但必须是可调用参数。
    const sentiment = PANEL_PLANS.overview.market.find(
      (call) => call.name === 'get_ashare_sentiment',
    );
    const sentimentInput =
      typeof sentiment?.input === 'function' ? sentiment.input(FIXED_AS_OF) : sentiment?.input;
    expect(sentimentInput?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('publishes the trading session and the next session start for client scheduling', async () => {
    const { handle } = await setup();
    const body = await bodyOf(await handle(stateRequest('overview')));
    // FIXED_AS_OF = 2026-10-25T04:00:00Z = 上海周日 12:00
    expect(body.session).toEqual({
      marketSession: 'non-trading-day',
      nextSessionStart: new Date('2026-10-26T09:30:00+08:00').toISOString(),
    });
  });

  it.each([
    ['2026-10-25T04:00:00Z', '2026-10-23'],
    ['2026-10-01T04:00:00Z', '2026-09-30'],
    ['2026-10-23T04:00:00Z', '2026-10-23'],
  ])('requests sentiment for the latest trading day at %s', (at, expected) => {
    const call = PANEL_PLANS.overview.market.find((entry) => entry.name === 'get_ashare_sentiment');
    if (!call || typeof call.input !== 'function') throw new Error('Missing sentiment call');
    expect(call.input(new Date(at))).toEqual({ date: expected });
  });

  it('returns only panel names and rejects unknown or extra query input', async () => {
    const { handle, contextCalls } = await setup();
    for (const uri of ['', '?panel=unknown', '?panel=overview&tool=list_accounts']) {
      const response = await handle(new Request(`https://dsh.example/api/luoome/state${uri}`));
      expect([400, 404]).toContain(response.status);
    }
    const unknown = await handle(stateRequest('admin'));
    expect(unknown.status).toBe(404);
    expect((await bodyOf(unknown)).ok).toBe(false);
    // 拒绝发生在任何工具执行之前。
    expect(contextCalls).not.toHaveBeenCalled();
  });

  it('allows only GET and passes host admission rejections through untouched', async () => {
    const rejection = new Response('unauthorized', { status: 401 });
    const admitted = await setup({ admit: () => rejection });
    expect(await admitted.handle(stateRequest('review'))).toBe(rejection);
    expect(admitted.contextCalls).not.toHaveBeenCalled();

    const throwing = await setup({
      admit: () => {
        throw new Error('secret');
      },
    });
    const forbidden = await throwing.handle(stateRequest('review'));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain('secret');

    const { handle } = await setup();
    const post = await handle(
      new Request('https://dsh.example/api/luoome/state?panel=overview', { method: 'POST' }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('projects strategies catalog plus per-strategy workspace derived from list_strategies', async () => {
    const { handle, ctx } = await setup();
    await seedStrategy(ctx);
    const response = await handle(stateRequest('strategies'));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const tools = body.tools as { name: string; ok: boolean; data?: unknown }[];
    const listed = tools.find((tool) => tool.name === 'list_strategies');
    expect(listed?.ok).toBe(true);
    expect(((listed?.data ?? {}) as { total?: number }).total).toBe(1);
    const strategies = body.strategies as
      | { strategyId: string; workspace: { name: string; ok: boolean; data?: unknown } }[]
      | undefined;
    expect(strategies).toHaveLength(1);
    expect(strategies?.[0]?.strategyId).toBe('direction-a');
    expect(strategies?.[0]?.workspace.name).toBe('get_strategy_workspace');
    expect(strategies?.[0]?.workspace.ok).toBe(true);
    const workspace = strategies?.[0]?.workspace.data as {
      currentVersion?: { id?: string };
      currentRun?: { id?: string };
      currentRunVersion?: { id?: string };
      matches?: {
        total: number;
        rows: {
          stock: { stockId: string; stockName: string };
          result: { selected: boolean; score: number };
        }[];
      };
      overview?: { health?: string };
    };
    expect(workspace.currentVersion?.id).toBe('direction-a-v1');
    expect(workspace.currentRun?.id).toBe('direction-a-run');
    expect(workspace.currentRunVersion?.id).toBe('direction-a-v1');
    expect(workspace.matches?.total).toBe(1);
    expect(workspace.matches?.rows[0]).toMatchObject({
      stock: { stockId: '600519.SH', stockName: '贵州茅台' },
      result: { selected: true, score: 60 },
    });
    expect(workspace.overview?.health).toBe('ready');
  });

  it('passes the strategy id to per-strategy schedule/subscription reads and keeps absent vs active state', async () => {
    const { handle, ctx, read } = await setup();
    expect(readNames()).toContain('get_strategy_schedule');
    expect(readNames()).toContain('list_strategy_watchlist_subscriptions');
    await seedStrategy(ctx);
    await seedScheduleAndSubscription(ctx);
    // 第二条策略没有 schedule 也没有订阅：合法的空配置必须原样保留为 null/空。
    await ctx.repos.strategy.create({
      id: 'direction-b',
      name: '未配置调度策略',
      description: '没有 schedule 与订阅的面板验收策略',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    const invoke = vi.spyOn(read, 'invoke');
    const response = await handle(stateRequest('strategies'));
    expect(response.status).toBe(200);
    const inputsOf = (tool: string) =>
      invoke.mock.calls
        .filter(([name]) => name === tool)
        .map(([, input]) => input as Record<string, unknown>);
    for (const tool of [
      'get_strategy_workspace',
      'get_strategy_schedule',
      'list_strategy_watchlist_subscriptions',
    ]) {
      const inputs = inputsOf(tool);
      expect(inputs.map((input) => input.strategyId).sort()).toEqual([
        'direction-a',
        'direction-b',
      ]);
      // 派生调用的输入只有服务端写死的 strategyId，不接受 HTTP 侧任何额外字段。
      for (const input of inputs) expect(Object.keys(input)).toEqual(['strategyId']);
    }
    const body = await bodyOf(response);
    const strategies = body.strategies as {
      strategyId: string;
      schedule: { name: string; ok: boolean; data?: { schedule: unknown } };
      subscriptions: {
        name: string;
        ok: boolean;
        data?: { total: number; subscriptions: Record<string, unknown>[] };
      };
    }[];
    const byId = new Map(strategies.map((entry) => [entry.strategyId, entry]));
    const configured = byId.get('direction-a');
    expect(configured?.schedule).toMatchObject({ name: 'get_strategy_schedule', ok: true });
    expect(configured?.schedule.data?.schedule).toMatchObject({
      strategyId: 'direction-a',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
    });
    expect(configured?.subscriptions).toMatchObject({
      name: 'list_strategy_watchlist_subscriptions',
      ok: true,
    });
    expect(configured?.subscriptions.data?.total).toBe(1);
    expect(configured?.subscriptions.data?.subscriptions[0]).toMatchObject({
      strategyId: 'direction-a',
      watchlistId: 'watchlist-a',
      sourceKey: 'strategy:direction-a',
      status: 'active',
    });
    const unconfigured = byId.get('direction-b');
    expect(unconfigured?.schedule).toMatchObject({ name: 'get_strategy_schedule', ok: true });
    expect(unconfigured?.schedule.data?.schedule).toBeNull();
    expect(unconfigured?.subscriptions).toMatchObject({
      name: 'list_strategy_watchlist_subscriptions',
      ok: true,
    });
    expect(unconfigured?.subscriptions.data).toEqual({ subscriptions: [], total: 0 });
  });

  it('projects per-strategy read failures as errors instead of empty configuration', async () => {
    // 调度/订阅工具不在 allowlist 时必须原样投影 permission_denied，
    // 不能把失败伪装成 schedule=null 或空订阅列表（库里其实有配置）。
    const { handle, ctx } = await setup({
      allowlist: readNames().filter(
        (name) =>
          name !== 'get_strategy_schedule' && name !== 'list_strategy_watchlist_subscriptions',
      ),
    });
    await seedStrategy(ctx);
    await seedScheduleAndSubscription(ctx);
    const response = await handle(stateRequest('strategies'));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const strategies = body.strategies as {
      strategyId: string;
      workspace: { ok: boolean };
      schedule: { name: string; ok: boolean; data?: unknown; error?: { kind: string } };
      subscriptions: { name: string; ok: boolean; data?: unknown; error?: { kind: string } };
    }[];
    const entry = strategies.find((item) => item.strategyId === 'direction-a');
    expect(entry?.workspace.ok).toBe(true);
    expect(entry?.schedule).toMatchObject({
      name: 'get_strategy_schedule',
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(entry?.schedule.data).toBeUndefined();
    expect(entry?.subscriptions).toMatchObject({
      name: 'list_strategy_watchlist_subscriptions',
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(entry?.subscriptions.data).toBeUndefined();
  });

  it('serves review facts without recomputing stats or calibration', async () => {
    const { handle } = await setup();
    const body = await bodyOf(await handle(stateRequest('review')));
    const tools = body.tools as { name: string; ok: boolean; data?: unknown }[];
    for (const call of PANEL_PLANS.review.read) {
      expect(tools.some((tool) => tool.name === call.name)).toBe(true);
    }
    const stats = tools.find((tool) => tool.name === 'get_advice_stats');
    expect(stats?.ok).toBe(true);
    expect(((stats?.data ?? {}) as { schemaVersion?: number }).schemaVersion).toBe(2);
    const calibration = tools.find((tool) => tool.name === 'get_confidence_calibration');
    expect(calibration?.ok).toBe(true);
    expect(((calibration?.data ?? {}) as { schemaVersion?: number }).schemaVersion).toBe(2);
    expect(((calibration?.data ?? {}) as { buckets?: unknown[] }).buckets).toHaveLength(10);
    const reviews = tools.find((tool) => tool.name === 'list_decision_reviews');
    expect(reviews?.ok).toBe(true);
    expect(((reviews?.data ?? {}) as { records?: unknown[] }).records).toEqual([]);
  });

  it('never exposes write, queue or trade tools through the fixed panel mapping', () => {
    for (const panel of PANEL_NAMES) {
      for (const call of PANEL_PLANS[panel].read) {
        const tool = toolRegistry.get(call.name);
        expect(tool, `${call.name} 不在 registry`).toBeDefined();
        expect(tool?.sideEffect).toBe('read');
        expect(tool?.requiredCapabilities ?? []).not.toContain('write');
        expect(tool?.requiredCapabilities ?? []).not.toContain('queue');
        expect(tool?.requiredCapabilities ?? []).not.toContain('trade');
      }
      for (const call of PANEL_PLANS[panel].market) {
        const tool = toolRegistry.get(call.name);
        expect(tool, `${call.name} 不在 registry`).toBeDefined();
        expect(tool?.sideEffect).toBe('external');
      }
    }
    const mapped = new Set([...readNames(), ...marketNames()]);
    for (const forbidden of [
      'record_advice',
      'record_analysis_result',
      'save_decision_review',
      'create_strategy',
      'publish_strategy_version',
      'record_advice_outcome',
      'claim_analysis_jobs',
      'add_trade',
      'record_decision_trade',
    ])
      expect(mapped.has(forbidden)).toBe(false);
  });

  it('projects ToolResult failures and rejects disposed surfaces after disposal', async () => {
    expect(
      projectPanelTool('list_accounts', {
        ok: false,
        error: { kind: 'not_found', entity: 'Account', id: 'missing' },
      }),
    ).toEqual({
      name: 'list_accounts',
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: 'missing' },
    });
    const { handle, read, market } = await setup();
    read.dispose();
    market.dispose();
    const body = await bodyOf(await handle(stateRequest('overview')));
    const tools = body.tools as { ok: boolean; error?: { kind?: string } }[];
    expect(tools.every((tool) => tool.ok === false)).toBe(true);
    expect(tools.every((tool) => tool.error?.kind === 'permission_denied')).toBe(true);
  });
});

describe('stock detail route', () => {
  const request = (query = 'stockId=600519.SH') =>
    new Request(`https://dsh.example/api/luoome/stock?${query}`);

  it('projects one stock through the opted-in market tool and preserves quote provenance', async () => {
    const { stockHandle } = await setup({ marketAllowlist: ['fetch_quote'] });
    const response = await stockHandle(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      quote: { data: { quote: { stockId: string }; retrieval: string } };
    };
    expect(body).toMatchObject({
      stockId: '600519.SH',
      asOf: FIXED_AS_OF.toISOString(),
      quote: { name: 'fetch_quote', ok: true },
    });
    expect(body.quote.data).toMatchObject({ retrieval: 'live', quote: { stockId: '600519.SH' } });
  });

  it('does not enable external access implicitly or turn denied quotes into empty success', async () => {
    const { stockHandle } = await setup();
    const body = (await (await stockHandle(request())).json()) as {
      quote: { ok: boolean; data?: unknown; error?: { kind: string } };
    };
    expect(body.quote).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(body.quote.data).toBeUndefined();
  });

  it('can load a complete stock code before it has a local stock row', async () => {
    const { ctx, stockHandle } = await setup({ marketAllowlist: ['fetch_quote'] });
    expect(await ctx.repos.stock.findById('601398.SH')).toBeNull();
    const body = (await (await stockHandle(request('stockId=601398.SH'))).json()) as {
      quote: { ok: boolean; data: { quote: { stockId: string } } };
    };
    expect(body.quote.ok).toBe(true);
    expect(body.quote.data.quote.stockId).toBe('601398.SH');
  });

  it('rejects invalid or extra input before any tool runs', async () => {
    const { stockHandle, contextCalls } = await setup({ marketAllowlist: ['fetch_quote'] });
    for (const query of [
      '',
      'stockId=NOPE',
      'stockId=600519.SH&stockId=000001.SZ',
      'stockId=600519.SH&tool=add_trade',
      'stockId=600519.SH&stockName=override',
    ]) {
      expect((await stockHandle(request(query))).status).toBe(400);
    }
    expect(contextCalls).not.toHaveBeenCalled();
  });

  it('keeps host admission and method restrictions', async () => {
    const rejection = new Response(null, { status: 401 });
    const { stockHandle, contextCalls } = await setup({ admit: () => rejection });
    expect(await stockHandle(request())).toBe(rejection);
    expect(contextCalls).not.toHaveBeenCalled();
    const method = await stockHandle(
      new Request('https://dsh.example/api/luoome/stock', { method: 'POST' }),
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
    const throwing = await setup({
      admit: () => {
        throw new Error('secret');
      },
    });
    expect((await throwing.stockHandle(request())).status).toBe(403);
  });
});

describe('fixed stock history route', () => {
  const request = (query = 'stockId=600519.SH') =>
    new Request(`https://dsh.example/api/luoome/stock/history?${query}`);

  it('returns actual market-view candles with a fixed bounded history input', async () => {
    const { historyHandle, market } = await setup({ marketAllowlist: ['get_stock_market_view'] });
    const invoke = vi.spyOn(market, 'invoke');
    const response = await historyHandle(request());
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      'get_stock_market_view',
      { stockId: '600519.SH', range: '3m', granularity: 'day', strategySignalScope: 'operational' },
    ]);
    const body = (await response.json()) as {
      marketView: { ok: boolean; data: { candles: unknown[]; dataStatus: unknown } };
    };
    expect(body.marketView.ok).toBe(true);
    expect(body.marketView.data.candles.length).toBeGreaterThan(0);
    expect(body.marketView.data.dataStatus).toBeDefined();
  });

  it('keeps unavailable history unavailable and denies arbitrary dates, ranges and accounts', async () => {
    const { historyHandle, market } = await setup();
    expect(await (await historyHandle(request())).json()).toMatchObject({
      marketView: { ok: false, error: { kind: 'permission_denied' } },
    });
    const invoke = vi.spyOn(market, 'invoke');
    for (const query of [
      'stockId=600519.SH&date=2026-01-01',
      'stockId=600519.SH&range=1y',
      'stockId=600519.SH&accountId=foreign',
      'stockId=600519.SH&stockId=000001.SZ',
    ])
      expect((await historyHandle(request(query))).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    const rejected = new Response(null, { status: 401 });
    expect(await (await setup({ admit: () => rejected })).historyHandle(request())).toBe(rejected);
  });
});
