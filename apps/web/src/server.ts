// @luoome/web —— 最小 Web 端（plan.md 跨包契约 / ARCHITECTURE §10）。
// Hono HTTP API + 同源静态仪表盘：
//   GET  /api/stocks/search    → adshare 优先搜索，真实行情源兜底
//   GET  /api/holdings          → list_holdings
//   GET  /api/advice            → get_advice（?subjectId=&includeExpired=）
//   GET  /api/advice/stats        → get_advice_stats
//   POST /api/tools/:name/call    → 放行 read/advice/write（ARCHITECTURE §7.1：Web 默认
//                                   含 write）+ 白名单 external（fetch_quote）；其余
//                                   external / trade 一律 403 permission_denied。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMarketAdapterFromEnv, LLMManager } from '@luoome/adapters';
import { AdshareClient } from '@luoome/adshare-sdk';
import type { SideEffect, Stock, ToolContext, ToolError, ToolResult } from '@luoome/core';
import { stockCode as brandStockCode, parseLlmProviderConfigFromEnv } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext, toolRegistry } from '@luoome/tools';
import { runIntradayWatchObserved } from '@luoome/workflows';
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
const WEB_ALLOWED_EXTERNAL: ReadonlySet<string> = new Set(['fetch_quote', 'refresh_stock_group']);

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

interface ResolvedWebToken {
  readonly token: string;
  readonly filePath: string | null;
}

/** 环境变量优先；否则在数据库同目录生成并复用 0600 token 文件。 */
export const resolveWebToken = (dbPath: string): ResolvedWebToken => {
  const fromEnv = process.env.LUOOME_WEB_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { token: fromEnv, filePath: null };
  }
  const filePath = join(dirname(dbPath), 'web-token');
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8').trim();
    if (existing.length >= 24) return { token: existing, filePath };
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const token = randomBytes(24).toString('hex');
  writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  return { token, filePath };
};

/**
 * 组装 web 端 ToolContext（与其他 surface 同一模式）：
 * LUOOME_HOME 下的 luoome.db + createDrizzleRepos + 真实行情/LLM + buildContext。
 * 空数据库保持为空，不自动插入任何业务记录。
 */
export const buildWebContext = async (
  dbPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ToolContext> => {
  const now = (): Date => new Date();
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = createDrizzleRepos(dbPath);
  const accounts = await handle.repos.account.list();
  const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  return buildContext({
    repos: handle.repos,
    adapters: {
      market: createMarketAdapterFromEnv(env, { clock: now, logger: console }),
      llm: new LLMManager({ logger: console, config: parseLlmProviderConfigFromEnv(env) }),
    },
    clock: now,
    user: { id: 'local-web-user', defaultAccountId },
  });
};

export interface CreateWebAppOptions {
  /** 服务端认可的 Bearer token；write / external 调用必须提供。 */
  readonly webToken?: string;
  /** 非 loopback 监听时，read/advice API 也必须鉴权。 */
  readonly requireApiToken?: boolean;
}

const mutationPermission = (request: Request, webToken: string): ToolResult<never> | null => {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return permissionDenied('跨站 Origin 不允许执行本地 mutation');
  }
  const authorization = request.headers.get('authorization');
  if (webToken.length === 0 || authorization !== `Bearer ${webToken}`) {
    return permissionDenied('write/external 操作需要有效 LUOOME_WEB_TOKEN');
  }
  return null;
};

/** 构造 Hono app（注入 ctx，便于测试与复用）。 */
/**
 * 构造 Hono app（注入 ctx，便于测试与复用）。
 * 接受 ctx 引用对象 { current } 而非裸 ToolContext——v0.5 W3 多账户切换通过
 * /api/account/select 改写 ctxRef.current.user.defaultAccountId，其它路由通过
 * ctxRef.current 取最新值，不再每次请求 mutate 全量 ctx。
 */
export const createWebApp = (initialCtx: ToolContext, options: CreateWebAppOptions = {}): Hono => {
  // 多账户切换（v0.5 W3）通过 ctxRef.current mutate user.defaultAccountId；
  // 内部 callTool / invokeTool 全部走 ctxRef.current 读取最新值。
  const ctxRef: { current: ToolContext } = { current: initialCtx };
  const webToken = options.webToken ?? process.env.LUOOME_WEB_TOKEN ?? '';
  const app = new Hono();

  if (options.requireApiToken === true) {
    app.use('/api/*', async (c, next) => {
      if (webToken.length === 0 || c.req.header('authorization') !== `Bearer ${webToken}`) {
        return jsonResult(permissionDenied('非 loopback Web 的所有 API 都需要有效 token'));
      }
      await next();
    });
  }

  // —— 同源静态仪表盘（原生 HTML/JS，无构建步骤）——
  const serveFile = (file: string, contentType: string) => (): Response =>
    new Response(Bun.file(join(PUBLIC_DIR, file)), {
      headers: { 'content-type': contentType },
    });
  app.get('/', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/style.css', serveFile('style.css', 'text/css; charset=utf-8'));
  app.get('/tactics', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/holdings', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/groups', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/watch', serveFile('index.html', 'text/html; charset=utf-8'));
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

  app.get('/api/trades', (c) => {
    const input: Record<string, unknown> = {};
    const stockId = c.req.query('stockId');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const side = c.req.query('side');
    const limit = c.req.query('limit');
    if (stockId !== undefined) input.stockId = stockId;
    if (since !== undefined) input.since = since;
    if (until !== undefined) input.until = until;
    if (side !== undefined) input.side = side;
    if (limit !== undefined) input.limit = Number(limit);
    return callTool('list_trades', input);
  });

  app.get('/api/groups', () =>
    callTool('list_stock_groups', { enabledOnly: false, includeMemberCount: true }),
  );
  app.get('/api/groups/:id', (c) => callTool('get_stock_group', { id: c.req.param('id') }));

  app.get('/api/watch/pools', () => callTool('list_stock_pools', { enabledOnly: false }));
  app.get('/api/watch/status', (c) => {
    const interval = Number(c.req.query('interval') ?? 60);
    return callTool('get_watch_status', {
      expectedIntervalSeconds: Number.isFinite(interval) ? interval : 60,
    });
  });
  app.get('/api/watch/triggers', (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['poolId', 'stockId', 'ruleKind', 'since'] as const) {
      const value = c.req.query(key);
      if (value !== undefined) input[key] = value;
    }
    const notified = c.req.query('notified');
    if (notified !== undefined) input.notified = notified === 'true' || notified === '1';
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number(limit);
    return callTool('list_watch_triggers', input);
  });

  app.post('/api/watch/run-once', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const input =
      typeof body === 'object' && body !== null
        ? { ...(body as Record<string, unknown>), seedTacticSources: false }
        : { notify: false, seedTacticSources: false };
    return jsonResult(await runIntradayWatchObserved(input, ctxRef.current, 'once'));
  });

  app.get('/api/dashboard', async () => {
    const [holdings, groups, pools, watch, triggers, advice] = await Promise.all([
      invokeTool('list_holdings', {}),
      invokeTool('list_stock_groups', { enabledOnly: false, includeMemberCount: true }),
      invokeTool('list_stock_pools', { enabledOnly: false }),
      invokeTool('get_watch_status', {}),
      invokeTool('list_watch_triggers', { limit: 8 }),
      invokeTool('get_advice', { limit: 8 }),
    ]);
    if (!holdings.ok) return jsonResult(holdings);
    if (!groups.ok) return jsonResult(groups);
    if (!pools.ok) return jsonResult(pools);
    if (!watch.ok) return jsonResult(watch);
    if (!triggers.ok) return jsonResult(triggers);
    if (!advice.ok) return jsonResult(advice);
    const groupRows = groups.data as {
      groups: Array<{ group: { id: string; resolver: { kind: string } } }>;
    };
    const dynamicIds = groupRows.groups
      .filter(({ group }) => group.resolver.kind === 'formula' || group.resolver.kind === 'llm')
      .map(({ group }) => group.id);
    const dynamicDetails = await Promise.all(
      dynamicIds.map((id) => invokeTool('get_stock_group', { id })),
    );
    const staleGroupCount = dynamicDetails.filter(
      (result) => result.ok && (result.data as { stale: boolean }).stale,
    ).length;
    return jsonResult({
      ok: true,
      data: {
        asOf: ctxRef.current.clock(),
        holdings: holdings.data,
        groups: groups.data,
        pools: pools.data,
        watch: watch.data,
        triggers: triggers.data,
        advice: advice.data,
        staleGroupCount,
      },
    });
  });

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

  // 股票搜索（adshare 优先，本地数据库兜底）
  app.get('/api/stocks/search', async (c) => {
    const q = c.req.query('q');
    const limitRaw = c.req.query('limit');
    // 契约：default 20、max 50（防御性上限，避免 agent 误传超大值把上游拖垮）。
    const limit = limitRaw === undefined ? 20 : Math.max(1, Math.min(50, Number(limitRaw) || 20));
    if (typeof q !== 'string' || q.trim().length === 0) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '缺少搜索参数 q',
          issues: [],
        },
      });
    }

    const name = q.trim();
    const validExchanges = new Set<Stock['exchange']>(['SH', 'SZ', 'BJ', 'HK', 'US']);

    const toStock = (item: {
      readonly ts_code: string;
      readonly name: string;
      readonly industry?: string | undefined;
    }): Stock | null => {
      const parts = item.ts_code.trim().split('.');
      if (parts.length !== 2) return null;
      const [code, exchange] = parts;
      if (code === undefined || exchange === undefined) return null;
      const upperExchange = exchange.toUpperCase() as Stock['exchange'];
      if (!validExchanges.has(upperExchange)) return null;
      try {
        return item.industry === undefined
          ? {
              id: `${code}.${upperExchange}`,
              code: brandStockCode(code),
              exchange: upperExchange,
              name: item.name,
            }
          : {
              id: `${code}.${upperExchange}`,
              code: brandStockCode(code),
              exchange: upperExchange,
              name: item.name,
              industry: item.industry,
            };
      } catch {
        return null;
      }
    };

    try {
      const adshare = AdshareClient.fromEnv(process.env);
      const candidates = await adshare.searchStocks({
        name,
        fields: ['ts_code', 'name', 'industry'],
        limit,
      });
      const stocks = candidates
        .map(toStock)
        .filter((candidate): candidate is Stock => candidate !== null);
      if (stocks.length > 0) {
        return jsonResult({
          ok: true,
          data: { stocks, total: stocks.length, source: 'adshare' as const },
        });
      }
    } catch (error) {
      ctxRef.current.logger.warn('adshare search fallback to local', { q, error: String(error) });
    }

    const localResult = await invokeTool('search_stocks', { query: name, limit });
    if (!localResult.ok) return jsonResult(localResult);
    const localData = localResult.data as { stocks: Stock[]; total: number; source?: string };
    return jsonResult({
      ok: true,
      data: {
        stocks: localData.stocks,
        total: localData.total,
        source: (localData.source as 'local' | 'market') ?? 'local',
      },
    });
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
      const denied = mutationPermission(c.req.raw, webToken);
      if (denied !== null) return jsonResult(denied);
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
    if (tool.sideEffect === 'write' || tool.sideEffect === 'external') {
      const denied = mutationPermission(c.req.raw, webToken);
      if (denied !== null) return jsonResult(denied);
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
  /** 缺省仅监听本机，避免把个人投资数据意外暴露到局域网。 */
  readonly host?: string;
  /** 缺省 resolveDbPath()（$LUOOME_HOME/luoome.db）。 */
  readonly dbPath?: string;
  /** 显式注入 token；缺省从 env / 本地 token 文件解析。 */
  readonly webToken?: string;
}

/** 启动 web server，返回 Bun server 句柄（调用方可 close()）。 */
export const startWeb = async (options: StartWebOptions): Promise<Bun.Server<undefined>> => {
  const dbPath = options.dbPath ?? resolveDbPath();
  const ctx = await buildWebContext(dbPath);
  const resolved =
    options.webToken !== undefined
      ? { token: options.webToken, filePath: null }
      : resolveWebToken(dbPath);
  const hostname = options.host ?? process.env.LUOOME_HOST ?? '127.0.0.1';
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!loopback && resolved.token.length === 0) {
    throw new Error('非 loopback Web 必须配置非空 LUOOME_WEB_TOKEN');
  }
  const app = createWebApp(ctx, {
    webToken: resolved.token,
    requireApiToken: !loopback,
  });
  const server = Bun.serve({ port: options.port, hostname, fetch: app.fetch });
  ctx.logger.info(`luoome web 已启动: http://${hostname}:${server.port}`);
  if (resolved.filePath !== null) {
    ctx.logger.info(`Web 写操作 token: ${resolved.filePath}（复制文件内容到 Web「设置」页）`);
  }
  return server;
};
