// @luoome/web —— 最小 Web 端（docs/archive/plan.md 跨包契约 / ARCHITECTURE §10）。
// Hono HTTP API + 同源静态仪表盘：
//   GET  /api/stocks/search    → search_stocks tool（本地股票目录优先，外部行情源补充）
//   GET  /api/holdings          → list_holdings
//   GET  /api/advice            → get_advice（?subjectId=&includeExpired=）
//   GET  /api/advice/stats        → get_advice_stats
//   POST /api/tools/:name/call    → 默认只放行 read/advice（ARCHITECTURE §7.1）；
//                                   write 需 LUOOME_EXPOSE_WRITE=true，external 需
//                                   LUOOME_EXPOSE_EXTERNAL=true 且命中白名单
//                                   （fetch_quote 等）；trade 一律 403 permission_denied。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createStockUniverseManagerFromEnv,
} from '@luoome/adapters';
import type { SideEffect, ToolContext, ToolError, ToolResult } from '@luoome/core';
import { BUILTIN_STRATEGIES } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext, ensureBuiltinStrategies, toolRegistry } from '@luoome/tools';
import {
  closingReportWorkflow,
  openingReportWorkflow,
  runIntradayWatchObserved,
  weeklyReportWorkflow,
} from '@luoome/workflows';
import { Hono } from 'hono';
import { ZodError } from 'zod';

import { AISettingsStore, SaveAISettingsSchema } from './ai-settings.js';
import { type ChatStreamRuntime, createChatStreamResponse } from './chat.js';
import { MarketSettingsStore, SaveMarketSettingsSchema } from './market-settings.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/**
 * 行情页图表库（设计 §12.1）：固定版本 lightweight-charts 的 ESM 产物文件。
 * 必须serve standalone 产物：包入口（lightweight-charts.production.mjs）含裸导入
 * fancy-canvas，浏览器无 import map 无法解析，standalone 已内联全部依赖。
 * 由 import.meta.resolve 定位已安装包的 package.json 再拼 dist 固定文件名，
 * 不接受任何用户路径，禁止目录遍历，不暴露整个 node_modules；
 * 升级依赖时同步改 /vendor/lightweight-charts-<version>.mjs 的 URL 版本段。
 */
const LIGHTWEIGHT_CHARTS_FILE = join(
  dirname(fileURLToPath(import.meta.resolve('lightweight-charts/package.json'))),
  'dist',
  'lightweight-charts.standalone.production.mjs',
);

/**
 * Web 端暴露面（对齐 ARCHITECTURE §7.1）：默认只放行 read + advice。
 * write 需 LUOOME_EXPOSE_WRITE=true、external 需 LUOOME_EXPOSE_EXTERNAL=true 且命中
 * WEB_ALLOWED_EXTERNAL 白名单才放行（见 /api/tools/:name/call 的门控）；
 * MCP 暴露面同样默认只读（write 需 LUOOME_EXPOSE_WRITE）。
 */
const EXPOSED_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(['read', 'advice', 'write']);

/**
 * external 白名单仅包含目标模型运行、行情读取与显式同步；
 * sync_quotes / send_notification 等仍不对通用 Web tool call 开放。
 */
const WEB_ALLOWED_EXTERNAL: ReadonlySet<string> = new Set([
  'agent_run',
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'get_ashare_sentiment',
  'get_stock_market_view',
  'sync_stock_universe',
  'sync_daily_bars',
  'run_strategy',
  'validate_strategy_version',
]);

/**
 * external（白名单外）/trade tool 不通过 web 暴露：已在 registry 实现的被
 * sideEffect 门拦截（403 文案准确）；本表覆盖「契约里有名字但尚未实现」的
 * tool——同样按契约返回 403 permission_denied，而不是 404 not_found。
 * （write 默认不放行；未实现的 write 类契约 tool 走 not_found。）
 */
const KNOWN_UNEXPOSED_TOOLS: Readonly<Record<string, SideEffect>> = {
  sync_quotes: 'external',
  send_notification: 'external',
  generate_report: 'external',
  place_order: 'trade',
  cancel_order: 'trade',
};

/** Asia/Shanghai 当日 00:00 的 Date（web 与 workflow 用同口径）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const startOfTodayShanghai = (now: Date): Date => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return new Date(Date.UTC(y, m, d) - SHANGHAI_OFFSET_MS);
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
    case 'adapter_error':
      // 上游 / 解析失败 → 502 Bad Gateway，前端用此判 upstream-unavailable 文案
      return 502;
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
  await ensureBuiltinStrategies(handle.repos);
  const accounts = await handle.repos.account.list();
  const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  let ai: ReturnType<typeof createAIStackFromEnv> | undefined;
  try {
    ai = createAIStackFromEnv(env, { logger: console });
  } catch (error) {
    console.warn('AI 模型尚未配置；Web 将以配置模式启动', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const unavailableLLM = {
    name: 'ai-unconfigured',
    generate: async (): Promise<never> => {
      throw new Error('AI 模型尚未配置，请前往设置页完成 LLM 设置');
    },
  };
  return buildContext({
    repos: handle.repos,
    adapters: {
      market: createMarketAdapterFromEnv(env, {
        clock: now,
        logger: console,
        // Web 持仓与 Watchlist 盘中轮询；TTL 不调小的话拿到的都是缓存
        quoteCacheTtlMs: 10_000,
      }),
      stockUniverse: createStockUniverseManagerFromEnv(env, {
        clock: now,
        logger: console,
      }),
      llm: ai?.llm ?? unavailableLLM,
    },
    ...(ai === undefined ? {} : { agent: ai.agent }),
    clock: now,
    user: { id: 'local-web-user', defaultAccountId },
    limitUpLadder: createLimitUpLadderManagerFromEnv(env, { clock: now, logger: console }),
    ashareSentiment: createAShareSentimentManagerFromEnv(env, { clock: now, logger: console }),
  });
};

export interface CreateWebAppOptions {
  /** 服务端认可的 Bearer token；write / external 调用必须提供。 */
  readonly webToken?: string;
  /** 非 loopback 监听时，read/advice API 也必须鉴权。 */
  readonly requireApiToken?: boolean;
  /** write tools/routes 必须显式开启；默认读取 LUOOME_EXPOSE_WRITE。 */
  readonly exposeWrite?: boolean;
  /** external tools/routes 必须显式开启；默认读取 LUOOME_EXPOSE_EXTERNAL。 */
  readonly exposeExternal?: boolean;
  /** LLM 设置持久化；仅生产启动注入，测试可按需提供临时 store。 */
  readonly aiSettingsStore?: AISettingsStore;
  /** 行情源设置持久化；保存后立即替换当前 Web 进程的 market adapter。 */
  readonly marketSettingsStore?: MarketSettingsStore;
  /** 流式聊天 runtime；测试可注入，生产默认复用 AI SDK agent。 */
  readonly chatStreamRuntime?: ChatStreamRuntime;
}

const asChatStreamRuntime = (value: unknown): ChatStreamRuntime | undefined => {
  if (
    value !== null &&
    typeof value === 'object' &&
    'createUIMessageStreamResponse' in value &&
    typeof value.createUIMessageStreamResponse === 'function'
  ) {
    return value as ChatStreamRuntime;
  }
  return undefined;
};

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
  const chatRuntimeRef: { current: ChatStreamRuntime | undefined } = {
    current: options.chatStreamRuntime ?? asChatStreamRuntime(initialCtx.agent),
  };
  const webToken = options.webToken ?? process.env.LUOOME_WEB_TOKEN ?? '';
  const exposeWrite = options.exposeWrite ?? process.env.LUOOME_EXPOSE_WRITE === 'true';
  const exposeExternal = options.exposeExternal ?? process.env.LUOOME_EXPOSE_EXTERNAL === 'true';
  const aiSettingsStore = options.aiSettingsStore;
  const marketSettingsStore = options.marketSettingsStore;
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
  app.get('/strategies', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/watchlists', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/alerts', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/groups', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/watch', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/advice', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/reports', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/settings', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/review', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/chat', serveFile('index.html', 'text/html; charset=utf-8'));
  // 行情页 SPA shell（设计 §11.1：#market 深链接；/market 供直接访问）。
  app.get('/market', serveFile('index.html', 'text/html; charset=utf-8'));

  // 图表库 ESM 产物（设计 §12.1）：固定版本固定文件，长缓存；
  // 路由不带路径参数，/vendor 下任何其它路径一律 404。
  app.get(
    '/vendor/lightweight-charts-5.2.0.mjs',
    () =>
      new Response(Bun.file(LIGHTWEIGHT_CHARTS_FILE), {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      }),
  );

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
   * 内部组合调用：直接返回 ToolResult（不包 Response），便于聚合端点统一 wrap。
   */
  const invokeTool = async (name: string, input: unknown): Promise<ToolResult<unknown>> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return notFound('Tool', name);
    return tool.execute(input, ctxRef.current);
  };

  const parseJsonObject = async (
    request: Request,
  ): Promise<
    { readonly parsed: true; readonly data: Record<string, unknown> } | ToolResult<never>
  > => {
    try {
      const value: unknown = await request.json();
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          ok: false,
          error: { kind: 'invalid_input', message: '请求体必须是 JSON 对象', issues: [] },
        };
      }
      return { parsed: true, data: value as Record<string, unknown> };
    } catch {
      return {
        ok: false,
        error: { kind: 'invalid_input', message: '请求体必须是 JSON 对象', issues: [] },
      };
    }
  };

  const targetMutation = async (
    request: Request,
    sideEffect: 'write' | 'external',
    toolName: string,
    fixedInput: Readonly<Record<string, unknown>> = {},
  ): Promise<Response> => {
    const exposed = sideEffect === 'write' ? exposeWrite : exposeExternal;
    if (!exposed) {
      return jsonResult(
        permissionDenied(
          `${sideEffect} 操作未开启；设置 LUOOME_EXPOSE_${sideEffect.toUpperCase()}=true`,
        ),
      );
    }
    const denied = mutationPermission(request, webToken);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(request);
    if (!('parsed' in body)) return jsonResult(body);
    return jsonResult(await invokeTool(toolName, { ...body.data, ...fixedInput }));
  };

  // 指数行情缓存：dashboard 5s 轮询，push2 对高频请求突发限流（2026-07 实测），
  // 15s TTL 把请求量降到 1/3；调用失败时回退最近成功值（60s 内），避免指数条闪空。
  const INDEX_QUOTES_TTL_MS = 15_000;
  const INDEX_QUOTES_STALE_MS = 60_000;
  let indexQuotesCache: {
    readonly at: number;
    readonly value: { indices: unknown[]; unsupported?: boolean };
  } | null = null;
  const invokeIndexQuotes = async (): Promise<ToolResult<unknown>> => {
    const now = Date.now();
    if (indexQuotesCache !== null && now - indexQuotesCache.at < INDEX_QUOTES_TTL_MS) {
      return { ok: true, data: indexQuotesCache.value };
    }
    const result = await invokeTool('fetch_index_quotes', {});
    if (result.ok) {
      indexQuotesCache = {
        at: now,
        value: result.data as { indices: unknown[]; unsupported?: boolean },
      };
      return result;
    }
    if (indexQuotesCache !== null && now - indexQuotesCache.at < INDEX_QUOTES_STALE_MS) {
      return { ok: true, data: indexQuotesCache.value };
    }
    return result;
  };

  // ===== AI 模型设置 =====
  app.get('/api/settings/ai', () => {
    if (aiSettingsStore === undefined) return jsonResult(notFound('AISettingsStore', 'default'));
    try {
      return jsonResult({ ok: true, data: aiSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `AI 设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  // ===== 行情数据源设置 =====
  app.get('/api/settings/market', () => {
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    try {
      return jsonResult({ ok: true, data: marketSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `行情源设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.post('/api/settings/market', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    try {
      const input = SaveMarketSettingsSchema.parse(await c.req.json());
      const candidateEnv = {
        ...marketSettingsStore.runtimeEnv(),
        LUOOME_MARKET_SOURCES: input.sources.join(','),
      };
      const market = createMarketAdapterFromEnv(candidateEnv, {
        clock: ctxRef.current.clock,
        logger: ctxRef.current.logger,
      });
      const saved = marketSettingsStore.save(input);
      ctxRef.current = {
        ...ctxRef.current,
        adapters: { ...ctxRef.current.adapters, market },
      };
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '行情源设置校验失败',
            issues: error.issues,
          },
        });
      }
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: error instanceof Error ? error.message : String(error),
          issues: [],
        },
      });
    }
  });

  app.get('/api/chat/sessions', () => callTool('list_chat_sessions', { limit: 100 }));
  app.post('/api/chat/sessions', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // 空请求体等同默认标题。
    }
    return callTool('create_chat_session', body);
  });
  app.get('/api/chat/sessions/:id', (c) =>
    callTool('get_chat_session', { sessionId: c.req.param('id'), messageLimit: 200 }),
  );
  app.patch('/api/chat/sessions/:id', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    let body: { title?: unknown };
    try {
      body = (await c.req.json()) as { title?: unknown };
    } catch {
      body = {};
    }
    return callTool('rename_chat_session', {
      sessionId: c.req.param('id'),
      title: body.title,
    });
  });
  app.delete('/api/chat/sessions/:id', (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    return callTool('delete_chat_session', { sessionId: c.req.param('id') });
  });

  app.post('/api/settings/ai', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    if (aiSettingsStore === undefined) return jsonResult(notFound('AISettingsStore', 'default'));
    try {
      const input = SaveAISettingsSchema.parse(await c.req.json());
      const saved = aiSettingsStore.save(input);
      const ai = createAIStackFromEnv(aiSettingsStore.runtimeEnv(), {
        logger: ctxRef.current.logger,
      });
      ctxRef.current = {
        ...ctxRef.current,
        adapters: { ...ctxRef.current.adapters, llm: ai.llm },
        agent: ai.agent,
      };
      chatRuntimeRef.current = asChatStreamRuntime(ai.agent);
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'AI 设置校验失败',
            issues: error.issues,
          },
        });
      }
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `AI 设置保存失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  // ===== 多账户切换（v0.5 W3）端点 =====
  // 全部账户列表（用于顶栏下拉）。
  app.get('/api/accounts', () => callTool('list_accounts', {}));

  /**
   * 切换当前激活账户：把 ctxRef.current.user.defaultAccountId 更新为指定账户。
   * 单进程单 tab 假设（与现有 TUI / CLI 一致）：ctx 共享内存仓，切换是 mutate。
   * 调用侧只需要再 reload 受影响的数据视图（持仓 / Strategy / 复盘）。
   */
  app.post('/api/account/select', async (c) => {
    // v0.8 起：虽然此路由只 in-memory 改 ctxRef.current.user.defaultAccountId
    // （不写 db），但仍是 mutation，应与 /api/tools/:name/call 的 write/external 守卫一致。
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
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

  const intQuery = (raw: string | undefined, fallback: number, min: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) return fallback;
    return n;
  };

  const enumQuery = <T extends string>(
    raw: string | undefined,
    fallback: T,
    allowed: readonly T[],
  ): T => {
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };

  /**
   * 连板天梯（Phase 2，docs/ddd/limit-up-ladder-detailed-design.md §11）。
   *
   * 参数：
   *   date (必填) YYYY-MM-DD
   *   days, includeStar, includeBse, includeST, includeUncategorized (可选)
   *
   * 缓存：Manager 自带 LRU + 分时段 TTL;web 层不再加二级。
   * 上游不可达：tool 返回 internal；web 包成 HTTP 502。
   */
  app.get('/api/market/limit-up', async (c) => {
    const date = c.req.query('date');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'date 必填且为 YYYY-MM-DD',
          issues: [],
        },
      });
    }
    const input: Record<string, unknown> = {
      date,
      days: intQuery(c.req.query('days'), 15, 1),
      source: enumQuery(c.req.query('source'), 'eastmoney', ['eastmoney']),
      includeStar: c.req.query('includeStar') === 'true',
      includeBse: c.req.query('includeBse') === 'true',
      includeST: c.req.query('includeST') === 'true',
      includeUncategorized: c.req.query('includeUncategorized') === 'true',
    };
    const r = await invokeTool('limit_up_ladder', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 连板天梯对比（Phase 2，docs/ddd/limit-up-ladder-detailed-design.md §8.2）。
   * 用 limit_up_ladder_compare tool，复用同一 cache。
   */
  app.get('/api/market/limit-up/compare', async (c) => {
    const date = c.req.query('date');
    const prevDate = c.req.query('prevDate');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: 'date 必填且为 YYYY-MM-DD', issues: [] },
      });
    }
    if (typeof prevDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(prevDate)) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: 'prevDate 必填且为 YYYY-MM-DD', issues: [] },
      });
    }
    const input: Record<string, unknown> = {
      date,
      prevDate,
      days: intQuery(c.req.query('days'), 15, 1),
      source: enumQuery(c.req.query('source'), 'eastmoney', ['eastmoney']),
      includeStar: c.req.query('includeStar') === 'true',
      includeBse: c.req.query('includeBse') === 'true',
      includeST: c.req.query('includeST') === 'true',
      includeUncategorized: c.req.query('includeUncategorized') === 'true',
    };
    const r = await invokeTool('limit_up_ladder_compare', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // HTML route for SPA shell
  app.get('/market/limit-up', serveFile('index.html', 'text/html; charset=utf-8'));

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

  app.get('/api/strategies', (c) => {
    const status = c.req.query('status');
    const owner = c.req.query('owner');
    const filter = {
      ...(status === undefined ? {} : { status }),
      ...(owner === undefined ? {} : { owner }),
    };
    return callTool('list_strategies', {
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
    });
  });
  app.get('/api/strategy-templates', (c) =>
    c.json({
      ok: true,
      data: {
        templates: BUILTIN_STRATEGIES.map(({ strategy, version }) => ({
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          definition: version.definition,
        })),
      },
    }),
  );
  app.post('/api/strategies', (c) => targetMutation(c.req.raw, 'write', 'create_strategy'));
  app.get('/api/strategies/:id', (c) =>
    callTool('get_strategy', { strategyId: c.req.param('id') }),
  );
  app.post('/api/strategies/:id/versions', (c) =>
    targetMutation(c.req.raw, 'write', 'create_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/validate', (c) =>
    targetMutation(c.req.raw, 'external', 'validate_strategy_version'),
  );
  app.post('/api/strategies/:id/publish', (c) =>
    targetMutation(c.req.raw, 'write', 'publish_strategy_version'),
  );
  app.post('/api/strategies/:id/run', (c) =>
    targetMutation(c.req.raw, 'external', 'run_strategy', {
      strategyId: c.req.param('id'),
    }),
  );

  app.get('/api/watchlists', () => callTool('list_watchlists', {}));
  app.post('/api/watchlists', (c) => targetMutation(c.req.raw, 'write', 'create_watchlist'));
  app.get('/api/watchlists/:id', (c) =>
    callTool('get_watchlist', { watchlistId: c.req.param('id') }),
  );
  app.patch('/api/watchlists/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/members', (c) =>
    targetMutation(c.req.raw, 'write', 'add_watchlist_member', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.patch('/api/watchlists/:id/members/:stockId', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist_member', {
      watchlistId: c.req.param('id'),
      stockId: c.req.param('stockId'),
    }),
  );

  app.get('/api/alert-plans', (c) =>
    callTool('list_alert_plans', {
      enabledOnly: c.req.query('enabledOnly') === 'true',
      ...(c.req.query('watchlistId') === undefined
        ? {}
        : { watchlistId: c.req.query('watchlistId') }),
    }),
  );
  app.post('/api/alert-plans', (c) => targetMutation(c.req.raw, 'write', 'create_alert_plan'));

  app.get('/api/watch/status', (c) => {
    const interval = Number(c.req.query('interval') ?? 60);
    return callTool('get_watch_status', {
      expectedIntervalSeconds: Number.isFinite(interval) ? interval : 60,
    });
  });
  app.get('/api/watch/triggers', (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['alertPlanId', 'stockId', 'ruleKind', 'ruleId', 'since'] as const) {
      const value = c.req.query(key);
      if (value !== undefined) input[key] = value;
    }
    const notified = c.req.query('notified');
    if (notified !== undefined) input.notified = notified === 'true' || notified === '1';
    const priority = c.req.query('priority');
    if (priority === 'urgent' || priority === 'important' || priority === 'normal') {
      input.priority = priority;
    }
    const feedback = c.req.query('feedback');
    if (
      feedback === 'handled' ||
      feedback === 'useful' ||
      feedback === 'useless' ||
      feedback === 'ignored'
    ) {
      input.feedback = feedback;
    }
    const triggerType = c.req.query('triggerType');
    if (triggerType === 'triggered' || triggerType === 'recovered') {
      input.triggerType = triggerType;
    }
    const deliveryStatus = c.req.query('deliveryStatus');
    if (typeof deliveryStatus === 'string' && deliveryStatus.length > 0) {
      input.deliveryStatus = deliveryStatus.split(',').filter((v) => v.length > 0);
    }
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number(limit);
    return callTool('list_watch_triggers', input);
  });

  /**
   * 反馈写入（v0.7 策略预警）。
   * 调 set_watch_trigger_feedback；幂等；triggerId 不存在 → 404。
   */
  app.post('/api/watch/triggers/:id/feedback', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    const id = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const feedback = (body as { feedback?: unknown }).feedback;
    if (
      feedback !== 'handled' &&
      feedback !== 'useful' &&
      feedback !== 'useless' &&
      feedback !== 'ignored'
    ) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'feedback 必须是 handled / useful / useless / ignored',
          issues: [],
        },
      });
    }
    return jsonResult(await invokeTool('set_watch_trigger_feedback', { triggerId: id, feedback }));
  });

  app.post('/api/watch/run-once', async (c) => {
    if (!exposeExternal) {
      return jsonResult(permissionDenied('external 操作未开启；设置 LUOOME_EXPOSE_EXTERNAL=true'));
    }
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const input =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : { notify: false };
    return jsonResult(await runIntradayWatchObserved(input, ctxRef.current, 'once'));
  });

  app.get('/api/dashboard', async () => {
    const todayStart = startOfTodayShanghai(ctxRef.current.clock());
    const [holdings, watchlists, alertPlans, watch, triggers, advice, recentTriggers, indexQuotes] =
      await Promise.all([
        invokeTool('list_holdings', {}),
        invokeTool('list_watchlists', {}),
        invokeTool('list_alert_plans', { enabledOnly: false }),
        invokeTool('get_watch_status', {}),
        invokeTool('list_watch_triggers', { limit: 8 }),
        invokeTool('get_advice', { limit: 8 }),
        invokeTool('list_watch_triggers', { since: todayStart, limit: 200 }),
        invokeIndexQuotes(),
      ]);
    if (!holdings.ok) return jsonResult(holdings);
    if (!watchlists.ok) return jsonResult(watchlists);
    if (!alertPlans.ok) return jsonResult(alertPlans);
    if (!watch.ok) return jsonResult(watch);
    if (!triggers.ok) return jsonResult(triggers);
    if (!advice.ok) return jsonResult(advice);

    // 单项失败降级为警告，不拖垮整个 dashboard（指数条 / 看板仍可空态呈现）。
    const warnings: string[] = [];
    let indices: { indices: unknown[]; unsupported?: boolean } = { indices: [] };
    if (indexQuotes.ok) {
      indices = indexQuotes.data as typeof indices;
    } else {
      warnings.push(`fetch_index_quotes 失败（${indexQuotes.error.kind}），指数行情降级为空`);
    }

    const watchlistRows = (
      watchlists.data as {
        items: Array<{
          watchlist: { id: string; name: string; enabled: boolean };
          sourceHealth: { stale: number };
        }>;
      }
    ).items;
    // Watchlist 详情在一次请求内复用。
    const watchlistDetailCache = new Map<string, Promise<ToolResult<unknown>>>();
    const watchlistDetail = (id: string): Promise<ToolResult<unknown>> => {
      const cached = watchlistDetailCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('get_watchlist', { watchlistId: id });
      watchlistDetailCache.set(id, pending);
      return pending;
    };
    const staleWatchlistCount = watchlistRows.filter(
      ({ sourceHealth }) => sourceHealth.stale > 0,
    ).length;

    // 策略预警指标（docs/.../§11 / §12）：今日优先级计数 / 送达状态分布 / 反馈分布（噪声率）
    const todayTriggers = (
      recentTriggers.ok
        ? (recentTriggers.data as { triggers: Array<Record<string, unknown>> }).triggers
        : []
    ) as Array<{
      stockId: string;
      priority: 'urgent' | 'important' | 'normal';
      deliveryStatus: string;
      feedback?: 'handled' | 'useful' | 'useless' | 'ignored';
    }>;

    // —— 实时看板：持仓 ∪ 被启用 AlertPlan 引用的 Watchlist 成员 ——
    interface BoardItem {
      stockId: string;
      name: string;
      quote: {
        close: number;
        observedAt: unknown;
        retrieval: 'live' | 'local-fallback';
        freshness: 'fresh' | 'stale';
      } | null;
      /** 股价涨跌幅（%）：全行统一由 batch_quote 昨收基准换算，无昨收基准为 null。 */
      changePct: number | null;
      holding: {
        quantity: number;
        marketValue: number;
        todayPnl: number | null;
        todayPnlPct: number | null;
      } | null;
      watchlists: string[];
      todayTrigger: { count: number; maxPriority: 'urgent' | 'important' | 'normal' } | null;
    }
    const BOARD_CAP = 40;
    const holdingRows = (
      holdings.data as {
        holdings: Array<{
          holding: { stockId: string; quantity: number };
          stockName: string;
          marketValue: number;
          todayPnl: number | null;
          todayPnlPct: number | null;
        }>;
      }
    ).holdings;
    const board = new Map<string, BoardItem>();
    for (const row of holdingRows) {
      if (board.size >= BOARD_CAP) break;
      board.set(row.holding.stockId, {
        stockId: row.holding.stockId,
        name: row.stockName,
        quote: null,
        changePct: null,
        holding: {
          quantity: row.holding.quantity,
          marketValue: row.marketValue,
          todayPnl: row.todayPnl,
          todayPnlPct: row.todayPnlPct,
        },
        watchlists: [],
        todayTrigger: null,
      });
    }
    const planRows = (
      alertPlans.data as { plans: Array<{ watchlistId: string; enabled: boolean }> }
    ).plans;
    const watchlistById = new Map(watchlistRows.map(({ watchlist }) => [watchlist.id, watchlist]));
    const watchedWatchlistIds = [
      ...new Set(
        planRows
          .filter((plan) => plan.enabled && plan.watchlistId.length > 0)
          .map((plan) => plan.watchlistId)
          .filter((id) => watchlistById.get(id)?.enabled === true),
      ),
    ];
    const watchedDetails = await Promise.all(watchedWatchlistIds.map((id) => watchlistDetail(id)));
    for (const [index, detail] of watchedDetails.entries()) {
      if (!detail.ok) {
        warnings.push(
          `get_watchlist(${watchedWatchlistIds[index]}) 失败（${detail.error.kind}），看板跳过该 Watchlist`,
        );
        continue;
      }
      const { watchlist, members } = detail.data as {
        watchlist: { name: string };
        members: Array<{ member: { stockId: string } }>;
      };
      for (const { member } of members) {
        const existing = board.get(member.stockId);
        if (existing !== undefined) {
          existing.watchlists.push(watchlist.name);
        } else if (board.size < BOARD_CAP) {
          board.set(member.stockId, {
            stockId: member.stockId,
            name: member.stockId,
            quote: null,
            changePct: null,
            holding: null,
            watchlists: [watchlist.name],
            todayTrigger: null,
          });
        }
      }
    }
    if (board.size > 0) {
      const quotesResult = await invokeTool('batch_quote', {
        stockIds: [...board.keys()],
        context: 'display',
      });
      if (quotesResult.ok) {
        const { items } = quotesResult.data as {
          items: Array<
            | {
                stockId: string;
                status: 'ok';
                quote: { close: number; prevClose?: number; observedAt: unknown };
                retrieval: 'live' | 'local-fallback';
                freshness: 'fresh' | 'stale';
              }
            | { stockId: string; status: 'unresolved' | 'unavailable'; reason: string }
          >;
        };
        for (const result of items) {
          if (result.status !== 'ok') continue;
          const item = board.get(result.stockId);
          if (item === undefined) continue;
          item.quote = {
            close: result.quote.close,
            observedAt: result.quote.observedAt,
            retrieval: result.retrieval,
            freshness: result.freshness,
          };
          // 涨跌幅全行统一口径：昨收基准换算
          const prevClose = result.quote.prevClose;
          if (item.changePct === null && typeof prevClose === 'number' && prevClose > 0) {
            item.changePct = ((result.quote.close - prevClose) / prevClose) * 100;
          }
        }
      } else {
        warnings.push(`batch_quote 失败（${quotesResult.error.kind}），看板行情降级为空`);
      }
    }
    const PRIORITY_RANK = { urgent: 0, important: 1, normal: 2 } as const;
    for (const t of todayTriggers) {
      const item = board.get(t.stockId);
      if (item === undefined) continue;
      const entry = item.todayTrigger ?? { count: 0, maxPriority: 'normal' as const };
      entry.count += 1;
      if (PRIORITY_RANK[t.priority] < PRIORITY_RANK[entry.maxPriority]) {
        entry.maxPriority = t.priority;
      }
      item.todayTrigger = entry;
    }

    const priorityCounts = todayTriggers.reduce<Record<string, number>>((acc, t) => {
      acc[t.priority] = (acc[t.priority] ?? 0) + 1;
      return acc;
    }, {});
    const deliveryStatusCounts = todayTriggers.reduce<Record<string, number>>((acc, t) => {
      acc[t.deliveryStatus] = (acc[t.deliveryStatus] ?? 0) + 1;
      return acc;
    }, {});
    const feedbackCounts = todayTriggers.reduce<Record<string, number>>((acc, t) => {
      if (t.feedback === undefined) return acc;
      acc[t.feedback] = (acc[t.feedback] ?? 0) + 1;
      return acc;
    }, {});

    // 噪声率（§11）：样本 ≥ 30 才展示，避免误读
    const feedbackTotal = Object.values(feedbackCounts).reduce((s, n) => s + n, 0);
    const noiseRate =
      feedbackTotal >= 30
        ? ((feedbackCounts.useless ?? 0) + (feedbackCounts.ignored ?? 0)) /
          Math.max(feedbackTotal, 1)
        : null;

    // watch.run 摘要（§11）：最近一轮的发送失败 / 抑制分项
    const watchData = watch.data as { latest?: Record<string, unknown> | null };
    const latestRun = watchData.latest ?? null;

    return jsonResult({
      ok: true,
      data: {
        asOf: ctxRef.current.clock(),
        holdings: holdings.data,
        watchlists: watchlists.data,
        alertPlans: alertPlans.data,
        watch: watch.data,
        triggers: triggers.data,
        advice: advice.data,
        staleWatchlistCount,
        // 看盘主页：指数条 + 实时看板 + 今日预警列表
        indices,
        board: [...board.values()],
        todayTriggers,
        meta: { warnings },
        // v0.7 策略预警 dashboard 指标（§11）
        metrics: {
          todayTotal: todayTriggers.length,
          priorityCounts,
          deliveryStatusCounts,
          feedbackCounts,
          feedbackTotal,
          noiseRate,
          latestRun: latestRun
            ? {
                status: latestRun.status ?? null,
                evaluatedPlans: latestRun.evaluatedPools ?? 0,
                evaluatedStocks: latestRun.evaluatedStocks ?? 0,
                triggered: latestRun.triggered ?? 0,
                notified: latestRun.notified ?? 0,
                suppressedByCooldown: latestRun.suppressedByCooldown ?? 0,
                suppressedByDailyLimit: latestRun.suppressedByDailyLimit ?? 0,
                notifyFailed: latestRun.notifyFailed ?? 0,
                startedAt: latestRun.startedAt ?? null,
                finishedAt: latestRun.finishedAt ?? null,
                error: latestRun.error ?? null,
              }
            : null,
        },
      },
    });
  });

  // ruo 迁移 §8：研究档案时间线聚合（内部组合读 tool，按时间倒序，支持类型筛选）。
  app.get('/api/stocks/:id/research-timeline', async (c) => {
    const stockId = c.req.param('id');
    const typesParam = c.req.query('types');
    const wanted =
      typesParam !== undefined && typesParam.length > 0
        ? new Set(typesParam.split(',').map((s) => s.trim()))
        : null;
    const want = (t: string): boolean => wanted === null || wanted.has(t);

    const [notesR, eventsR, triggersR, adviceR, signalsR, watchlistsR] = await Promise.all([
      invokeTool('list_research_notes', { stockId, limit: 200 }),
      invokeTool('list_stock_events', { stockId, limit: 200 }),
      invokeTool('list_watch_triggers', { stockId, limit: 100 }),
      invokeTool('get_advice', { subjectKind: 'stock', subjectId: stockId, limit: 50 }),
      invokeTool('strategy_signals_by_stock', { stockId, limit: 100 }),
      invokeTool('list_watchlists', {}),
    ]);
    if (!notesR.ok) return jsonResult(notesR);
    if (!eventsR.ok) return jsonResult(eventsR);

    const notes = (notesR.data as { notes: Array<Record<string, unknown>> }).notes;
    const events = (eventsR.data as { events: Array<Record<string, unknown>> }).events;
    const triggers = triggersR.ok
      ? (triggersR.data as { triggers: Array<Record<string, unknown>> }).triggers
      : [];
    const advice = adviceR.ok
      ? (adviceR.data as {
          advice?: Array<Record<string, unknown>>;
          advices?: Array<Record<string, unknown>>;
        })
      : {};
    const adviceList = advice.advice ?? advice.advices ?? [];
    const strategySignals = signalsR.ok
      ? (signalsR.data as { signals: Array<Record<string, unknown>> }).signals
      : [];
    const watchlistItems = watchlistsR.ok
      ? (
          watchlistsR.data as {
            items: Array<{ watchlist: { id: string; name: string } }>;
          }
        ).items
      : [];
    const watchlistMemberships = (
      await Promise.all(
        watchlistItems.map(async ({ watchlist }) => {
          const detail = await invokeTool('get_watchlist', { watchlistId: watchlist.id });
          if (!detail.ok) return [];
          const members = (
            detail.data as {
              members: Array<{
                member: { stockId: string; stage: string; priority: string };
                sources: Array<Record<string, unknown>>;
              }>;
            }
          ).members;
          return members
            .filter(({ member }) => member.stockId === stockId)
            .map(({ member, sources }) => ({ watchlist, member, sources }));
        }),
      )
    ).flat();

    type TimelineItem = { type: string; at: string; payload: Record<string, unknown> };
    const items: TimelineItem[] = [];
    if (want('note')) {
      for (const n of notes) {
        items.push({ type: 'note', at: String(n.createdAt), payload: n });
      }
    }
    if (want('event')) {
      for (const e of events) {
        items.push({ type: 'event', at: String(e.occursAt), payload: e });
      }
    }
    if (want('trigger')) {
      for (const t of triggers) {
        items.push({ type: 'trigger', at: String(t.createdAt), payload: t });
      }
    }
    if (want('advice')) {
      for (const a of adviceList) {
        items.push({ type: 'advice', at: String(a.createdAt), payload: a });
      }
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const activeThesis = notes.find((n) => n.kind === 'thesis' && n.active === true) ?? null;
    const now = ctxRef.current.clock().getTime();
    const upcomingEvents = events
      .filter((e) => e.status === 'scheduled' && new Date(String(e.occursAt)).getTime() >= now)
      .slice(0, 10);

    return jsonResult({
      ok: true,
      data: {
        stockId,
        summary: {
          activeThesis,
          noteCount: notes.length,
          eventCount: events.length,
          upcomingEvents,
          strategySignals,
          watchlistMemberships,
        },
        timeline: items,
      },
    });
  });

  // ruo 迁移 §8：数据健康读模型 + workflow 运行审计（供仪表盘 / 设置页消费）。
  app.get('/api/market-data-status', () => callTool('get_market_data_status', {}));
  app.get('/api/workflow-runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '30');
    return callTool('list_workflow_runs', {
      limit: Number.isFinite(limit) ? limit : 30,
      includeWatch: true,
    });
  });

  // 对话助手：AI SDK UI Message Stream（SSE），web 内部端点，不进 toolRegistry。
  app.post('/api/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是 JSON：{ "messages": [...] }',
          issues: [],
        },
      });
    }
    const runtime = chatRuntimeRef.current;
    if (runtime === undefined) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            kind: 'llm_error',
            provider: ctxRef.current.adapters.llm.name,
            cause: 'AI 模型尚未配置，请前往设置页完成 LLM 设置',
            retryable: false,
          },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }
    return createChatStreamResponse(body, ctxRef.current, runtime, c.req.raw.signal);
  });

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

    return jsonResult(await invokeTool('search_stocks', { query: q.trim(), limit }));
  });

  app.get('/api/advice', (c) => {
    const subjectId = c.req.query('subjectId');
    const subjectKind = c.req.query('subjectKind');
    const includeExpired = c.req.query('includeExpired');
    const limitRaw = c.req.query('limit');
    const input: Record<string, unknown> = {
      includeExpired: includeExpired === 'true' || includeExpired === '1',
    };
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    if (subjectKind !== undefined && subjectKind.length > 0) input.subjectKind = subjectKind;
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (Number.isInteger(limit) && limit > 0) input.limit = limit;
    }
    return callTool('get_advice', input);
  });

  app.get('/api/advice/stats', (c) => {
    const subjectId = c.req.query('subjectId');
    const input: Record<string, unknown> = {};
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    return callTool('get_advice_stats', input);
  });

  app.get('/api/reports', (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['kind', 'from', 'to', 'status'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.length > 0) input[key] = value;
    }
    const scopeKind = c.req.query('scope');
    const accountId = c.req.query('accountId');
    if (scopeKind === 'all-accounts') input.scope = { kind: 'all-accounts' };
    if (scopeKind === 'account' && accountId !== undefined) {
      input.scope = { kind: 'account', accountId };
    }
    const limit = Number(c.req.query('limit'));
    if (Number.isInteger(limit) && limit > 0) input.limit = limit;
    return callTool('list_reports', input);
  });

  app.post('/api/reports/run/:kind', async (c) => {
    const denied = mutationPermission(c.req.raw, webToken);
    if (denied !== null) return jsonResult(denied);
    const kind = c.req.param('kind');
    const workflow =
      kind === 'opening'
        ? openingReportWorkflow
        : kind === 'closing'
          ? closingReportWorkflow
          : kind === 'weekly'
            ? weeklyReportWorkflow
            : undefined;
    if (workflow === undefined) return jsonResult(notFound('ReportWorkflow', kind));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const raw =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const input = {
      ...raw,
      mode: 'manual' as const,
      ...(kind === 'weekly' && typeof raw.date === 'string'
        ? { periodEnd: raw.date, date: undefined }
        : {}),
    };
    return jsonResult(await workflow.run(input, ctxRef.current));
  });

  app.get('/api/reports/:id/render', (c) =>
    callTool('render_report', {
      reportId: c.req.param('id'),
      format: c.req.query('format') === 'plain-text' ? 'plain-text' : 'markdown',
    }),
  );

  app.get('/api/reports/:id', (c) => callTool('get_report', { id: c.req.param('id') }));

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

  // outcome 回填（write；仅当 exposeWrite 开启时挂载）。
  // 默认不暴露：避免 web 端被滥用为批量回填入口。
  if (exposeWrite) {
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
      (EXPOSED_SIDE_EFFECTS.has(tool.sideEffect) && (tool.sideEffect !== 'write' || exposeWrite)) ||
      (tool.sideEffect === 'external' && exposeExternal && WEB_ALLOWED_EXTERNAL.has(name));
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
  // 行情源以设置页持久化的值为准（含启动装配），不能只读 process.env。
  const marketSettingsStore = new MarketSettingsStore(process.env);
  const ctx = await buildWebContext(dbPath, marketSettingsStore.runtimeEnv());
  const aiSettingsStore = new AISettingsStore(process.env);
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
    aiSettingsStore,
    marketSettingsStore,
  });
  const server = Bun.serve({ port: options.port, hostname, fetch: app.fetch });
  ctx.logger.info(`luoome web 已启动: http://${hostname}:${server.port}`);
  if (resolved.filePath !== null) {
    ctx.logger.info(`Web 写操作 token: ${resolved.filePath}（复制文件内容到 Web「设置」页）`);
  }
  if (process.env.LUOOME_EXPOSE_WRITE !== 'true') {
    ctx.logger.info(
      'write 能力未开启：设置 LUOOME_EXPOSE_WRITE=true 后重启可启用持仓/预警等写操作',
    );
  }
  if (process.env.LUOOME_EXPOSE_EXTERNAL !== 'true') {
    ctx.logger.info(
      'external 能力未开启：设置 LUOOME_EXPOSE_EXTERNAL=true 后重启可启用行情同步/盯盘等外部调用',
    );
  }
  return server;
};
