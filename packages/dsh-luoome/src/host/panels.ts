// dsh-luoome 面板宿主只读数据路由（plugin 详细设计 §4.2 HTTP、§8 UI）。
//
// 数据路径：浏览器同源 GET /api/luoome/state?panel=... → 宿主认证（prefix 层 Connection.admit）
// → 本模块固定 panel→工具映射 → 进程内 ReadSurface / MarketSurface 调真实领域工具。
//
// 安全边界：
// - URL 只接受固定 panel/section，关注行情另接受页码；不接受工具名、命令或账户。
// - 映射在服务端冻结，调用方无法通过请求扩大工具集合；响应只投影 ToolResult（ok/data 或
//   error），不在服务端重算 PnL、统计或发布资格。
// - 所有响应 cache-control: no-store；未知 panel 404、方法错误 405（Allow: GET）。
import {
  computeMarketSession,
  dateInShanghai,
  isHoliday,
  isWeekend,
  type MarketSession,
  nextTradingSessionStart,
  previousTradingDate,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { DEFAULT_MARKET_TIMEOUT_MS, type MarketSurface } from './market-surface.js';
import { denied, invalidInput, type ReadSurface } from './read-surface.js';
import type { ResearchContinuity } from './research-status.js';
import type { RequestAdmission } from './routes.js';

export const PANEL_NAMES = [
  'overview',
  'positions',
  'watchlists',
  'strategies',
  'review',
  'settings',
] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

/**
 * 单条固定工具调用：input 由服务端写死，不能来自 HTTP。
 * `input` 可以是函数，仅用于需要服务端派生（如当日日期）的固定工具；HTTP 仍不能传输入。
 */
type PanelToolInput = Readonly<Record<string, unknown>> | ((now: Date) => Record<string, unknown>);
interface PanelToolCall {
  readonly name: string;
  readonly input: PanelToolInput;
}

interface PanelPlan {
  readonly read: readonly PanelToolCall[];
  readonly market: readonly PanelToolCall[];
}

const fixed = (name: string, input: Readonly<Record<string, unknown>> = {}): PanelToolCall =>
  Object.freeze({ name, input: Object.freeze({ ...input }) });

/** 行情情绪工具要求可验证的 A 股交易日；日期由服务端按 Asia/Shanghai 派生。 */
const sentimentCall = (): PanelToolCall =>
  Object.freeze({
    name: 'get_ashare_sentiment',
    input: (now: Date) => ({
      date: isWeekend(now) || isHoliday(now) ? previousTradingDate(now) : dateInShanghai(now),
    }),
  });

const todayTriggers = (): PanelToolCall => ({
  name: 'list_watch_triggers',
  input: (now) => {
    const since = new Date(`${dateInShanghai(now)}T00:00:00+08:00`);
    return {
      since,
      until: new Date(since.getTime() + 86_400_000 - 1),
      limit: 8,
      orderBy: 'priority',
    };
  },
});

export const OVERVIEW_PLANS = {
  indices: { read: [], market: [fixed('fetch_index_quotes')] },
  sentiment: { read: [], market: [sentimentCall()] },
  account: { read: [fixed('get_account_facts')], market: [] },
  holdings: { read: [fixed('list_holdings')], market: [] },
  watchlists: { read: [fixed('list_watchlists', { enabledOnly: true })], market: [] },
  watchlist: { read: [], market: [] },
  triggers: { read: [todayTriggers()], market: [] },
  advice: { read: [fixed('get_advice', { limit: 9 })], market: [] },
  health: { read: [fixed('get_market_data_status')], market: [] },
  sectors: { read: [], market: [fixed('fetch_sector_quotes', { sort: 'changePct', limit: 5 })] },
  news: { read: [], market: [fixed('fetch_news', { limit: 8 })] },
} as const satisfies Readonly<Record<string, PanelPlan>>;
export type OverviewSection = keyof typeof OVERVIEW_PLANS;
export const WATCHLIST_PAGE_SIZE = 40;

interface WatchlistPage {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly incomplete: boolean;
}

/**
 * 面板固定映射（需求 §7）：
 * - overview：市场（情绪/指数 external + 本地行情状态）、账户概览、触发、建议卡；
 * - watchlists：关注列表目录，成员详情按需经只读调用获取；
 * - strategies：目录、当前版本/最近 published operational run（派生 get_strategy_workspace）、
 *   数据健康、实际结果版本与有界匹配明细、待补观察；
 * - review：Advice 统计/信心校准分桶/逐条反馈、DecisionReview 记录、决策闭环与待补观察。
 *
 * 所有名字必须是 read/market surface 默认 allowlist 内的真实工具；装配期由 surface 自身
 * fail-closed，未暴露的工具在运行时返回 permission_denied，不会泄露或静默成功。
 */
export const PANEL_PLANS: Readonly<Record<PanelName, PanelPlan>> = Object.freeze({
  overview: Object.freeze({
    read: Object.freeze([
      fixed('list_accounts'),
      fixed('list_holdings'),
      todayTriggers(),
      fixed('list_watchlists'),
      fixed('get_advice'),
      fixed('get_market_data_status'),
    ]),
    market: Object.freeze([sentimentCall(), fixed('fetch_index_quotes')]),
  }),
  positions: Object.freeze({
    read: Object.freeze([
      fixed('get_account'),
      fixed('list_holdings'),
      fixed('list_trades', { limit: 50 }),
      fixed('list_account_performance_snapshots', { limit: 30 }),
    ]),
    market: Object.freeze([]),
  }),
  watchlists: Object.freeze({
    read: Object.freeze([fixed('list_watchlists')]),
    market: Object.freeze([]),
  }),
  settings: Object.freeze({
    read: Object.freeze([
      fixed('get_account'),
      fixed('get_market_data_status'),
      fixed('get_stock_universe_status'),
    ]),
    market: Object.freeze([]),
  }),
  strategies: Object.freeze({
    read: Object.freeze([
      fixed('list_strategies'),
      fixed('get_watch_status'),
      fixed('get_strategy_reliability_summary'),
      fixed('list_pending_strategy_observations', { limit: 100 }),
    ]),
    market: Object.freeze([]),
  }),
  review: Object.freeze({
    read: Object.freeze([
      fixed('get_advice_stats'),
      fixed('get_confidence_calibration'),
      fixed('list_decision_reviews', { limit: 20 }),
      fixed('get_advice', { includeExpired: true, limit: 20 }),
      fixed('get_decision_loop_review', { limit: 100 }),
      fixed('list_pending_strategy_observations', { limit: 100 }),
    ]),
    market: Object.freeze([]),
  }),
}) as Readonly<Record<PanelName, PanelPlan>>;

/** 策略面板的「当前版本/运行/数据健康」派生：对目录里每条策略读一次 workspace。 */
export const STRATEGY_WORKSPACE_TOOL = 'get_strategy_workspace';
export const MAX_STRATEGY_WORKSPACES = 20;
// 情绪首查会聚合多个上游，不能在 market surface 的时限前截断正常结果。
export const DEFAULT_PANEL_MARKET_TIMEOUT_MS = DEFAULT_MARKET_TIMEOUT_MS;

type ToolError = Extract<ToolResult<unknown>, { readonly ok: false }>['error'];

export interface PanelStateTool {
  readonly name: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: ToolError;
}

export interface PanelStrategyWorkspace {
  readonly strategyId: string;
  readonly workspace: PanelStateTool;
  readonly schedule: PanelStateTool;
  readonly subscriptions: PanelStateTool;
  readonly continuity?: PanelContinuitySummary;
}

/**
 * 面板首屏只需要续跑结论与事实截止；审计全文、任务回执和完整运行事实走
 * `research?view=updates` 按需读取，避免把数 MB 的审计塞进面板响应。
 */
export interface PanelContinuitySummary {
  readonly status: ResearchContinuity['status'];
  readonly reasons: readonly string[];
  readonly limitations: readonly string[];
  readonly factCutoff: string | null;
  readonly automationsEnabled: boolean;
  readonly taskSource: 'available' | 'unavailable';
  readonly taskCount: number;
  readonly notificationStatus: 'not-verified';
  readonly latestRun: {
    readonly id: string;
    readonly status: string;
    readonly dataAsOf: string;
    readonly finishedAt: string | null;
  } | null;
}

const continuitySummary = (continuity: ResearchContinuity): PanelContinuitySummary => ({
  status: continuity.status,
  reasons: continuity.reasons,
  limitations: continuity.limitations,
  factCutoff: continuity.factCutoff,
  automationsEnabled: continuity.automationsEnabled,
  taskSource: continuity.taskSource,
  taskCount: continuity.tasks.length,
  notificationStatus: continuity.notificationStatus,
  latestRun:
    continuity.latestRun === null
      ? null
      : {
          id: continuity.latestRun.id,
          status: continuity.latestRun.status,
          // 续跑事实来自工具结果，日期可能已是 ISO 字符串；两种形态都要能投影。
          dataAsOf: isoOf(continuity.latestRun.dataAsOf) ?? '',
          finishedAt: isoOf(continuity.latestRun.finishedAt),
        },
});

const isoOf = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** 面板调度用的交易时段事实：服务端按 core 交易日历算出，客户端不自己判时段。 */
export interface PanelSession {
  readonly marketSession: MarketSession;
  /** 下一次连续竞价开始的时刻（ISO）；客户端据此决定何时醒来轮询。 */
  readonly nextSessionStart: string;
}

export interface PanelStateResponse {
  readonly panel: PanelName;
  readonly asOf: string;
  readonly session: PanelSession;
  readonly tools: readonly PanelStateTool[];
  readonly strategies?: readonly PanelStrategyWorkspace[];
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly section?: OverviewSection;
  readonly watchlistPage?: WatchlistPage;
}

const jsonNoStore = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const jsonSafe = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { kind: 'internal', cause: 'Panel value is not JSON serializable' };
  }
};

/** 只投影 ToolResult：成功带 data，失败原样带 error（不重算、不包装成成功空数据）。 */
export const projectPanelTool = (name: string, result: ToolResult<unknown>): PanelStateTool =>
  result.ok
    ? { name, ok: true, data: jsonSafe(result.data) }
    : { name, ok: false, error: jsonSafe(result.error) as ToolError };

const resolveInput = (call: PanelToolCall, now: Date): Record<string, unknown> =>
  typeof call.input === 'function' ? call.input(now) : call.input;

const invoke = async (
  surface: ReadSurface | MarketSurface,
  call: PanelToolCall,
  signal: AbortSignal,
  now: Date,
): Promise<PanelStateTool> => {
  try {
    return projectPanelTool(
      call.name,
      await surface.invoke(call.name, resolveInput(call, now), signal),
    );
  } catch {
    return {
      name: call.name,
      ok: false,
      error: { kind: 'internal', cause: 'Panel tool execution unavailable' },
    };
  }
};

/** 成员由受账户约束的读工具决定；HTTP 不能提供任意股票集合。 */
const readWatchlistPage = async (
  options: CreatePanelStateHandlerOptions,
  page: number,
  signal: AbortSignal,
  now: Date,
): Promise<{ tools: PanelStateTool[]; watchlistPage?: WatchlistPage }> => {
  const listed = await invoke(
    options.read,
    fixed('list_watchlists', { enabledOnly: true }),
    signal,
    now,
  );
  if (!listed.ok) return { tools: [listed] };
  const lists = listed.data as { items: { watchlist: { id: string } }[] };
  const members = await Promise.all(
    lists.items.map(({ watchlist }) =>
      invoke(options.read, fixed('get_watchlist', { watchlistId: watchlist.id }), signal, now),
    ),
  );
  const successful = members.filter((result) => result.ok);
  if (members.length > 0 && successful.length === 0)
    return { tools: [members[0] as PanelStateTool] };
  const ids = [
    ...new Set(
      successful.flatMap((result) =>
        (result.data as { members: { member: { stockId: string } }[] }).members.map(
          ({ member }) => member.stockId,
        ),
      ),
    ),
  ].sort();
  const stockIds = ids.slice((page - 1) * WATCHLIST_PAGE_SIZE, page * WATCHLIST_PAGE_SIZE);
  const quotes =
    stockIds.length === 0
      ? projectPanelTool('batch_quote', {
          ok: true,
          data: { items: [], quotes: [], unresolved: [] },
        })
      : await invoke(
          options.market,
          fixed('batch_quote', { stockIds, context: 'display' }),
          signal,
          now,
        );
  return {
    tools: [quotes],
    watchlistPage: {
      page,
      pageSize: WATCHLIST_PAGE_SIZE,
      total: ids.length,
      incomplete: successful.length !== members.length,
    },
  };
};

const strategyIdsOf = (result: PanelStateTool): readonly string[] => {
  if (!result.ok) return [];
  const data = asRecord(result.data);
  const strategies = data?.strategies;
  if (!Array.isArray(strategies)) return [];
  const ids: string[] = [];
  for (const item of strategies) {
    const strategy = asRecord(item);
    const id = strategy?.id;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

export interface CreatePanelStateHandlerOptions {
  readonly read: ReadSurface;
  readonly market: MarketSurface;
  /** 与 /api/luoome/call 一致：prefix 已做 Connection.admit 时传 () => null；测试可注入拒绝。 */
  readonly admit: RequestAdmission;
  readonly now?: () => Date;
  readonly continuity?: (
    strategyId: string,
    signal: AbortSignal,
  ) => Promise<ResearchContinuity | undefined>;
  readonly marketTimeoutMs?: number;
  readonly maxStrategyWorkspaces?: number;
  readonly configuration?: () => Readonly<Record<string, unknown>>;
}

const StockDetailQuery = z.object({ stockId: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/) }).strict();

export const createStockDetailHandler =
  (options: Pick<CreatePanelStateHandlerOptions, 'market' | 'admit' | 'now' | 'marketTimeoutMs'>) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      const response = jsonNoStore(invalidInput('GET required'), 405);
      response.headers.set('allow', 'GET');
      return response;
    }
    try {
      const rejection = await options.admit(request);
      if (rejection) return rejection;
    } catch {
      return jsonNoStore(denied('host authentication'), 403);
    }
    const query = new URL(request.url).searchParams;
    const parsed = StockDetailQuery.safeParse(Object.fromEntries(query));
    if (!parsed.success || [...query.keys()].length !== 1)
      return jsonNoStore(invalidInput('A single supported stockId is required'), 400);
    const now = (options.now ?? (() => new Date()))();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(options.marketTimeoutMs ?? DEFAULT_PANEL_MARKET_TIMEOUT_MS),
    ]);
    const quote = await invoke(
      options.market,
      fixed('fetch_quote', { stockId: parsed.data.stockId }),
      signal,
      now,
    );
    return jsonNoStore({ stockId: parsed.data.stockId, asOf: now.toISOString(), quote });
  };

export const createStockHistoryHandler =
  (options: Pick<CreatePanelStateHandlerOptions, 'market' | 'admit' | 'now' | 'marketTimeoutMs'>) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      const response = jsonNoStore(invalidInput('GET required'), 405);
      response.headers.set('allow', 'GET');
      return response;
    }
    try {
      const rejection = await options.admit(request);
      if (rejection) return rejection;
    } catch {
      return jsonNoStore(denied('host authentication'), 403);
    }
    const query = new URL(request.url).searchParams;
    const parsed = z
      .object({ stockId: z.string().regex(/^\d{6}\.(SH|SZ)$/) })
      .strict()
      .safeParse(Object.fromEntries(query));
    if (!parsed.success || [...query.keys()].length !== 1)
      return jsonNoStore(invalidInput('A single supported stockId is required'), 400);
    const now = (options.now ?? (() => new Date()))();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(options.marketTimeoutMs ?? DEFAULT_PANEL_MARKET_TIMEOUT_MS),
    ]);
    const marketView = await invoke(
      options.market,
      fixed('get_stock_market_view', {
        stockId: parsed.data.stockId,
        range: '3m',
        granularity: 'day',
        strategySignalScope: 'operational',
      }),
      signal,
      now,
    );
    return jsonNoStore({ stockId: parsed.data.stockId, asOf: now.toISOString(), marketView });
  };

/**
 * 创建 `GET /api/luoome/state` handler。
 *
 * 认证拒绝沿用宿主 admission 的 Response；GET 不构造请求体，也不读取 cookie 之外的凭据。
 * market external 调用用 AbortSignal.timeout 有界取消，失败以 ToolResult 原样投影。
 */
export const createPanelStateHandler =
  (options: CreatePanelStateHandlerOptions) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      const response = jsonNoStore(invalidInput('GET required'), 405);
      response.headers.set('allow', 'GET');
      return response;
    }
    try {
      const rejection = await options.admit(request);
      if (rejection) return rejection;
    } catch {
      return jsonNoStore(denied('host authentication'), 403);
    }
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!['panel', 'section', 'page'].includes(key) || url.searchParams.getAll(key).length !== 1)
        return jsonNoStore(invalidInput('Unsupported query parameter'), 400);
    }
    const panel = url.searchParams.get('panel');
    if (panel === null || !(PANEL_NAMES as readonly string[]).includes(panel)) {
      return jsonNoStore(
        { ok: false, error: { kind: 'not_found', entity: 'Panel', id: panel ?? '' } },
        404,
      );
    }
    const name = panel as PanelName;
    const sectionValue = url.searchParams.get('section');
    if (
      sectionValue !== null &&
      (name !== 'overview' || !Object.hasOwn(OVERVIEW_PLANS, sectionValue))
    )
      return jsonNoStore(invalidInput('Unknown overview section'), 400);
    const section = sectionValue as OverviewSection | null;
    const pageValue = url.searchParams.get('page');
    if (pageValue !== null && (section !== 'watchlist' || !/^[1-9]\d{0,4}$/.test(pageValue)))
      return jsonNoStore(invalidInput('Invalid watchlist page'), 400);
    const plan: PanelPlan = section === null ? PANEL_PLANS[name] : OVERVIEW_PLANS[section];
    const now = (options.now ?? (() => new Date()))();
    const signal = request.signal;
    const marketSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.marketTimeoutMs ?? DEFAULT_PANEL_MARKET_TIMEOUT_MS),
    ]);

    const [readTools, marketTools] = await Promise.all([
      Promise.all(plan.read.map((call) => invoke(options.read, call, signal, now))),
      Promise.all(plan.market.map((call) => invoke(options.market, call, marketSignal, now))),
    ]);
    const tools: PanelStateTool[] = [...readTools, ...marketTools];
    const watchlist =
      section === 'watchlist'
        ? await readWatchlistPage(options, Number(pageValue ?? 1), marketSignal, now)
        : undefined;
    if (watchlist !== undefined) tools.push(...watchlist.tools);

    let strategies: PanelStrategyWorkspace[] | undefined;
    if (name === 'strategies') {
      const listed = tools.find((tool) => tool.name === 'list_strategies');
      const ids = listed === undefined ? [] : strategyIdsOf(listed);
      const limit = options.maxStrategyWorkspaces ?? MAX_STRATEGY_WORKSPACES;
      strategies = await Promise.all(
        ids.slice(0, limit).map(async (strategyId) => {
          const [workspace, schedule, subscriptions, continuity] = await Promise.all([
            invoke(options.read, fixed(STRATEGY_WORKSPACE_TOOL, { strategyId }), signal, now),
            invoke(options.read, fixed('get_strategy_schedule', { strategyId }), signal, now),
            invoke(
              options.read,
              fixed('list_strategy_watchlist_subscriptions', { strategyId }),
              signal,
              now,
            ),
            options.continuity?.(strategyId, signal),
          ]);
          return {
            strategyId,
            workspace,
            schedule,
            subscriptions,
            ...(continuity === undefined ? {} : { continuity: continuitySummary(continuity) }),
          };
        }),
      );
    }

    const body: PanelStateResponse = {
      panel: name,
      asOf: now.toISOString(),
      session: {
        marketSession: computeMarketSession(now),
        nextSessionStart: nextTradingSessionStart(now).toISOString(),
      },
      tools,
      ...(section === null ? {} : { section }),
      ...(watchlist?.watchlistPage === undefined ? {} : { watchlistPage: watchlist.watchlistPage }),
      ...(strategies === undefined ? {} : { strategies }),
      ...(name === 'settings' && options.configuration !== undefined
        ? { configuration: options.configuration() }
        : {}),
    };
    return jsonNoStore(body);
  };
