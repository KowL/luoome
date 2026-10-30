// dsh-luoome 纯插件生产装配的受信任部署配置（需求 §6.2，插件详细设计 §3.1）。
//
// 配置只由部署代码或进程环境解析，HTTP 请求、模型参数和 skill 内容都不能提升
// owner 账户、扩大 read allowlist 或打开 automations/trade。解析结果在装配时冻结。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MARKET_TIMEOUT_MS, MAX_MARKET_TIMEOUT_MS } from './market-surface.js';

/**
 * M1 默认只读白名单。
 *
 * 名字按 `packages/tools/src/registry.ts` 的真实 tool 名核对，覆盖四场景与三面板：
 * - 每日市场分析：市场状态 / 本地市场事实（external 刷新面属于 M2，不在此列）；
 * - 策略制定与结果研究：Strategy、版本、运行、结果、信号、观察与 insight facts；
 * - 复盘：Advice、Advice stats、confidence calibration、DecisionReview；
 * - 三面板：看板（账户/持仓/关注/触发/建议）、策略、复盘。
 *
 * registry 中分类为 queue 的 job 查询（list_analysis_jobs 等）与私人研究工具都不在
 * 默认名单内：前者属于 worker 面，后者由共享拒绝清单控制 opt-in。
 */
export const DEFAULT_READ_TOOL_ALLOWLIST = Object.freeze([
  // 账户、持仓、交易与看板
  'list_accounts',
  'get_account',
  'get_account_facts',
  'list_account_performance_snapshots',
  'list_holdings',
  'get_holding',
  'list_trades',
  'get_investment_workspace',
  // Advice、复盘与校准
  'get_advice',
  'get_advice_stats',
  'get_confidence_calibration',
  'list_decision_reviews',
  'get_decision_review_context',
  'get_decision_review_snapshot',
  'get_decision_loop_review',
  // 交互分析上下文（读业务事实并持久化审计快照，口径见需求 §5.4）
  'get_analysis_context',
  // Strategy 制定与结果研究
  'list_strategies',
  'get_strategy',
  'get_strategy_dsl_catalog',
  'get_strategy_experiment_context',
  'get_strategy_research_state',
  'get_strategy_data_preflight',
  'get_strategy_selection_diagnostics',
  'compare_strategy_definitions',
  'list_strategy_runs',
  'get_strategy_run',
  'get_strategy_workspace',
  'compare_strategy_runs',
  'get_strategy_evaluation_session',
  'list_strategy_evaluation_sessions',
  'get_strategy_evaluation_progress',
  'list_strategy_evaluation_days',
  'get_strategy_pit_universe',
  'get_strict_strategy_backtest',
  'list_strict_strategy_backtests',
  'assess_adaptive_personality',
  'export_strategy_manifest',
  'validate_strategy_manifest',
  'import_strategy_manifest',
  'list_workflow_runs',
  'get_strategy_insight_facts',
  'strategy_signals_by_stock',
  'list_pending_strategy_observations',
  'get_signal_observation_stats',
  'get_strategy_decision_cycles',
  'evaluate_strategy_candidate_preflight',
  'get_strategy_reliability_summary',
  'get_strategy_schedule',
  'list_strategy_watchlist_subscriptions',
  // 关注、触发与计划（看板）
  'list_watchlists',
  'get_watchlist',
  'list_watchlist_changes',
  'list_watch_triggers',
  'list_alert_plans',
  'get_watch_status',
  // 本地市场事实与数据健康（每日市场分析；external 刷新留待 M2）
  'get_market_data_status',
  'get_stock_universe_status',
  'limit_up_ladder',
  'limit_up_ladder_compare',
  'dragon_tiger_list',
  'northbound_flow',
  'get_previous_closes',
  'search_stocks',
  'list_stock_events',
]);

/**
 * M2a 默认 market external 白名单：按真实 registry 对账后只收
 * `sideEffect==='external'` 且能力仅 external 的工具。
 *
 * `fetch_news` 访问第三方新闻源、不写库，已按外部访问语义修正为 external
 * (packages/tools/src/tools/news.ts)，因此是每日市场分析「要闻」事实的默认候选。
 * `fetch_sector_quotes` 与新闻一致归入 external，供看盘分区读取行业排行。
 * `sync_quotes`/`send_notification` 等 external 工具虽
 * 满足能力规则，但不属于「对话主动刷新市场事实」的精确名单，默认不点名。
 */
export const DEFAULT_MARKET_TOOL_ALLOWLIST = Object.freeze([
  'fetch_index_quotes',
  'get_ashare_sentiment',
  'fetch_quote',
  'batch_quote',
  'trial_strategy_version',
  'run_strategy_research_comparison',
  'get_stock_market_view',
  'fetch_news',
  'fetch_sector_quotes',
  'get_stock_profile',
]);

const ToolNameSchema = z.string().trim().min(1).max(120);
const ToolNameListSchema = z.array(ToolNameSchema);

const OwnerSchema = z
  .object({
    userId: z.string().trim().min(1).max(200),
    accountId: z.string().trim().min(1).max(200),
  })
  .strict();

const ReadSchema = z
  .object({
    allowlist: ToolNameListSchema.optional(),
    denylist: ToolNameListSchema.optional(),
    exposeResearch: z.literal(false).optional(),
  })
  .strict();

const MarketSchema = z
  .object({
    allowlist: ToolNameListSchema.optional(),
    denylist: ToolNameListSchema.optional(),
    timeoutMs: z.number().int().positive().max(MAX_MARKET_TIMEOUT_MS).optional(),
    exposeResearch: z.literal(false).optional(),
  })
  .strict();

/**
 * 受信任部署配置。`strict()` 拒绝未声明的字段，避免把任意环境变量/HTTP 参数
 * 顺带带进生产装配。batch/automations 默认关闭；自动化须先显式打开 batch。
 * `read` 与 `market` 是两份独立 allowlist，不能互相借用。
 */
export const productionConfigSchema = z
  .object({
    /** LUOOME_HOME；省略时取 `env.LUOOME_HOME`，再退回 `~/.luoome`。 */
    home: z.string().trim().min(1).max(4096).optional(),
    /** owner 由部署配置显式绑定；不从 HTTP/模型参数推断。 */
    owner: OwnerSchema,
    read: ReadSchema.optional(),
    market: MarketSchema.optional(),
    batchEnabled: z.boolean().optional(),
    automationsEnabled: z.boolean().optional(),
    /** 透传给 adapters *FromEnv 工厂（行情/研究/通知等），不在此复制领域规则。 */
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict()
  .refine((config) => !config.automationsEnabled || config.batchEnabled === true, {
    path: ['automationsEnabled'],
    message: 'Automations require explicit batchEnabled opt-in',
  });

export type ProductionConfigInput = z.input<typeof productionConfigSchema>;

export interface ProductionOwner {
  readonly userId: string;
  readonly accountId: string;
}

export interface ProductionReadConfig {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly exposeResearch: false;
}

export interface ProductionMarketConfig {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly timeoutMs: number;
  readonly exposeResearch: false;
}

export interface ProductionConfig {
  readonly home: string;
  readonly owner: ProductionOwner;
  readonly read: ProductionReadConfig;
  readonly market: ProductionMarketConfig;
  readonly batchEnabled: boolean;
  readonly automationsEnabled: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * zod 4 的 `z.record` 不接受 Node 的 `process.env`（非普通对象，报 expected record），
 * 但接受其快照。这里在任何 parse 前把显式 env 归一化成普通对象，保证部署环境可直接透传。
 */
const normalizeEnvInput = (input: unknown): unknown => {
  if (input === null || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  const env = record.env;
  if (env === null || typeof env !== 'object') return input;
  return { ...record, env: { ...(env as Record<string, string | undefined>) } };
};

/** 解析并冻结部署配置；不产生任何文件系统 IO。 */
export const resolveProductionConfig = (
  input: unknown,
  options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): ProductionConfig => {
  const parsed = productionConfigSchema.parse(normalizeEnvInput(input));
  const env = Object.freeze({
    ...(parsed.env ?? options.env ?? process.env),
  });
  const envHome = env.LUOOME_HOME?.trim();
  const home = parsed.home ?? (envHome === undefined || envHome.length === 0 ? undefined : envHome);
  const config: ProductionConfig = {
    home: home ?? join(homedir(), '.luoome'),
    owner: Object.freeze({
      userId: parsed.owner.userId,
      accountId: parsed.owner.accountId,
    }),
    read: Object.freeze({
      allowlist: Object.freeze([...(parsed.read?.allowlist ?? DEFAULT_READ_TOOL_ALLOWLIST)]),
      denylist: Object.freeze([...(parsed.read?.denylist ?? [])]),
      exposeResearch: false as const,
    }),
    market: Object.freeze({
      allowlist: Object.freeze([...(parsed.market?.allowlist ?? DEFAULT_MARKET_TOOL_ALLOWLIST)]),
      denylist: Object.freeze([...(parsed.market?.denylist ?? [])]),
      timeoutMs: parsed.market?.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS,
      exposeResearch: false as const,
    }),
    batchEnabled: parsed.batchEnabled === true,
    automationsEnabled: parsed.automationsEnabled === true,
    env,
  };
  return Object.freeze(config);
};

/**
 * 从进程环境解析受信任部署配置。
 *
 * owner 必须由部署显式提供：缺失时直接拒绝装配，不猜账户、不回退默认账户。
 * LUOOME_HOME 与 adapters 所需变量沿用既有环境变量名。
 */
export const resolveProductionConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProductionConfig => {
  const ownerUserId = env.LUOOME_OWNER_USER_ID?.trim();
  const ownerAccountId = env.LUOOME_OWNER_ACCOUNT_ID?.trim();
  if (
    ownerUserId === undefined ||
    ownerUserId.length === 0 ||
    ownerAccountId === undefined ||
    ownerAccountId.length === 0
  )
    throw new Error(
      'dsh-luoome production host requires LUOOME_OWNER_USER_ID and LUOOME_OWNER_ACCOUNT_ID from trusted deployment configuration',
    );
  const home = env.LUOOME_HOME?.trim();
  return resolveProductionConfig({
    ...(home === undefined || home.length === 0 ? {} : { home }),
    owner: { userId: ownerUserId, accountId: ownerAccountId },
    batchEnabled: env.LUOOME_BATCH_ENABLED === 'true',
    automationsEnabled: env.LUOOME_AUTOMATIONS_ENABLED === 'true',
    env,
  });
};
