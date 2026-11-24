import { describe, expect, it } from 'bun:test';

import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { dateInShanghai, type StockBrief, StockBriefSchema } from '@luoome/core';
import { createPluginExecutionPolicy } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';

import { createWebApp } from '../server.js';

const FIXED_NOW = new Date('2026-11-24T09:30:00Z'); // 17:30 上海
const TRADING_DATE = dateInShanghai(FIXED_NOW);

const briefRow = (overrides: Record<string, unknown> = {}): StockBrief =>
  StockBriefSchema.parse({
    id: 'brief-1',
    tradingDate: TRADING_DATE,
    phase: 'post-market',
    accountId: TEST_ACCOUNT.id,
    stockId: '002594.SZ',
    source: 'scheduled',
    decision: 'buy',
    confidence: 64,
    horizon: 'short',
    quality: 'partial',
    factDigest: 'digest-abcdef0123456789',
    factsAsOf: FIXED_NOW,
    missing: [{ dimension: 'intraday', reason: '分时拉取失败：timeout' }],
    dataSources: ['eastmoney'],
    llmHttpCalls: 1,
    llmPromptTokens: 1200,
    llmCompletionTokens: 600,
    llmReasoningTokens: 200,
    llmCostUsd: 0,
    validUntil: new Date('2026-11-30T09:00:00Z'),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  });

const seedBriefs = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const now = ctx.clock();
  await ctx.repos.watchlist.save({
    id: 'wl-1',
    name: '测试关注池',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.watchlistMember.saveMember({
    id: 'member-002594',
    watchlistId: 'wl-1',
    stockId: '002594.SZ',
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: now,
    lastActivityAt: now,
  });
  await ctx.repos.stockBrief.upsert(briefRow({ id: 'brief-a' }));
  await ctx.repos.stockBrief.upsert(
    briefRow({
      id: 'brief-b',
      stockId: '600519.SH',
      quality: 'rule-only',
      decision: 'watch',
      confidence: 30,
      adviceId: undefined,
      missing: [{ dimension: 'news', reason: '未配置新闻数据源' }],
      dataSources: [],
    }),
  );
};

const context = () => buildTestContext({ advices: [], clock: () => FIXED_NOW });

const appOf = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  options: { exposeWrite?: boolean; exposeExternal?: boolean } = {},
) =>
  createWebApp(ctx, {
    exposeWrite: options.exposeWrite ?? true,
    exposeExternal: options.exposeExternal ?? true,
  });

const get = async (app: ReturnType<typeof createWebApp>, path: string) => {
  const response = await app.fetch(new Request(`http://test${path}`));
  return { status: response.status, body: (await response.json()) as unknown };
};

/** 计数型适配器：断言只读 GET 0 次 LLM / 0 次行情。 */
const withCounters = (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const calls = { llm: 0, market: 0 };
  const llm = {
    name: ctx.adapters.llm.name,
    generate: async () => {
      calls.llm += 1;
      throw new Error('read-only route must not call llm');
    },
  };
  const market = new Proxy(ctx.adapters.market, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls.market += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { ctx: { ...ctx, adapters: { ...ctx.adapters, llm, market } } as typeof ctx, calls };
};

describe('GET /api/stock-briefs', () => {
  it('按 stockId 返回 StockBriefView（wording / disclaimer / evidence / missing / budget）', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const app = await appOf(ctx);

    const { status, body } = await get(app, '/api/stock-briefs?stockId=002594.SZ');
    expect(status).toBe(200);
    const data = (body as { data: Record<string, unknown> }).data as unknown as {
      view: {
        wording: { label: string; disclaimer: string };
        disclaimer: string;
        isRuleOnly: boolean;
        evidence: Array<{ label: string; value: string | null; missing: boolean }>;
        missing: Array<{ dimension: string; reason: string }>;
        budget: { limit: { maxHttpCalls: number } };
      };
    };
    expect(data.view.wording.label).toBe('偏多信号');
    expect(data.view.disclaimer).toContain('不构成投资建议');
    expect(data.view.isRuleOnly).toBe(false);
    expect(data.view.evidence.some((row) => row.label === '数据来源')).toBe(true);
    expect(data.view.evidence.some((row) => row.missing && row.value === null)).toBe(true);
    expect(data.view.missing).toEqual([{ dimension: 'intraday', reason: '分时拉取失败：timeout' }]);
    expect(data.view.budget.limit.maxHttpCalls).toBe(16);
  });

  it('按 stockIds 批量与 watchlistId 查询', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const app = await appOf(ctx);

    const batch = await get(app, '/api/stock-briefs?stockIds=002594.SZ,600519.SH');
    expect(batch.status).toBe(200);
    const batchData = (batch.body as { data: { items: Array<{ stockId: string }> } }).data;
    expect(batchData.items.map((item) => item.stockId).sort()).toEqual(['002594.SZ', '600519.SH']);

    const watchlist = await get(app, '/api/stock-briefs?watchlistId=wl-1');
    expect(watchlist.status).toBe(200);
    const watchlistData = (watchlist.body as { data: { items: Array<{ stockId: string }> } }).data;
    expect(watchlistData.items.map((item) => item.stockId)).toEqual(['002594.SZ']);
  });

  it('today 返回当日列表 + coverage + budget', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const app = await appOf(ctx);

    const { status, body } = await get(app, '/api/stock-briefs/today');
    expect(status).toBe(200);
    const data = (body as { data: Record<string, unknown> }).data as unknown as {
      date: string;
      items: Array<{ stockId: string; wording: { label: string } }>;
      coverage: { byQuality: { partial: number; ruleOnly: number } };
      budget: { date: string };
    };
    expect(data.date).toBe(TRADING_DATE);
    expect(data.items).toHaveLength(2);
    expect(data.coverage.byQuality).toMatchObject({ partial: 1, ruleOnly: 1 });
    expect(data.budget.date).toBe(TRADING_DATE);
  });

  it('插件未启用时 today / 列表带 plugin_disabled 降级，而不是静默空列表', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const policy = createPluginExecutionPolicy(
      { isEnabled: (id) => id !== 'business.analysis' },
      new Set(['read', 'advice', 'write', 'external']),
    );
    const app = await appOf({ ...ctx, executionPolicy: policy });

    const today = await get(app, '/api/stock-briefs/today');
    const todayData = (today.body as { data: { degradation?: { reason: string } } }).data;
    expect(todayData.degradation?.reason).toBe('plugin_disabled');

    const list = await get(app, '/api/stock-briefs?stockIds=002594.SZ');
    const listData = (list.body as { data: { degradation?: { reason: string } } }).data;
    expect(listData.degradation?.reason).toBe('plugin_disabled');
  });

  it('只读端点不触发 LLM / 行情', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const counter = withCounters(ctx);
    const app = await appOf(counter.ctx);

    expect((await get(app, '/api/stock-briefs?stockId=002594.SZ')).status).toBe(200);
    expect((await get(app, '/api/stock-briefs/today')).status).toBe(200);
    expect(counter.calls.llm).toBe(0);
    expect(counter.calls.market).toBe(0);
  });
});

describe('POST /api/stock-briefs/generate', () => {
  const post = async (
    app: ReturnType<typeof createWebApp>,
    body: Record<string, unknown>,
    origin = 'http://test',
  ) => {
    const response = await app.fetch(
      new Request('http://test/api/stock-briefs/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it('未开 write 或 external 时 403', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const noWrite = await appOf(ctx, { exposeWrite: false, exposeExternal: true });
    expect((await post(noWrite, { scope: 'stock', stockIds: ['002594.SZ'] })).status).toBe(403);

    const noExternal = await appOf(ctx, { exposeWrite: true, exposeExternal: false });
    expect((await post(noExternal, { scope: 'stock', stockIds: ['002594.SZ'] })).status).toBe(403);
  });

  it('跨站 Origin 403', async () => {
    const ctx = await context();
    await seedBriefs(ctx);
    const app = await appOf(ctx);
    const response = await post(app, { scope: 'stock', stockIds: ['002594.SZ'] }, 'http://evil');
    expect(response.status).toBe(403);
    expect((response.body as { error: { kind: string } }).error.kind).toBe('permission_denied');
  });

  it('成功时走 generate_stock_briefs，并按手动 Web 入口写 source=manual', async () => {
    const ctx = await context();
    const app = await appOf(ctx);
    const response = await post(app, {
      scope: 'stock',
      stockIds: ['002594.SZ'],
      phase: 'post-market',
      force: true,
    });
    expect(response.status).toBe(200);
    const briefs = await ctx.repos.stockBrief.findByDay({
      tradingDate: TRADING_DATE,
      accountId: TEST_ACCOUNT.id,
    });
    expect(briefs.some((brief) => brief.stockId === '002594.SZ')).toBe(true);
    expect(briefs.every((brief) => brief.source === 'manual')).toBe(true);
  });

  it('预算耗尽返回 429 + 部分结果（items + budget + degradation）', async () => {
    const ctx = await context();
    // 当日已用满 16 次 HTTP 预算（limit 默认 16）。
    await ctx.repos.stockBrief.upsert(briefRow({ id: 'budget-used', llmHttpCalls: 16 }));
    const app = await appOf(ctx);

    const response = await post(app, {
      scope: 'stock',
      stockIds: ['002594.SZ'],
      phase: 'post-market',
      force: true,
    });
    expect(response.status).toBe(429);
    const data = (response.body as { ok: boolean; data: Record<string, unknown> })
      .data as unknown as {
      items: Array<{ stockId: string; action: string }>;
      budget: { httpCalls: number };
      degradation: { reason: string };
    };
    expect((response.body as { ok: boolean }).ok).toBe(true);
    expect(data.degradation.reason).toBe('rate_limited');
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.budget.httpCalls).toBeGreaterThanOrEqual(16);
  });
});
