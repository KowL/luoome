import {
  assertWatchTriggerInvariants,
  type Money,
  type Quote,
  type Stock,
  type StockPool,
  type ToolContext,
  type ToolResult,
  type WatchRule,
  type WatchTrigger,
} from '@luoome/core';
import { recordWatchRunTool } from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { refreshGroupsWorkflow } from './refresh-groups.js';

/**
 * intraday-watch workflow（v0.6 起，docs/intraday-watch-design.md §6；
 * 分组化改造 docs/stock-group-design.md §7）。
 *
 * 单轮盯盘评估（无状态）：
 *   0. daily 刷新检查（阶段 B）：今日（Asia/Shanghai 口径）尚未成功跑过 refresh-groups
 *      且存在 daily 动态分组（formula / llm）→ 先跑一轮 refresh-groups（仅 stale 子集）。
 *      判定依据：latestRefreshId 对应批次的 createdAt 日期 < 今日 或不存在。
 *      进程内记内存 flag：一轮 watch 进程只尝试一次（失败也记，避免每 60s 重复 LLM 成本）
 *   1. 加载 enabled 池
 *   2. seed：池引用的 formula 分组的 tacticId 去重，每个跑一次 run_tactic(persistSignals=true) 灌 tactic_signals
 *      （成员本身读快照，不依赖本步；灌库信号供 refresh-groups / 复盘用）
 *   3. 逐池解析成员：pool.groupId → StockGroup.resolver
 *      manual → resolver.stockIds；holdings → list_holdings 现算（活视图，含 avgCost）；
 *      formula / llm → repos.groupMember.currentMembers(groupId) 读最新快照
 *      （hot path 不跑 resolver；快照由 step 0 / refresh-groups 盘外产出）
 *   4. 跨池去重聚合 stockIds → batch_quote
 *   5. 拉 dailyBars 昨收（v0.6.1+）：dailyBar.latestBefore(stockId, now, 1) → Map<stockId, prevClose>
 *   6. 逐池逐规则评估 → 候选触发（price-change 优先用 prevCloses；fallback 到 quote.open）
 *   7. cooldown 过滤：lastForKey(now − cooldownMinutes) 存在则 notified=false
 *   8. 所有 fire 的触发都 save_watch_trigger 落库（含 notified=false 的）
 *   9. notify=true 且有 notified=true → 按池切片 send_notification（log channel 兜底）
 *
 * price-change v0.6.1 行为：
 * - dailyBars 有昨日/前日 close 且 > 0 → 用作 prevClose
 * - dailyBars 缺失 / repo throw / close ≤ 0 → fallback 到 quote.open（v0.6 兼容）
 * - evidence 字段：原本 \`prevClose(open)=${q.open}\` → \`prevClose=${prevClose}\`，
 *   日志端从 evidence 难以判断来源，可加前缀 \`(bar)\` / \`(open-fallback)\`（v1 再做）
 *
 * cost-threshold：v0.6+ 已实现（cost-threshold.test.ts 11 case 覆盖）
 * tactic：调用 run_tactic(scope=watchlist, persistSignals=false)，score ≥ minScore 触发
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
}

interface QuotesState extends MembersState {
  readonly quotes: ReadonlyMap<string, Quote>;
}

/**
 * v0.6.1 起：dailyBars 接入的昨收视图。
 * - 通过 stepLoadPrevCloses 填充；缺失 / close <= 0 不入 map（evaluate 时 fallback）
 * - Map<string, Money> 允许日线缺失时退化成空 map，
 *   evaluate 阶段会落到 quote.open 分支（v0.6 行为）。
 */
interface PrevClosesState extends QuotesState {
  readonly prevCloses: ReadonlyMap<string, Money>;
}

interface EvaluatedState extends PrevClosesState {
  readonly candidates: readonly WatchTrigger[];
}

// ---------- helpers ----------

/**
 * 解析单个池的成员（分组化模型，docs/stock-group-design.md §7）。
 * - pool.groupId → StockGroup；分组不存在 → 空成员 + warn（hot path 不 crash）
 * - 分组 enabled=false → 空成员 + warn（pool 可保持启用，恢复分组后自动继续）
 * - manual：resolver.stockIds 现算（avgCost undefined）
 * - holdings：调 list_holdings 现算（活视图，无快照）→ 活跃持仓 stockIds + avgCost
 * - formula / llm：读 repos.groupMember.currentMembers(groupId) 最新快照
 *   （resolver 永不进 hot path；快照由 refresh-groups 盘外产出，阶段 B）
 */
const resolveMembers = async (
  pool: StockPool,
  ctx: Parameters<typeof defineWorkflow>[0]['steps'][number] extends (
    prev: unknown,
    c: infer C,
  ) => unknown
    ? C
    : never,
): Promise<readonly PoolMember[]> => {
  const group = await ctx.repos.stockGroup.findById(pool.groupId);
  if (group === null) {
    ctx.logger.warn('[intraday-watch] 池引用的分组不存在', {
      poolId: pool.id,
      groupId: pool.groupId,
    });
    return [];
  }
  if (!group.enabled) {
    ctx.logger.warn('[intraday-watch] 盯盘方案引用的分组已停用，跳过成员评估', {
      poolId: pool.id,
      groupId: pool.groupId,
    });
    return [];
  }
  const resolver = group.resolver;
  if (resolver.kind === 'manual') {
    return resolver.stockIds.map((stockId) => ({ stockId, avgCost: undefined }));
  }
  if (resolver.kind === 'holdings') {
    const r = await ctx.tools.list_holdings.execute({ accountId: resolver.accountId });
    if (!r.ok) return [];
    return r.data.holdings
      .filter((h) => h.holding.closedAt === null)
      .map((h) => ({ stockId: h.holding.stockId, avgCost: h.holding.avgCost }));
  }
  // formula / llm：读最新成员快照
  const snapshots = await ctx.repos.groupMember.currentMembers(group.id);
  return snapshots.map((s) => ({ stockId: s.stockId, avgCost: undefined }));
};

/** 单条规则评估（price-change / cost-threshold 同步分支）。 */
const evaluateSyncRule = (
  pool: StockPool,
  rule: Exclude<WatchRule, { kind: 'tactic' }>,
  members: readonly PoolMember[],
  quotes: ReadonlyMap<string, Quote>,
  prevCloses: ReadonlyMap<string, Money>,
  ctx: { clock: () => Date; logger: { warn: (m: string, meta?: Record<string, unknown>) => void } },
): WatchTrigger[] => {
  const out: WatchTrigger[] = [];
  const now = ctx.clock();

  if (rule.kind === 'price-change') {
    for (const m of members) {
      const q = quotes.get(m.stockId);
      if (q === undefined) continue;
      // v0.6.1：dailyBars 拉到的昨日/前日 close 优先；缺失 fallback 到 quote.open
      const prevClose = prevCloses.get(m.stockId) ?? q.open;
      if (!(prevClose > 0)) continue;
      const change = Math.abs(q.close - prevClose) / prevClose;
      if (change < rule.pct) continue;
      const trigger: WatchTrigger = {
        id: `wt-${pool.id}-${m.stockId}-${rule.kind}-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
        poolId: pool.id,
        stockId: m.stockId,
        ruleKind: rule.kind,
        direction: 'watch',
        reason: `日内变动 ${(change * 100).toFixed(2)}% ≥ ${(rule.pct * 100).toFixed(2)}%`,
        evidence: [`close=${q.close}`, `prevClose=${prevClose}`],
        quote: { close: q.close, ts: q.ts },
        notified: false,
        createdAt: now,
      };
      out.push(trigger);
    }
    return out;
  }

  if (rule.kind === 'cost-threshold') {
    for (const m of members) {
      const q = quotes.get(m.stockId);
      if (q === undefined || m.avgCost === undefined) continue;
      if (!(m.avgCost > 0)) continue;
      const change = (q.close - m.avgCost) / m.avgCost;
      let triggered = false;
      let reason = '';
      if (rule.stopLossPct !== undefined && change <= -rule.stopLossPct) {
        triggered = true;
        reason = `止损 现价 ${q.close} ≤ 成本 ${m.avgCost} × (1 − ${rule.stopLossPct})`;
      } else if (rule.takeProfitPct !== undefined && change >= rule.takeProfitPct) {
        triggered = true;
        reason = `止盈 现价 ${q.close} ≥ 成本 ${m.avgCost} × (1 + ${rule.takeProfitPct})`;
      }
      if (!triggered) continue;
      const trigger: WatchTrigger = {
        id: `wt-${pool.id}-${m.stockId}-${rule.kind}-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
        poolId: pool.id,
        stockId: m.stockId,
        ruleKind: rule.kind,
        direction: 'sell',
        reason,
        evidence: [
          `close=${q.close}`,
          `avgCost=${m.avgCost}`,
          `change=${(change * 100).toFixed(2)}%`,
        ],
        quote: { close: q.close, ts: q.ts },
        notified: false,
        createdAt: now,
      };
      out.push(trigger);
    }
    return out;
  }

  return out;
};

/** 异步规则：tactic（每次调 run_tactic 跑一轮评估）。 */
const evaluateTacticRule = async (
  pool: StockPool,
  rule: { kind: 'tactic'; tacticId: string; minScore: number },
  members: readonly PoolMember[],
  quotes: ReadonlyMap<string, Quote>,
  ctx: Parameters<typeof evaluateSyncRule>[3] extends infer _
    ? Parameters<typeof defineWorkflow>[0]['steps'][number] extends (
        prev: unknown,
        c: infer C2,
      ) => unknown
      ? C2
      : never
    : never,
): Promise<WatchTrigger[]> => {
  if (members.length === 0) return [];
  const r = await ctx.tools.run_tactic.execute({
    tacticId: rule.tacticId,
    scope: 'watchlist',
    stockIds: members.map((m) => m.stockId),
    persistSignals: false,
  });
  if (!r.ok) {
    ctx.logger.warn('[intraday-watch] run_tactic 失败', { tacticId: rule.tacticId });
    return [];
  }
  const out: WatchTrigger[] = [];
  const now = ctx.clock();
  for (const sig of r.data.signals) {
    if (sig.score < rule.minScore) continue;
    const direction: WatchTrigger['direction'] =
      sig.direction === 'bullish' ? 'buy' : sig.direction === 'bearish' ? 'sell' : 'watch';
    const q = quotes.get(sig.stockId);
    const close = q !== undefined && q.close > 0 ? q.close : (0 as Money);
    const ts = q !== undefined ? q.ts : now;
    const trigger: WatchTrigger = {
      id: `wt-${pool.id}-${sig.stockId}-tactic-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      poolId: pool.id,
      stockId: sig.stockId,
      ruleKind: 'tactic',
      direction,
      reason: `战法命中 score=${sig.score.toFixed(1)} ≥ ${rule.minScore}`,
      evidence: [...sig.evidence],
      quote: { close, ts },
      notified: false,
      createdAt: now,
    };
    out.push(trigger);
  }
  return out;
};

// ---------- steps ----------

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

/**
 * 「本进程今日已尝试过 daily 刷新」的内存 flag（YYYY-MM-DD，Asia/Shanghai）。
 * 长驻 watch 每 interval 跑一轮本 workflow，必须避免每轮重复触发 LLM / 全市场扫描；
 * --once 单轮天然只跑一次。失败也记 flag（失败组保留旧快照，stale 由 get_stock_group 感知）。
 */
let dailyGroupRefreshAttemptedFor: string | null = null;

/** 测试用：重置 daily 刷新 flag（vitest 同进程多 case 共享模块状态）。 */
export const resetDailyGroupRefreshFlagForTest = (): void => {
  dailyGroupRefreshAttemptedFor = null;
};

/**
 * step 0：daily 刷新检查（docs/stock-group-design.md §7）。
 * 今日尚未成功跑过 refresh-groups 且存在 daily 动态分组 → 先跑一轮（仅 stale 子集）。
 * 任何异常都不阻塞盯盘主链路（hot path 容错：warn 后继续）。
 */
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

    // 无论是否真有 stale / 刷新成败，今日都只尝试一次
    dailyGroupRefreshAttemptedFor = today;
    if (staleIds.length === 0) return input;

    ctx.logger.info('[intraday-watch] daily 动态分组刷新', { groupIds: staleIds });
    const r = await refreshGroupsWorkflow.run({ groupIds: staleIds }, ctx);
    if (!r.ok) {
      ctx.logger.warn('[intraday-watch] refresh-groups 失败（保留旧快照继续盯盘）', {
        error: JSON.stringify(r.error),
      });
    } else if (r.data.failed.length > 0) {
      ctx.logger.warn('[intraday-watch] 部分分组刷新失败（保留旧快照）', {
        failed: r.data.failed,
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
      : r.data.pools.filter((p) => input.poolIds?.includes(p.id));
  return { pools, input } satisfies LoadedState;
};

const stepSeedTacticSources: WorkflowStep = async (prev, ctx) => {
  const state = prev as LoadedState;
  if (!state.input.seedTacticSources) return state;
  // 池引用的 formula 分组：tacticId 去重 + 各取最大 lookbackDays，跑一次 run_tactic 灌 tactic_signals。
  // 成员本身读快照不依赖本步；灌库信号供 refresh-groups（阶段 B）/ 复盘用。
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
  for (const pool of state.pools) {
    const list = await resolveMembers(pool, ctx);
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
  } satisfies MembersState;
};

const stepBatchQuote: WorkflowStep = async (prev, ctx) => {
  const state = prev as MembersState;
  if (state.allStockIds.length === 0) {
    return { ...state, quotes: new Map<string, Quote>() } satisfies QuotesState;
  }
  const r = await ctx.tools.batch_quote.execute({ stockIds: [...state.allStockIds] });
  if (!r.ok) return r;
  const map = new Map<string, Quote>();
  for (const q of r.data.quotes) map.set(q.stockId, q);
  const now = ctx.clock();
  for (const id of r.data.unresolved) {
    if (!map.has(id)) {
      map.set(id, {
        stockId: id,
        ts: now,
        open: 0 as Money,
        high: 0 as Money,
        low: 0 as Money,
        close: 0 as Money,
        volume: 0,
        source: 'unresolved',
      });
    }
  }
  return { ...state, quotes: map } satisfies QuotesState;
};

/**
 * v0.6.1：从 dailyBar repo 拉每个 distinct stock 的"昨收"。
 *
 * 行为契约：
 * - 缺失（unseeded / repo throw / close <= 0）→ 不进 map，evaluate 阶段
 *   自然 fallback 到 quote.open（v0.6 兼容）
 * - 用 \`latestBefore(stockId, now, 1)\` 取 ≤ now 的最近 1 根；返回 Date[]
 *   长度为 0 或 1，皆视为缺失
 * - 跨池 distinct stockIds 已经在 \`state.allStockIds\` 里聚合好了（stepResolveMembers）
 *
 * 容错：repo throw 用 try/catch 兜住（hot path 上不应让 watch daemon crash）；
 * 失败时 \`prevCloses\` 缺该 stock，等价于 fallback。
 */
const stepLoadPrevCloses: WorkflowStep = async (prev, ctx) => {
  const state = prev as QuotesState;
  const now = ctx.clock();
  const prevCloses = new Map<string, Money>();
  await Promise.all(
    [...state.allStockIds].map(async (stockId) => {
      try {
        const bars = await ctx.repos.dailyBar.latestBefore(stockId, now, 1);
        const last = bars[bars.length - 1];
        if (last !== undefined && last.close > 0) {
          prevCloses.set(stockId, last.close);
        }
      } catch {
        // 静默：repo / IO 错误 → fallback 到 quote.open
      }
    }),
  );
  return { ...state, prevCloses } satisfies PrevClosesState;
};

const stepEvaluateRules: WorkflowStep = async (prev, ctx) => {
  const state = prev as PrevClosesState;
  const candidates: WatchTrigger[] = [];
  for (const pool of state.pools) {
    const members = state.members.get(pool.id) ?? [];
    for (const rule of pool.rules) {
      if (rule.kind === 'tactic') {
        const triggered = await evaluateTacticRule(pool, rule, members, state.quotes, ctx);
        for (const t of triggered) candidates.push(t);
      } else {
        const triggered = evaluateSyncRule(
          pool,
          rule,
          members,
          state.quotes,
          state.prevCloses,
          ctx,
        );
        for (const t of triggered) candidates.push(t);
      }
    }
  }
  return { ...state, candidates } satisfies EvaluatedState;
};

interface PersistedState {
  readonly triggers: readonly WatchTrigger[];
  readonly evaluatedPools: number;
  readonly evaluatedStocks: number;
  readonly suppressedByCooldown: number;
}

const stepApplyCooldownAndPersist: WorkflowStep = async (prev, ctx) => {
  const state = prev as EvaluatedState;
  const now = ctx.clock();
  const finalTriggers: WatchTrigger[] = [];
  let suppressedByCooldown = 0;
  for (const cand of state.candidates) {
    const pool = state.pools.find((p) => p.id === cand.poolId);
    let notified = false;
    if (state.input.notify && pool !== undefined) {
      const cd = new Date(now.getTime() - pool.cooldownMinutes * 60_000);
      const last = await ctx.repos.watchTrigger.lastForKey(
        { poolId: cand.poolId, stockId: cand.stockId, ruleKind: cand.ruleKind },
        cd,
      );
      notified = last === null;
      if (last !== null) suppressedByCooldown += 1;
    }
    const persisted: WatchTrigger = { ...cand, notified };
    assertWatchTriggerInvariants(persisted);
    await ctx.repos.watchTrigger.save(persisted);
    finalTriggers.push(persisted);
  }
  return {
    triggers: finalTriggers,
    evaluatedPools: state.pools.length,
    evaluatedStocks: state.allStockIds.length,
    suppressedByCooldown,
  } satisfies PersistedState;
};

const stepNotifyAndSummary: WorkflowStep = async (prev, ctx) => {
  const state = prev as PersistedState;
  const triggers = state.triggers;
  let notifiedCount = 0;
  const byPool = new Map<string, WatchTrigger[]>();
  for (const t of triggers) {
    if (!t.notified) continue;
    const arr = byPool.get(t.poolId) ?? [];
    arr.push(t);
    byPool.set(t.poolId, arr);
  }
  for (const [poolId, group] of byPool.entries()) {
    notifiedCount += group.length;
    const lines = group.map((t) => {
      const dir = t.direction === 'buy' ? '买' : t.direction === 'sell' ? '卖' : '观察';
      return `· [${dir}] ${t.stockId} @ ${t.quote.close.toFixed(2)} — ${t.reason}`;
    });
    const content = lines.join('\n');
    await ctx.tools.send_notification.execute({
      log: { title: `盘中提醒 池-${poolId} ${group.length} 条`, content, level: 'info' },
    });
  }
  // metrics: 0/0 占位（最终 summary 阶段不依赖 metrics，由 caller 从 output.triggers 推断）
  return IntradayWatchOutput.parse({
    triggers: triggers.map((t) => ({
      id: t.id,
      poolId: t.poolId,
      stockId: t.stockId,
      ruleKind: t.ruleKind,
      direction: t.direction,
      reason: t.reason,
      evidence: [...t.evidence],
      quoteClose: t.quote.close,
      notified: t.notified,
      createdAt: t.createdAt,
    })),
    evaluatedPools: state.evaluatedPools,
    evaluatedStocks: state.evaluatedStocks,
    notified: notifiedCount,
    suppressedByCooldown: state.suppressedByCooldown,
  });
};

// Re-export for callers (Stock used in test fixtures via @luoome/core re-export)
export type { Stock };

/**
 * intraday-watch workflow：单轮盯盘评估。
 *
 * 用法：CLI `luoome watch --once` 跑一轮；长驻进程每 interval 跑一轮。
 * 也可由 cron 触发：传 { poolIds: [...], notify: false, seedTacticSources: false }。
 */
export const intradayWatchWorkflow = defineWorkflow<
  z.infer<typeof IntradayWatchInput>,
  z.infer<typeof IntradayWatchOutput>
>({
  name: 'intraday-watch',
  description:
    '单轮盘中盯盘评估：池成员 → batch_quote → 规则评估 → cooldown 过滤 → 触发落库 → 通知',
  input: IntradayWatchInput,
  steps: [
    stepDailyGroupRefresh,
    stepLoadPools,
    stepSeedTacticSources,
    stepResolveMembers,
    stepBatchQuote,
    stepLoadPrevCloses,
    stepEvaluateRules,
    stepApplyCooldownAndPersist,
    stepNotifyAndSummary,
  ],
});

/**
 * 带持久化心跳的单轮入口。
 *
 * workflow 本身保持纯编排契约；CLI/Web 的实际运行入口调用本函数，使成功、失败、
 * 零触发三种情况都有 WatchRun 审计。record tool 失败只记日志，不覆盖原 workflow
 * 结果，避免可观测性故障反过来阻断盯盘。
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
          error: JSON.stringify(result.error),
        },
        ctx,
      );
  if (!terminal.ok) {
    ctx.logger.warn('[intraday-watch] 写入 terminal 心跳失败', { error: terminal.error });
  }
  return result;
};
