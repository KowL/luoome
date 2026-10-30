// dsh-luoome 纯插件生产 composition root（需求 §6.2，插件详细设计 §2/§3/§7）。
//
// 数据路径：受信任部署配置 → Node SQLite（`@luoome/db/node`）→ 真实 adapters *FromEnv
// → `buildContext` → 真实只读 surface。本模块不 import bun:sqlite、@luoome/mcp、CLI 或 Web，
// 也不读取 memory fixture：装配失败时拒绝启动，而不是降级成假数据。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import {
  createAShareSentimentManagerFromEnv,
  createFileAuditLogger,
  createLocalAdapters,
  createMarketAdapterFromEnv,
  createNotificationManagerFromEnv,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { createNodeDrizzleRepos, type NodeDrizzleReposHandle } from '@luoome/db/node';
import {
  buildContext,
  type ConfirmablePluginTool,
  decisionReviewOperation,
  toolRegistry,
} from '@luoome/tools';
import { updateAccountOperation } from './account-operations.js';
import {
  createAnalysisOperationPolicies,
  type TrustedAnalysisProvenance,
} from './analysis-operations.js';
import { createBatchOperationPolicies } from './batch-operations.js';
import { type MarketSettings, MarketSettingsStore } from './market-settings.js';
import {
  assertExternalMarketAllowlist,
  createMarketSurface,
  type MarketSurface,
  registerMarketTools,
} from './market-surface.js';
import {
  type ProductionConfig,
  resolveProductionConfig,
  resolveProductionConfigFromEnv,
} from './production-config.js';
import { createReadSurface, denied, type ReadSurface } from './read-surface.js';
import { createResearchJobs, type ResearchJobs } from './research-jobs.js';
import { createResearchOperationPolicies } from './research-operations.js';
import { createStrategyOperationPolicies } from './strategy-operations.js';
import { registerReadTools } from './tools.js';
import { createWatchlistOperationPolicies } from './watchlist-operations.js';
import { mountDshWebProfile } from './web-profile.js';

/** stderr logger：DSH 宿主进程的 stdout 留给他用，插件告警只写 stderr。 */
const createPluginLogger = (): Logger => {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      process.stderr.write(`[dsh-luoome][${level}] ${message}${suffix}\n`);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
};

/**
 * M1 硬卡：trade 永不注册。检查发生在创建目录、打开数据库等任何 IO 之前；
 * 同时检查显式传入的 adapters env 与真实进程环境，避免任一侧被绕过。
 */
export const assertNoTradeExposure = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  if (env.LUOOME_EXPOSE_TRADE === 'true' || process.env.LUOOME_EXPOSE_TRADE === 'true')
    throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed in the dsh-luoome production host');
};

/**
 * allowlist 只接受 registry 中真实的纯 read 工具；写/外部/队列/trade 名字直接拒绝装配
 * （而不是注册后静默过滤），把配置错误挡在任何 IO 之前。
 */
export const assertReadOnlyAllowlist = (allowlist: readonly string[]): void => {
  for (const name of allowlist) {
    const tool = toolRegistry.get(name);
    if (tool === undefined) throw new Error(`Unknown configured dsh-luoome read tool: ${name}`);
    if (
      tool.sideEffect !== 'read' ||
      tool.requiredCapabilities.some((capability) => capability !== 'read')
    )
      throw new Error(`Configured dsh-luoome tool is not read-only: ${name}`);
  }
};

export interface ProductionHost {
  readonly config: ProductionConfig;
  readonly context: ToolContext;
  readonly read: ReadSurface;
  /** 独立的 native market external surface；与 read 分开注册/撤销。 */
  readonly market: MarketSurface;
  readonly marketSettings: MarketSettings;
  readonly researchJobs: ResearchJobs;
  /** 把真实只读工具注册进 DSH ToolRuntime；返回撤销函数。 */
  register(runtime: Pick<ToolRuntime, 'register'>): () => void;
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult<unknown>>;
  /** 把 market external 工具注册进 DSH ToolRuntime；返回撤销函数。 */
  registerMarket(runtime: Pick<ToolRuntime, 'register'>): () => void;
  invokeMarket(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult<unknown>>;
  /** 关闭 Node DB、撤销注册并让旧闭包全部拒绝；幂等。 */
  dispose(): void;
}

export interface CreateProductionHostOptions {
  readonly logger?: Logger;
}

const DISPOSED_MESSAGE = 'dsh-luoome production host is disposed';

/**
 * 生产插件的受信任分析来源：generatorKind 由部署代码固定为 DSH 会话，model/skillVersion
 * 没有可信宿主元数据时保持未知；模型自报的 provenance/approved/callId 不参与授权或事实。
 */
export const TRUSTED_ANALYSIS_PROVENANCE: TrustedAnalysisProvenance = Object.freeze({
  generatorKind: 'dsh-chat',
});

/**
 * M2b 精确写回策略清单：
 * - M2b-1：DecisionReview 保存 + 交互分析 record_advice / record_analysis_result；
 * - M2b-2：策略 create / create-version / validate / publish + 用户反馈 record_advice_outcome；
 * - 策略上线：schedule / pause / resume / Watchlist subscribe / unsubscribe。
 *
 * 不包含 claim/complete/fail/metrics/job、通用 settings 或 trade；batch 仅由部署显式开启。
 * 个人版按明确意图直接执行，每个写工具仍保留独立 Operation 与业务回执。
 */
export const createProductionOperationPolicies = (
  trusted: TrustedAnalysisProvenance = TRUSTED_ANALYSIS_PROVENANCE,
  options: { readonly batchEnabled?: boolean; readonly researchJobs?: ResearchJobs } = {},
): readonly ConfirmablePluginTool[] => [
  decisionReviewOperation,
  ...createAnalysisOperationPolicies(trusted),
  ...createStrategyOperationPolicies(),
  ...createResearchOperationPolicies(options.researchJobs ?? createResearchJobs()),
  updateAccountOperation,
  ...createWatchlistOperationPolicies(),
  ...(options.batchEnabled === true ? createBatchOperationPolicies() : []),
];

/**
 * 用临时或真实 LUOOME_HOME 装配生产只读 host。
 *
 * 顺序刻意固定：解析/冻结配置 → trade 硬卡 → allowlist 对账 → 才 mkdir/打开 SQLite。
 * owner 账户必须已存在于事实库；缺失时关闭连接并拒绝装配，不回退默认账户。
 */
export const createProductionHost = async (
  configInput: unknown,
  options: CreateProductionHostOptions = {},
): Promise<ProductionHost> => {
  const config = resolveProductionConfig(configInput);
  assertNoTradeExposure(config.env);
  assertReadOnlyAllowlist(config.read.allowlist);
  // market allowlist 同样在任何 IO 之前 fail-closed；read 名单不能借给 market。
  assertExternalMarketAllowlist(config.market.allowlist, toolRegistry.all());

  const logger = options.logger ?? createPluginLogger();
  const clock = (): Date => new Date();

  const settingsStore = new MarketSettingsStore(config.env, join(config.home, '.env'));
  mkdirSync(config.home, { recursive: true });
  const handle: NodeDrizzleReposHandle = createNodeDrizzleRepos(join(config.home, 'luoome.db'));
  let read: ReadSurface | undefined;
  let market: MarketSurface | undefined;
  let context: ToolContext;
  let saveMarketSettings: MarketSettings['save'];
  try {
    const ownerAccount = await handle.repos.account.findById(config.owner.accountId);
    if (ownerAccount === null)
      throw new Error(
        `Configured dsh-luoome owner account does not exist: ${config.owner.accountId}`,
      );

    const adapters = createLocalAdapters({
      env: settingsStore.runtimeEnv(),
      clock,
      logger,
      researchVaultBackupRoot: join(config.home, 'backups', 'research-vault'),
    });
    const built = buildContext({
      repos: handle.repos,
      adapters: { market: adapters.market, stockUniverse: adapters.stockUniverse },
      user: { id: config.owner.userId, defaultAccountId: config.owner.accountId },
      identity: { mode: 'local', userId: config.owner.userId },
      clock,
      logger,
      auditLog: createFileAuditLogger(join(config.home, 'logs', 'audit.log')),
      auditCaller: 'dsh-luoome',
      portfolioBenchmark: {
        stockId:
          config.env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() ||
          DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
        name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
      },
      limitUpLadder: adapters.limitUpLadder,
      dragonTiger: adapters.dragonTiger,
      stockProfile: adapters.stockProfile,
      northboundFlow: adapters.northboundFlow,
      news: adapters.news,
      sectorQuote: adapters.sectorQuote,
      ashareSentiment: adapters.ashareSentiment,
      researchRemote: adapters.researchRemote,
      notification: createNotificationManagerFromEnv(config.env, {
        repos: handle.repos,
        logger,
        clock,
      }),
      ...(adapters.researchVault === undefined ? {} : { researchVault: adapters.researchVault }),
      ...(adapters.researchEmbedding === undefined
        ? {}
        : { researchEmbedding: adapters.researchEmbedding }),
      ...(adapters.researchVaultGitSync === undefined
        ? {}
        : { researchVaultGitSync: adapters.researchVaultGitSync }),
      ...(adapters.fundamentalData === undefined
        ? {}
        : { fundamentalData: adapters.fundamentalData }),
    });
    context = built;
    saveMarketSettings = (input) =>
      settingsStore.save(input, (env) => {
        const market = createMarketAdapterFromEnv(env, {
          clock,
          logger,
          sources: adapters.sources,
        });
        const ashareSentiment = createAShareSentimentManagerFromEnv(env, {
          clock,
          logger,
          market,
          sources: adapters.sources,
        });
        return () => {
          context = { ...context, adapters: { ...context.adapters, market }, ashareSentiment };
        };
      });
    read = createReadSurface({
      accountId: config.owner.accountId,
      // 同一冻结快照同时用于注册与执行；createReadSurface 再 parse 一次只读校验。
      config: {
        allowlist: [...config.read.allowlist],
        denylist: [...config.read.denylist],
        exposeResearch: config.read.exposeResearch,
      },
      tools: toolRegistry.all(),
      context: () => {
        if (context === undefined) throw new Error('dsh-luoome production context is unavailable');
        return context;
      },
    });
    market = createMarketSurface({
      accountId: config.owner.accountId,
      // 与 read 完全独立的冻结快照；只允许 external 能力。
      config: {
        allowlist: [...config.market.allowlist],
        denylist: [...config.market.denylist],
        timeoutMs: config.market.timeoutMs,
        exposeResearch: config.market.exposeResearch,
      },
      tools: toolRegistry.all(),
      context: () => {
        if (context === undefined) throw new Error('dsh-luoome production context is unavailable');
        return context;
      },
    });
  } catch (error) {
    read?.dispose();
    market?.dispose();
    handle.close();
    throw error;
  }

  const resolvedRead = read;
  const resolvedMarket = market;
  const researchJobs = createResearchJobs();
  const removers: (() => void)[] = [];
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    researchJobs.dispose();
    for (const remove of removers.splice(0).reverse()) remove();
    resolvedRead.dispose();
    resolvedMarket.dispose();
    handle.close();
  };

  return {
    config,
    get context() {
      return context;
    },
    read: resolvedRead,
    market: resolvedMarket,
    researchJobs,
    marketSettings: {
      read() {
        if (disposed) throw new Error(DISPOSED_MESSAGE);
        return settingsStore.read();
      },
      save(input) {
        if (disposed) throw new Error(DISPOSED_MESSAGE);
        return saveMarketSettings(input);
      },
    },
    register(runtime) {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      const remove = registerReadTools(runtime, resolvedRead);
      removers.push(remove);
      return remove;
    },
    invoke(name, input, signal) {
      if (disposed) return Promise.resolve(denied('production host'));
      return resolvedRead.invoke(name, input, signal);
    },
    registerMarket(runtime) {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      const remove = registerMarketTools(runtime, resolvedMarket);
      removers.push(remove);
      return remove;
    },
    invokeMarket(name, input, signal) {
      if (disposed) return Promise.resolve(denied('production host'));
      return resolvedMarket.invoke(name, input, signal);
    },
    dispose,
  };
};

/** mountDshWebProfile 实际依赖的宿主服务；缺失时拒绝装配，不降级成半成品入口。 */
export const REQUIRED_HOST_SERVICES = [
  'connection',
  'webServer',
  'sessionController',
  'tools',
  'agents',
] as const satisfies readonly (keyof Context)[];

export const assertProductionHostDependencies = (ctx: Context): void => {
  const missing = REQUIRED_HOST_SERVICES.filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0)
    throw new Error(
      `dsh-luoome production host requires ${missing.join(', ')}; refusing to assemble a partial surface`,
    );
};

/**
 * DSH 生产插件入口：注册只读/市场工具、宿主认证的只读 `/api/luoome/call` 路由，以及
 * M2b 的精确写回 policies（DecisionReview + 交互分析 record + 策略生命周期 + 用户反馈）。
 *
 * 写操作只经 `luoome_confirmed_operation` 直接执行：prepare 冻结输入，confirm 保留幂等与回执；
 * `/api/luoome/call` 仍只读，queue/write 能力不会被它借用。
 * 连接、WebServer、SessionController 任一缺失时在打开数据库之前抛错。
 */
export const apply = async (ctx: Context, config?: unknown): Promise<ProductionHost> => {
  assertProductionHostDependencies(ctx);
  const resolved = resolveProductionConfig(config ?? resolveProductionConfigFromEnv());
  if (resolved.batchEnabled && ctx.get('schedule') === undefined)
    throw new Error('dsh-luoome batches require the host schedule service');
  const host = await createProductionHost(resolved);
  const owner = Object.freeze({
    userId: host.config.owner.userId,
    accountId: host.config.owner.accountId,
  });
  let web: ReturnType<typeof mountDshWebProfile> | undefined;
  let removeMarket: (() => void) | undefined;
  let removeMarketGuard: (() => void) | undefined;
  try {
    web = mountDshWebProfile(ctx, {
      repository: host.context.repos.pluginAuthority,
      policies: createProductionOperationPolicies(TRUSTED_ANALYSIS_PROVENANCE, {
        ...host.config,
        researchJobs: host.researchJobs,
      }),
      // queue 只由这里的精确 analysis policy 使用；generic `/api/luoome/call` 仍是只读 read surface。
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: Date.now,
      context: () => host.context,
      profile: 'dsh-luoome-plugin',
      principalForOwner: () => owner,
      principalForSession: () => owner,
      automationsEnabled: host.config.automationsEnabled,
      read: host.read,
      market: host.market,
      marketSettings: host.marketSettings,
      researchJobs: host.researchJobs,
    });
    // market external 面与 read 分开注册，但使用同一 owner/top-level guard 语义：
    // 子 Agent、跨账户会话和 HTTP bridge 都不能只靠工具名获得外部调用权限。
    const marketNames = new Set(host.market.descriptors().map((tool) => tool.name));
    removeMarketGuard = ctx.tools.guard((execution) => {
      if (!marketNames.has(execution.name)) return;
      const principal = web === undefined ? null : web.identity.principal(execution.agent);
      if (
        !principal ||
        principal.userId !== owner.userId ||
        principal.accountId !== owner.accountId
      )
        return 'A live, top-level session for the current owner account is required';
    });
    removeMarket = registerMarketTools(ctx.tools, host.market);
  } catch (error) {
    removeMarketGuard?.();
    removeMarket?.();
    web?.dispose();
    host.dispose();
    throw error;
  }
  ctx.effect(() => () => {
    removeMarketGuard?.();
    removeMarket?.();
    host.dispose();
  });
  return host;
};
