// dsh-luoome 纯插件生产 composition root（需求 §6.2，插件详细设计 §2/§3/§7）。
//
// 数据路径：受信任部署配置 → Node SQLite（`@luoome/db/node`）→ 真实 adapters *FromEnv
// → `buildContext` → 真实只读 surface。本模块不 import bun:sqlite、已下线的 stdio MCP 包、CLI 或 Web，
// 也不读取 memory fixture：装配失败时拒绝启动，而不是降级成假数据。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';

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
  DEFAULT_AUDIT_KEEP,
  DEFAULT_AUDIT_MAX_MB,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  parsePositiveInteger,
  parsePositiveMegabytes,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  createNodeDrizzleRepos,
  type NodeDrizzleReposHandle,
  readDataImportStorageSchema,
} from '@luoome/db/node';
import {
  assertSurfaceSelection,
  assertTradeNeverExposed,
  buildContext,
  type ConfirmablePluginTool,
  decisionReviewOperation,
  previewDataImportTool,
  toolRegistry,
} from '@luoome/tools';
import { createAccountOperationPolicies } from './account-operations.js';
import { ALERT_PLAN_OPERATION_POLICIES } from './alert-plan-operations.js';
import {
  createAnalysisOperationPolicies,
  type TrustedAnalysisProvenance,
} from './analysis-operations.js';
import { createBatchOperationPolicies } from './batch-operations.js';
import { createDataArchives, DEFAULT_EXPORT_KEEP } from './data-archives.js';
import {
  createDataImportBackups,
  createDataImportStaging,
  type DataImportBackupStore,
  type DataImportStaging,
} from './data-import.js';
import {
  createDataImportOperationPolicies,
  createExportBusinessDataOperation,
} from './data-import-operations.js';
import { DELETION_OPERATION_POLICIES } from './deletion-operations.js';
import { type MarketSettings, MarketSettingsStore } from './market-settings.js';
import {
  assertExternalMarketAllowlist,
  createMarketSurface,
  type MarketSurface,
  registerMarketTools,
} from './market-surface.js';
import { saveTradingPlanOperation } from './plan-operations.js';
import {
  type ProductionConfig,
  resolveProductionConfig,
  resolveProductionConfigFromEnv,
} from './production-config.js';
import { createReadSurface, denied, type ReadSurface } from './read-surface.js';
import { createWriteReportArtifactOperation } from './report-artifact-operations.js';
import { createReportArtifacts } from './report-artifacts.js';
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
  // 判定与文案来自 `@luoome/tools` 的 exposure 判定层，与 read/market surface、MCP 面同一条。
  assertTradeNeverExposed(env.LUOOME_EXPOSE_TRADE, process.env.LUOOME_EXPOSE_TRADE);
};

/**
 * allowlist 只接受 registry 中真实的纯 read 工具；写/外部/队列/trade 名字直接拒绝装配
 * （而不是注册后静默过滤），把配置错误挡在任何 IO 之前。
 */
export const assertReadOnlyAllowlist = (allowlist: readonly string[]): void =>
  assertSurfaceSelection(allowlist, toolRegistry.all(), 'read', {
    label: 'dsh-luoome read tool',
  });

export interface ProductionHost {
  readonly config: ProductionConfig;
  /**
   * `recovery-only`：业务库为空且 owner 账户尚不存在。此时只装配恢复入口
   * （上传/预检/导入 Operation），不注册市场、批处理与普通业务写能力。
   * 导入成功后必须重新装配或重启插件才进入 `normal`。
   */
  readonly mode: 'normal' | 'recovery-only';
  /** T48 有界上传暂存与预检面；未装配时为 undefined（CLI/TUI 不提供恢复入口）。 */
  readonly dataImport: DataImportStaging;
  /** T48 恢复前一致性备份（node:sqlite backup，事务外生成）。 */
  readonly dataImportBackups: DataImportBackupStore;
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

const RECOVERY_EMPTY_PROBES = [
  'accounts',
  'holdings',
  'trades',
  'portfolio_cash_flows',
  'strategies',
  'advices',
  'reports',
  'watchlists',
  'stock_universe_memberships',
  'chat_sessions',
] as const;

/**
 * 只有「确实没有任何业务事实」才允许进入 recovery-only；owner 缺失但有事实是配置问题，
 * 不能降级成可覆盖的空库。
 */
const isEmptyBusinessDatabase = (handle: NodeDrizzleReposHandle): boolean =>
  RECOVERY_EMPTY_PROBES.every(
    (table) =>
      Number(handle.sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? 0) === 0,
  );

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
 * 精确写回策略清单：
 * - M2b-1：DecisionReview 保存 + 交互分析 record_advice / record_analysis_result；
 * - M2b-2：策略 create / create-version / validate / publish + 用户反馈 record_advice_outcome；
 * - 策略上线：schedule / pause / resume / Watchlist subscribe / unsubscribe；
 * - T47（REQ-M2-08）：账户维护四写 —— update_account / add_trade / close_holding /
 *   create_portfolio_cash_flow。`add_trade` 是**人工记账 write**，不是 trade 能力。
 *
 * 不包含 claim/complete/fail/metrics/job、通用 settings 或 trade；batch 仅由部署显式开启。
 * 个人版按明确意图直接执行，每个写工具仍保留独立 Operation 与业务回执。
 */
export const createProductionOperationPolicies = (
  trusted: TrustedAnalysisProvenance = TRUSTED_ANALYSIS_PROVENANCE,
  options: {
    readonly batchEnabled?: boolean;
    readonly researchJobs?: ResearchJobs;
    readonly dataImport?: Pick<DataImportStaging, 'describe'>;
    readonly dataImportBackups?: Pick<DataImportBackupStore, 'describe'>;
  } = {},
): readonly ConfirmablePluginTool[] => [
  decisionReviewOperation,
  ...createAnalysisOperationPolicies(trusted),
  ...createStrategyOperationPolicies(),
  ...createResearchOperationPolicies(options.researchJobs ?? createResearchJobs()),
  ...createAccountOperationPolicies(),
  ...createWatchlistOperationPolicies(),
  ...(options.batchEnabled === true ? createBatchOperationPolicies() : []),
  // REQ-M3-08：报告交付物写盘，只作精确 Operation policy（不进 read/market allowlist）。
  createWriteReportArtifactOperation(),
  // task-35：导出业务数据（write 副作用，会落文件）。
  createExportBusinessDataOperation(),
  // task-39 批次 A：交易计划保存（write）。**没有乐观锁**，见 plan-operations.ts 的头注释。
  saveTradingPlanOperation,
  // task-39 批次 B：告警规则增删改（write）。删除的回执冻结了**删除前的完整快照**。
  ...ALERT_PLAN_OPERATION_POLICIES,
  // 决策 3-C：删除类工具接入精确 policy（取回执可查）。
  // 全部 scheduled:false，**不新增人工二次确认**——prepare 端点自己会 confirm。
  //
  // `delete_strategy` **已接入**（需求负责人裁定）：删除是最需要「删了什么」可审计的操作，
  // 与 `pause_strategy` / `resume_strategy` 当年移出 forbidden 清单的理由相同
  // （那份清单表达的是「当时判断不需要回执」，不是「永远不许」，见 `production.test.ts`）。
  //
  // `delete_chat_session` **刻意不在此列**：chat 面按 H1 决策保留不暴露
  // （`exposure/classify.ts:19-22`：会话由 DSH 宿主承载，领域层 chat 工具没有插件入口）。
  // 详细理由见 `deletion-operations.ts` 的头注释。
  ...DELETION_OPERATION_POLICIES,
  // T48 恢复：只作精确 Operation policy，不进 agent 面。
  ...(options.dataImport === undefined || options.dataImportBackups === undefined
    ? []
    : createDataImportOperationPolicies({
        staging: options.dataImport,
        backups: options.dataImportBackups,
      })),
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
  // 暂存目录与 TTL/配额在装配期固定；targetSchema 读共享主连接，不另开第二连接。
  // 备份走 node:sqlite 的 backup（事务外生成，与单写实例的写串行，得到自洽快照）。
  const dataImportBackups = createDataImportBackups({
    directory: join(config.home, 'imports', 'backups'),
    userId: config.owner.userId,
    accountId: config.owner.accountId,
    now: () => Date.now(),
    backupDatabase: async (path) => {
      await sqliteBackup(handle.sqlite, path);
    },
  });
  const dataImportStaging = createDataImportStaging({
    directory: join(config.home, 'imports'),
    userId: config.owner.userId,
    accountId: config.owner.accountId,
    now: () => Date.now(),
    targetSchema: () => readDataImportStorageSchema(handle.sqlite),
    // 提交前复核备份文件（事务外）。
    backups: dataImportBackups,
  });
  const reportArtifacts = createReportArtifacts({
    directory: join(config.home, 'reports'),
  });
  // task-35：事实库导出物单独一个目录（不混进 reports/）。
  const dataArchives = createDataArchives({
    directory: join(config.home, 'exports'),
    keep: parsePositiveInteger(config.env.LUOOME_EXPORT_KEEP, {
      name: 'LUOOME_EXPORT_KEEP',
      fallback: DEFAULT_EXPORT_KEEP,
    }),
  });
  let read: ReadSurface | undefined;
  let market: MarketSurface | undefined;
  let context: ToolContext;
  let saveMarketSettings: MarketSettings['save'];
  let mode: 'normal' | 'recovery-only' = 'normal';
  try {
    const ownerAccount = await handle.repos.account.findById(config.owner.accountId);
    if (ownerAccount === null) {
      if (!isEmptyBusinessDatabase(handle))
        throw new Error(
          `Configured dsh-luoome owner account does not exist: ${config.owner.accountId}`,
        );
      // 空库从 0 到设置入口：只装配恢复面，不造示例账户、不注册普通业务能力。
      mode = 'recovery-only';
    }

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
      auditLog: createFileAuditLogger(join(config.home, 'logs', 'audit.log'), {
        // 与 `LUOOME_BACKUP_KEEP` / `LUOOME_EXPORT_KEEP` 共用同一条判据（core `retention.ts`）。
        maxMb: parsePositiveMegabytes(config.env.LUOOME_AUDIT_MAX_MB, {
          name: 'LUOOME_AUDIT_MAX_MB',
          fallback: DEFAULT_AUDIT_MAX_MB,
        }),
        keep: parsePositiveInteger(config.env.LUOOME_AUDIT_KEEP, {
          name: 'LUOOME_AUDIT_KEEP',
          fallback: DEFAULT_AUDIT_KEEP,
        }),
      }),
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
      dataImport: dataImportStaging,
      reportArtifacts,
      dataArchives,
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
        allowlist: mode === 'recovery-only' ? ['preview_data_import'] : [...config.read.allowlist],
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
        allowlist: mode === 'recovery-only' ? [] : [...config.market.allowlist],
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
    dataImportStaging.dispose();
    dataImportBackups.dispose();
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
    dataImportStaging.dispose();
    dataImportBackups.dispose();
    handle.close();
  };

  return {
    config,
    mode,
    dataImport: dataImportStaging,
    dataImportBackups,
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
  const recoveryOnly = host.mode === 'recovery-only';
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
      policies: recoveryOnly
        ? createDataImportOperationPolicies({
            staging: host.dataImport,
            backups: host.dataImportBackups,
          })
        : createProductionOperationPolicies(TRUSTED_ANALYSIS_PROVENANCE, {
            ...host.config,
            researchJobs: host.researchJobs,
            dataImport: host.dataImport,
            dataImportBackups: host.dataImportBackups,
          }),
      // queue 只由这里的精确 analysis policy 使用；generic `/api/luoome/call` 仍是只读 read surface。
      capabilities: recoveryOnly ? ['write'] : ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: Date.now,
      context: () => host.context,
      profile: 'dsh-luoome-plugin',
      principalForOwner: () => owner,
      principalForSession: () => owner,
      automationTier: host.config.automationTier,
      read: host.read,
      market: host.market,
      marketSettings: host.marketSettings,
      researchJobs: host.researchJobs,
      dataImport: {
        staging: host.dataImport,
        backups: host.dataImportBackups,
        // 预检是只读 tool 调用：不创建 Operation，也不持有账户 lease。
        preview: (uploadId: string) =>
          previewDataImportTool.execute(
            { uploadId, mode: 'restore-business-v1' as const },
            host.context,
          ),
        // 备份复核用同一份目标摘要口径（与 previewHash 内的 preDigest 相同）。
        targetDigest: () => {
          const repository = host.context.repos.dataImport;
          if (repository === undefined) throw new Error('data import repository is unavailable');
          return repository.targetDigest({
            userId: host.config.owner.userId,
            accountId: host.config.owner.accountId,
          });
        },
      },
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
