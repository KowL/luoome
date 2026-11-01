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
  // 组合风险（REQ-M3-06）：只读本地持仓 + 已落库报价 + 已落库绩效快照 + active TradingPlan，
  // 零回源、零写库。VaR 读已落库绩效快照；要刷新快照走 external 面的 get_account_performance
  // 或盘后 snapshot-account-performance 任务，本工具不自己算组合日收益序列。
  'get_portfolio_risk',
  // 账户层归因与超额收益（REQ-M3-07）：TWR / 基准 TWR / 超额 / 覆盖缺口 / 归因 fact id。
  // 会回源刷新行情的 get_account_performance 属 external，见 DEFAULT_MARKET_TOOL_ALLOWLIST。
  'list_account_performance_snapshots',
  'list_holdings',
  'get_holding',
  'list_trades',
  'get_investment_workspace',
  // Advice、复盘与校准
  'get_advice',
  // REQ-M3-17 ③：盘前简报的「既有建议与反证」段需要列表入口（read，零回源）。
  'list_advices',
  'get_advice_stats',
  'get_confidence_calibration',
  'list_decision_reviews',
  'get_decision_review_context',
  'get_decision_review_snapshot',
  'get_decision_loop_review',
  // 单条建议事后归因（REQ-M3-14）：只读已落库事实（建议/回填/成交/现金流/观察/绩效快照），
  // 零回源、零写库；要刷新快照走 external 面的 get_account_performance。
  'get_advice_attribution',
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
  'get_strategy_ic',
  'get_strategy_schedule',
  'list_strategy_watchlist_subscriptions',
  // 关注、触发与计划（看板）
  'list_watchlists',
  'get_watchlist',
  'list_watchlist_changes',
  'list_watch_triggers',
  'list_alert_plans',
  // 交易计划面板（决策 3-C ②）：`PANEL_PLANS.plans` 早就在读它，但它**从未**进过
  // 默认 allowlist ⇒ 面板恒为 permission_denied、列表永远空白。
  // 这正是「面板要用但读面没开」的暴露面缺口：装配期不报错，只在浏览器里表现为空列表。
  'list_trading_plans',
  'get_watch_status',
  // 本地市场事实与数据健康（每日市场分析；external 刷新留待 M2）
  'get_market_data_status',
  'get_stock_universe_status',
  'get_data_diagnostics',
  'get_closing_batch_audit',
  'limit_up_ladder',
  'limit_up_ladder_compare',
  'dragon_tiger_list',
  'northbound_flow',
  'get_previous_closes',
  'search_stocks',
  'list_stock_events',
  // 「这条提醒属于哪条计划的哪一版」——**只读不可变依据**，不判断当前是否仍成立。
  // 外部评审（gpt-6-astra）裁定：它的契约是「定位来源」，与 `state` 三档口径无关，
  // 因此不必等 `state` 定案才开放。刻意不含 `state`/`changes`（那三个要现算）。
  'resolve_watch_notification',
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
 *
 * `get_account_performance`（REQ-M3-07）：它回源拉日线、写 `daily_bars` 并落绩效快照，
 * 声明是 `external`，而只读面只收 `sideEffect==='read'`（见 `assertSurfaceSelection`），
 * 所以它**只能**进这份 external 名单——塞进 read allowlist 等于把「会写库 + 会访问外部
 * 服务」的工具谎报成只读。对话面的归因读取走只读的
 * `list_account_performance_snapshots`（已在 read allowlist），本工具负责显式刷新。
 */
export const DEFAULT_MARKET_TOOL_ALLOWLIST = Object.freeze([
  // task-14：持仓行情的**唯一回源入口**（访问外部源 + 写 price_snapshots）。
  // `list_holdings` 已改成纯读（只读已落库报价），刷新必须显式调用本工具。
  'refresh_holdings_quotes',
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
  'get_account_performance',
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
    /**
     * 自动化档位（REQ-M4-06）。
     *
     * - `off`：不自动派发
     * - `notify`：派发，但**只产草稿/提醒**，不写 Advice / DecisionReview / Trade
     * - `granted`：凭 `PluginAutomationGrant` 执行写入
     */
    automationTier: z.enum(['off', 'notify', 'granted']).optional(),
    /**
     * @deprecated 已被 `automationTier` 取代。仍接受只是为了**读旧配置**：
     * `false → off`、`true → granted`（见 `resolveAutomationTier`）。
     * 同时给出两者时以 `automationTier` 为准——**不保留两个真相源**。
     */
    automationsEnabled: z.boolean().optional(),
    /** 透传给 adapters *FromEnv 工厂（行情/研究/通知等），不在此复制领域规则。 */
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict()
  .refine(
    (config) =>
      (config.automationTier === undefined || config.automationTier === 'off') &&
      config.automationsEnabled !== true
        ? true
        : config.batchEnabled === true,
    {
      path: ['automationTier'],
      message: 'Automations beyond `off` require explicit batchEnabled opt-in',
    },
  );

export type ProductionConfigInput = z.input<typeof productionConfigSchema>;

export interface ProductionOwner {
  readonly userId: string;
  readonly accountId: string;
}

/** 自动化三档（REQ-M4-06）。 */
export type AutomationTier = 'off' | 'notify' | 'granted';

/**
 * 解析自动化档位，**含旧配置迁移**。
 *
 * 旧字段 `automationsEnabled: boolean` 已被 `automationTier` 取代：
 * `false → 'off'`、`true → 'granted'`（旧语义就是「启用授权执行」）。
 *
 * 两者同时给出时**以 `automationTier` 为准**——不保留两个真相源，
 * 也不做「更严格者胜」这类隐式规则（那会让读配置的人无法预测结果）。
 */
export const resolveAutomationTier = (input: {
  readonly automationTier?: AutomationTier | undefined;
  readonly automationsEnabled?: boolean | undefined;
}): AutomationTier => {
  if (input.automationTier !== undefined) return input.automationTier;
  return input.automationsEnabled === true ? 'granted' : 'off';
};

/** 档位是否允许自动派发（`off` 之外都派发）。 */
export const tierAllowsDispatch = (tier: AutomationTier): boolean => tier !== 'off';

/**
 * 档位是否允许**写业务数据**（Advice / DecisionReview / Trade）。
 *
 * 只有 `granted` 允许，且仍需 `PluginAutomationGrant`。
 * `notify` 档的派发**只能产草稿**——这条是 REQ-M4-06 的核心边界。
 */
export const tierAllowsBusinessWrite = (tier: AutomationTier): boolean => tier === 'granted';

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
  /** 自动化档位（REQ-M4-06）。**取代** 旧的 `automationsEnabled` 布尔值。 */
  readonly automationTier: AutomationTier;
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
    automationTier: resolveAutomationTier(parsed),
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
    // 新变量优先；旧 `LUOOME_AUTOMATIONS_ENABLED=true` 仍映射为 `granted`（向后兼容）。
    automationTier:
      env.LUOOME_AUTOMATION_TIER === 'off' ||
      env.LUOOME_AUTOMATION_TIER === 'notify' ||
      env.LUOOME_AUTOMATION_TIER === 'granted'
        ? env.LUOOME_AUTOMATION_TIER
        : undefined,
    automationsEnabled: env.LUOOME_AUTOMATIONS_ENABLED === 'true' ? true : undefined,
    env,
  });
};
