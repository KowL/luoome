// dsh-luoome 面板宿主只读数据路由（plugin 详细设计 §4.2 HTTP、§8 UI）。
//
// 数据路径：浏览器同源 GET /api/luoome/state?panel=... → 宿主认证（prefix 层 Connection.admit）
// → 本模块固定 panel→工具映射 → 进程内 ReadSurface / MarketSurface 调真实领域工具。
//
// 安全边界：
// - URL 只接受 `panel` 参数且必须是固定面板名字；不接受工具名、命令、账户或任意查询参数。
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
      fixed('list_watch_triggers'),
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
      fixed('list_strategy_runs', { scope: 'operational', publication: 'published', limit: 20 }),
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
  readonly continuity?: ResearchContinuity;
}

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
      if (key !== 'panel') return jsonNoStore(invalidInput('Unsupported query parameter'), 400);
    }
    const panel = url.searchParams.get('panel');
    if (panel === null || !(PANEL_NAMES as readonly string[]).includes(panel)) {
      return jsonNoStore(
        { ok: false, error: { kind: 'not_found', entity: 'Panel', id: panel ?? '' } },
        404,
      );
    }
    const name = panel as PanelName;
    const plan = PANEL_PLANS[name];
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
            ...(continuity === undefined ? {} : { continuity }),
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
      ...(strategies === undefined ? {} : { strategies }),
      ...(name === 'settings' && options.configuration !== undefined
        ? { configuration: options.configuration() }
        : {}),
    };
    return jsonNoStore(body);
  };
