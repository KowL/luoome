// apps/web 闸口矩阵测试（bun runner：server.ts 顶层 import @luoome/db → bun:sqlite，
// node/vitest 无法解析，已在 vitest.config.ts exclude；由 `bun run test:web` 执行）。
// ctx 用 buildMockContext（in-memory repos）注入 createWebApp，不走真实 SQLite 文件。

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildMockContext } from '@luoome/tools';
import type { Hono } from 'hono';

import { createWebApp } from './server.js';

let app: Hono;

beforeAll(async () => {
  app = createWebApp(await buildMockContext());
});

const callTool = async (name: string, input: unknown): Promise<Response> =>
  app.fetch(
    new Request(`http://test/api/tools/${name}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }),
  );

const json = async (r: Response): Promise<{ ok: boolean; data?: never; error?: never }> =>
  (await r.json()) as { ok: boolean; data?: never; error?: never };

describe('web tool 闸口：write 默认放行', () => {
  it('add_trade（buy）建仓 → 200 且持仓可见', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'buy',
      quantity: 500,
      price: 7.25,
    });
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(true);

    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { stockId: string; quantity: number } }> };
    };
    const mine = body.data.holdings.find((h) => h.holding.stockId === '601398.SH');
    expect(mine?.holding.quantity).toBe(500);
  });

  it('add_trade（buy）加仓 → 200 且数量累加', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'buy',
      quantity: 300,
      price: 7.5,
    });
    expect(r.status).toBe(200);

    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { stockId: string; quantity: number } }> };
    };
    const mine = body.data.holdings.find((h) => h.holding.stockId === '601398.SH');
    expect(mine?.holding.quantity).toBe(800);
  });

  it('add_trade（sell）超卖 → 400 invalid_input', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'sell',
      quantity: 999_999,
      price: 7.5,
    });
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.ok).toBe(false);
  });

  it('update_holding / close_holding → 200', async () => {
    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { id: string } }> };
    };
    const id = body.data.holdings[0]?.holding.id;
    expect(id).toBeDefined();

    const u = await callTool('update_holding', { holdingId: id, avgCost: 7.1 });
    expect(u.status).toBe(200);
    expect((await json(u)).ok).toBe(true);

    const c = await callTool('close_holding', { holdingId: id });
    expect(c.status).toBe(200);
    expect((await json(c)).ok).toBe(true);

    // 平仓后默认（active）列表不再包含
    const after = await app.fetch(new Request('http://test/api/holdings'));
    const afterBody = (await after.json()) as {
      data: { holdings: Array<{ holding: { id: string } }> };
    };
    expect(afterBody.data.holdings.some((h) => h.holding.id === id)).toBe(false);
  });
});

describe('web tool 闸口：external 白名单与拒绝面', () => {
  it('fetch_quote（白名单）→ 200', async () => {
    const r = await callTool('fetch_quote', { stockId: '002594.SZ' });
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(true);
  });

  it('sync_quotes / send_notification（external 非白名单）→ 403', async () => {
    for (const name of ['sync_quotes', 'send_notification']) {
      const r = await callTool(name, {});
      expect(r.status).toBe(403);
      const body = (await json(r)) as { ok: boolean; error?: { kind: string } };
      expect(body.error?.kind).toBe('permission_denied');
    }
  });

  it('place_order（trade，契约未实现）→ 403 permission_denied', async () => {
    const r = await callTool('place_order', {});
    expect(r.status).toBe(403);
  });

  it('不存在的 tool → 404 not_found', async () => {
    const r = await callTool('no_such_tool', {});
    expect(r.status).toBe(404);
  });

  it('请求体非 JSON → 400 invalid_input', async () => {
    const r = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe('GET /api/stocks/search', () => {
  const originalAdshareUrl = process.env.ADSHARE_URL;
  const originalAdshareApiKey = process.env.ADSHARE_API_KEY;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalAdshareUrl === undefined) delete process.env.ADSHARE_URL;
    else process.env.ADSHARE_URL = originalAdshareUrl;
    if (originalAdshareApiKey === undefined) delete process.env.ADSHARE_API_KEY;
    else process.env.ADSHARE_API_KEY = originalAdshareApiKey;
    globalThis.fetch = originalFetch;
  });

  it('q 为空 → 400 invalid_input', async () => {
    const r = await app.fetch(new Request('http://test/api/stocks/search?q='));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error?: { kind: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('invalid_input');
  });

  it('未配置 ADSHARE_URL 时回退到本地 search_stocks', async () => {
    delete process.env.ADSHARE_URL;
    delete process.env.ADSHARE_API_KEY;
    const testApp = createWebApp(await buildMockContext());
    const r = await testApp.fetch(new Request('http://test/api/stocks/search?q=%E8%8C%85'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data?: { stocks: unknown[]; source: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.source).not.toBe('adshare');
    expect(body.data?.stocks.length).toBeGreaterThan(0);
  });

  it('adshare 返回结果时优先使用 adshare', async () => {
    process.env.ADSHARE_URL = 'http://adshare.test';
    process.env.ADSHARE_API_KEY = 'k';
    const mockFetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/stock_basic')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ ts_code: '600519.SH', name: '贵州茅台', industry: '白酒' }],
          }),
          text: async () => '',
          headers: new Headers(),
        } as Response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = mockFetch;

    const testApp = createWebApp(await buildMockContext());
    const r = await testApp.fetch(
      new Request('http://test/api/stocks/search?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0'),
    );
    globalThis.fetch = originalFetch;

    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: { stocks: Array<{ id: string }>; source: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.source).toBe('adshare');
    expect(body.data?.stocks[0]?.id).toBe('600519.SH');
  });
});
