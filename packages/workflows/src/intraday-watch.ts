import {
  type AlertPriority,
  ATTEMPTED_DELIVERY_STATUSES,
  assertWatchTriggerInvariants,
  type DeliveryStatus,
  deriveRulePriority,
  type Money,
  type Quote,
  type Stock,
  type StockPool,
  type ToolContext,
  type ToolResult,
  type WatchRule,
  type WatchRuleState,
  type WatchTrigger,
} from '@luoome/core';
import { recordWatchRunTool } from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';
import { refreshGroupsWorkflow } from './refresh-groups.js';

/**
 * intraday-watch workflow
 * - v0.6 起（docs/ddd/intraday-watch-design.md）
 * - 分组化改造（docs/ddd/stock-group-design.md §7）
 * - v0.7 策略预警扩展（docs/ddd/strategy-alert-detailed-design.md §4-§8）
 *
 * 单轮盯盘评估管线（§4，**粗体为新增**）：
 *   0.  daily 分组刷新检查
 *   1.  加载 enabled 池
 *   2.  tactic seed
 *   3.  逐池解析成员（**stale 动态分组 → 跳过该池**）
 *   4.  batch_quote
 *   5.  拉 prevCloses
 *   6.  逐池逐成员逐规则求值：
 *       **6a. 批量加载 WatchRuleState**
 *       **6b. 状态机边沿判定（§5）→ 候选触发**
 *       **6c. logic=ALL：合成 composite 虚拟规则 → 同一边沿判定**
 *   7.  cooldown 过滤（**改用 (poolId,stockId,ruleId) 维度；只数 ATTEMPTED**）
 *   8.  **每日上限过滤（方案级 + 全局；update_config 默认 50）**
 *   9.  **优先级映射：normal → not-requested；其余 → pending**
 *   10. notify=true：按池切片 send_notification → sent / failed / fallback-log，
 *       回写 deliveryStatus + notificationId；notify=false（试跑）→ not-requested，
 *       不占 cooldown。
 */

export const IntradayWatchInput = z.object({
  /** 仅评估这些池（id 列表）；缺省 = 全部 enabled。 */
  poolIds: z.array(z.string().min(1)).optional(),
  /** 是否推送通知；默认 true。--no-notify 时 CLI 传 false。 */
  notify: z.boolean().default(true),
  /** 是否对 formula 分组引用的 tactic 跑启动 seed；CLI watch 启动时 true，单轮 --once 测试时 false。 */
  seedTacticSources: z.boolean().default(true),
});

export type IntradayWatchInputT = z.infer<typeof IntradayWatchInput>;

export const WatchTriggerSummarySchema = z.object({
  id: z.string(),
  poolId: z.string(),
  stockId: z.string(),
  ruleKind: z.string(),
  ruleId: z.string(),
  triggerType: z.enum(['triggered', 'recovered']),
  priority: z.enum(['urgent', 'important', 'normal']),
  deliveryStatus: z.enum([
    'not-requested',
    'suppressed-cooldown',
    'suppressed-daily-limit',
    'pending',
    'sent',
    'failed',
    'fallback-log',
  ]),
  direction: z.string(),
  reason: z.string(),
  evidence: z.array(z.string()),
  quoteClose: z.number(),
  notified: z.boolean(),
  createdAt: z.coerce.date(),
});

export const IntradayWatchOutput = z.object({
  triggers: z.array(WatchTriggerSummarySchema),
  evaluatedPools: z.number().int().nonnegative(),
  evaluatedStocks: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
  suppressedByCooldown: z.number().int().nonnegative(),
  suppressedByDailyLimit: z.number().int().nonnegative(),
  notifyFailed: z.number().int().nonnegative(),
});

export type IntradayWatchOutputT = z.infer<typeof IntradayWatchOutput>;

// ---------- 内部状态类型 ----------

interface PoolMember {
  readonly stockId: string;
  /** 仅 holdings 池填充；其它池为 undefined。 */
  readonly avgCost: Money | undefined;
}

interface LoadedState {
  readonly pools: readonly StockPool[];
  readonly input: IntradayWatchInputT;
}

interface MembersState {
  readonly pools: readonly StockPool[];
  readonly input: IntradayWatchInputT;
  /** poolId → members（含 avgCost 信息）。 */
  readonly members: ReadonlyMap<string, readonly PoolMember[]>;
  /** 跨池 distinct stockIds。 */
  readonly allStockIds: readonly string[];
  /** stockId → avgCost（多池合并；同一 stock 在多池取第一条）。 */
  readonly avgCostByStock: ReadonlyMap<string, Money>;
  /** skipped 原因（§4 step 3）：stale 动态分组 / group-missing / group-disabled。 */
  readonly skipped: ReadonlyMap<string, string>;
}

interface QuotesState extends MembersState {
  readonly quotes: ReadonlyMap<string, Quote>;
}

interface PrevClosesState extends QuotesState {
  readonly prevCloses: ReadonlyMap<string, Money>;
}

/**
 * 求值结果（§4 step 6）：
 * - value=true：规则本轮满足条件
 * - value=false：规则本轮不满足
 * - value=unknown：行情缺失 / 求值抛错，状态保持不变
 */
type EvalResult =
  | { readonly kind: 'true'; readonly evaluatedValue: number; readonly evidence: readonly string[] }
  | {
      readonly kind: 'false';
      readonly evaluatedValue: number;
      readonly evidence: readonly string[];
    }
  | { readonly kind: 'unknown' };

interface EvaluatedState extends PrevClosesState {
  /** 已经过边沿状态机筛选的候选触发（已含 ruleId / priority / triggerType）。 */
  readonly candidates: readonly WatchTrigger[];
  /** 求值后待写回的 WatchRuleState（含初始化 / 变更 / 不变）。 */
  readonly nextStates: readonly WatchRuleState[];
}

// ---------- helpers ----------

/** 把每个 rule.id 缺省的补上稳定的临时 id（用于本轮评估；落库时也是 pool 内稳定 id）。 */
const ensureRuleIds = (pool: StockPool): readonly (WatchRule & { id: string })[] => {
  const seen = new Set<string>();
  return pool.rules.map((r) => {
    const id = r.id ?? `r_${globalThis.crypto.randomUUID().slice(0, 8)}`;
    if (seen.has(id)) {
      throw new Error(`pool ${pool.id} 的 rules[].id 重复：${id}`);
    }
    seen.add(id);
    return { ...(r as object), id } as WatchRule & { id: string };
  });
};

/** Asia/Shanghai 时区偏移（+8h，无夏令时）；与 packages/cli/src/holidays.ts 同口径。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把 Date 转成 Asia/Shanghai 当日的 YYYY-MM-DD 字符串（不依赖 process.env.TZ）。 */
const dateInShanghai = (date: Date): string => {
  const d = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** evalSnapshot 必填字段（§3.4 / §12 可解释率）。 */
const buildEvalSnapshot = (args: {
  ruleId: string;
  kind: WatchRule['kind'];
  quoteClose: Money;
  quoteTs: Date;
  threshold: Record<string, unknown>;
  evaluatedValue: number;
  prevClose?: Money;
  prevCloseSource?: 'bar';
  avgCost?: Money;
  pnlPct?: number;
}): Record<string, unknown> => ({
  ruleId: args.ruleId,
  kind: args.kind,
  quoteClose: args.quoteClose,
  quoteTs: args.quoteTs,
  threshold: args.threshold,
  evaluatedValue: args.evaluatedValue,
  ...(args.prevClose !== undefined ? { prevClose: args.prevClose } : {}),
  ...(args.prevCloseSource !== undefined ? { prevCloseSource: args.prevCloseSource } : {}),
  ...(args.avgCost !== undefined ? { avgCost: args.avgCost } : {}),
  ...(args.pnlPct !== undefined ? { pnlPct: args.pnlPct } : {}),
});

/**
 * 求值单条规则的 boolean / unknown。
 * 返回 evald value（changePct / pnlPct / level-差值）+ evidence 条目；上层拿去触发判定与文案。
 */
const evaluateRule = (
  rule: WatchRule & { id: string },
  member: PoolMember,
  quote: Quote | undefined,
  prevCloses: ReadonlyMap<string, Money>,
  avgCost: Money | undefined,
): EvalResult => {
  if (quote === undefined || !(quote.close > 0)) return { kind: 'unknown' };

  if (rule.kind === 'price-change') {
    const prevClose = prevCloses.get(member.stockId);
    if (prevClose === undefined || !(prevClose > 0)) return { kind: 'unknown' };
    const pc = prevClose;
    const change = (quote.close - pc) / pc;
    const pct = rule.pct;
    const pass =
      rule.direction === 'up'
        ? change >= pct
        : rule.direction === 'down'
          ? change <= -pct
          : Math.abs(change) >= pct;
    return {
      kind: pass ? 'true' : 'false',
      evaluatedValue: change,
      evidence: [`close=${quote.close}`, `prevClose=${pc}`, 'prevCloseSource=bar'],
    };
  }

  if (rule.kind === 'cost-threshold') {
    if (avgCost === undefined || !(avgCost > 0)) return { kind: 'unknown' };
    const pnlPct = (quote.close - avgCost) / avgCost;
    const stop = rule.stopLossPct;
    const tp = rule.takeProfitPct;
    const stopped = stop !== undefined && pnlPct <= -stop;
    const profited = tp !== undefined && pnlPct >= tp;
    return {
      kind: stopped || profited ? 'true' : 'false',
      evaluatedValue: pnlPct,
      evidence: [`close=${quote.close}`, `avgCost=${avgCost}`, `pnlPct=${pnlPct.toFixed(4)}`],
    };
  }

  if (rule.kind === 'price-level') {
    const pass = rule.side === 'above' ? quote.close >= rule.level : quote.close <= rule.level;
    return {
      kind: pass ? 'true' : 'false',
      evaluatedValue: quote.close - rule.level,
      evidence: [`close=${quote.close}`, `level=${rule.level}`, `side=${rule.side}`],
    };
  }

  // tactic 由 evaluateTacticRule 单独处理（异步），不应进 sync 路径。
  return { kind: 'unknown' };
};

/**
 * 边沿状态机（§5）：
 * - 求值结果 + 当前状态 → (action, nextActive, firstTriggeredAt, lastEvaluatedAt, lastValue)
 * - lastRecoveredAt 在 false 边沿（active=true → false）时更新
 * - unknown 任何时候不动状态
 *
 * 返回的是「本轮评估」对该 key 应当写入的下一状态；上层决定是否产生 trigger。
 */
const stepStateMachine = (
  prev: WatchRuleState | undefined,
  evaluation: EvalResult,
  rule: WatchRule & { id: string },
  now: Date,
): {
  next: WatchRuleState;
  /** 本轮是否产生 triggered 候选。 */
  emitTrigger: boolean;
  /** 本轮是否产生 recovered 候选。 */
  emitRecovered: boolean;
  evaluatedValue: number | undefined;
} => {
  // 未初始化：bootstrap（§5 + §11）
  // - 默认（生产）：active=true/false 仅写入状态，不产生触发（避免新规则上线就 spam）
  // - dry-run（notify=false）：可见当前命中（§11 验收），把 bootstrap=true 当作 emit 触发
  if (prev === undefined) {
    if (evaluation.kind === 'true') {
      return {
        next: {
          poolId: '', // 上层填充
          stockId: '', // 上层填充
          ruleId: rule.id,
          active: true,
          lastEvaluatedAt: now,
          lastValue: evaluation.evaluatedValue,
        },
        emitTrigger: false, // 由上层 stepEvaluateRules 在 dry-run 时翻为 true（§11）
        emitRecovered: false,
        evaluatedValue: evaluation.evaluatedValue,
      };
    }
    return {
      next: {
        poolId: '',
        stockId: '',
        ruleId: rule.id,
        active: false,
        lastEvaluatedAt: now,
        ...(evaluation.kind === 'false' ? { lastValue: evaluation.evaluatedValue } : {}),
      },
      emitTrigger: false,
      emitRecovered: false,
      evaluatedValue: evaluation.kind === 'false' ? evaluation.evaluatedValue : undefined,
    };
  }

  // unknown：状态保持，lastEvaluatedAt 也保持（§4 关键顺序约束）。
  if (evaluation.kind === 'unknown') {
    return {
      next: prev,
      emitTrigger: false,
      emitRecovered: false,
      evaluatedValue: prev.lastValue,
    };
  }

  // active=false → true 上升沿：产生触发 + active=true
  if (evaluation.kind === 'true' && !prev.active) {
    return {
      next: {
        ...prev,
        active: true,
        ...(prev.firstTriggeredAt === undefined ? { firstTriggeredAt: now } : {}),
        lastEvaluatedAt: now,
        lastValue: evaluation.evaluatedValue,
      },
      emitTrigger: true,
      emitRecovered: false,
      evaluatedValue: evaluation.evaluatedValue,
    };
  }

  // active=true → true：on-enter 不动作；repeat / daily-first 由上层决定（§5 表格）
  if (evaluation.kind === 'true' && prev.active) {
    return {
      next: { ...prev, lastEvaluatedAt: now, lastValue: evaluation.evaluatedValue },
      emitTrigger: false, // on-enter 默认；上层按 triggerMode 翻为 true
      emitRecovered: false,
      evaluatedValue: evaluation.evaluatedValue,
    };
  }

  // active=true → false：下降沿；notifyOnRecovery=true 时上层产生 recovered
  if (evaluation.kind === 'false' && prev.active) {
    return {
      next: {
        ...prev,
        active: false,
        lastEvaluatedAt: now,
        lastValue: evaluation.evaluatedValue,
        lastRecoveredAt: now,
      },
      emitTrigger: false,
      emitRecovered: true, // 上层按 pool.notifyOnRecovery 翻为 false
      evaluatedValue: evaluation.evaluatedValue,
    };
  }

  // active=false → false
  return {
    next: {
      ...prev,
      lastEvaluatedAt: now,
      ...(evaluation.kind === 'false' ? { lastValue: evaluation.evaluatedValue } : {}),
    },
    emitTrigger: false,
    emitRecovered: false,
    evaluatedValue: evaluation.kind === 'false' ? evaluation.evaluatedValue : prev.lastValue,
  };
};

/** 解析单个池的成员（docs/ddd/stock-group-design.md §7 + §4 stale 跳过）。 */
const resolveMembers = async (
  pool: StockPool,
  ctx: WorkflowContext,
): Promise<{ members: readonly PoolMember[]; skipReason?: string }> => {
  const group = await ctx.repos.stockGroup.findById(pool.groupId);
  if (group === null) {
    ctx.logger.warn('[intraday-watch] 池引用的分组不存在', {
      poolId: pool.id,
      groupId: pool.groupId,
    });
    return { members: [], skipReason: 'group-missing' };
  }
  if (!group.enabled) {
    ctx.logger.warn('[intraday-watch] 盯盘方案引用的分组已停用，跳过成员评估', {
      poolId: pool.id,
      groupId: pool.groupId,
    });
    return { members: [], skipReason: 'group-disabled' };
  }
  if (
    group.refreshPolicy === 'daily' &&
    (group.resolver.kind === 'formula' || group.resolver.kind === 'llm')
  ) {
    // stale：今日 (Asia/Shanghai) 还没有快照 / 最近一批 < 今日
    const members = await ctx.repos.groupMember.currentMembers(group.id);
    if (members.length === 0) {
      return { members: [], skipReason: 'stale-empty' };
    }
    const today = dateInShanghai(ctx.clock());
    const lastRefreshAt = members[0]?.createdAt;
    if (lastRefreshAt === undefined || dateInShanghai(lastRefreshAt) < today) {
      return { members: [], skipReason: 'stale' };
    }
    return { members: members.map((s) => ({ stockId: s.stockId, avgCost: undefined })) };
  }
  if (group.resolver.kind === 'manual') {
    return { members: group.resolver.stockIds.map((stockId) => ({ stockId, avgCost: undefined })) };
  }
  if (group.resolver.kind === 'holdings') {
    const r = await ctx.tools.list_holdings.execute({ accountId: group.resolver.accountId });
    if (!r.ok) return { members: [], skipReason: 'holdings-error' };
    return {
      members: r.data.holdings
        .filter((h: { holding: { closedAt: Date | null } }) => h.holding.closedAt === null)
        .map((h: { holding: { stockId: string; avgCost: Money } }) => ({
          stockId: h.holding.stockId,
          avgCost: h.holding.avgCost,
        })),
    };
  }
  // formula / llm 已在上方 fresh 校验后走 currentMembers；到此 fallback。
  const snapshots = await ctx.repos.groupMember.currentMembers(group.id);
  return {
    members: snapshots.map((s) => ({ stockId: s.stockId, avgCost: undefined })),
  };
};

/** 异步规则求值：tactic。返回 evaluation（true/false/unknown）。 */
const evaluateTacticRuleMember = async (
  rule: WatchRule & { id: string; kind: 'tactic' },
  members: readonly PoolMember[],
  quotes: ReadonlyMap<string, Quote>,
  ctx: WorkflowContext,
): Promise<
  ReadonlyMap<
    string,
    EvalResult & {
      score: number;
      direction: 'buy' | 'sell' | 'watch';
      sigEvidence: readonly string[];
    }
  >
> => {
  const out = new Map<
    string,
    EvalResult & {
      score: number;
      direction: 'buy' | 'sell' | 'watch';
      sigEvidence: readonly string[];
    }
  >();
  if (members.length === 0) return out;
  const r = await ctx.tools.run_tactic.execute({
    tacticId: rule.tacticId,
    scope: 'watchlist',
    stockIds: members.map((m) => m.stockId),
    persistSignals: false,
  });
  if (!r.ok) {
    ctx.logger.warn('[intraday-watch] run_tactic 失败', { tacticId: rule.tacticId });
    return out;
  }
  for (const sig of r.data.signals) {
    const q = quotes.get(sig.stockId);
    if (q === undefined || !(q.close > 0)) {
      out.set(sig.stockId, { kind: 'unknown' } as never);
      continue;
    }
    const pass = sig.score >= rule.minScore;
    out.set(sig.stockId, {
      kind: pass ? 'true' : 'false',
      evaluatedValue: sig.score,
      evidence: [...sig.evidence],
      score: sig.score,
      direction:
        sig.direction === 'bullish' ? 'buy' : sig.direction === 'bearish' ? 'sell' : 'watch',
      sigEvidence: [...sig.evidence],
    });
  }
  return out;
};

// ---------- steps ----------

/**
 * 「本进程今日已尝试过 daily 刷新」的内存 flag。
 */
let dailyGroupRefreshAttemptedFor: string | null = null;

/** 测试用：重置 daily 刷新 flag。 */
export const resetDailyGroupRefreshFlagForTest = (): void => {
  dailyGroupRefreshAttemptedFor = null;
};

const stepDailyGroupRefresh: WorkflowStep = async (prev, ctx) => {
  const input = prev as IntradayWatchInputT;
  try {
    const today = dateInShanghai(ctx.clock());
    if (dailyGroupRefreshAttemptedFor === today) return input;

    const groups = await ctx.repos.stockGroup.list(true);
    const dailyDynamic = groups.filter(
      (g) =>
        g.refreshPolicy === 'daily' && (g.resolver.kind === 'formula' || g.resolver.kind === 'llm'),
    );
    if (dailyDynamic.length === 0) {
      dailyGroupRefreshAttemptedFor = today;
      return input;
    }

    const staleIds: string[] = [];
    for (const g of dailyDynamic) {
      const refreshId = await ctx.repos.groupMember.latestRefreshId(g.id);
      if (refreshId === null) {
        staleIds.push(g.id);
        continue;
      }
      const members = await ctx.repos.groupMember.currentMembers(g.id);
      const lastRefreshAt = members[0]?.createdAt;
      if (lastRefreshAt === undefined || dateInShanghai(lastRefreshAt) < today) {
        staleIds.push(g.id);
      }
    }

    dailyGroupRefreshAttemptedFor = today;
    if (staleIds.length === 0) return input;

    ctx.logger.info('[intraday-watch] daily 动态分组刷新', { groupIds: staleIds });
    const r = await refreshGroupsWorkflow.run({ groupIds: staleIds }, ctx);
    if (!r.ok) {
      ctx.logger.warn('[intraday-watch] refresh-groups 失败（保留旧快照继续盯盘）', {
        error: JSON.stringify(r.error),
      });
    }
  } catch (e) {
    ctx.logger.warn('[intraday-watch] daily 刷新检查异常（跳过，不阻塞盯盘）', {
      err: String(e),
    });
  }
  return input;
};

const stepLoadPools: WorkflowStep = async (prev, ctx) => {
  const input = prev as IntradayWatchInputT;
  const r = await ctx.tools.list_stock_pools.execute({ enabledOnly: true });
  if (!r.ok) return r;
  const pools =
    input.poolIds === undefined || input.poolIds.length === 0
      ? r.data.pools
      : r.data.pools.filter((p) => (input.poolIds ?? []).includes(p.id));
  return { pools, input } satisfies LoadedState;
};

const stepSeedTacticSources: WorkflowStep = async (prev, ctx) => {
  const state = prev as LoadedState;
  if (!state.input.seedTacticSources) return state;
  const lookbackByTactic = new Map<string, number>();
  for (const p of state.pools) {
    const group = await ctx.repos.stockGroup.findById(p.groupId);
    if (group === null || group.resolver.kind !== 'formula') continue;
    const r = group.resolver;
    lookbackByTactic.set(
      r.tacticId,
      Math.max(lookbackByTactic.get(r.tacticId) ?? 30, r.lookbackDays),
    );
  }
  for (const [tid, lookbackDays] of lookbackByTactic) {
    const r = await ctx.tools.run_tactic.execute({
      tacticId: tid,
      scope: 'all-stocks',
      lookbackDays,
      persistSignals: true,
    });
    if (!r.ok) {
      ctx.logger.warn('[intraday-watch] seed tactic 失败', { tacticId: tid });
    }
  }
  return state;
};

const stepResolveMembers: WorkflowStep = async (prev, ctx) => {
  const state = prev as LoadedState;
  const members = new Map<string, readonly PoolMember[]>();
  const allIds = new Set<string>();
  const avgCostByStock = new Map<string, Money>();
  const skipped = new Map<string, string>();
  for (const pool of state.pools) {
    const { members: list, skipReason } = await resolveMembers(pool, ctx);
    if (skipReason !== undefined) {
      skipped.set(pool.id, skipReason);
      members.set(pool.id, []);
      continue;
    }
    members.set(pool.id, list);
    for (const m of list) {
      allIds.add(m.stockId);
      if (m.avgCost !== undefined && !avgCostByStock.has(m.stockId)) {
        avgCostByStock.set(m.stockId, m.avgCost);
      }
    }
  }
  return {
    pools: state.pools,
    input: state.input,
    members,
    allStockIds: [...allIds],
    avgCostByStock,
    skipped,
  } satisfies MembersState;
};

const stepBatchQuote: WorkflowStep = async (prev, ctx) => {
  const state = prev as MembersState;
  if (state.allStockIds.length === 0) {
    return { ...state, quotes: new Map<string, Quote>() } satisfies QuotesState;
  }
  const r = await ctx.tools.batch_quote.execute({
    stockIds: [...state.allStockIds],
    context: 'intraday-rule',
  });
  if (!r.ok) return r;
  const map = new Map<string, Quote>();
  for (const item of r.data.items) {
    if (item.status === 'ok' && item.freshness === 'fresh') {
      map.set(item.stockId, item.quote);
    }
  }
  return { ...state, quotes: map } satisfies QuotesState;
};

const stepLoadPrevCloses: WorkflowStep = async (prev, ctx) => {
  const state = prev as QuotesState;
  const prevCloses = new Map<string, Money>();
  const result = await ctx.tools.get_previous_closes.execute({
    stockIds: [...state.allStockIds],
  });
  if (result.ok) {
    for (const item of result.data.items) {
      if (item.status === 'ok' && item.close > 0) prevCloses.set(item.stockId, item.close);
    }
  }
  return { ...state, prevCloses } satisfies PrevClosesState;
};

/**
 * step 6：评估 → 状态机 → 候选触发（§4 step 6 + §5 状态机 + §6 ALL composite）。
 * - 6a：批量加载 WatchRuleState（同一 (pool, stock, rule) 初始化为 undefined）
 * - 6b：每条规则每只股票过一遍 evaluateRule → stepStateMachine → 候选 / 状态变更
 * - 6c：pool.logic='ALL' 时维护 composite 虚拟规则（ruleId='composite'），
 *       当且仅当 pool 内所有规则 active=true（最新一轮求值确定的状态）才 active=true
 *
 * 输出：candidates (待落库) + nextStates（待回写 watch_rule_states）
 */
const stepEvaluateRules: WorkflowStep = async (prev, ctx) => {
  const state = prev as PrevClosesState;
  const now = ctx.clock();
  const candidates: WatchTrigger[] = [];
  const nextStates: WatchRuleState[] = [];
  let unknownCount = 0;

  // 6a：批量加载该池状态（按 pool 进行顺序处理；池数一般 O(10)）
  for (const pool of state.pools) {
    if (state.skipped.has(pool.id)) continue;
    const rulesWithIds = ensureRuleIds(pool);
    // event-date 规则由 evaluate-event-rules workflow 每日盘前求值，intraday 跳过：
    // 不评估、不写触发、不参与 ANY/ALL 组合判定（ruo 迁移 §3.5）。
    const evaluableRules = rulesWithIds.filter((r) => r.kind !== 'event-date');
    const members = state.members.get(pool.id) ?? [];
    if (members.length === 0) continue;

    const allStates = await ctx.repos.watchRuleState.listByPool(pool.id);
    const stateByKey = new Map<string, WatchRuleState>();
    for (const s of allStates) {
      stateByKey.set(`${s.stockId}|${s.ruleId}`, s);
    }

    // 按 (stockId, ruleId) 累积 active 结果，给 composite 用
    const activeByStockRule = new Map<string, boolean>();

    // 先逐规则求值（同步）
    for (const rule of evaluableRules) {
      const priority = deriveRulePriority(rule, pool.priority);

      // 异步规则：tactic 一次跑整批
      let tacticResults: ReadonlyMap<
        string,
        EvalResult & {
          score: number;
          direction: 'buy' | 'sell' | 'watch';
          sigEvidence: readonly string[];
        }
      > | null = null;
      if (rule.kind === 'tactic') {
        tacticResults = await evaluateTacticRuleMember(rule, members, state.quotes, ctx);
      }

      for (const member of members) {
        const quote = state.quotes.get(member.stockId);
        const evaluation: EvalResult =
          rule.kind === 'tactic' && tacticResults !== null
            ? (tacticResults.get(member.stockId) ?? { kind: 'unknown' })
            : evaluateRule(
                rule,
                member,
                quote,
                state.prevCloses,
                state.avgCostByStock.get(member.stockId),
              );
        if (evaluation.kind === 'unknown') {
          unknownCount += 1;
          // 状态保持：bootstrap 此前若无状态则初始化为 false，否则保留
          const prevState = stateByKey.get(`${member.stockId}|${rule.id}`);
          if (prevState === undefined) {
            nextStates.push({
              poolId: pool.id,
              stockId: member.stockId,
              ruleId: rule.id,
              active: false,
              lastEvaluatedAt: now,
            });
          }
          continue;
        }

        const prevState = stateByKey.get(`${member.stockId}|${rule.id}`);
        const sm = stepStateMachine(prevState, evaluation, rule, now);
        // dry-run（notify=false）下，bootstrap=true 也视作 emit（§11：试跑可见当前命中）
        const isDryRun = state.input.notify === false;
        const bootstrapEmits =
          sm.emitTrigger || (isDryRun && prevState === undefined && evaluation.kind === 'true');

        const nextState: WatchRuleState = {
          ...sm.next,
          poolId: pool.id,
          stockId: member.stockId,
          ruleId: rule.id,
        };
        nextStates.push(nextState);

        // 记录给 composite 用
        activeByStockRule.set(`${member.stockId}|${rule.id}`, nextState.active);

        if (bootstrapEmits) {
          // bootstrapEmits 仅在 evaluation.kind='true' 时成立（state machine 保证）
          const evalTrue: EvalResult =
            evaluation.kind === 'true'
              ? evaluation
              : { kind: 'true', evaluatedValue: 0, evidence: [] };
          const direction = deriveDirection(rule, evalTrue, !!quote);
          const snapshot = buildEvalSnapshot({
            ruleId: rule.id,
            kind: rule.kind,
            quoteClose: quote?.close ?? (0 as Money),
            quoteTs: quote?.ts ?? now,
            threshold: ruleKindThreshold(rule),
            evaluatedValue: evalTrue.evaluatedValue,
          });
          const id = makeTriggerId(pool.id, member.stockId, rule.id, now);
          const trigger: WatchTrigger = {
            id,
            poolId: pool.id,
            stockId: member.stockId,
            ruleKind: rule.kind,
            ruleId: rule.id,
            direction,
            triggerType: 'triggered',
            reason: makeReason(rule, evaluation.evaluatedValue, member),
            evidence: [...evaluation.evidence],
            quote: { close: quote?.close ?? (0 as Money), ts: quote?.ts ?? now },
            priority,
            deliveryStatus: 'not-requested', // placeholder, stepResolveDelivery 会覆盖
            evalSnapshot: snapshot,
            notified: false,
            createdAt: now,
          };
          assertWatchTriggerInvariants(trigger);
          candidates.push(trigger);
        }

        if (sm.emitRecovered && pool.notifyOnRecovery) {
          const direction = deriveDirection(rule, evaluation, !!quote);
          const snapshot = buildEvalSnapshot({
            ruleId: rule.id,
            kind: rule.kind,
            quoteClose: quote?.close ?? (0 as Money),
            quoteTs: quote?.ts ?? now,
            threshold: ruleKindThreshold(rule),
            evaluatedValue: evaluation.evaluatedValue,
          });
          const id = makeTriggerId(pool.id, member.stockId, rule.id, now, 'rec');
          const trigger: WatchTrigger = {
            id,
            poolId: pool.id,
            stockId: member.stockId,
            ruleKind: rule.kind,
            ruleId: rule.id,
            direction,
            triggerType: 'recovered',
            reason: `已退出 active：${makeReason(rule, evaluation.evaluatedValue, member)}`,
            evidence: [...evaluation.evidence],
            quote: { close: quote?.close ?? (0 as Money), ts: quote?.ts ?? now },
            // recovered 优先级固定 normal（§5）
            priority: 'normal',
            deliveryStatus: 'not-requested',
            evalSnapshot: snapshot,
            notified: false,
            createdAt: now,
          };
          assertWatchTriggerInvariants(trigger);
          candidates.push(trigger);
        }

        // active=true → true：按 triggerMode 决定 repeat / daily-first（§5）
        if (
          evaluation.kind === 'true' &&
          prevState !== undefined &&
          prevState.active &&
          // sm.next.active 也应当为 true（保留）
          (pool.triggerMode === 'repeat' ||
            (pool.triggerMode === 'daily-first' &&
              !alreadyTriggeredToday(state, pool.id, member.stockId, rule.id, now)))
        ) {
          const direction = deriveDirection(rule, evaluation, !!quote);
          const snapshot = buildEvalSnapshot({
            ruleId: rule.id,
            kind: rule.kind,
            quoteClose: quote?.close ?? (0 as Money),
            quoteTs: quote?.ts ?? now,
            threshold: ruleKindThreshold(rule),
            evaluatedValue: evaluation.evaluatedValue,
          });
          const id = makeTriggerId(pool.id, member.stockId, rule.id, now, 'rep');
          const trigger: WatchTrigger = {
            id,
            poolId: pool.id,
            stockId: member.stockId,
            ruleKind: rule.kind,
            ruleId: rule.id,
            direction,
            triggerType: 'triggered',
            reason: makeReason(rule, evaluation.evaluatedValue, member),
            evidence: [...evaluation.evidence],
            quote: { close: quote?.close ?? (0 as Money), ts: quote?.ts ?? now },
            priority: priority as AlertPriority,
            deliveryStatus: 'not-requested',
            evalSnapshot: snapshot,
            notified: false,
            createdAt: now,
          };
          assertWatchTriggerInvariants(trigger);
          candidates.push(trigger);
        }
      }
    }

    // 6c：ALL composite 虚拟规则
    if (pool.logic === 'ALL' && evaluableRules.length > 0) {
      for (const member of members) {
        const allActive = evaluableRules.every(
          (r) => activeByStockRule.get(`${member.stockId}|${r.id}`) === true,
        );
        const anyUnknown = evaluableRules.some((r) => {
          const prevState = stateByKey.get(`${member.stockId}|${r.id}`);
          return prevState === undefined
            ? false
            : prevState.lastValue === undefined && !prevState.active; // 启发式：未评估过为 unknown
        });
        const compositeId = 'composite';
        const prev = stateByKey.get(`${member.stockId}|${compositeId}`);
        const evaluation: EvalResult = anyUnknown
          ? { kind: 'unknown' }
          : { kind: allActive ? 'true' : 'false', evaluatedValue: allActive ? 1 : 0, evidence: [] };
        const sm = stepStateMachine(
          prev,
          evaluation,
          { id: compositeId, kind: 'cost-threshold', stopLossPct: undefined } as never,
          now,
        );
        nextStates.push({
          ...sm.next,
          poolId: pool.id,
          stockId: member.stockId,
          ruleId: compositeId,
        });
        if (sm.emitTrigger && allActive) {
          const compositeRuleKind = pickCompositeKind(evaluableRules) as WatchRule['kind'];
          const priority = evaluableRules
            .map((r) => deriveRulePriority(r, pool.priority))
            .reduce<AlertPriority>(
              (acc, p) => (priorityRank(p) > priorityRank(acc) ? p : acc),
              'normal',
            );
          const quote = state.quotes.get(member.stockId);
          const id = makeTriggerId(pool.id, member.stockId, compositeId, now, 'cmp');
          const trigger: WatchTrigger = {
            id,
            poolId: pool.id,
            stockId: member.stockId,
            ruleKind: compositeRuleKind,
            ruleId: compositeId,
            direction: 'watch',
            triggerType: 'triggered',
            reason: '所有规则同时进入 active',
            evidence: evaluableRules.map((r) => `${r.kind} active`),
            quote: { close: quote?.close ?? (0 as Money), ts: quote?.ts ?? now },
            priority,
            deliveryStatus: 'not-requested',
            evalSnapshot: { composite: true, rules: evaluableRules.map((r) => r.kind) },
            notified: false,
            createdAt: now,
          };
          assertWatchTriggerInvariants(trigger);
          candidates.push(trigger);
        }
      }
    }
  }

  ctx.logger.info('[intraday-watch] step6 完成', {
    candidates: candidates.length,
    unknown: unknownCount,
    states: nextStates.length,
  });
  return { ...state, candidates, nextStates } satisfies EvaluatedState;
};

/** 已当天触发过：扫一遍候选（同 (pool, stock, rule) createdAt 当日）。 */
const alreadyTriggeredToday = (
  state: PrevClosesState,
  poolId: string,
  stockId: string,
  ruleId: string,
  now: Date,
): boolean => {
  const todayStr = dateInShanghai(now);
  for (const c of (state as unknown as EvaluatedState).candidates ?? []) {
    if (
      c.poolId === poolId &&
      c.stockId === stockId &&
      c.ruleId === ruleId &&
      dateInShanghai(c.createdAt) === todayStr
    ) {
      return true;
    }
  }
  return false;
};

const priorityRank = (p: AlertPriority): number => (p === 'urgent' ? 2 : p === 'important' ? 1 : 0);

const pickCompositeKind = (rules: readonly (WatchRule & { id: string })[]): WatchRule['kind'] => {
  const first = rules[0];
  if (first === undefined) throw new Error('composite watch rule requires at least one rule');
  let best: WatchRule = first;
  let bestP = -1;
  for (const r of rules) {
    const kind = r.kind;
    let p = 0;
    if (kind === 'cost-threshold' && r.stopLossPct !== undefined) p = 3;
    else if (kind === 'price-level') p = 2;
    else if (kind === 'cost-threshold') p = 2;
    else if (kind === 'tactic') p = r.minScore >= 70 ? 2 : 1;
    if (p > bestP) {
      bestP = p;
      best = r;
    }
  }
  return best.kind;
};

const deriveDirection = (
  rule: WatchRule,
  evaluation: EvalResult,
  hasQuote: boolean,
): WatchTrigger['direction'] => {
  if (!hasQuote) return 'watch';
  if (rule.kind === 'price-change') {
    if (rule.direction === 'up') return 'buy';
    if (rule.direction === 'down') return 'sell';
    return evaluation.kind !== 'unknown' && evaluation.evaluatedValue >= 0 ? 'buy' : 'sell';
  }
  if (rule.kind === 'cost-threshold') {
    if (
      rule.stopLossPct !== undefined &&
      evaluation.kind !== 'unknown' &&
      evaluation.evaluatedValue <= -rule.stopLossPct
    )
      return 'sell';
    if (
      rule.takeProfitPct !== undefined &&
      evaluation.kind !== 'unknown' &&
      evaluation.evaluatedValue >= rule.takeProfitPct
    )
      return 'buy';
    return 'watch';
  }
  if (rule.kind === 'price-level') {
    return rule.side === 'above' ? 'buy' : 'sell';
  }
  return 'watch';
};

const ruleKindThreshold = (rule: WatchRule): Record<string, unknown> => {
  if (rule.kind === 'price-change') return { pct: rule.pct, direction: rule.direction };
  if (rule.kind === 'cost-threshold')
    return { stopLossPct: rule.stopLossPct ?? null, takeProfitPct: rule.takeProfitPct ?? null };
  if (rule.kind === 'price-level') return { level: rule.level, side: rule.side };
  if (rule.kind === 'tactic') return { tacticId: rule.tacticId, minScore: rule.minScore };
  // event-date：intraday 不评估（此分支不可达，仅为类型穷尽）
  return {};
};

const makeReason = (rule: WatchRule, value: number, member: PoolMember): string => {
  if (rule.kind === 'price-change') {
    return `${member.stockId} 日内变动 ${(value * 100).toFixed(2)}% ≥ ${(rule.pct * 100).toFixed(2)}%`;
  }
  if (rule.kind === 'cost-threshold') {
    const v = (value * 100).toFixed(2);
    if (rule.stopLossPct !== undefined && value <= -rule.stopLossPct)
      return `止损 收益 ${v}% ≤ -${rule.stopLossPct * 100}%`;
    if (rule.takeProfitPct !== undefined && value >= rule.takeProfitPct)
      return `止盈 收益 ${v}% ≥ ${rule.takeProfitPct * 100}%`;
    return `成本阈值 收益 ${v}%`;
  }
  if (rule.kind === 'price-level') {
    return `价位穿越 level=${rule.level} side=${rule.side} diff=${value.toFixed(2)}`;
  }
  return `战法命中 score=${value.toFixed(1)}`;
};

const makeTriggerId = (
  poolId: string,
  stockId: string,
  ruleId: string,
  now: Date,
  suffix = '',
): string =>
  `wt-${poolId}-${stockId}-${ruleId}-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}${suffix ? `-${suffix}` : ''}`;

// ============================================================
// step 7-9：cooldown + 每日上限 + 优先级映射（统一处理）
// ============================================================

interface DeliveryState extends EvaluatedState {
  readonly triggers: readonly WatchTrigger[];
  readonly suppressedByCooldown: number;
  readonly suppressedByDailyLimit: number;
}

/**
 * 全局每日上限；默认 50。Phase 1 从 update_config tool 读，无配置时取 50。
 * 由于运行时没法直接读 update_config（tool 入口），这里用一个 ctx.config 看：
 * - ctx.config?.globalDailyLimit ?? 50
 */
const GLOBAL_DAILY_LIMIT_DEFAULT = 50;

/** 时区归一化的「今日 00:00 Asia/Shanghai」的 Date。 */
const startOfTodayShanghai = (now: Date): Date => {
  const dStr = dateInShanghai(now);
  const [y, m, day] = dStr.split('-').map((s) => Number(s));
  const yyyy = y ?? new Date(now).getUTCFullYear();
  const mm = m ?? 1;
  const dd = day ?? 1;
  // 00:00 Shanghai = 前一天 16:00 UTC（2026 不变夏令时）
  return new Date(Date.UTC(yyyy, mm - 1, dd) - SHANGHAI_OFFSET_MS);
};

const stepResolveDelivery: WorkflowStep = async (prev, ctx) => {
  const state = prev as EvaluatedState;
  const now = ctx.clock();
  const todayStart = startOfTodayShanghai(now);
  const globalLimit =
    Number(
      (ctx as unknown as { config?: { globalDailyLimit?: number } }).config?.globalDailyLimit,
    ) || GLOBAL_DAILY_LIMIT_DEFAULT;

  // 已用额度（读库，避免本轮自己写入后被重复计入；先读一次，后续本轮新写入也要算）
  const baselineGlobal = await ctx.repos.watchTrigger.countAttemptedSince(todayStart, null);
  const baselineByPool = new Map<string, number>();
  for (const pool of state.pools) {
    baselineByPool.set(
      pool.id,
      await ctx.repos.watchTrigger.countAttemptedSince(todayStart, pool.id),
    );
  }

  const out: WatchTrigger[] = [];
  let suppressedByCooldown = 0;
  let suppressedByDailyLimit = 0;
  let usedGlobal = baselineGlobal;
  const usedByPool = new Map<string, number>([...baselineByPool]);

  for (const cand of state.candidates) {
    const pool = state.pools.find((p) => p.id === cand.poolId);
    if (pool === undefined) continue;
    // 7. cooldown（先于 daily limit，§4 关键顺序约束；试跑 notify=false 同样询问，但命中只落抑制不占配额）
    const cdCutoff = new Date(now.getTime() - pool.cooldownMinutes * 60_000);
    const cooldownHit = await ctx.repos.watchTrigger.lastForKey(
      { poolId: cand.poolId, stockId: cand.stockId, ruleId: cand.ruleId },
      cdCutoff,
    );
    let deliveryStatus: DeliveryStatus = 'pending';

    // 9. 优先级映射（normal → not-requested；试跑 / recovered + 默认关 → not-requested）
    if (cand.triggerType === 'recovered' && !(pool.notifyOnRecovery === true)) {
      deliveryStatus = 'not-requested';
    } else if (cand.priority === 'normal') {
      // Phase 1 不做 15 分钟聚合，普通优先级只记录（§8 表格）
      deliveryStatus = 'not-requested';
    } else if (cooldownHit !== null) {
      deliveryStatus = 'suppressed-cooldown';
      suppressedByCooldown += 1;
    } else if (
      (usedByPool.get(pool.id) ?? 0) >= pool.dailyNotificationLimit ||
      usedGlobal >= globalLimit
    ) {
      deliveryStatus = 'suppressed-daily-limit';
      suppressedByDailyLimit += 1;
    } else if (!state.input.notify) {
      // 试跑：占位 not-requested，不消耗配额（lastForKey 只数 ATTEMPTED）
      deliveryStatus = 'not-requested';
    } else {
      deliveryStatus = 'pending';
      // pending 不计入配额，但若后续发送失败成 'failed' 会回写（setDeliveryStatus 不计数）
    }

    // 与 pickup 配额相关的占位：先按照 ATTEMPTED_STATUSES 决定哪些会让配额增 1
    if (
      deliveryStatus === 'pending' &&
      cand.priority !== 'normal' &&
      cand.triggerType !== 'recovered' &&
      cooldownHit === null
    ) {
      // 标记为「将要发生 ATTEMPT」—— 实际发送后再回写 deliveryStatus，notifyFailed 时不计数
      // 这里只用于卡每日上限：如果命中 daily limit 应转为 suppressed-daily-limit
      const projectedPool = (usedByPool.get(pool.id) ?? 0) + 1;
      const projectedGlobal = usedGlobal + 1;
      if (projectedPool > pool.dailyNotificationLimit || projectedGlobal > globalLimit) {
        deliveryStatus = 'suppressed-daily-limit';
        suppressedByDailyLimit += 1;
      } else {
        // pending 不占配额（lastForKey 只数 ATTEMPTED），但下一轮 ATTEMPT 后的 lastForKey 会算
        // 这里简单处理：把 ATTEMPT 计数延后到 send 后回写阶段体现
        usedByPool.set(pool.id, projectedPool);
        usedGlobal = projectedGlobal;
      }
    }

    const persisted: WatchTrigger = {
      ...cand,
      deliveryStatus,
      notified: (ATTEMPTED_DELIVERY_STATUSES as readonly string[]).includes(deliveryStatus),
    };
    assertWatchTriggerInvariants(persisted);
    await ctx.repos.watchTrigger.save(persisted);
    out.push(persisted);
  }

  // 写回 WatchRuleState
  if (state.nextStates.length > 0) {
    await ctx.repos.watchRuleState.upsertMany(state.nextStates);
  }

  return {
    ...state,
    triggers: out,
    suppressedByCooldown,
    suppressedByDailyLimit,
  } satisfies DeliveryState;
};

const stepNotifyAndSummary: WorkflowStep = async (prev, ctx) => {
  const state = prev as DeliveryState;
  const triggers = state.triggers;
  let notifiedCount = 0;
  let notifyFailed = 0;

  // 仅发送 status='pending' 的；按 pool 切片聚合（保留每只股票方向与原因，§8）
  const byPool = new Map<string, WatchTrigger[]>();
  for (const t of triggers) {
    if (t.deliveryStatus !== 'pending') continue;
    const arr = byPool.get(t.poolId) ?? [];
    arr.push(t);
    byPool.set(t.poolId, arr);
  }
  for (const [poolId, group] of byPool.entries()) {
    notifiedCount += group.length;
    const lines = group.map((t) => {
      const dir = t.direction === 'buy' ? '买' : t.direction === 'sell' ? '卖' : '观察';
      const prio =
        t.priority === 'urgent' ? '【急】' : t.priority === 'important' ? '【重要】' : '';
      return `· ${prio}[${dir}] ${t.stockId} @ ${t.quote ? t.quote.close.toFixed(2) : '—'} — ${t.reason}`;
    });
    const content = lines.join('\n');
    const r = await ctx.tools.send_notification.execute({
      log: {
        title: `盘中提醒 池-${poolId} ${group.length} 条`,
        content,
        level: 'info',
      },
    });
    let deliveryStatus: DeliveryStatus = 'sent';
    let notificationId: string | undefined;
    if (!r.ok) {
      deliveryStatus = 'failed';
      notifyFailed += group.length;
      ctx.logger.warn('[intraday-watch] send_notification 失败', {
        poolId,
        error: r.error,
      });
    } else if (r.data.notification.result === 'suppressed') {
      // feishu 未配置 → 自动降级为 log（fallback-log）
      deliveryStatus = 'fallback-log';
      notificationId = r.data.notification.id;
    } else if (r.data.notification.result === 'failed') {
      deliveryStatus = 'failed';
      notifyFailed += group.length;
    } else {
      notificationId = r.data.notification.id;
    }
    await ctx.repos.watchTrigger.setDeliveryStatus(
      group.map((t) => t.id),
      deliveryStatus,
      notificationId,
    );
  }

  return IntradayWatchOutput.parse({
    triggers: triggers.map((t) => ({
      id: t.id,
      poolId: t.poolId,
      stockId: t.stockId,
      ruleKind: t.ruleKind,
      ruleId: t.ruleId,
      triggerType: t.triggerType,
      priority: t.priority,
      deliveryStatus: t.deliveryStatus,
      direction: t.direction,
      reason: t.reason,
      evidence: [...t.evidence],
      quoteClose: t.quote?.close ?? (0 as Money),
      notified: t.notified,
      createdAt: t.createdAt,
    })),
    evaluatedPools: state.pools.length,
    evaluatedStocks: state.allStockIds.length,
    notified: notifiedCount,
    suppressedByCooldown: state.suppressedByCooldown,
    suppressedByDailyLimit: state.suppressedByDailyLimit,
    notifyFailed,
  });
};

// Re-export for callers
export type { Stock };

/**
 * intraday-watch workflow（v0.7）。
 */
export const intradayWatchWorkflow = defineWorkflow<
  z.infer<typeof IntradayWatchInput>,
  z.infer<typeof IntradayWatchOutput>
>({
  name: 'intraday-watch',
  description: '单轮盘中盯盘评估（v0.7 策略预警）',
  input: IntradayWatchInput,
  steps: [
    stepDailyGroupRefresh,
    stepLoadPools,
    stepSeedTacticSources,
    stepResolveMembers,
    stepBatchQuote,
    stepLoadPrevCloses,
    stepEvaluateRules,
    stepResolveDelivery,
    stepNotifyAndSummary,
  ],
});

/**
 * 带持久化心跳的单轮入口。
 */
export const runIntradayWatchObserved = async (
  input: unknown,
  ctx: ToolContext,
  mode: 'once' | 'daemon',
): Promise<ToolResult<IntradayWatchOutputT>> => {
  const id = `watch-run-${crypto.randomUUID()}`;
  const startedAt = ctx.clock();
  const initial = await recordWatchRunTool.execute(
    {
      id,
      mode,
      status: 'running',
      startedAt,
      finishedAt: null,
      evaluatedPools: 0,
      evaluatedStocks: 0,
      triggered: 0,
      notified: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
    },
    ctx,
  );
  if (!initial.ok) {
    ctx.logger.warn('[intraday-watch] 写入 running 心跳失败', { error: initial.error });
  }

  const result = await intradayWatchWorkflow.run(input, ctx);
  const finishedAt = ctx.clock();
  const terminal = result.ok
    ? await recordWatchRunTool.execute(
        {
          id,
          mode,
          status: 'succeeded',
          startedAt,
          finishedAt,
          evaluatedPools: result.data.evaluatedPools,
          evaluatedStocks: result.data.evaluatedStocks,
          triggered: result.data.triggers.length,
          notified: result.data.notified,
          suppressedByCooldown: result.data.suppressedByCooldown,
          suppressedByDailyLimit: result.data.suppressedByDailyLimit,
          notifyFailed: result.data.notifyFailed,
        },
        ctx,
      )
    : await recordWatchRunTool.execute(
        {
          id,
          mode,
          status: 'failed',
          startedAt,
          finishedAt,
          evaluatedPools: 0,
          evaluatedStocks: 0,
          triggered: 0,
          notified: 0,
          suppressedByCooldown: 0,
          suppressedByDailyLimit: 0,
          notifyFailed: 0,
          error: JSON.stringify(result.error),
        },
        ctx,
      );
  if (!terminal.ok) {
    ctx.logger.warn('[intraday-watch] 写入 terminal 心跳失败', { error: terminal.error });
  }
  return result;
};
