// @luoome/web —— 最小 Web 端（docs/archive/plan.md 跨包契约 / ARCHITECTURE §10）。
// Hono HTTP API + 同源静态仪表盘：
//   GET  /api/stocks/search    → search_stocks tool（本地股票目录优先，外部行情源补充）
//   GET  /api/holdings          → list_holdings
//   GET  /api/advice            → get_advice（?subjectId=&includeExpired=）
//   GET  /api/advice/stats        → get_advice_stats
//   POST /api/advice/delete       → delete_advice（write，body { ids }）
//   POST /api/tools/:name/call    → 默认只放行 read/advice（ARCHITECTURE §7.1）；
//                                   write 需 LUOOME_EXPOSE_WRITE=true，external 需
//                                   LUOOME_EXPOSE_EXTERNAL=true 且命中白名单
//                                   （fetch_quote 等）；trade 一律 403 permission_denied。
// 所有 /api 响应统一 ToolResult 形状；同源部署，无需 CORS。

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createFeishuWebhookAdapterFromEnv,
  createFileAuditLogger,
  createFundamentalDataAdapterFromEnv,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createNotificationManagerFromEnv,
  createResearchEmbeddingAdapterFromEnv,
  createResearchRemoteDocumentAdapter,
  createResearchVaultAdapterFromEnv,
  createResearchVaultGitSyncAdapterFromEnv,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
  MarketSourceIdSchema,
  NotificationManager,
} from '@luoome/adapters';
import {
  BUILTIN_STRATEGY_TEMPLATES,
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  NotificationSchema,
  type SideEffect,
  type ToolContext,
  type ToolError,
  type ToolResult,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import {
  auditPortfolioPerformanceSnapshotsTool,
  buildContext,
  cancelStrategyEvaluationSessionTool,
  createStrictStrategyBacktestTool,
  executeStrictStrategyBacktestTool,
  finishStrategyEvaluationSessionTool,
  getAccountPerformanceTool,
  getResearchVaultRemoteSyncStatusTool,
  getStrategyEvaluationSessionTool,
  getStrictStrategyBacktestTool,
  listPortfolioPerformanceSnapshotsTool,
  listStrategyEvaluationDaysTool,
  listStrictStrategyBacktestsTool,
  resumeStrategyEvaluationSessionTool,
  startStrategyEvaluationSessionTool,
  syncStrategyWatchlistSubscriptionsTool,
  toolRegistry,
} from '@luoome/tools';
import {
  closingReportWorkflow,
  openingReportWorkflow,
  replayStrategyRangeWorkflow,
  runIntradayWatchObserved,
  syncResearchVaultRemoteWorkflow,
  weeklyReportWorkflow,
} from '@luoome/workflows';
import { type Context, Hono } from 'hono';
import { ZodError, z } from 'zod';

import { AISettingsStore, SaveAISettingsSchema } from './ai-settings.js';
import { type ChatStreamRuntime, createChatStreamResponse } from './chat.js';
import { DATA_TRANSFER_CATEGORIES, exportDataArchive, importDataArchive } from './data-transfer.js';
import { FeishuSettingsStore, SaveFeishuSettingsSchema } from './feishu-settings.js';
import {
  type MarketDatasetStatusRow,
  MarketSettingsStore,
  SaveMarketSettingsSchema,
  withRuntimeStatus,
} from './market-settings.js';
import {
  PORTFOLIO_PERFORMANCE_SCHEDULER_INTERVAL_MS,
  startPortfolioPerformanceScheduler,
} from './portfolio-performance-scheduler.js';
import {
  ResearchVaultSettingsStore,
  SaveResearchVaultSettingsSchema,
} from './research-vault-settings.js';
import { STRATEGY_SCHEDULER_INTERVAL_MS, startStrategyScheduler } from './strategy-scheduler.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const STRATEGY_BACKTEST_MAX_DAYS = 31;
const StrategyBacktestRequest = z
  .object({
    versionId: z.string().min(1).optional(),
    from: z.string().date(),
    to: z.string().date(),
    stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  })
  .superRefine((input, ctx) => {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T00:00:00.000Z`);
    if (from > to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'from 不能晚于 to' });
      return;
    }
    const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > STRATEGY_BACKTEST_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Web 单次历史模拟最多 ${STRATEGY_BACKTEST_MAX_DAYS} 个自然日`,
      });
    }
  });

const StrictStrategyBacktestRequest = z.object({
  evaluationSessionId: z.string().min(1),
  initialCash: z.number().positive().default(1_000_000),
  benchmarkStockId: z.string().min(1).default('000300.SH'),
  benchmarkDatasetVersion: z.string().min(1).default('000300.SH:qfq:daily:v1'),
  lotSize: z.number().int().positive().default(100),
  maxPositions: z.number().int().min(1).max(100).default(20),
  costs: z.object({
    commissionBps: z.number().nonnegative().max(100),
    minimumCommission: z.number().nonnegative(),
    sellStampDutyBps: z.number().nonnegative().max(100),
    buySlippageBps: z.number().nonnegative().max(500),
    sellSlippageBps: z.number().nonnegative().max(500),
  }),
});

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
  'fetch_intraday_minutes',
  'get_stock_minute_bars',
  'get_ashare_sentiment',
  'get_stock_market_view',
  'get_account_performance',
  'sync_stock_universe',
  'sync_daily_bars',
  'sync_financial_facts',
  'run_strategy',
  'generate_strategy_insight',
  'search_research_documents_hybrid',
  'rebuild_research_embeddings',
  'evaluate_research_embeddings',
  'propose_strategy_version_draft',
  'trial_strategy_version',
  'import_remote_research_document',
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

const jsonResult = (result: ToolResult<unknown>, statusOverride?: number): Response =>
  new Response(JSON.stringify(result), {
    status: statusOverride ?? (result.ok ? 200 : statusOf(result.error)),
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
 * 进程级共享数据源实例集（docs/ddd/source-pluggability-and-observation-design.md §4.6/§4.7）。
 * 当前仅 EastmoneySource；组装根创建一次后分发给 market 与五个非行情 factory，
 * 行情源热更新复用同一实例。
 */
export interface WebSourceSet {
  readonly eastmoney?: EastmoneySource;
}

/**
 * 组装 web 端 ToolContext（与其他 surface 同一模式）：
 * LUOOME_HOME 下的 luoome.db + createDrizzleRepos + 真实行情/LLM + buildContext。
 * 空数据库保持为空，不自动插入任何业务记录。
 */
export const buildWebContext = async (
  dbPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: { readonly sources?: WebSourceSet } = {},
): Promise<ToolContext> => {
  const now = (): Date => new Date();
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = createDrizzleRepos(dbPath);
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
  let researchVault: ReturnType<typeof createResearchVaultAdapterFromEnv>;
  try {
    researchVault = createResearchVaultAdapterFromEnv(env);
  } catch (error) {
    console.warn('Research Vault 配置无效；Web 将以未挂载状态启动', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let researchEmbedding: ReturnType<typeof createResearchEmbeddingAdapterFromEnv>;
  try {
    researchEmbedding = createResearchEmbeddingAdapterFromEnv(env);
  } catch (error) {
    console.warn('Research embedding 配置无效；Web 将以 capability 未挂载状态启动', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let researchVaultGitSync: ReturnType<typeof createResearchVaultGitSyncAdapterFromEnv>;
  try {
    researchVaultGitSync = createResearchVaultGitSyncAdapterFromEnv(env, {
      backupRoot: join(dirname(dbPath), 'backups', 'research-vault'),
    });
  } catch {
    console.warn('Research Vault 远端同步配置无效；Web 将以未挂载状态启动');
  }
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与五个非行情 factory（§4.6）
  const eastmoney = deps.sources?.eastmoney ?? new EastmoneySource({ clock: now });
  const sources = { eastmoney };
  const market = createMarketAdapterFromEnv(env, {
    clock: now,
    logger: console,
    // Web 持仓与 Watchlist 盘中轮询；TTL 不调小的话拿到的都是缓存
    quoteCacheTtlMs: 10_000,
    sources,
  });
  const fundamentalData = createFundamentalDataAdapterFromEnv(env);
  return buildContext({
    repos: handle.repos,
    adapters: {
      market,
      stockUniverse: createStockUniverseManagerFromEnv(env, {
        clock: now,
        logger: console,
      }),
      llm: ai?.llm ?? unavailableLLM,
    },
    ...(ai === undefined ? {} : { agent: ai.agent }),
    clock: now,
    auditLog: createFileAuditLogger(join(dirname(dbPath), 'logs', 'audit.log')),
    auditCaller: 'web',
    user: { id: 'local-web-user', defaultAccountId },
    portfolioBenchmark: {
      stockId:
        env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() || DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
    },
    limitUpLadder: createLimitUpLadderManagerFromEnv(env, { clock: now, logger: console, sources }),
    dragonTiger: createDragonTigerManagerFromEnv(env, { clock: now, logger: console, sources }),
    northboundFlow: createNorthboundFlowManagerFromEnv(env, {
      clock: now,
      logger: console,
      sources,
    }),
    news: createNewsManagerFromEnv(env, { clock: now, logger: console, sources }),
    sectorQuote: createSectorQuoteManagerFromEnv(env, { clock: now, logger: console }),
    ashareSentiment: createAShareSentimentManagerFromEnv(env, {
      clock: now,
      logger: console,
      market,
      sources,
    }),
    ...(researchVault ? { researchVault } : {}),
    ...(researchEmbedding ? { researchEmbedding } : {}),
    ...(researchVaultGitSync ? { researchVaultGitSync } : {}),
    ...(fundamentalData === undefined ? {} : { fundamentalData }),
    researchRemote: createResearchRemoteDocumentAdapter(),
    notification: createNotificationManagerFromEnv(env, {
      repos: handle.repos,
      logger: console,
      clock: now,
    }),
  });
};

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

const mutationPermission = (request: Request): ToolResult<never> | null => {
  // 同源 Origin 校验挡住浏览器被恶意站点带着执行本地 mutation。
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return permissionDenied('跨站 Origin 不允许执行本地 mutation');
  }
  return null;
};

/** 构造 Hono app（注入 ctx，便于测试与复用）。 */
/**
 * 构造 Hono app（注入 ctx，便于测试与复用）。
 * 接受 ctx 引用对象 { current } 而非裸 ToolContext。浏览器账户选择通过
 * X-Luoome-Account-Id 形成 request-scoped context；无 header 的本地调用沿用默认账户。
 */
export const createWebApp = (initialCtx: ToolContext, options: CreateWebAppOptions = {}): Hono => {
  // 兼容无 header 的本地调用，同时为浏览器请求提供 request-scoped 账户选择。
  // 这样不同 tab 的 localStorage 账户不会再互相覆盖共享进程上下文。
  const ctxRef: { current: ToolContext } = { current: initialCtx };
  const requestStorage = new AsyncLocalStorage<Request>();
  const chatRuntimeRef: { current: ChatStreamRuntime | undefined } = {
    current: options.chatStreamRuntime ?? asChatStreamRuntime(initialCtx.agent),
  };
  const exposeWrite = options.exposeWrite ?? process.env.LUOOME_EXPOSE_WRITE === 'true';
  const exposeExternal = options.exposeExternal ?? process.env.LUOOME_EXPOSE_EXTERNAL === 'true';
  const aiSettingsStore = options.aiSettingsStore;
  const marketSettingsStore = options.marketSettingsStore;
  const sharedSources = options.sources;
  const researchVaultSettingsStore = options.researchVaultSettingsStore;
  const feishuSettingsStore = options.feishuSettingsStore;
  const dataTransferDbPath = options.dataTransferDbPath;
  const app = new Hono();

  /** 浏览器 api.js 从 localStorage 发送的账户选择；没有时沿用本地默认账户。 */
  const contextForRequest = (): ToolContext => {
    const request = requestStorage.getStore();
    const accountId = request?.headers.get('x-luoome-account-id')?.trim();
    return {
      ...ctxRef.current,
      ...(request === undefined ? {} : { abortSignal: request.signal }),
      ...(accountId === undefined || accountId.length === 0
        ? {}
        : { user: { ...ctxRef.current.user, defaultAccountId: accountId } }),
    };
  };

  app.use('*', async (c, next) => requestStorage.run(c.req.raw, next));

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
    return new Response(Bun.file(join(PUBLIC_DIR, 'js', filename)), {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  });

  // —— HTTP API（统一 ToolResult 形状）——
  const callTool = async (name: string, input: unknown): Promise<Response> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return jsonResult(notFound('Tool', name));
    return jsonResult(await tool.execute(input, contextForRequest()));
  };

  /**
   * 内部组合调用：直接返回 ToolResult（不包 Response），便于聚合端点统一 wrap。
   */
  const invokeTool = async (name: string, input: unknown): Promise<ToolResult<unknown>> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) return notFound('Tool', name);
    return tool.execute(input, contextForRequest());
  };

  const getEvaluationSession = (input: { sessionId: string }) =>
    getStrategyEvaluationSessionTool.execute(input, ctxRef.current);
  const listEvaluationDays = (input: { sessionId: string }) =>
    listStrategyEvaluationDaysTool.execute(input, ctxRef.current);
  const startEvaluationSession = (
    input: Parameters<typeof startStrategyEvaluationSessionTool.execute>[0],
  ) => startStrategyEvaluationSessionTool.execute(input, ctxRef.current);
  const finishEvaluationSession = (
    input: Parameters<typeof finishStrategyEvaluationSessionTool.execute>[0],
  ) => finishStrategyEvaluationSessionTool.execute(input, ctxRef.current);
  const resumeEvaluationSession = (
    input: Parameters<typeof resumeStrategyEvaluationSessionTool.execute>[0],
  ) => resumeStrategyEvaluationSessionTool.execute(input, ctxRef.current);
  const cancelEvaluationSession = (
    input: Parameters<typeof cancelStrategyEvaluationSessionTool.execute>[0],
  ) => cancelStrategyEvaluationSessionTool.execute(input, ctxRef.current);

  type EvaluationJobInput = {
    readonly strategyId: string;
    readonly versionId: string | undefined;
    readonly from: string;
    readonly to: string;
    readonly stockIds: string[] | undefined;
  };
  const evaluationJobs = new Map<string, Promise<void>>();

  const startEvaluationJob = (sessionId: string, input: EvaluationJobInput): void => {
    if (evaluationJobs.has(sessionId)) return;
    const job = (async (): Promise<void> => {
      const result = await replayStrategyRangeWorkflow.run(
        {
          ...input,
          from: new Date(`${input.from}T00:00:00.000Z`),
          to: new Date(`${input.to}T00:00:00.000Z`),
          persist: true,
          owner: `web-evaluation:${sessionId}`,
          resumeSessionId: sessionId,
        },
        contextForRequest(),
      );
      if (!result.ok) {
        const session = await getEvaluationSession({ sessionId });
        if (session.ok && session.data.session?.status === 'running') {
          await finishEvaluationSession({
            sessionId,
            status: 'failed',
            error:
              result.error.kind === 'invalid_input'
                ? result.error.message
                : `evaluation_job_failed:${result.error.kind}`,
          });
        }
        ctxRef.current.logger.error('web evaluation job failed', {
          sessionId,
          strategyId: input.strategyId,
          errorKind: result.error.kind,
        });
      }
    })()
      .catch(async (error: unknown) => {
        const session = await getEvaluationSession({ sessionId });
        if (session.ok && session.data.session?.status === 'running') {
          await finishEvaluationSession({
            sessionId,
            status: 'failed',
            error: 'evaluation_job_failed',
          });
        }
        ctxRef.current.logger.error('web evaluation job crashed', {
          sessionId,
          strategyId: input.strategyId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        evaluationJobs.delete(sessionId);
      });
    evaluationJobs.set(sessionId, job);
  };

  const evaluationSnapshot = async (sessionId: string): Promise<ToolResult<unknown>> => {
    const session = await getEvaluationSession({ sessionId });
    if (!session.ok) return session;
    if (session.data.session === null) return notFound('StrategyEvaluationSession', sessionId);
    const days = await listEvaluationDays({ sessionId });
    if (!days.ok) return days;
    const rows = days.data.days;
    const completedDays = rows.filter((day) => day.status === 'complete').length;
    const failedDays = rows.filter((day) => day.status === 'failed').length;
    return {
      ok: true,
      data: {
        session: session.data.session,
        days: rows,
        status: session.data.session.status,
        summary: {
          tradingDays: rows.length,
          completedDays,
          failedDays,
          vintageAvailableDays: rows.filter((day) => day.vintageStatus === 'available').length,
          vintageUnavailableDays: rows.filter((day) => day.vintageStatus === 'unavailable').length,
          evaluatedCount: rows.reduce((sum, day) => sum + (day.evaluatedCount ?? 0), 0),
          selectedCount: rows.reduce((sum, day) => sum + (day.selectedCount ?? 0), 0),
          signalCount: rows.reduce((sum, day) => sum + (day.signalCount ?? 0), 0),
          failedCount: rows.reduce((sum, day) => sum + (day.failedCount ?? 0), 0),
        },
      },
    };
  };

  const strictBacktestJobs = new Map<string, Promise<void>>();
  const startStrictBacktestJob = (backtestRunId: string, strategyId: string): void => {
    if (strictBacktestJobs.has(backtestRunId)) return;
    const job = executeStrictStrategyBacktestTool
      .execute({ backtestRunId }, ctxRef.current)
      .then((result) => {
        if (!result.ok || result.data.run.status === 'failed') {
          ctxRef.current.logger.error('web strict backtest job failed', {
            backtestRunId,
            strategyId,
            errorKind: result.ok ? result.data.run.error : result.error.kind,
          });
        }
      })
      .catch((error: unknown) => {
        ctxRef.current.logger.error('web strict backtest job crashed', {
          backtestRunId,
          strategyId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        strictBacktestJobs.delete(backtestRunId);
      });
    strictBacktestJobs.set(backtestRunId, job);
  };

  interface BatchQuoteTarget {
    name: string;
    quote: {
      close: number;
      observedAt: unknown;
      retrieval: 'live' | 'local-fallback';
      freshness: 'fresh' | 'stale';
    } | null;
    changePct: number | null;
  }

  /**
   * batch_quote 聚合写回（batch_quote 上限 100 只）：整体失败降级为
   * quote 保持 null + warnings；单只失败跳过；changePct 全行统一昨收基准换算。
   */
  const applyBatchQuotes = async <T extends BatchQuoteTarget>(
    entries: ReadonlyMap<string, T>,
    warnings: string[],
    degradeLabel: string,
    { updateName = false, keepExistingChangePct = false } = {},
  ): Promise<void> => {
    const stockIds = [...entries.keys()].slice(0, 100);
    if (stockIds.length === 0) return;
    const quotesResult = await invokeTool('batch_quote', {
      stockIds,
      context: 'display',
    });
    if (!quotesResult.ok) {
      warnings.push(`batch_quote 失败（${quotesResult.error.kind}），${degradeLabel}`);
      return;
    }
    const { items } = quotesResult.data as {
      items: Array<
        | {
            stockId: string;
            stockName: string;
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
      const entry = entries.get(result.stockId);
      if (entry === undefined) continue;
      if (updateName) entry.name = result.stockName;
      entry.quote = {
        close: result.quote.close,
        observedAt: result.quote.observedAt,
        retrieval: result.retrieval,
        freshness: result.freshness,
      };
      const prevClose = result.quote.prevClose;
      if (
        (!keepExistingChangePct || entry.changePct === null) &&
        typeof prevClose === 'number' &&
        prevClose > 0
      ) {
        entry.changePct = ((result.quote.close - prevClose) / prevClose) * 100;
      }
    }
  };

  app.get('/api/research/topics', (c) =>
    callTool('list_research_topics', {
      kind: c.req.query('kind') || undefined,
      subject: c.req.query('subject') || undefined,
      limit: Number(c.req.query('limit') ?? '50'),
    }),
  );
  app.get('/api/research/topics/:id', (c) =>
    callTool('get_research_topic', { topicId: c.req.param('id') }),
  );
  app.get('/api/research/documents', (c) =>
    callTool('list_research_documents', {
      topicId: c.req.query('topicId') || undefined,
      subject: c.req.query('subject') || undefined,
      kind: c.req.query('kind') || undefined,
      limit: Number(c.req.query('limit') ?? '50'),
    }),
  );
  app.get('/api/research/documents/:id', (c) =>
    callTool('get_research_document', {
      documentId: c.req.param('id'),
      includeContent: c.req.query('content') === '1',
    }),
  );
  app.get('/api/research/search', (c) =>
    callTool('search_research_documents', {
      text: c.req.query('q') ?? '',
      limit: Number(c.req.query('limit') ?? '50'),
    }),
  );

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
    const denied = requireMutationCapabilities(request, [sideEffect]);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(request);
    if (!('parsed' in body)) return jsonResult(body);
    return jsonResult(await invokeTool(toolName, { ...body.data, ...fixedInput }));
  };

  app.get('/api/research/embeddings/status', () => callTool('get_research_embedding_status', {}));
  app.post('/api/research/search/hybrid', (c) =>
    targetMutation(c.req.raw, 'external', 'search_research_documents_hybrid'),
  );
  app.post('/api/research/embeddings/rebuild', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external', 'write']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    return jsonResult(await invokeTool('rebuild_research_embeddings', body.data));
  });
  app.post('/api/research/embeddings/evaluate', (c) =>
    targetMutation(c.req.raw, 'external', 'evaluate_research_embeddings'),
  );

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

  app.get('/api/data/categories', () =>
    jsonResult({ ok: true, data: { categories: [...DATA_TRANSFER_CATEGORIES] } }),
  );

  app.post('/api/data/export', async (c) => {
    if (dataTransferDbPath === undefined) {
      return jsonResult(notFound('DataTransferDatabase', 'default'));
    }
    try {
      const body = (await c.req.json()) as { categories?: unknown };
      const categories = Array.isArray(body.categories) ? body.categories : [];
      const archive = exportDataArchive(dataTransferDbPath, categories as string[]);
      const date = archive.exportedAt.slice(0, 10);
      return new Response(JSON.stringify(archive), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="luoome-${date}.json"`,
        },
      });
    } catch (error) {
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

  app.post('/api/data/import', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (dataTransferDbPath === undefined) {
      return jsonResult(notFound('DataTransferDatabase', 'default'));
    }
    try {
      const body = (await c.req.json()) as { archive?: unknown };
      return jsonResult({
        ok: true,
        data: importDataArchive(dataTransferDbPath, body.archive),
      });
    } catch (error) {
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
  app.get('/api/settings/market', async () => {
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    try {
      const view = marketSettingsStore.read();
      // 叠加运行态（§5）：读模型失败时降级为纯配置态，不拖垮设置读取
      const status = await invokeTool('get_market_data_status', {});
      if (!status.ok) return jsonResult({ ok: true, data: view });
      const datasets = (status.data as { datasets?: MarketDatasetStatusRow[] }).datasets;
      if (!Array.isArray(datasets)) return jsonResult({ ok: true, data: view });
      return jsonResult({ ok: true, data: withRuntimeStatus(view, datasets) });
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
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
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
      // 只改来源顺序：复用进程级 SourceSet，仅重建 market 与依赖 market 的 sentiment（§4.7）
      const sharedDeps =
        sharedSources?.eastmoney === undefined
          ? {}
          : { sources: { eastmoney: sharedSources.eastmoney } };
      const market = createMarketAdapterFromEnv(candidateEnv, {
        clock: ctxRef.current.clock,
        logger: ctxRef.current.logger,
        ...sharedDeps,
      });
      const ashareSentiment = createAShareSentimentManagerFromEnv(candidateEnv, {
        clock: ctxRef.current.clock,
        logger: ctxRef.current.logger,
        market,
        ...sharedDeps,
      });
      const saved = marketSettingsStore.save(input);
      ctxRef.current = {
        ...ctxRef.current,
        adapters: { ...ctxRef.current.adapters, market },
        ashareSentiment,
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

  /**
   * 主动探测指定行情源的全部能力（设置页「测试」按钮）：逐项执行 registry handle，
   * 观测自动写入（§4.3），响应携带探测明细与叠加最新运行态的设置视图。
   * 只允许探测已启用源（未启用源不在当前 manager 的 registry 里，无 handle 可执行）。
   */
  app.post('/api/settings/market/:id/test', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    if (marketSettingsStore === undefined) {
      return jsonResult(notFound('MarketSettingsStore', 'default'));
    }
    const parsed = MarketSourceIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: `未知的行情源：${c.req.param('id')}`, issues: [] },
      });
    }
    const market = ctxRef.current.adapters.market;
    const view = marketSettingsStore.read();
    if (!view.activeOrder.includes(parsed.data)) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `行情源 ${parsed.data} 未启用，先启用并保存后再测试`,
          issues: [],
        },
      });
    }
    if (typeof market.probeSource !== 'function') {
      return jsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: market.name,
          cause: '当前行情适配器不支持主动探测',
          recoverable: false,
        },
      });
    }
    const probes = await market.probeSource(parsed.data);
    // 探测后重新聚合一次运行态，前端直接用响应里的 settings 刷新列表
    const fresh = marketSettingsStore.read();
    const status = await invokeTool('get_market_data_status', {});
    const datasets = status.ok
      ? (status.data as { datasets?: MarketDatasetStatusRow[] }).datasets
      : undefined;
    const settings = Array.isArray(datasets) ? withRuntimeStatus(fresh, datasets) : fresh;
    return jsonResult({ ok: true, data: { probes, settings } });
  });

  // ===== 飞书通知设置 =====
  app.get('/api/settings/feishu', () => {
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      return jsonResult({ ok: true, data: feishuSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `飞书设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.post('/api/settings/feishu', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      const input = SaveFeishuSettingsSchema.parse(await c.req.json());
      const saved = feishuSettingsStore.save(input);
      const adapter = createFeishuWebhookAdapterFromEnv(feishuSettingsStore.runtimeEnv(), {
        logger: ctxRef.current.logger,
      });
      if (ctxRef.current.notification instanceof NotificationManager) {
        ctxRef.current.notification.configureFeishu(adapter);
      }
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '飞书设置校验失败',
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

  app.post('/api/settings/feishu/test', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    if (feishuSettingsStore === undefined) {
      return jsonResult(notFound('FeishuSettingsStore', 'default'));
    }
    try {
      if (!feishuSettingsStore.read().configured) {
        return jsonResult({
          ok: false,
          error: { kind: 'invalid_input', message: '请先保存飞书 Webhook', issues: [] },
        });
      }
      const sent = await ctxRef.current.notification?.send({
        channel: 'feishu',
        payload: {
          title: '飞书通知连接测试',
          content: 'luoome 已成功连接此群。后续策略 Advice 可通过该 Webhook 投递。',
          level: 'success',
        },
      });
      if (sent === undefined) {
        return jsonResult({
          ok: false,
          error: { kind: 'internal', cause: 'NotificationManager 未注入' },
        });
      }
      const notification = NotificationSchema.parse(sent.notification);
      if (notification.result !== 'success') {
        return jsonResult({
          ok: false,
          error: {
            kind: 'adapter_error',
            adapter: 'feishu-webhook',
            cause: notification.errorMessage ?? notification.result,
            recoverable: false,
          },
        });
      }
      return jsonResult({
        ok: true,
        data: { delivered: true, sentAt: notification.sentAt },
      });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'feishu-webhook',
          cause: error instanceof Error ? error.message : String(error),
          recoverable: false,
        },
      });
    }
  });

  // ===== Research Vault 设置 =====
  app.get('/api/settings/research-vault', () => {
    if (researchVaultSettingsStore === undefined) {
      return jsonResult(notFound('ResearchVaultSettingsStore', 'default'));
    }
    try {
      return jsonResult({ ok: true, data: researchVaultSettingsStore.read() });
    } catch (error) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'internal',
          cause: `Vault 设置读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });

  app.post('/api/settings/research-vault', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    if (researchVaultSettingsStore === undefined) {
      return jsonResult(notFound('ResearchVaultSettingsStore', 'default'));
    }
    try {
      const input = SaveResearchVaultSettingsSchema.parse(await c.req.json());
      const saved = researchVaultSettingsStore.save(input);
      const researchVault = createResearchVaultAdapterFromEnv(
        researchVaultSettingsStore.runtimeEnv(),
      );
      if (researchVault === undefined) throw new Error('Vault 配置未生效');
      const researchVaultGitSync = createResearchVaultGitSyncAdapterFromEnv(
        researchVaultSettingsStore.runtimeEnv(),
        {
          backupRoot: join(
            dirname(dataTransferDbPath ?? resolveDbPath()),
            'backups',
            'research-vault',
          ),
        },
      );
      const nextContext = { ...ctxRef.current, researchVault };
      delete nextContext.researchVaultGitSync;
      ctxRef.current =
        researchVaultGitSync === undefined ? nextContext : { ...nextContext, researchVaultGitSync };
      return jsonResult({ ok: true, data: { ...saved, applied: true } });
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'Vault 设置校验失败',
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

  app.get('/api/research/remote-sync/status', async () =>
    jsonResult(await getResearchVaultRemoteSyncStatusTool.execute({}, contextForRequest())),
  );

  app.post('/api/research/remote-sync', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    return jsonResult(
      await syncResearchVaultRemoteWorkflow.run(
        { ...body.data, mode: 'manual' },
        contextForRequest(),
      ),
    );
  });

  app.get('/api/chat/sessions', () => callTool('list_chat_sessions', { limit: 100 }));
  app.post('/api/chat/sessions', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
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
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
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
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    return callTool('delete_chat_session', { sessionId: c.req.param('id') });
  });

  app.post('/api/settings/ai', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
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

  const accountPerformanceResponse = async (c: Context, accountId: string): Promise<Response> => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from === undefined || to === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'from 和 to 必填（YYYY-MM-DD）',
          issues: [],
        },
      });
    }
    return jsonResult(
      await getAccountPerformanceTool.execute(
        {
          accountId,
          from,
          to,
          ...(c.req.query('benchmarkStockId') === undefined
            ? {}
            : { benchmarkStockId: c.req.query('benchmarkStockId') }),
        },
        contextForRequest(),
      ),
    );
  };
  app.get('/api/account/performance', (c) =>
    accountPerformanceResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance', (c) => accountPerformanceResponse(c, c.req.param('id')));
  const accountPerformanceSnapshotsResponse = async (
    c: Context,
    accountId: string,
  ): Promise<Response> =>
    jsonResult(
      await listPortfolioPerformanceSnapshotsTool.execute(
        {
          accountId,
          ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit') }),
        },
        contextForRequest(),
      ),
    );
  app.get('/api/account/performance/snapshots', (c) =>
    accountPerformanceSnapshotsResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance/snapshots', (c) =>
    accountPerformanceSnapshotsResponse(c, c.req.param('id')),
  );
  const accountPerformanceSnapshotAuditResponse = async (
    c: Context,
    accountId: string,
  ): Promise<Response> => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from === undefined || to === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'from 和 to 必填（YYYY-MM-DD）',
          issues: [],
        },
      });
    }
    return jsonResult(
      await auditPortfolioPerformanceSnapshotsTool.execute(
        {
          accountId,
          from,
          to,
          ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit') }),
        },
        contextForRequest(),
      ),
    );
  };
  app.get('/api/account/performance/snapshot-audit', (c) =>
    accountPerformanceSnapshotAuditResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance/snapshot-audit', (c) =>
    accountPerformanceSnapshotAuditResponse(c, c.req.param('id')),
  );

  /**
   * 切换当前激活账户：浏览器把账户 id 保存到 localStorage，后续请求通过
   * X-Luoome-Account-Id 形成 request-scoped 账户上下文；无 header 的本地调用仍兼容共享默认账户。
   */
  app.post('/api/account/select', async (c) => {
    // 该路由不写 db，但仍是 mutation，应与 /api/tools/:name/call 的 write/external 守卫一致。
    const denied = mutationPermission(c.req.raw);
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

  /** 连板天梯 / 对比共用 query 解析；compare 的校验顺序保持先 date 后 prevDate。 */
  const parseLimitUpQuery = (
    c: Context,
    { requirePrevDate }: { requirePrevDate: boolean },
  ): { input: Record<string, unknown> } | { response: Response } => {
    const date = c.req.query('date');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        response: jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'date 必填且为 YYYY-MM-DD',
            issues: [],
          },
        }),
      };
    }
    const input: Record<string, unknown> = { date };
    if (requirePrevDate) {
      const prevDate = c.req.query('prevDate');
      if (typeof prevDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(prevDate)) {
        return {
          response: jsonResult({
            ok: false,
            error: { kind: 'invalid_input', message: 'prevDate 必填且为 YYYY-MM-DD', issues: [] },
          }),
        };
      }
      input.prevDate = prevDate;
    }
    input.days = intQuery(c.req.query('days'), 15, 1);
    input.source = enumQuery(c.req.query('source'), 'eastmoney', ['eastmoney']);
    input.includeStar = c.req.query('includeStar') === 'true';
    input.includeBse = c.req.query('includeBse') === 'true';
    input.includeST = c.req.query('includeST') === 'true';
    input.includeUncategorized = c.req.query('includeUncategorized') === 'true';
    return { input };
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
    const parsed = parseLimitUpQuery(c, { requirePrevDate: false });
    if ('response' in parsed) return parsed.response;
    const r = await invokeTool('limit_up_ladder', parsed.input);
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
    const parsed = parseLimitUpQuery(c, { requirePrevDate: true });
    if ('response' in parsed) return parsed.response;
    const r = await invokeTool('limit_up_ladder_compare', parsed.input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // HTML route for SPA shell
  app.get('/market/limit-up', serveFile('index.html', 'text/html; charset=utf-8'));

  /**
   * 行业板块行情（fetch_sector_quotes tool；实时快照，无缓存）。
   *
   * 参数：
   *   sort (可选) changePct | amount，默认 changePct
   *   limit (可选) 1-200，默认 50；all=true 时按上游 total 加载完整集合
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/market/sectors', async (c) => {
    const input: Record<string, unknown> = {};
    const sort = c.req.query('sort');
    if (sort !== undefined) input.sort = sort;
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number.parseInt(limit, 10);
    const all = c.req.query('all');
    if (all !== undefined) input.all = all === 'true';
    const r = await invokeTool('fetch_sector_quotes', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // HTML route for SPA shell
  app.get('/market/sectors', serveFile('index.html', 'text/html; charset=utf-8'));

  /**
   * 财经要闻（fetch_news tool；7×24 滚动流，无缓存）。
   *
   * 参数：
   *   limit (可选) 1-100，默认 30
   *   category / keyword (可选) 透传 tool
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/news', async (c) => {
    const input: Record<string, unknown> = {};
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number.parseInt(limit, 10);
    const category = c.req.query('category');
    if (category !== undefined) input.category = category;
    const keyword = c.req.query('keyword');
    if (keyword !== undefined) input.keyword = keyword;
    const r = await invokeTool('fetch_news', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 龙虎榜（dragon_tiger_list tool；Manager 自带缓存与节假日历）。
   *
   * 参数：
   *   date (可选) YYYY-MM-DD；缺省时 manager 自动回溯最近交易日
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/dragon-tiger', async (c) => {
    const input: Record<string, unknown> = {};
    const date = c.req.query('date');
    if (date !== undefined) input.date = date;
    const r = await invokeTool('dragon_tiger_list', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

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
        templates: BUILTIN_STRATEGY_TEMPLATES,
      },
    }),
  );
  app.post('/api/strategies', (c) => targetMutation(c.req.raw, 'write', 'create_strategy'));
  app.delete('/api/strategies/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id', (c) =>
    callTool('get_strategy', { strategyId: c.req.param('id') }),
  );
  app.get('/api/strategies/:id/workspace', (c) =>
    callTool('get_strategy_workspace', { strategyId: c.req.param('id') }),
  );
  app.get('/api/strategies/:id/decision-cycles', (c) => {
    const runId = c.req.query('runId');
    const stockId = c.req.query('stockId');
    const accountId = c.req.query('accountId');
    const limit = c.req.query('limit');
    return callTool('get_strategy_decision_cycles', {
      strategyId: c.req.param('id'),
      ...(accountId === undefined ? {} : { accountId }),
      ...(runId === undefined ? {} : { runId }),
      ...(stockId === undefined ? {} : { stockId }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });
  app.get('/api/strategies/:id/insights', (c) => {
    const windowDays = c.req.query('windowDays');
    const scope = c.req.query('scope');
    const evaluationSessionId = c.req.query('evaluationSessionId');
    return callTool('get_strategy_insight_facts', {
      strategyId: c.req.param('id'),
      ...(windowDays === undefined ? {} : { windowDays: Number(windowDays) }),
      ...(scope === undefined ? {} : { scope }),
      ...(evaluationSessionId === undefined ? {} : { evaluationSessionId }),
    });
  });
  app.get('/api/strategies/:id/definition-diff', (c) =>
    callTool('compare_strategy_definitions', {
      strategyId: c.req.param('id'),
      ...(c.req.query('fromVersionId') === undefined
        ? {}
        : { fromVersionId: c.req.query('fromVersionId') }),
      ...(c.req.query('toVersionId') === undefined
        ? {}
        : { toVersionId: c.req.query('toVersionId') }),
    }),
  );
  app.post('/api/strategies/:id/insights/generate', (c) =>
    targetMutation(c.req.raw, 'external', 'generate_strategy_insight', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id/schedule', (c) =>
    callTool('get_strategy_schedule', { strategyId: c.req.param('id') }),
  );
  app.post('/api/strategies/:id/schedule', (c) =>
    targetMutation(c.req.raw, 'write', 'set_strategy_schedule', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id/results', (c) => {
    const runId = c.req.query('runId');
    const view = c.req.query('view') ?? 'selected';
    const rankingWindow = c.req.query('rankingWindow');
    const query = c.req.query('query');
    const sort = c.req.query('sort');
    const order = c.req.query('order');
    const offset = c.req.query('offset');
    const limit = c.req.query('limit');
    return callTool('list_strategy_result_views', {
      strategyId: c.req.param('id'),
      view,
      ...(runId === undefined ? {} : { runId }),
      ...(rankingWindow === undefined ? {} : { rankingWindow: Number(rankingWindow) }),
      ...(query === undefined ? {} : { query }),
      ...(sort === undefined ? {} : { sort }),
      ...(order === undefined ? {} : { order }),
      ...(offset === undefined ? {} : { offset: Number(offset) }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });
  app.post('/api/strategies/:id/versions', (c) =>
    targetMutation(c.req.raw, 'write', 'create_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/validate', (c) =>
    targetMutation(c.req.raw, 'write', 'validate_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/publish', (c) =>
    targetMutation(c.req.raw, 'write', 'publish_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/pause', (c) =>
    targetMutation(c.req.raw, 'write', 'pause_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/resume', (c) =>
    targetMutation(c.req.raw, 'write', 'resume_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/run', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    const run = await invokeTool('run_strategy', {
      ...body.data,
      strategyId: c.req.param('id'),
    });
    if (!run.ok || typeof run.data !== 'object' || run.data === null) return jsonResult(run);
    const payload = run.data as {
      readonly run?: { readonly id?: unknown; readonly status?: unknown };
      readonly persisted?: unknown;
    } & Record<string, unknown>;
    if (
      payload.persisted !== true ||
      typeof payload.run?.id !== 'string' ||
      payload.run.status === 'failed'
    ) {
      return jsonResult(run);
    }
    const synced = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: c.req.param('id'), producerRunId: payload.run.id },
      contextForRequest(),
    );
    return jsonResult({
      ...run,
      data: {
        ...payload,
        watchlistSync: synced.ok
          ? synced.data
          : {
              status: 'failed',
              error:
                'message' in synced.error
                  ? synced.error.message
                  : 'cause' in synced.error
                    ? synced.error.cause
                    : synced.error.kind,
            },
      },
    });
  });
  app.get('/api/strategies/:id/watchlists', (c) =>
    callTool('list_strategy_watchlist_subscriptions', {
      strategyId: c.req.param('id'),
      status: 'active',
    }),
  );
  app.post('/api/strategies/:id/watchlists', (c) =>
    targetMutation(c.req.raw, 'write', 'subscribe_strategy_to_watchlist', {
      strategyId: c.req.param('id'),
    }),
  );
  app.delete('/api/strategies/:id/watchlists/:watchlistId', (c) =>
    targetMutation(c.req.raw, 'write', 'unsubscribe_strategy_from_watchlist', {
      strategyId: c.req.param('id'),
      watchlistId: c.req.param('watchlistId'),
    }),
  );
  app.get('/api/strategies/:id/strict-backtests', async (c) => {
    const result = await listStrictStrategyBacktestsTool.execute(
      { strategyId: c.req.param('id'), limit: 50 },
      contextForRequest(),
    );
    return jsonResult(result);
  });
  app.get('/api/strategies/:id/strict-backtests/:backtestRunId', async (c) => {
    const result = await getStrictStrategyBacktestTool.execute(
      { backtestRunId: c.req.param('backtestRunId') },
      contextForRequest(),
    );
    if (!result.ok) return jsonResult(result);
    if (result.data.run === null || result.data.run.spec.strategyId !== c.req.param('id')) {
      return jsonResult(notFound('StrictStrategyBacktest', c.req.param('backtestRunId')));
    }
    return jsonResult(result);
  });
  app.post('/api/strategies/:id/strict-backtests', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    const parsed = StrictStrategyBacktestRequest.safeParse(body.data);
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '严格回测参数无效',
          issues: parsed.error.issues,
        },
      });
    }
    const created = await createStrictStrategyBacktestTool.execute(
      { strategyId: c.req.param('id'), ...parsed.data },
      contextForRequest(),
    );
    if (!created.ok) return jsonResult(created);
    if (created.data.run.status === 'queued') {
      startStrictBacktestJob(created.data.run.id, c.req.param('id'));
    }
    return jsonResult(
      { ok: true, data: { run: created.data.run } },
      created.data.run.status === 'queued' ? 202 : 200,
    );
  });
  app.get('/api/strategies/:id/backtests/:sessionId', async (c) => {
    const session = await getEvaluationSession({
      sessionId: c.req.param('sessionId'),
    });
    if (!session.ok) return jsonResult(session);
    if (session.data.session === null) {
      return jsonResult(notFound('StrategyEvaluationSession', c.req.param('sessionId')));
    }
    if (session.data.session.strategyId !== c.req.param('id')) {
      return jsonResult(notFound('StrategyEvaluationSession', c.req.param('sessionId')));
    }
    return jsonResult(await evaluationSnapshot(c.req.param('sessionId')));
  });
  app.post('/api/strategies/:id/backtests', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    const parsed = StrategyBacktestRequest.safeParse(body.data);
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '历史模拟参数无效',
          issues: parsed.error.issues,
        },
      });
    }
    const started = await startEvaluationSession({
      strategyId: c.req.param('id'),
      ...parsed.data,
    });
    if (!started.ok) return jsonResult(started);
    startEvaluationJob(started.data.session.id, {
      strategyId: c.req.param('id'),
      versionId: parsed.data.versionId,
      from: parsed.data.from,
      to: parsed.data.to,
      stockIds: parsed.data.stockIds,
    });
    return jsonResult(
      {
        ok: true,
        data: {
          session: started.data.session,
          status: 'queued',
          sessionId: started.data.session.id,
        },
      },
      202,
    );
  });
  app.post('/api/strategies/:id/backtests/:sessionId/retry', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const sessionId = c.req.param('sessionId');
    const existing = await getEvaluationSession({ sessionId });
    if (!existing.ok) return jsonResult(existing);
    if (existing.data.session === null || existing.data.session.strategyId !== c.req.param('id')) {
      return jsonResult(notFound('StrategyEvaluationSession', sessionId));
    }
    const resumed = await resumeEvaluationSession({ sessionId });
    if (!resumed.ok) return jsonResult(resumed);
    startEvaluationJob(sessionId, {
      strategyId: resumed.data.session.strategyId,
      versionId: resumed.data.session.strategyVersionId,
      from: resumed.data.session.from.toISOString().slice(0, 10),
      to: resumed.data.session.to.toISOString().slice(0, 10),
      stockIds:
        resumed.data.session.stockIds === undefined
          ? undefined
          : [...resumed.data.session.stockIds],
    });
    return jsonResult({ ok: true, data: { session: resumed.data.session, status: 'queued' } }, 202);
  });
  app.post('/api/strategies/:id/backtests/:sessionId/cancel', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const sessionId = c.req.param('sessionId');
    const existing = await getEvaluationSession({ sessionId });
    if (!existing.ok) return jsonResult(existing);
    if (existing.data.session === null || existing.data.session.strategyId !== c.req.param('id')) {
      return jsonResult(notFound('StrategyEvaluationSession', sessionId));
    }
    return jsonResult(await cancelEvaluationSession({ sessionId }));
  });
  app.post('/api/strategies/:id/draft', (c) =>
    targetMutation(c.req.raw, 'external', 'propose_strategy_version_draft', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/trial', (c) =>
    targetMutation(c.req.raw, 'external', 'trial_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id/runs', (c) => {
    const scope = c.req.query('scope');
    const publication = c.req.query('publication');
    return callTool('list_strategy_runs', {
      strategyId: c.req.param('id'),
      limit: 50,
      ...(scope === undefined ? {} : { scope }),
      ...(publication === undefined ? {} : { publication }),
    });
  });
  app.get('/api/strategy-runs/compare', (c) => {
    const fromRunId = c.req.query('fromRunId');
    const toRunId = c.req.query('toRunId');
    return callTool('compare_strategy_runs', {
      strategyId: c.req.query('strategyId'),
      ...(fromRunId === undefined ? {} : { fromRunId }),
      ...(toRunId === undefined ? {} : { toRunId }),
    });
  });
  app.get('/api/strategy-runs/:id', (c) =>
    callTool('get_strategy_run', { runId: c.req.param('id') }),
  );

  app.get('/api/watchlists', () => callTool('list_watchlists', {}));
  app.post('/api/watchlists', (c) => targetMutation(c.req.raw, 'write', 'create_watchlist'));

  /**
   * Watchlist 总览聚合（PRD §10.1）：一次请求组装主视图与已归档弹窗所需数据，
   * 前端按 tab 派生，切换视图不重复拉取。照 /api/dashboard 模式：
   * invokeTool + 请求内缓存；单列表 detail/changes 失败降级为警告，不拖垮整个端点。
   * 「已归档列表」= enabled=false：core Watchlist 无 archivedAt，repo.archive 即停用。
   */
  app.get('/api/watchlists/overview', async () => {
    interface OverviewWatchlist {
      id: string;
      name: string;
      kind: string;
      membershipPolicy: string;
      enabled: boolean;
    }
    interface OverviewMember {
      member: {
        id: string;
        watchlistId: string;
        stockId: string;
        stage: string;
        priority: string;
        archivedAt?: unknown;
      };
      sources: Array<{ kind: string; status: string; dataAsOf?: unknown }>;
    }
    interface OverviewRun {
      run: { startedAt: string; finishedAt?: string };
      snapshots: Array<{ stockId: string; change: string; reason: string }>;
    }
    const warnings: string[] = [];
    // 「今日」按服务器本地日期（与快照的落库时间同一口径）。
    const now = ctxRef.current.clock();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [watchlistsResult, triggersResult] = await Promise.all([
      invokeTool('list_watchlists', {}),
      invokeTool('list_watch_triggers', { limit: 200 }),
    ]);
    if (!watchlistsResult.ok) return jsonResult(watchlistsResult);
    const rows = (
      watchlistsResult.data as {
        items: Array<{
          watchlist: OverviewWatchlist;
          memberCount: number;
          sourceHealth: { active: number; stale: number };
        }>;
      }
    ).items;

    // Watchlist 详情 / 同步变化在一次请求内复用。
    const detailCache = new Map<string, Promise<ToolResult<unknown>>>();
    const detailOf = (id: string): Promise<ToolResult<unknown>> => {
      const cached = detailCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('get_watchlist', {
        watchlistId: id,
        includeArchivedMembers: true,
      });
      detailCache.set(id, pending);
      return pending;
    };
    const changesCache = new Map<string, Promise<ToolResult<unknown>>>();
    const changesOf = (id: string): Promise<ToolResult<unknown>> => {
      const cached = changesCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('list_watchlist_changes', { watchlistId: id, limit: 50 });
      changesCache.set(id, pending);
      return pending;
    };

    interface TodayChange {
      watchlistId: string;
      watchlistName: string;
      stockId: string;
      direction: 'entered' | 'exited';
      reason: string;
      at: string;
    }
    interface StockMembership {
      watchlistId: string;
      watchlistName: string;
      stage: string;
      priority: string;
      sources: OverviewMember['sources'];
      holding: boolean;
    }
    const lists: Array<Record<string, unknown>> = [];
    interface OverviewStock {
      stockId: string;
      /** 股票名称；batch_quote 成功前暂为 stockId。 */
      name: string;
      quote: {
        close: number;
        observedAt: unknown;
        retrieval: 'live' | 'local-fallback';
        freshness: 'fresh' | 'stale';
      } | null;
      /** 涨跌幅（%）：与 dashboard 看板同口径，batch_quote 昨收基准换算，无基准为 null。 */
      changePct: number | null;
      memberships: StockMembership[];
    }
    const stocksById = new Map<string, OverviewStock>();
    const todayChanges: TodayChange[] = [];
    const archivedLists: OverviewWatchlist[] = [];
    const archivedMembers: Array<Record<string, unknown>> = [];

    for (const { watchlist, memberCount, sourceHealth } of rows) {
      if (!watchlist.enabled) archivedLists.push(watchlist);
      let members: OverviewMember[] = [];
      const detail = await detailOf(watchlist.id);
      if (detail.ok) {
        members = (detail.data as { members: OverviewMember[] }).members;
      } else {
        warnings.push(
          `get_watchlist(${watchlist.id}) 失败（${detail.error.kind}），总览跳过该列表成员`,
        );
      }
      let todayEntered = 0;
      let todayExited = 0;
      const changes = await changesOf(watchlist.id);
      if (changes.ok) {
        for (const { run, snapshots } of (changes.data as { runs: OverviewRun[] }).runs) {
          const at = new Date(run.finishedAt ?? run.startedAt);
          if (at < todayStart) continue;
          for (const snapshot of snapshots) {
            if (snapshot.change !== 'entered' && snapshot.change !== 'exited') continue;
            if (snapshot.change === 'entered') todayEntered += 1;
            else todayExited += 1;
            todayChanges.push({
              watchlistId: watchlist.id,
              watchlistName: watchlist.name,
              stockId: snapshot.stockId,
              direction: snapshot.change,
              reason: snapshot.reason,
              at: at.toISOString(),
            });
          }
        }
      } else if (changes.error.kind !== 'not_found') {
        warnings.push(
          `list_watchlist_changes(${watchlist.id}) 失败（${changes.error.kind}），今日变化降级为空`,
        );
      }
      const activeMembers = members.filter(({ member }) => member.stage !== 'archived');
      lists.push({
        watchlist,
        memberCount,
        discoveredCount: activeMembers.filter(({ member }) => member.stage === 'discovered').length,
        sourceHealth,
        todayEntered,
        todayExited,
      });
      for (const { member, sources } of members) {
        if (member.stage === 'archived') {
          archivedMembers.push({
            watchlistId: watchlist.id,
            watchlistName: watchlist.name,
            member,
          });
          continue;
        }
        const entry = stocksById.get(member.stockId) ?? {
          stockId: member.stockId,
          name: member.stockId,
          quote: null,
          changePct: null,
          memberships: [],
        };
        entry.memberships.push({
          watchlistId: watchlist.id,
          watchlistName: watchlist.name,
          stage: member.stage,
          priority: member.priority,
          sources,
          holding: sources.some(
            (source) => source.kind === 'portfolio' && source.status === 'active',
          ),
        });
        stocksById.set(member.stockId, entry);
      }
    }

    interface OverviewTrigger {
      stockId: string;
      priority: string;
      ruleKind: string;
      reason: string;
      createdAt: string;
    }
    let triggers: OverviewTrigger[] = [];
    if (triggersResult.ok) {
      triggers = (triggersResult.data as { triggers: OverviewTrigger[] }).triggers;
    } else {
      warnings.push(`list_watch_triggers 失败（${triggersResult.error.kind}），触发摘要降级为空`);
    }
    // list_watch_triggers 按 createdAt 倒序，首次出现即该股最新一条。
    const latestByStock: Record<
      string,
      { at: string; ruleKind: string; priority: string; reason: string }
    > = {};
    for (const trigger of triggers) {
      if (latestByStock[trigger.stockId] !== undefined) continue;
      latestByStock[trigger.stockId] = {
        at: trigger.createdAt,
        ruleKind: trigger.ruleKind,
        priority: trigger.priority,
        reason: trigger.reason,
      };
    }

    // 成员股票行情：照 /api/dashboard 看板模式一次 batch_quote 聚合，
    // 整体失败降级为 quote=null，不拖垮总览端点。
    await applyBatchQuotes(stocksById, warnings, '总览行情降级为空', { updateName: true });

    return jsonResult({
      ok: true,
      data: {
        lists,
        stocks: [...stocksById.values()],
        todayChanges,
        archived: { lists: archivedLists, members: archivedMembers },
        triggers: {
          urgentImportantCount: triggers.filter(
            (trigger) => trigger.priority === 'urgent' || trigger.priority === 'important',
          ).length,
          latestByStock,
        },
        meta: { warnings },
      },
    });
  });

  app.get('/api/watchlist-changes', (c) => {
    const watchlistId = c.req.query('watchlistId');
    if (typeof watchlistId !== 'string' || watchlistId.trim().length === 0) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '缺少 watchlistId 参数', issues: [] },
      });
    }
    return callTool('list_watchlist_changes', {
      watchlistId,
      limit: intQuery(c.req.query('limit'), 50, 1),
    });
  });

  app.get('/api/watchlists/:id', (c) =>
    callTool('get_watchlist', { watchlistId: c.req.param('id') }),
  );
  app.patch('/api/watchlists/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/archive', (c) =>
    targetMutation(c.req.raw, 'write', 'archive_watchlist', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/members', (c) =>
    targetMutation(c.req.raw, 'write', 'add_watchlist_member', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/members/batch', (c) =>
    targetMutation(c.req.raw, 'write', 'add_watchlist_members', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.patch('/api/watchlists/:id/members/:stockId', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist_member', {
      watchlistId: c.req.param('id'),
      stockId: c.req.param('stockId'),
    }),
  );
  app.post('/api/watchlists/:id/members/:stockId/archive', (c) =>
    targetMutation(c.req.raw, 'write', 'archive_watchlist_member', {
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
  app.patch('/api/alert-plans/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'update_alert_plan', {
      alertPlanId: c.req.param('id'),
    }),
  );
  app.delete('/api/alert-plans/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_alert_plan', {
      alertPlanId: c.req.param('id'),
    }),
  );

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
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
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
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
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
    return jsonResult(await runIntradayWatchObserved(input, contextForRequest(), 'once'));
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
    await applyBatchQuotes(board, warnings, '看板行情降级为空', { keepExistingChangePct: true });
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

  app.get('/api/research/stocks/:id', (c) =>
    callTool('get_stock_research_view', { stockId: c.req.param('id'), limit: 200 }),
  );

  // ruo 迁移 §8：数据健康读模型 + workflow 运行审计（供仪表盘 / 设置页消费）。
  app.get('/api/market-data-status', () => callTool('get_market_data_status', {}));

  // 行情页指数条：与 /api/dashboard 共用 invokeIndexQuotes 缓存（15s TTL + 60s stale），
  // 失败按 dashboard 语义降级为空数组，不拖垮行情页。
  app.get('/api/market/indices', async () => {
    const indexQuotes = await invokeIndexQuotes();
    if (indexQuotes.ok) return jsonResult({ ok: true, data: indexQuotes.data });
    return jsonResult({ ok: true, data: { indices: [] } });
  });

  /**
   * 指数当日分时（fetch_intraday_minutes tool；tencent 分钟端点仅沪深，恒指不支持）。
   *
   * 参数：code (必填) 指数代码，白名单见 INDEX_INTRADAY_STOCK_IDS
   * 降级：数据源不支持 → { ok: true, data: { supported: false, points: [] } }（200）；
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  const INDEX_INTRADAY_STOCK_IDS: Readonly<Record<string, string>> = {
    '000001': '000001.SH', // 上证指数
    '399001': '399001.SZ', // 深证成指
    '399006': '399006.SZ', // 创业板指
    '000300': '000300.SH', // 沪深300
    '000688': '000688.SH', // 科创50
  };
  app.get('/api/market/indices/intraday', async (c) => {
    const code = c.req.query('code') ?? '';
    const stockId = INDEX_INTRADAY_STOCK_IDS[code];
    if (stockId === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `不支持的指数 code: ${code === '' ? '(空)' : code}（可选 ${Object.keys(INDEX_INTRADAY_STOCK_IDS).join('/')}）`,
          issues: [],
        },
      });
    }
    const r = await invokeTool('fetch_intraday_minutes', { stockId });
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/workflow-runs', (c) => {
    const limit = Number(c.req.query('limit') ?? '30');
    return callTool('list_workflow_runs', {
      limit: Number.isFinite(limit) ? limit : 30,
      includeWatch: true,
    });
  });

  app.get('/api/strategy/reliability-summary', (c) => {
    const targetTradingDays = Number(c.req.query('targetTradingDays') ?? '30');
    const limit = Number(c.req.query('limit') ?? '1000');
    const strategyId = c.req.query('strategyId')?.trim();
    const scheduleId = c.req.query('scheduleId')?.trim();
    const since = c.req.query('since')?.trim();
    const until = c.req.query('until')?.trim();
    return callTool('get_strategy_reliability_summary', {
      ...(strategyId === undefined || strategyId.length === 0 ? {} : { strategyId }),
      ...(scheduleId === undefined || scheduleId.length === 0 ? {} : { scheduleId }),
      ...(since === undefined || since.length === 0 ? {} : { since }),
      ...(until === undefined || until.length === 0 ? {} : { until }),
      targetTradingDays: Number.isFinite(targetTradingDays) ? targetTradingDays : 30,
      limit: Number.isFinite(limit) ? limit : 1000,
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
            provider: contextForRequest().adapters.llm.name,
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
    return createChatStreamResponse(body, contextForRequest(), runtime, c.req.raw.signal);
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

  // 建议删除（单个 = 单元素 ids）；write 能力门控与 delete_report 一致。
  app.post('/api/advice/delete', (c) => targetMutation(c.req.raw, 'write', 'delete_advice'));

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
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
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
    return jsonResult(await workflow.run(input, contextForRequest()));
  });

  app.get('/api/reports/:id/render', (c) =>
    callTool('render_report', {
      reportId: c.req.param('id'),
      format: c.req.query('format') === 'plain-text' ? 'plain-text' : 'markdown',
    }),
  );

  app.get('/api/reports/:id', (c) => callTool('get_report', { id: c.req.param('id') }));

  app.delete('/api/reports/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_report', { reportId: c.req.param('id') }),
  );

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

  // 全局决策闭环复盘（read）：直接消费 get_decision_loop_review，保留 unknown/partial 语义。
  app.get('/api/review/decision-loop', (c) => {
    const accountId = c.req.query('accountId');
    const stockId = c.req.query('stockId');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const limit = c.req.query('limit');
    return callTool('get_decision_loop_review', {
      ...(accountId === undefined ? {} : { accountId }),
      ...(stockId === undefined ? {} : { stockId }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });

  // confidence 自校准（v0.5 W4）：把历史 advice 按 confidence 桶聚合 hitRate / avgPnl，
  // 复盘页右侧渲染成本表 + 整体命中率。
  app.get('/api/review/calibration', async () => callTool('get_confidence_calibration', {}));

  // outcome 回填（write；仅当 exposeWrite 开启时挂载）。
  // 默认不暴露：避免 web 端被滥用为批量回填入口。
  if (exposeWrite) {
    app.post('/api/review/:id/outcome', async (c) => {
      const denied = mutationPermission(c.req.raw);
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
    const primaryAllowed =
      (EXPOSED_SIDE_EFFECTS.has(tool.sideEffect) && (tool.sideEffect !== 'write' || exposeWrite)) ||
      (tool.sideEffect === 'external' && exposeExternal && WEB_ALLOWED_EXTERNAL.has(name));
    const capabilitiesAllowed = tool.requiredCapabilities.every(
      (capability) =>
        (capability !== 'write' || exposeWrite) &&
        (capability !== 'external' || exposeExternal) &&
        capability !== 'trade',
    );
    if (!primaryAllowed || !capabilitiesAllowed) {
      return jsonResult(permissionDenied(`web 端不暴露 ${tool.sideEffect} 类 tool（${name}）`));
    }
    if (tool.sideEffect === 'write' || tool.sideEffect === 'external') {
      const denied = mutationPermission(c.req.raw);
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
    return jsonResult(await tool.execute(input, contextForRequest()));
  });

  return app;
};

export interface StartWebOptions {
  readonly port: number;
  /** 缺省仅监听本机，避免把个人投资数据意外暴露到局域网。 */
  readonly host?: string;
  /** 缺省 resolveDbPath()（$LUOOME_HOME/luoome.db）。 */
  readonly dbPath?: string;
  /** write API 与后台任务必须显式开启；缺省读取 LUOOME_EXPOSE_WRITE。 */
  readonly exposeWrite?: boolean;
  /** external API 与后台任务必须显式开启；缺省读取 LUOOME_EXPOSE_EXTERNAL。 */
  readonly exposeExternal?: boolean;
  /** 仅供测试缩短 tick；生产固定每分钟检查一次。 */
  readonly strategySchedulerIntervalMs?: number;
  /** 仅供启动级测试关闭立即 tick；生产缺省立即检查。 */
  readonly strategySchedulerStartImmediately?: boolean;
  /** 仅供测试缩短 tick；生产每五分钟检查一次盘后账户绩效快照。 */
  readonly portfolioPerformanceSchedulerIntervalMs?: number;
  /** 仅供启动级测试观察 capability gate；生产使用真实 scheduler。 */
  readonly portfolioPerformanceSchedulerFactory?: typeof startPortfolioPerformanceScheduler;
}

export interface WebServerHandle {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

/** 启动 Web 与进程内策略调度器；stop() 会同时停止二者。 */
export const startWeb = async (options: StartWebOptions): Promise<WebServerHandle> => {
  const dbPath = options.dbPath ?? resolveDbPath();
  // 行情源以设置页持久化的值为准（含启动装配），不能只读 process.env。
  const marketSettingsStore = new MarketSettingsStore(process.env);
  const researchVaultSettingsStore = new ResearchVaultSettingsStore(process.env);
  const feishuSettingsStore = new FeishuSettingsStore(process.env);
  // composition root 持有进程级 SourceSet（§4.7）：主装配与热更新共用同一实例
  const sources: WebSourceSet = { eastmoney: new EastmoneySource() };
  const ctx = await buildWebContext(dbPath, researchVaultSettingsStore.runtimeEnv(), { sources });
  const aiSettingsStore = new AISettingsStore(process.env);
  const hostname = options.host ?? process.env.LUOOME_HOST ?? '127.0.0.1';
  const exposeWrite = options.exposeWrite ?? process.env.LUOOME_EXPOSE_WRITE === 'true';
  const exposeExternal = options.exposeExternal ?? process.env.LUOOME_EXPOSE_EXTERNAL === 'true';
  const app = createWebApp(ctx, {
    exposeWrite,
    exposeExternal,
    aiSettingsStore,
    marketSettingsStore,
    researchVaultSettingsStore,
    feishuSettingsStore,
    dataTransferDbPath: dbPath,
    sources,
  });
  const server = Bun.serve({ port: options.port, hostname, fetch: app.fetch });
  const scheduler = startStrategyScheduler(ctx, {
    intervalMs: options.strategySchedulerIntervalMs ?? STRATEGY_SCHEDULER_INTERVAL_MS,
    ...(options.strategySchedulerStartImmediately === undefined
      ? {}
      : { startImmediately: options.strategySchedulerStartImmediately }),
  });
  const portfolioPerformanceScheduler =
    exposeWrite && exposeExternal
      ? (options.portfolioPerformanceSchedulerFactory ?? startPortfolioPerformanceScheduler)(ctx, {
          intervalMs:
            options.portfolioPerformanceSchedulerIntervalMs ??
            PORTFOLIO_PERFORMANCE_SCHEDULER_INTERVAL_MS,
        })
      : undefined;
  ctx.logger.info(`luoome web 已启动: http://${hostname}:${server.port}`);
  if (!exposeWrite) {
    ctx.logger.info(
      'write 能力未开启：设置 LUOOME_EXPOSE_WRITE=true 后重启可启用持仓/预警等写操作',
    );
  }
  if (!exposeExternal) {
    ctx.logger.info(
      'external 能力未开启：设置 LUOOME_EXPOSE_EXTERNAL=true 后重启可启用行情同步/盯盘等外部调用',
    );
  }
  if (portfolioPerformanceScheduler === undefined) {
    ctx.logger.info(
      `账户绩效盘后快照调度器未启动：需要同时显式开启 LUOOME_EXPOSE_WRITE=true 与 LUOOME_EXPOSE_EXTERNAL=true（write=${exposeWrite ? '已开启' : '未开启'}，external=${exposeExternal ? '已开启' : '未开启'}）`,
      { exposeWrite, exposeExternal },
    );
  }
  return {
    port: server.port ?? options.port,
    stop: (closeActiveConnections) => {
      scheduler.stop();
      portfolioPerformanceScheduler?.stop();
      server.stop(closeActiveConnections);
    },
  };
};
