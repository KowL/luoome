// @luoome/web —— 最小 Web 端（plan.md 跨包契约 / ARCHITECTURE §10）。
// Hono HTTP API + 同源静态仪表盘：
//   GET  /api/holdings            → list_holdings
//   GET  /api/advice              → get_advice（?subjectId=&includeExpired=）
//   GET  /api/advice/stats        → get_advice_stats
//   POST /api/tools/:name/call    → 仅放行 sideEffect 为 read/advice 的 tool；
//                                   write/external/trade 一律 403 permission_denied。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MOCK_NOW,
  defaultMockClock,
  MOCK_ACCOUNT,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
  MockLLMAdapter,
  MockMarketAdapter,
  mockAdviceFor,
} from '@luoome/adapters';
import type { SideEffect, ToolContext, ToolError, ToolResult } from '@luoome/core';
import { createDrizzleRepos, seedMockData } from '@luoome/db';
import { buildContext, toolRegistry } from '@luoome/tools';
import { Hono } from 'hono';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/** Web 端暴露面：与 MCP 默认一致，只放行 read + advice。 */
const EXPOSED_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(['read', 'advice']);

/**
 * v0.1 toolRegistry 只有 8 个 read/advice tool；AGENTS.md 工具清单里已命名的
 * write/external/trade tool 属于「存在但未在 web 暴露」——按契约返回
 * 403 permission_denied，而不是 404 not_found。
 */
const KNOWN_UNEXPOSED_TOOLS: Readonly<Record<string, SideEffect>> = {
  add_holding: 'write',
  update_holding: 'write',
  close_holding: 'write',
  add_trade: 'write',
  set_alert: 'write',
  delete_alert: 'write',
  add_note: 'write',
  update_config: 'write',
  fetch_quote: 'external',
  sync_quotes: 'external',
  send_notification: 'external',
  generate_report: 'external',
  place_order: 'trade',
  cancel_order: 'trade',
};

/** ToolResult 错误 → HTTP 状态码（响应体仍是 ToolResult 形状）。 */
const statusOf = (error: ToolError): number => {
  switch (error.kind) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'permission_denied':
      return 403;
    default:
      return 500;
  }
};

const jsonResult = (result: ToolResult<unknown>): Response =>
  new Response(JSON.stringify(result), {
    status: result.ok ? 200 : statusOf(result.error),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const permissionDenied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

const notFound = (entity: string, id: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity, id },
});

/** 缺省数据库路径：$LUOOME_HOME/luoome.db（LUOOME_HOME 缺省 ~/.luoome）。 */
export const resolveDbPath = (): string => {
  const home = process.env.LUOOME_HOME ?? join(homedir(), '.luoome');
  return join(home, 'luoome.db');
};

/**
 * 种子建议时钟：取 max(mock 锚点 DEFAULT_MOCK_NOW, 真实时间)。
 * 业务 ctx.clock 固定为 DEFAULT_MOCK_NOW（mock 行情 ts 确定性），但 advice 过期
 * 过滤在 repo 层按 Date.now() 真实时间进行；若种子按 mock 时钟生成，真实时间
 * 越过 validUntil 后 /api/advice 默认查询会看不到种子建议。取 max 保证两口径
 * 下种子建议稳定可见；id 由 stockId 哈希决定，upsert 幂等。
 */
const seedAdviceClock = (): Date => new Date(Math.max(DEFAULT_MOCK_NOW.getTime(), Date.now()));

/**
 * 组装 web 端 ToolContext（与其他 surface 同一模式）：
 * LUOOME_HOME 下的 luoome.db + createDrizzleRepos + seedMockData(fixtures)
 * + MockMarketAdapter/MockLLMAdapter + buildContext。
 *
 * v0.1 演示口径：每次启动幂等重灌 mock fixtures（repo save 为 upsert、
 * fixture id 固定；advice 种子与 buildMockContext 对齐，保证首屏有数据）。
 * 业务 clock 与 mock adapters 的锚点（DEFAULT_MOCK_NOW）对齐，保证 mock 行情 ts
 * 确定性；种子建议的有效期口径见 seedAdviceClock 注释。
 */
export const buildWebContext = async (dbPath: string): Promise<ToolContext> => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = createDrizzleRepos(dbPath);
  await seedMockData(handle.repos, {
    accounts: [MOCK_ACCOUNT],
    stocks: MOCK_STOCKS,
    holdings: MOCK_HOLDINGS,
    trades: MOCK_TRADES,
    advices: [
      mockAdviceFor('002594.SZ', seedAdviceClock),
      mockAdviceFor('600519.SH', seedAdviceClock),
    ],
  });
  return buildContext({
    repos: handle.repos,
    adapters: { market: new MockMarketAdapter(), llm: new MockLLMAdapter() },
    clock: defaultMockClock,
    user: { id: 'local-web-user', defaultAccountId: MOCK_ACCOUNT.id },
  });
};

/** 构造 Hono app（注入 ctx，便于测试与复用）。 */
export const createWebApp = (ctx: ToolContext): Hono => {
  const app = new Hono();

  // —— 同源静态仪表盘（原生 HTML/JS，无构建步骤）——
  const serveFile = (file: string, contentType: string) => (): Response =>
    new Response(Bun.file(join(PUBLIC_DIR, file)), {
      headers: { 'content-type': contentType },
    });
  app.get('/', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', serveFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/style.css', serveFile('style.css', 'text/css; charset=utf-8'));

  // —— HTTP API（统一 ToolResult 形状）——
  const callTool = async (name: string, input: unknown): Promise<Response> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return jsonResult(notFound('Tool', name));
    return jsonResult(await tool.execute(input, ctx));
  };

  app.get('/api/holdings', () => callTool('list_holdings', {}));

  app.get('/api/advice', (c) => {
    const subjectId = c.req.query('subjectId');
    const includeExpired = c.req.query('includeExpired');
    const input: Record<string, unknown> = {
      includeExpired: includeExpired === 'true' || includeExpired === '1',
    };
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    return callTool('get_advice', input);
  });

  app.get('/api/advice/stats', (c) => {
    const subjectId = c.req.query('subjectId');
    const input: Record<string, unknown> = {};
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    return callTool('get_advice_stats', input);
  });

  app.post('/api/tools/:name/call', async (c) => {
    const name = c.req.param('name');
    const tool = toolRegistry.get(name);

    if (tool === undefined) {
      const known = KNOWN_UNEXPOSED_TOOLS[name];
      if (known !== undefined) {
        return jsonResult(permissionDenied(`sideEffect=${known} 的 tool 不通过 web 暴露`));
      }
      return jsonResult(notFound('Tool', name));
    }
    if (!EXPOSED_SIDE_EFFECTS.has(tool.sideEffect)) {
      return jsonResult(
        permissionDenied(`web 端仅暴露 read/advice（${name} 为 ${tool.sideEffect}）`),
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是 JSON：{ "input": {...} }',
          issues: [],
        },
      });
    }
    const input =
      typeof body === 'object' && body !== null && 'input' in body
        ? (body as { input: unknown }).input
        : {};
    return jsonResult(await tool.execute(input, ctx));
  });

  return app;
};

export interface StartWebOptions {
  readonly port: number;
  /** 缺省 resolveDbPath()（$LUOOME_HOME/luoome.db）。 */
  readonly dbPath?: string;
}

/** 启动 web server，返回 Bun server 句柄（调用方可 close()）。 */
export const startWeb = async (options: StartWebOptions): Promise<Bun.Server<undefined>> => {
  const ctx = await buildWebContext(options.dbPath ?? resolveDbPath());
  const app = createWebApp(ctx);
  const server = Bun.serve({ port: options.port, fetch: app.fetch });
  ctx.logger.info(`luoome web 已启动: http://localhost:${server.port}`);
  return server;
};
