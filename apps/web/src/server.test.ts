// apps/web 闸口矩阵测试（bun runner：server.ts 顶层 import @luoome/db → bun:sqlite，
// node/vitest 无法解析，已在 vitest.config.ts exclude；由 `bun run test:web` 执行）。
// ctx 用 buildTestContext（in-memory repos）注入 createWebApp，不走真实 SQLite 文件。

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { buildTestContext } from '@luoome/tools/testing';
import type { Hono } from 'hono';

import { buildWebContext, createWebApp, resolveWebToken } from './server.js';

let app: Hono;
const WEB_TOKEN = 'test-web-token';

beforeAll(async () => {
  app = createWebApp(await buildTestContext(), { webToken: WEB_TOKEN });
});

const callTool = async (name: string, input: unknown): Promise<Response> =>
  app.fetch(
    new Request(`http://test/api/tools/${name}/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WEB_TOKEN}`,
      },
      body: JSON.stringify({ input }),
    }),
  );

const json = async (r: Response): Promise<{ ok: boolean; data?: never; error?: never }> =>
  (await r.json()) as { ok: boolean; data?: never; error?: never };

describe('Web token bootstrap', () => {
  it('无 env 时生成并复用数据库同目录的 0600 token 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-web-token-'));
    const previous = process.env.LUOOME_WEB_TOKEN;
    delete process.env.LUOOME_WEB_TOKEN;
    try {
      const first = resolveWebToken(join(dir, 'luoome.db'));
      const second = resolveWebToken(join(dir, 'luoome.db'));
      expect(first.filePath).toBe(join(dir, 'web-token'));
      expect(second.token).toBe(first.token);
      expect(readFileSync(first.filePath ?? '', 'utf8').trim()).toBe(first.token);
      expect(statSync(first.filePath ?? '').mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.LUOOME_WEB_TOKEN;
      else process.env.LUOOME_WEB_TOKEN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Web runtime bootstrap', () => {
  it('starts with an empty database and never inserts sample records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-empty-runtime-'));
    try {
      const ctx = await buildWebContext(join(dir, 'luoome.db'), {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_LLM_PROVIDER: 'openai-compatible',
        LUOOME_LLM_API_KEY: 'test-key-not-used',
      });
      expect(await ctx.repos.account.list()).toEqual([]);
      expect(await ctx.repos.stock.search('')).toEqual([]);
      expect(await ctx.repos.holding.listByAccount('')).toEqual([]);
      expect(await ctx.repos.trade.listByAccount('')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('非 loopback API 鉴权模式', () => {
  it('read API 也要求 Bearer token', async () => {
    const protectedApp = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      requireApiToken: true,
    });
    const denied = await protectedApp.fetch(new Request('http://lan/api/holdings'));
    expect(denied.status).toBe(403);
    const allowed = await protectedApp.fetch(
      new Request('http://lan/api/holdings', {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe('web tool 闸口：write 需本地 token', () => {
  it('write/external 缺 token → 403，read 仍可用', async () => {
    const write = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { stockId: '601398.SH', side: 'buy', quantity: 1, price: 7.25 },
        }),
      }),
    );
    expect(write.status).toBe(403);

    const read = await app.fetch(
      new Request('http://test/api/tools/list_holdings/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      }),
    );
    expect(read.status).toBe(200);
  });

  it('跨站 Origin 即使 token 正确也拒绝 mutation', async () => {
    const r = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
          origin: 'https://evil.example',
        },
        body: JSON.stringify({
          input: { stockId: '601398.SH', side: 'buy', quantity: 1, price: 7.25 },
        }),
      }),
    );
    expect(r.status).toBe(403);
  });

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

  it('create_account → 200 且可切换为空持仓账户', async () => {
    const created = await callTool('create_account', {
      id: 'web-real-account',
      name: 'Web 真实账户',
      currency: 'CNY',
      initialCapital: 100_000,
    });
    expect(created.status).toBe(200);
    const selected = await app.fetch(
      new Request('http://test/api/account/select', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ accountId: 'web-real-account' }),
      }),
    );
    expect(selected.status).toBe(200);
    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      ok: boolean;
      data: { accountId: string; holdings: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.accountId).toBe('web-real-account');
    expect(body.data.holdings).toEqual([]);
    const restored = await app.fetch(
      new Request('http://test/api/account/select', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ accountId: TEST_ACCOUNT.id }),
      }),
    );
    expect(restored.status).toBe(200);
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
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: 'not-json',
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe('MVP dashboard / watch API', () => {
  it('dashboard 聚合持仓、分组、池、watch 状态与最近触发', async () => {
    const r = await app.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: {
        holdings: { holdings: unknown[] };
        groups: { groups: unknown[] };
        pools: { pools: unknown[] };
        watch: { state: string };
        triggers: { triggers: unknown[] };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.holdings.holdings.length).toBeGreaterThan(0);
    expect(body.data?.watch.state).toBe('never');
  });

  it('run-once 需要 token；成功后 watch status 可见', async () => {
    const denied = await app.fetch(
      new Request('http://test/api/watch/run-once', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notify: false }),
      }),
    );
    expect(denied.status).toBe(403);

    const run = await app.fetch(
      new Request('http://test/api/watch/run-once', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ notify: false }),
      }),
    );
    expect(run.status).toBe(200);

    const status = await app.fetch(new Request('http://test/api/watch/status'));
    const body = (await status.json()) as { data?: { state: string; latest: { mode: string } } };
    expect(body.data?.state).toBe('healthy');
    expect(body.data?.latest.mode).toBe('once');
  });
});

/* ============ /api/chat（docs/web-chat-design.md §6） ============ */

interface ChatResponseBody {
  ok: boolean;
  data?: {
    reply: string;
    drafts: Array<{ kind: string; tool: string; input: unknown; summary: string }>;
    usedActions: Array<{ tool: string; ok: boolean; rejected?: boolean }>;
  };
  error?: { kind: string; message?: string };
}

const chat = async (
  target: Hono,
  body: { message: string; history?: Array<{ role: string; content: string }> },
): Promise<{ status: number; body: ChatResponseBody }> => {
  const r = await target.fetch(
    new Request('http://test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: r.status, body: (await r.json()) as ChatResponseBody };
};

/** mock LLM chat fixture 注入：message 带前缀 + JSON plan（见 adapters/llm/mock.ts）。 */
const fixtureMsg = (plan: object): string => `chat-fixture:${JSON.stringify(plan)}`;

describe('/api/chat：对话助手', () => {
  let chatApp: Hono;
  let chatCtx: Awaited<ReturnType<typeof buildTestContext>>;

  beforeAll(async () => {
    chatCtx = await buildTestContext();
    chatApp = createWebApp(chatCtx);
  });

  it('mock LLM（无 fixture）→ 200 + 兜底 reply，不抛 500', async () => {
    const { status, body } = await chat(chatApp, { message: '你好' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.reply).toContain('暂时无法处理');
    expect(body.data?.drafts).toEqual([]);
    expect(body.data?.usedActions).toEqual([]);
  });

  it('message 为空 / 超长 → 400 invalid_input', async () => {
    expect((await chat(chatApp, { message: '' })).status).toBe(400);
    expect((await chat(chatApp, { message: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('plan 的 drafts（write）只进 drafts 不执行，DB 无写入', async () => {
    const { status, body } = await chat(chatApp, {
      message: fixtureMsg({
        reply: '已为你拟好分组草案，请确认。',
        actions: [],
        drafts: [
          {
            kind: 'stock-group',
            tool: 'create_stock_group',
            input: {
              id: 'chat-draft-group',
              name: '对话草案分组',
              resolver: { kind: 'llm', prompt: '选出当前龙头' },
            },
            summary: '创建 LLM 分组「对话草案分组」',
          },
        ],
      }),
    });
    expect(status).toBe(200);
    expect(body.data?.drafts.length).toBe(1);
    expect(body.data?.drafts[0]?.tool).toBe('create_stock_group');
    // 关键断言：draft 未被执行，库里不存在该分组
    expect(await chatCtx.repos.stockGroup.findById('chat-draft-group')).toBeNull();
  });

  it('幻觉 action（advice / write / external）被拦截并标 rejected，DB 无写入', async () => {
    const { status, body } = await chat(chatApp, {
      message: fixtureMsg({
        reply: '这几个操作我帮不了你。',
        actions: [
          { tool: 'analyze_stock', input: { stockId: '002594.SZ' } },
          { tool: 'create_stock_group', input: { id: 'hallucinated-group' } },
          { tool: 'sync_quotes', input: {} },
        ],
        drafts: [],
      }),
    });
    expect(status).toBe(200);
    const used = body.data?.usedActions ?? [];
    expect(used.length).toBe(3);
    expect(used.every((a) => a.rejected === true && a.ok === false)).toBe(true);
    expect(body.data?.reply).toContain('不在对话可用范围');
    expect(await chatCtx.repos.stockGroup.findById('hallucinated-group')).toBeNull();
  });

  it('read action 自动执行 + Pass 2 成文', async () => {
    const { status, body } = await chat(chatApp, {
      message: fixtureMsg({
        reply: '',
        actions: [{ tool: 'list_holdings', input: {} }],
        drafts: [],
        pass2Reply: '你当前持有 3 只股票。',
      }),
    });
    expect(status).toBe(200);
    expect(body.data?.usedActions).toEqual([{ tool: 'list_holdings', ok: true }]);
    expect(body.data?.reply).toBe('你当前持有 3 只股票。');
  });

  it('history 超过 10 轮被截断到 10', async () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));
    const { status, body } = await chat(chatApp, {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 字面占位符，由 mock LLM 替换为实际 history 轮数
      message: fixtureMsg({ reply: 'turns:${historyLength}', actions: [], drafts: [] }),
      history,
    });
    expect(status).toBe(200);
    expect(body.data?.reply).toBe('turns:10');
  });

  it('draft 二次校验失败被丢弃，reply 中说明', async () => {
    const { status, body } = await chat(chatApp, {
      message: fixtureMsg({
        reply: '拟好了草案。',
        actions: [],
        drafts: [
          {
            kind: 'stock-group',
            tool: 'create_stock_group',
            input: { id: 'BAD ID!!', name: '非法', resolver: { kind: 'manual', stockIds: [] } },
            summary: '非法草案',
          },
        ],
      }),
    });
    expect(status).toBe(200);
    expect(body.data?.drafts).toEqual([]);
    expect(body.data?.reply).toContain('已丢弃');
  });

  it('draft 的 kind 与 tool 不匹配被丢弃', async () => {
    const { status, body } = await chat(chatApp, {
      message: fixtureMsg({
        reply: '拟好了草案。',
        actions: [],
        drafts: [
          {
            kind: 'stock-pool',
            tool: 'create_stock_group',
            input: {
              id: 'kind-mismatch-group',
              name: 'x',
              resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
            },
            summary: 'kind 不匹配',
          },
        ],
      }),
    });
    expect(status).toBe(200);
    expect(body.data?.drafts).toEqual([]);
    expect(await chatCtx.repos.stockGroup.findById('kind-mismatch-group')).toBeNull();
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
    const testApp = createWebApp(await buildTestContext());
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

    const testApp = createWebApp(await buildTestContext());
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
