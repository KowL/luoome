import {
  assertWatchTriggerInvariants,
  type Money,
  type Quote,
  type Stock,
  type StockPool,
  type TacticPoolSource,
  type WatchRule,
  type WatchTrigger,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * intraday-watch workflow（v0.6 起，docs/intraday-watch-design.md §6）。
 *
 * 单轮盯盘评估（无状态）：
 *   1. 加载 enabled 池
 *   2. seed：source.kind='tactic' 池的 tacticId 去重，每个跑一次 run_tactic(persistSignals=true) 灌 tactic_signals
 *   3. 逐池解析成员 + 取 avgCost（holdings 池）：holdings / manual / tactic（取历史 signals distinct stockId）
 *   4. 跨池去重聚合 stockIds → batch_quote
 *   5. 逐池逐规则评估 → 候选触发
 *   6. cooldown 过滤：lastForKey(now − cooldownMinutes) 存在则 notified=false
 *   7. 所有 fire 的触发都 save_watch_trigger 落库（含 notified=false 的）
 *   8. notify=true 且有 notified=true → 按池切片 send_notification（log channel 兜底）
 *
 * 实现简化（v0.6）：
 * - price-change 规则：使用 quote.open 作为 prevClose 占位（mock 行情固定；真实场景接入 dailyBars 后取上一交易日 close）
 * - cost-threshold 规则：v0.6 不评估（需要 holding.avgCost，holdings 池的 members 已带 avgCost，但 v0.6 暂跳过；v0.6.1 改进）
 * - tactic 规则：调用 run_tactic(scope=watchlist, persistSignals=false)，score ≥ minScore 触发
 */

export const IntradayWatchInput = z.object({
  /** 仅评估这些池（id 列表）；缺省 = 全部 enabled。 */
  poolIds: z.array(z.string().min(1)).optional(),
  /** 是否推送通知；默认 true。--no-notify 时 CLI 传 false。 */
  notify: z.boolean().default(true),
  /** 是否对 source.kind='tactic' 的池跑启动 seed；CLI watch 启动时 true，单轮 --once 测试时 false。 */
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

interface EvaluatedState extends QuotesState {
  readonly candidates: readonly WatchTrigger[];
}

// ---------- helpers ----------

/**
 * 解析单个池的成员。
 * - holdings: 调 list_holdings → 取活跃持仓 stockIds + avgCost
 * - manual: 原样（avgCost undefined）
 * - tactic: 调 tactic_signals_by_tactic(since = now - lookbackDays) → distinct stockIds
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
  const source = pool.source;
  if (source.kind === 'manual') {
    return source.stockIds.map((stockId) => ({ stockId, avgCost: undefined }));
  }
  if (source.kind === 'holdings') {
    const r = await ctx.tools.list_holdings.execute({ accountId: source.accountId });
    if (!r.ok) return [];
    return r.data.holdings
      .filter((h) => h.holding.closedAt === null)
      .map((h) => ({ stockId: h.holding.stockId, avgCost: h.holding.avgCost }));
  }
  // tactic
  const since = new Date(ctx.clock().getTime() - source.lookbackDays * 86_400_000);
  const r = await ctx.tools.tactic_signals_by_tactic.execute({
    tacticId: source.tacticId,
    since,
    limit: 500,
  });
  if (!r.ok) return [];
  const ids = new Set<string>();
  for (const s of r.data.signals) ids.add(s.stockId);
  return [...ids].map((stockId) => ({ stockId, avgCost: undefined }));
};

/** 单条规则评估（price-change / cost-threshold 同步分支）。 */
const evaluateSyncRule = (
  pool: StockPool,
  rule: Exclude<WatchRule, { kind: 'tactic' }>,
  members: readonly PoolMember[],
  quotes: ReadonlyMap<string, Quote>,
  ctx: { clock: () => Date; logger: { warn: (m: string, meta?: Record<string, unknown>) => void } },
): WatchTrigger[] => {
  const out: WatchTrigger[] = [];
  const now = ctx.clock();

  if (rule.kind === 'price-change') {
    for (const m of members) {
      const q = quotes.get(m.stockId);
      if (q === undefined) continue;
      const prevClose = q.open; // v0.6 简化：用 open 当昨收
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
        evidence: [`close=${q.close}`, `prevClose(open)=${prevClose}`],
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
  const tacticIds = new Set<string>();
  for (const p of state.pools) {
    if (p.source.kind === 'tactic') tacticIds.add(p.source.tacticId);
  }
  for (const tid of tacticIds) {
    let maxLookback = 30;
    for (const p of state.pools) {
      if (p.source.kind === 'tactic' && p.source.tacticId === tid) {
        const ts = p.source as TacticPoolSource;
        if (ts.lookbackDays > maxLookback) maxLookback = ts.lookbackDays;
      }
    }
    const r = await ctx.tools.run_tactic.execute({
      tacticId: tid,
      scope: 'all-stocks',
      lookbackDays: maxLookback,
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
        source: 'mock-unresolved',
      });
    }
  }
  return { ...state, quotes: map } satisfies QuotesState;
};

const stepEvaluateRules: WorkflowStep = async (prev, ctx) => {
  const state = prev as QuotesState;
  const candidates: WatchTrigger[] = [];
  for (const pool of state.pools) {
    const members = state.members.get(pool.id) ?? [];
    for (const rule of pool.rules) {
      if (rule.kind === 'tactic') {
        const triggered = await evaluateTacticRule(pool, rule, members, state.quotes, ctx);
        for (const t of triggered) candidates.push(t);
      } else {
        const triggered = evaluateSyncRule(pool, rule, members, state.quotes, ctx);
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
}

const stepApplyCooldownAndPersist: WorkflowStep = async (prev, ctx) => {
  const state = prev as EvaluatedState;
  const now = ctx.clock();
  const finalTriggers: WatchTrigger[] = [];
  for (const cand of state.candidates) {
    const pool = state.pools.find((p) => p.id === cand.poolId);
    let notified = true;
    if (pool !== undefined) {
      const cd = new Date(now.getTime() - pool.cooldownMinutes * 60_000);
      const last = await ctx.repos.watchTrigger.lastForKey(
        { poolId: cand.poolId, stockId: cand.stockId, ruleKind: cand.ruleKind },
        cd,
      );
      notified = last === null;
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
    suppressedByCooldown: triggers.filter((t) => !t.notified).length,
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
    stepLoadPools,
    stepSeedTacticSources,
    stepResolveMembers,
    stepBatchQuote,
    stepEvaluateRules,
    stepApplyCooldownAndPersist,
    stepNotifyAndSummary,
  ],
});
