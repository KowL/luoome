// @luoome/web —— Web 服务组装根（docs/ddd/domain-simplification-and-architecture-convergence-detailed-design.md §7.1）。
// 本文件只保留：Hono 实例、ctx/依赖注入、同源静态资源、领域路由注册、进程启动与调度器。
// 领域路由见 ./routes/*.ts；共享 HTTP helper 见 ./http/*.ts；ToolContext 组装见 ./context.ts。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EastmoneySource } from '@luoome/adapters';
import type { ToolContext, ToolResult } from '@luoome/core';
import { toolRegistry } from '@luoome/tools';
import { type Context, Hono } from 'hono';

import { AISettingsStore } from './ai-settings.js';
import type { ChatStreamRuntime } from './chat.js';
import { buildWebContext, resolveDbPath, type WebSourceSet } from './context.js';
import { FeishuSettingsStore } from './feishu-settings.js';
import { appServiceTool } from './http/app-service.js';
import { jsonResult, notFound, parseJsonObject, permissionDenied } from './http/result.js';
import { startIntradayPlanScheduler } from './intraday-plan-scheduler.js';
import { startMarketBatchScheduler } from './market-batch-scheduler.js';
import { MarketSettingsStore } from './market-settings.js';
import { startPortfolioPerformanceScheduler } from './portfolio-performance-scheduler.js';
import { ResearchVaultSettingsStore } from './research-vault-settings.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerSettingsRoutes } from './routes/settings.js';
import {
  applyBatchQuotes as applyBatchQuotesImpl,
  createIndexQuotesCache,
} from './routes/shared.js';
import { registerStrategyRoutes } from './routes/strategy.js';
import { registerToolGatewayRoutes } from './routes/tool-gateway.js';
import type { WebRouteDeps } from './routes/types.js';
import { registerWatchlistAlertRoutes } from './routes/watchlist-alert.js';
import { startStrategyScheduler } from './strategy-scheduler.js';

export type { WebSourceSet };
export { buildWebContext, resolveDbPath };

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const LIGHTWEIGHT_CHARTS_FILE = join(
  dirname(fileURLToPath(import.meta.resolve('lightweight-charts/package.json'))),
  'dist',
  'lightweight-charts.standalone.production.mjs',
);

/**
 * 副作用能力开关：显式 options 优先，未提供时才读取环境变量。
 * Web 路由与进程内调度器共用同一解析，避免「路由已开、调度器仍看环境变量」的分叉。
 */
const resolveExpose = (value: boolean | undefined, envName: string): boolean =>
  value ?? process.env[envName] === 'true';

export interface CreateWebAppOptions {
  /** write tools/routes 必须显式开启；默认读取 LUOOME_EXPOSE_WRITE。 */
  readonly exposeWrite?: boolean;
  /** external tools/routes 必须显式开启；默认读取 LUOOME_EXPOSE_EXTERNAL。 */
  readonly exposeExternal?: boolean;
  /** LLM 设置持久化；仅生产启动注入，测试可按需提供临时 store。 */
  readonly aiSettingsStore?: AISettingsStore;
  /** 行情源设置持久化；保存后立即替换当前 Web 进程的 market adapter。 */
  readonly marketSettingsStore?: MarketSettingsStore;
  /**
   * 进程级共享 SourceSet（§4.7）：行情源热更新只改来源顺序时复用同一 EastmoneySource
   * 实例，只重建 market 与直接依赖 market 的 sentiment manager，不产生第二个实例。
   * 未来若设置项会改变 Eastmoney client 本身（超时、代理、base URL 等），必须先以新
   * SourceSet 构造并验证 market + 五个非行情 manager 的完整 candidate 图，验证成功后
   * 一次性替换 ctxRef 与本引用；失败时旧图保持不变。
   */
  readonly sources?: WebSourceSet;
  /** Research Vault 设置持久化；保存后即时替换当前 adapter。 */
  readonly researchVaultSettingsStore?: ResearchVaultSettingsStore;
  /** 飞书 Webhook 设置；保存后热更新共享 NotificationManager。 */
  readonly feishuSettingsStore?: FeishuSettingsStore;
  /** 流式聊天 runtime；测试可注入，生产默认复用 AI SDK agent。 */
  readonly chatStreamRuntime?: ChatStreamRuntime;
  /** 数据导出/导入所用 SQLite 文件；生产启动注入，未注入时端点返回 not_found。 */
  readonly dataTransferDbPath?: string;
}

/**
 * 构造 Hono app（注入 ctx，便于测试与复用）。
 * 浏览器账户选择通过 X-Luoome-Account-Id 形成 request-scoped context；
 * 无 header 的本地调用沿用默认账户。
 */
export const createWebApp = (
  initialCtx: ToolContext | undefined,
  options: CreateWebAppOptions = {},
): Hono => {
  if (initialCtx === undefined) throw new Error('local Web requires a context');
  const mutationPermission = (request: Request): ToolResult<never> | null => {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(request.url).origin) {
      return permissionDenied('跨站 Origin 不允许执行本地 mutation');
    }
    return null;
  };
  // 兼容无 header 的本地调用，同时为浏览器请求提供 request-scoped 账户选择。
  // 这样不同 tab 的 localStorage 账户不会再互相覆盖共享进程上下文。
  let localContext = initialCtx;
  const requestStorage = new AsyncLocalStorage<{
    request: Request;
  }>();
  const ctxRef = {
    get current(): ToolContext {
      if (localContext === undefined) throw new Error('Web request context unavailable');
      return localContext;
    },
    set current(context: ToolContext) {
      localContext = context;
    },
  };
  const chatRuntimeRef: { current: ChatStreamRuntime | undefined } = {
    current: options.chatStreamRuntime,
  };
  const exposeWrite = resolveExpose(options.exposeWrite, 'LUOOME_EXPOSE_WRITE');
  const exposeExternal = resolveExpose(options.exposeExternal, 'LUOOME_EXPOSE_EXTERNAL');
  const aiSettingsStore = options.aiSettingsStore;
  const marketSettingsStore = options.marketSettingsStore;
  const sharedSources = options.sources;
  const researchVaultSettingsStore = options.researchVaultSettingsStore;
  const feishuSettingsStore = options.feishuSettingsStore;
  const dataTransferDbPath = options.dataTransferDbPath;
  const app = new Hono();

  /** 浏览器 api.js 从 localStorage 发送的账户选择；没有时沿用本地默认账户。 */
  const contextForRequest = (): ToolContext => {
    const request = requestStorage.getStore()?.request;
    const accountId = request?.headers.get('x-luoome-account-id')?.trim();
    return {
      ...ctxRef.current,
      ...(request === undefined ? {} : { abortSignal: request.signal }),
      ...(accountId === undefined || accountId.length === 0
        ? {}
        : { user: { ...ctxRef.current.user, defaultAccountId: accountId } }),
    };
  };

  app.use('*', async (c, next) =>
    requestStorage.run(
      {
        request: c.req.raw,
      },
      next,
    ),
  );

  const requireMutationCapabilities = (
    request: Request,
    capabilities: readonly ('write' | 'external')[],
  ): ToolResult<never> | null => {
    for (const capability of capabilities) {
      const exposed = capability === 'write' ? exposeWrite : exposeExternal;
      if (!exposed) {
        return permissionDenied(
          `${capability} 操作未开启；设置 LUOOME_EXPOSE_${capability.toUpperCase()}=true`,
        );
      }
    }
    return mutationPermission(request);
  };

  // —— 同源静态仪表盘（原生 HTML/JS，无构建步骤）——
  /**
   * 静态资源响应：按 mtime+size 生成 ETag，并用 `no-cache` 让浏览器每次重新校验。
   * 本地工具没有构建步骤，隐式缓存会让改完的前端模块继续跑旧代码；未修改时回 304，不重复传输。
   */
  const staticResponse = async (
    request: Request,
    file: string,
    contentType: string,
  ): Promise<Response> => {
    const bunFile = Bun.file(join(PUBLIC_DIR, file));
    if (bunFile.size === 0) return new Response('not found', { status: 404 });
    const etag = `W/"${bunFile.lastModified}-${bunFile.size}"`;
    const headers = { 'content-type': contentType, 'cache-control': 'no-cache', etag };
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(bunFile, { headers });
  };

  const serveFile =
    (file: string, contentType: string) =>
    (c: Context): Promise<Response> =>
      staticResponse(c.req.raw, file, contentType);
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
  app.get('/dragon-tiger', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/reports', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/settings', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/review', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/chat', serveFile('index.html', 'text/html; charset=utf-8'));
  app.get('/research', serveFile('index.html', 'text/html; charset=utf-8'));
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
    return staticResponse(c.req.raw, join('js', filename), 'text/javascript; charset=utf-8');
  });

  // —— HTTP API（统一 ToolResult 形状）——
  const callTool = async (name: string, input: unknown): Promise<Response> => {
    const tool = toolRegistry.get(name) ?? appServiceTool(name);
    if (tool === undefined) return jsonResult(notFound('Tool', name));
    return jsonResult(await tool.execute(input, contextForRequest()));
  };

  /**
   * 内部组合调用：直接返回 ToolResult（不包 Response），便于聚合端点统一 wrap。
   */
  const invokeTool = async (name: string, input: unknown): Promise<ToolResult<unknown>> => {
    const tool = toolRegistry.get(name) ?? appServiceTool(name);
    if (tool === undefined) return notFound('Tool', name);
    return tool.execute(input, contextForRequest());
  };

  const bindDecisionAccount = (
    request: Request,
    input: unknown,
  ): { input: Record<string, unknown> } | { denied: ToolResult<never> } => {
    const object =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const accountId = contextForRequest().user.defaultAccountId;
    if (object.accountId !== undefined && object.accountId !== accountId) {
      return { denied: permissionDenied('请求账户与当前账户选择不一致') };
    }
    const headerId = request.headers.get('x-luoome-account-id')?.trim();
    if (headerId !== undefined && headerId.length > 0 && headerId !== accountId) {
      return { denied: permissionDenied('账户选择已变化，请刷新后重试') };
    }
    return { input: { ...object, accountId } };
  };

  const targetMutation = async (
    request: Request,
    sideEffect: 'write' | 'external',
    toolName: string,
    fixedInput: Readonly<Record<string, unknown>> = {},
  ): Promise<Response> => {
    const denied = requireMutationCapabilities(request, [sideEffect]);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(request);
    if (!('parsed' in body)) return jsonResult(body);
    return jsonResult(await invokeTool(toolName, { ...body.data, ...fixedInput }));
  };

  const decisionMutation = async (
    request: Request,
    name: string,
    fixed: Record<string, unknown> = {},
  ) => {
    const denied = requireMutationCapabilities(request, ['write']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(request);
    if (!('parsed' in body)) return jsonResult(body);
    const bound = bindDecisionAccount(request, { ...body.data, ...fixed });
    if ('denied' in bound) return jsonResult(bound.denied);
    return jsonResult(await invokeTool(name, bound.input));
  };

  // 指数行情缓存：dashboard 5s 轮询，push2 对高频请求突发限流（2026-07 实测），
  // 15s TTL 把请求量降到 1/3；调用失败时回退最近成功值（60s 内），避免指数条闪空。
  // —— 领域路由组装（S4.2）：deps 只暴露 server 内部闭包/状态，模块间无循环依赖 ——
  const applyBatchQuotes: WebRouteDeps['applyBatchQuotes'] = (
    entries,
    warnings,
    degradeLabel,
    options,
  ) => applyBatchQuotesImpl(invokeTool, entries, warnings, degradeLabel, options);
  const invokeIndexQuotes = createIndexQuotesCache(invokeTool);
  const deps: WebRouteDeps = {
    ctxRef,
    contextForRequest,
    callTool,
    invokeTool,
    parseJsonObject,
    requireMutationCapabilities,
    mutationPermission,
    targetMutation,
    decisionMutation,
    bindDecisionAccount,
    applyBatchQuotes,
    invokeIndexQuotes,
    serveFile,
    exposeWrite,
    exposeExternal,
    chatRuntimeRef,
    ...(aiSettingsStore === undefined ? {} : { aiSettingsStore }),
    ...(marketSettingsStore === undefined ? {} : { marketSettingsStore }),
    ...(feishuSettingsStore === undefined ? {} : { feishuSettingsStore }),
    ...(researchVaultSettingsStore === undefined ? {} : { researchVaultSettingsStore }),
    ...(sharedSources === undefined ? {} : { sharedSources }),
    ...(dataTransferDbPath === undefined ? {} : { dataTransferDbPath }),
  };
  registerResearchRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerPortfolioRoutes(app, deps);
  registerWatchlistAlertRoutes(app, deps);
  registerMarketRoutes(app, deps);
  registerStrategyRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerToolGatewayRoutes(app, deps);

  return app;
};

export interface StartWebOptions {
  readonly port: number;
  /** 默认监听回环地址，由反向代理终止 HTTPS。 */
  readonly host?: string;
  /** 本地 SQLite 数据库路径；缺省 $LUOOME_HOME/luoome.db。 */
  readonly dbPath?: string;
  /** write 能力开关；缺省读取 LUOOME_EXPOSE_WRITE。 */
  readonly exposeWrite?: boolean;
  /** external 能力开关；缺省读取 LUOOME_EXPOSE_EXTERNAL。 */
  readonly exposeExternal?: boolean;
}

export interface WebServerHandle {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/**
 * Bun.serve 默认 idleTimeout 只有 10s；流式对话在工具执行后等待下一段模型输出时
 * 可能更久无字节流动，连接会被服务端掐断（浏览器表现为 network error）。
 * 取 Bun 上限 255s，覆盖 agent 全程超时（120s）。
 */
export const WEB_SERVER_IDLE_TIMEOUT_SECONDS = 255;

/** 启动单机多账户 Web 服务及进程内业务调度器。 */
export const startWeb = async (options: StartWebOptions): Promise<WebServerHandle> => {
  const dbPath = options.dbPath ?? resolveDbPath();
  const sources: WebSourceSet = { eastmoney: new EastmoneySource({ clock: () => new Date() }) };
  const aiSettingsStore = new AISettingsStore(process.env);
  const marketSettingsStore = new MarketSettingsStore(process.env);
  const researchVaultSettingsStore = new ResearchVaultSettingsStore(process.env);
  const feishuSettingsStore = new FeishuSettingsStore(process.env);
  const runtimeEnv = {
    ...process.env,
    ...aiSettingsStore.runtimeEnv(),
    ...marketSettingsStore.runtimeEnv(),
    ...researchVaultSettingsStore.runtimeEnv(),
    ...feishuSettingsStore.runtimeEnv(),
  };
  const ctx = await buildWebContext(dbPath, runtimeEnv, { sources });
  const exposeWrite = resolveExpose(options.exposeWrite, 'LUOOME_EXPOSE_WRITE');
  const exposeExternal = resolveExpose(options.exposeExternal, 'LUOOME_EXPOSE_EXTERNAL');
  const app = createWebApp(ctx, {
    exposeWrite,
    exposeExternal,
    aiSettingsStore,
    marketSettingsStore,
    sources,
    researchVaultSettingsStore,
    feishuSettingsStore,
    dataTransferDbPath: dbPath,
  });
  const schedulers: Array<{ readonly stop: () => void }> = [
    startStrategyScheduler(ctx, { startImmediately: false }),
    startIntradayPlanScheduler(ctx, { startImmediately: false }),
    startPortfolioPerformanceScheduler(ctx, { startImmediately: false }),
  ];
  // 盘中批次采集访问外部行情并写本地快照：只有 write + external 同时显式开启才启动。
  if (exposeWrite && exposeExternal) {
    schedulers.push(startMarketBatchScheduler(ctx, { startImmediately: false, enabled: true }));
  }
  const host = options.host ?? '127.0.0.1';
  const server = Bun.serve({
    port: options.port,
    hostname: host,
    fetch: app.fetch,
    idleTimeout: WEB_SERVER_IDLE_TIMEOUT_SECONDS,
  });
  const port = server.port ?? options.port;
  console.log(`luoome web listening on http://${host}:${port}`);
  return {
    port,
    stop: async (closeActiveConnections = false) => {
      for (const scheduler of schedulers) scheduler.stop();
      await server.stop(closeActiveConnections);
    },
  };
};
