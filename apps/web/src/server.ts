// @luoome/web —— 最小 Web 端（plan.md 跨包契约 / ARCHITECTURE §10）。
// Hono HTTP API + 同源静态仪表盘：
//   GET  /api/holdings            → list_holdings
//   GET  /api/advice              → get_advice（?subjectId=&includeExpired=）
//   GET  /api/advice/stats        → get_advice_stats
//   POST /api/tools/:name/call    → 放行 read/advice/write（ARCHITECTURE §7.1：Web 默认
//                                   含 write）+ 白名单 external（fetch_quote）；其余
//                                   external / trade 一律 403 permission_denied。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMarketAdapterFromEnv,
  DEFAULT_MOCK_NOW,
  defaultMockClock,
  LLMManager,
  MOCK_ACCOUNT,
  MOCK_ACCOUNTS,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
  mockAdviceFor,
} from '@luoome/adapters';
import type { SideEffect, ToolContext, ToolError, ToolResult } from '@luoome/core';
import { createDrizzleRepos, seedMockData } from '@luoome/db';
import { buildContext, toolRegistry } from '@luoome/tools';
import { Hono } from 'hono';

import { handleChat } from './chat.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Web 端暴露面（对齐 ARCHITECTURE §7.1）：默认放行 read + advice + write。
 * 本地单用户工具，write（持仓 / 交易录入等）是 Web 持仓管理的基础能力；
 * MCP 暴露面不受影响（仍 read+advice 默认，write 需 LUOOME_EXPOSE_WRITE）。
 */
const EXPOSED_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(['read', 'advice', 'write']);

/**
 * external 白名单：fetch_quote 仅写本地 PriceSnapshot（无外部副作用外的状态变更），
 * 持仓表单「取现价」需要；sync_quotes / send_notification 等仍 403。
 */
const WEB_ALLOWED_EXTERNAL: ReadonlySet<string> = new Set(['fetch_quote']);

/**
 * external（白名单外）/trade tool 不通过 web 暴露：已在 registry 实现的被
 * sideEffect 门拦截（403 文案准确）；本表覆盖「契约里有名字但尚未实现」的
 * tool——同样按契约返回 403 permission_denied，而不是 404 not_found。
 * （write 已默认放行，未实现的 write 类契约 tool 走 not_found。）
 */
const KNOWN_UNEXPOSED_TOOLS: Readonly<Record<string, SideEffect>> = {
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
 * + 行情 factory / LLMManager（分别由 LUOOME_MARKET_PROVIDER / LUOOME_LLM_PROVIDER 路由，默认 mock）+ buildContext。
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
    accounts: MOCK_ACCOUNTS,
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
    adapters: {
      // 行情源由 LUOOME_MARKET_PROVIDER 路由（默认 mock；real = Eastmoney→Tencent→Mock）
      market: createMarketAdapterFromEnv(process.env, { logger: console }),
      // LLM 由 LUOOME_LLM_PROVIDER 路由（默认 mock；real 缺 key 启动期报错）
      llm: new LLMManager({ logger: console }),
    },
    clock: defaultMockClock,
    user: { id: 'local-web-user', defaultAccountId: MOCK_ACCOUNT.id },
  });
};

/** 构造 Hono app（注入 ctx，便于测试与复用）。 */
/**
 * 构造 Hono app（注入 ctx，便于测试与复用）。
 * 接受 ctx 引用对象 { current } 而非裸 ToolContext——v0.5 W3 多账户切换通过
 * /api/account/select 改写 ctxRef.current.user.defaultAccountId，其它路由通过
 * ctxRef.current 取最新值，不再每次请求 mutate 全量 ctx。
 */
export const createWebApp = (initialCtx: ToolContext): Hono => {
  // 多账户切换（v0.5 W3）通过 ctxRef.current mutate user.defaultAccountId；
  // 内部 callTool / invokeTool 全部走 ctxRef.current 读取最新值。
  const ctxRef: { current: ToolContext } = { current: initialCtx };
  const app = new Hono();

  // —— 同源静态仪表盘（原生 HTML/JS，无构建步骤）——
  const serveFile = (file: string, contentType: string) => (): Response =>
    new Response(Bun.file(join(PUBLIC_DIR, file)), {
      headers: { 'content-type': contentType },
    });
  app.get('/', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/style.css', serveFile('style.css', 'text/css; charset=utf-8'));
  app.get('/tactics', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/holdings', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/advice', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/settings', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/review', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/chat', serveFile('index.html', 'text/html; charset=utf-8'));

  // /js/* 静态文件（v0.4 起拆成模块；无构建步骤，直接读取 public/js/）。
  app.get('/js/:filename', (c) => {
    const filename = c.req.param('filename');
    if (filename.includes('/') || filename.includes('..')) {
      return new Response('forbidden', { status: 403 });
    }
    return new Response(Bun.file(join(PUBLIC_DIR, 'js', filename)), {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  });

  // —— HTTP API（统一 ToolResult 形状）——
  const callTool = async (name: string, input: unknown): Promise<Response> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return jsonResult(notFound('Tool', name));
    return jsonResult(await tool.execute(input, ctxRef.current));
  };

  /**
   * 内部组合调用：直接返回 ToolResult（不包 Response），便于在 /api/tactics/scan、
   * /api/review 等聚合端点中串多个 tool 后再统一 wrap。
   */
  const invokeTool = async (name: string, input: unknown): Promise<ToolResult<unknown>> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return notFound('Tool', name);
    return tool.execute(input, ctxRef.current);
  };

  // ===== 多账户切换（v0.5 W3）端点 =====
  // 全部账户列表（用于顶栏下拉）。
  app.get('/api/accounts', () => callTool('list_accounts', {}));

  /**
   * 切换当前激活账户：把 ctxRef.current.user.defaultAccountId 更新为指定账户。
   * 单进程单 tab 假设（与现有 TUI / CLI 一致）：ctx 共享内存仓，切换是 mutate。
   * 调用侧只需要再 reload 受影响的数据视图（持仓 / 战法扫描 / 复盘）。
   */
  app.post('/api/account/select', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是合法 JSON',
          issues: [],
        },
      });
    }
    const parsed = body as { accountId?: unknown };
    if (typeof parsed.accountId !== 'string' || parsed.accountId.length === 0) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'accountId 必填且为非空字符串',
          issues: [],
        },
      });
    }
    const accountResult = await invokeTool('list_accounts', {});
    if (!accountResult.ok) return jsonResult(accountResult);
    const accounts = (accountResult.data as { accounts: Array<{ id: string; name: string }> })
      .accounts;
    const target = accounts.find((a) => a.id === parsed.accountId);
    if (target === undefined) {
      return jsonResult({
        ok: false,
        error: { kind: 'not_found', entity: 'Account', id: parsed.accountId },
      });
    }
    ctxRef.current = {
      ...ctxRef.current,
      user: { ...ctxRef.current.user, defaultAccountId: target.id },
    };
    return jsonResult({
      ok: true,
      data: { currentAccountId: target.id, account: target },
    });
  });

  app.get('/api/holdings', () => callTool('list_holdings', {}));

  // 对话助手（web 内部端点，不进 toolRegistry；docs/web-chat-design.md）。
  // LLM 失败 / parse 失败一律走兜底 reply，不抛 500。
  app.post('/api/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是 JSON：{ "message": "...", "history"?: [...] }',
          issues: [],
        },
      });
    }
    return jsonResult(await handleChat(body, ctxRef.current, invokeTool));
  });

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

  // 战法列表（read；调 list_tactics includeBuiltins=true）
  app.get('/api/tactics', () => callTool('list_tactics', { includeBuiltins: true }));

  // 战法扫描（read + advice）：list_tactics → 并发 run_tactic × N → score_signals 精排 → top N。
  // 走 tool 直接串，等价 workflow tactic-scan；输出与 workflow 对齐。
  app.get('/api/tactics/scan', async (c) => {
    const topNRaw = c.req.query('topN');
    const topN = topNRaw === undefined ? 10 : Math.max(1, Math.min(50, Number(topNRaw) || 10));
    const scopeRaw = c.req.query('scope');
    const scope = scopeRaw === 'all-stocks' || scopeRaw === 'watchlist' ? scopeRaw : 'holdings';
    try {
      const listResult = await invokeTool('list_tactics', { includeBuiltins: true });
      if (!listResult.ok) return jsonResult(listResult);
      const list = listResult.data as { tactics: Array<{ id: string }> };
      const ids = list.tactics.map((t) => t.id);
      if (ids.length === 0) {
        return jsonResult({ ok: true, data: { ranked: [], totalTactics: 0, totalSignals: 0 } });
      }
      const runs = await Promise.all(
        ids.map((id) => invokeTool('run_tactic', { tacticId: id, scope })),
      );
      const okRuns = runs.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
      interface SignalRow {
        tacticId: string;
        tacticName: string;
        tacticTag: string;
        stockId: string;
        ts: Date;
        score: number;
        direction: string;
        evidence: string[];
      }
      const signals: SignalRow[] = [];
      let totalEvaluated = 0;
      for (const r of okRuns) {
        const data = r.data as {
          signals: SignalRow[];
          evaluatedStocks: number;
          triggeredCount: number;
        };
        totalEvaluated += data.evaluatedStocks;
        for (const s of data.signals) signals.push(s);
      }
      if (signals.length === 0) {
        return jsonResult({
          ok: true,
          data: {
            ranked: [],
            totalTactics: ids.length,
            totalSignals: 0,
            evaluatedStocks: totalEvaluated,
          },
        });
      }
      const scoreResult = await invokeTool('score_signals', { signals });
      if (!scoreResult.ok) return jsonResult(scoreResult);
      const ranked = (scoreResult.data as { ranked: unknown[] }).ranked.slice(0, topN);
      return jsonResult({
        ok: true,
        data: {
          ranked,
          totalTactics: ids.length,
          totalSignals: signals.length,
          evaluatedStocks: new Set(signals.map((s) => s.stockId)).size,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResult({ ok: false, error: { kind: 'internal', cause: message } });
    }
  });

  // 复盘趋势图：按天聚合命中率（confidence>=70 且 followed 且 pnl>0 占比）。
  // 默认 30 天窗口；advice 不足则返回空序列（前端 fallback 显示 byDecision）。
  app.get('/api/review/trend', async (c) => {
    const daysRaw = c.req.query('days');
    const days = daysRaw === undefined ? 30 : Math.max(1, Math.min(180, Number(daysRaw) || 30));
    const since = new Date(Date.now() - days * 86_400_000);
    const adviceResult = await invokeTool('get_advice', {
      since,
      includeExpired: true,
      limit: 500,
    });
    if (!adviceResult.ok) return jsonResult(adviceResult);
    interface AdviceRow {
      createdAt: Date;
      confidence: number;
      outcome?: { outcome: string; pnl?: number };
    }
    const rows = adviceResult.data as { advices: AdviceRow[] };
    // 按 createdAt.toDateString() 桶聚合
    const buckets = new Map<string, { total: number; hits: number }>();
    for (const a of rows.advices) {
      const d = new Date(a.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cur = buckets.get(key) ?? { total: 0, hits: 0 };
      cur.total += 1;
      if (
        a.outcome !== undefined &&
        a.outcome.outcome === 'followed' &&
        a.confidence >= 70 &&
        (a.outcome.pnl ?? 0) > 0
      ) {
        cur.hits += 1;
      }
      buckets.set(key, cur);
    }
    const series = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        total: v.total,
        hits: v.hits,
        hitRate: v.total === 0 ? 0 : v.hits / v.total,
      }));
    return jsonResult({ ok: true, data: { days, series } });
  });

  // 复盘页：近期 advice + 准确率统计（read）
  app.get('/api/review', async () => {
    const adviceResult = await invokeTool('get_advice', {
      includeExpired: true,
      limit: 20,
    });
    if (!adviceResult.ok) return jsonResult(adviceResult);
    const statsResult = await invokeTool('get_advice_stats', {});
    if (!statsResult.ok) return jsonResult(statsResult);
    return jsonResult({
      ok: true,
      data: { advices: adviceResult.data, stats: statsResult.data },
    });
  });

  // confidence 自校准（v0.5 W4）：把历史 advice 按 confidence 桶聚合 hitRate / avgPnl，
  // 复盘页右侧渲染成本表 + 整体命中率。
  app.get('/api/review/calibration', async () => callTool('get_confidence_calibration', {}));

  // outcome 回填（write；仅当 LUOOME_EXPOSE_WRITE=true 时挂载）。
  // 默认不暴露：避免 web 端被滥用为批量回填入口。
  if (process.env.LUOOME_EXPOSE_WRITE === 'true') {
    app.post('/api/review/:id/outcome', async (c) => {
      const id = c.req.param('id');
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return jsonResult({
          ok: false,
          error: { kind: 'invalid_input', message: '请求体必须是 JSON', issues: [] },
        });
      }
      const input =
        typeof body === 'object' && body !== null && 'input' in body
          ? (body as { input: object }).input
          : {};
      return jsonResult(await invokeTool('record_advice_outcome', { adviceId: id, ...input }));
    });
  }

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
    const allowed =
      EXPOSED_SIDE_EFFECTS.has(tool.sideEffect) ||
      (tool.sideEffect === 'external' && WEB_ALLOWED_EXTERNAL.has(name));
    if (!allowed) {
      return jsonResult(permissionDenied(`web 端不暴露 ${tool.sideEffect} 类 tool（${name}）`));
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
    return jsonResult(await tool.execute(input, ctxRef.current));
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
