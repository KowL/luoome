import type { GroupMemberSnapshot, StockGroup, ToolContext, ToolResult } from '@luoome/core';

import { errNotFound } from '../define-tool.js';
import { resolveLlmGroupTool } from '../tools/resolve-llm-group.js';
import { runTacticTool } from '../tools/run-tactic.js';

/**
 * 分组共享逻辑（docs/stock-group-design.md §4/§6；阶段 B）。
 *
 * 供以下消费方复用：
 * - get_stock_group（stale 判定）
 * - create / update_stock_group（resolver 引用校验）
 * - refresh_stock_group tool 与 refresh-groups workflow（单组刷新，同款逻辑）
 */

/** Asia/Shanghai 时区偏移（+8h，无夏令时）；与 packages/cli/src/holidays.ts 同口径。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把 Date 转成 Asia/Shanghai 当日的 YYYY-MM-DD 字符串（不依赖 process.env.TZ）。 */
export const dateInShanghai = (date: Date): string => {
  const d = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** 动态 resolver（formula / llm）才参与刷新与 stale 判定。 */
export const isDynamicResolver = (group: StockGroup): boolean =>
  group.resolver.kind === 'formula' || group.resolver.kind === 'llm';

/**
 * stale 判定（纯计算，不引入新存储；spec §6「可感知」）：
 * refreshPolicy=daily 的动态分组，且（从未刷新成功 或 最新批次 createdAt 的 Shanghai 日期 < 今日）。
 */
export const isGroupStale = (
  group: StockGroup,
  latestRefreshAt: Date | null,
  now: Date,
): boolean => {
  if (group.refreshPolicy !== 'daily') return false;
  if (!isDynamicResolver(group)) return false;
  if (latestRefreshAt === null) return true;
  return dateInShanghai(latestRefreshAt) < dateInShanghai(now);
};

/**
 * resolver 跨实体引用校验（create / update_stock_group 共用）：
 * - formula.tacticId → repos.tactic.findById
 * - holdings.accountId → repos.account.findById
 * - manual.stockIds 逐条 → repos.stock.findById（对齐 create_stock_pool 既有做法）
 * - llm 无引用校验（prompt 自由文本）
 *
 * 校验通过返回 null；失败返回对应 ToolResult（not_found）。
 */
export const validateGroupResolverRefs = async (
  resolver: StockGroup['resolver'],
  ctx: ToolContext,
): Promise<ToolResult<never> | null> => {
  if (resolver.kind === 'formula') {
    const t = await ctx.repos.tactic.findById(resolver.tacticId);
    if (t === null) return errNotFound('Tactic', resolver.tacticId);
    return null;
  }
  if (resolver.kind === 'holdings') {
    const a = await ctx.repos.account.findById(resolver.accountId);
    if (a === null) return errNotFound('Account', resolver.accountId);
    return null;
  }
  if (resolver.kind === 'manual') {
    for (const stockId of resolver.stockIds) {
      const s = await ctx.repos.stock.findById(stockId);
      if (s === null) return errNotFound('Stock', stockId);
    }
    return null;
  }
  return null;
};

/** 单组刷新结果（refresh_stock_group tool 与 refresh-groups workflow 共用）。 */
export interface GroupRefreshOutcome {
  /** true = 写了新批次；false = 保留旧快照（原因见 failureReason）。 */
  readonly refreshed: boolean;
  /** 失败 / 跳过原因（refreshed=false 时必填）。 */
  readonly failureReason?: string;
  /** 新批次 refreshId；未写批次为 null。 */
  readonly refreshId: string | null;
  /** 刷新后当前成员数（未写批次时为旧批成员数）。 */
  readonly memberCount: number;
  /** 相对旧批新进的 stockId（按新批顺序）。 */
  readonly entered: readonly string[];
  /** 相对旧批退出的 stockId（按旧批 stockId 升序）。 */
  readonly exited: readonly string[];
}

const failure = (failureReason: string, oldMemberCount: number): GroupRefreshOutcome => ({
  refreshed: false,
  failureReason,
  refreshId: null,
  memberCount: oldMemberCount,
  entered: [],
  exited: [],
});

/**
 * 单组刷新（spec §4「生产者 + 快照」）：
 * - formula → run_tactic(scope='all-stocks', persistSignals=true, lookbackDays)，
 *   命中且 score ≥ minScore（缺省 60）→ 成员，reason=`战法 <id> 命中，score=<n>`
 * - llm → resolve_llm_group（LLM 产出 + 逐条存在性校验 + 截断）
 * - 成功且非空：写新批次（同一 refreshId=uuid）；失败 / 空结果：保留旧快照，绝不写空批
 * - 成员变化检测：对比新旧批次 stockId 集合 → entered / exited
 */
export const refreshGroupMembers = async (
  group: StockGroup,
  ctx: ToolContext,
): Promise<GroupRefreshOutcome> => {
  const resolver = group.resolver;
  const now = ctx.clock();
  const oldMembers = await ctx.repos.groupMember.currentMembers(group.id);
  const oldIds = oldMembers.map((m) => m.stockId);

  let resolved: readonly { stockId: string; reason: string }[];
  if (resolver.kind === 'formula') {
    const r = await runTacticTool.execute(
      {
        tacticId: resolver.tacticId,
        scope: 'all-stocks',
        lookbackDays: resolver.lookbackDays,
        persistSignals: true,
      },
      ctx,
    );
    if (!r.ok) {
      return failure(
        `run_tactic(${resolver.tacticId}) 失败: ${JSON.stringify(r.error)}`,
        oldIds.length,
      );
    }
    const minScore = resolver.minScore ?? 60;
    resolved = r.data.signals
      .filter((s) => s.score >= minScore)
      .map((s) => ({
        stockId: s.stockId,
        reason: `战法 ${resolver.tacticId} 命中，score=${s.score.toFixed(1)}`,
      }));
  } else if (resolver.kind === 'llm') {
    const r = await resolveLlmGroupTool.execute(
      {
        prompt: resolver.prompt,
        maxMembers: resolver.maxMembers,
        ...(resolver.model !== undefined ? { model: resolver.model } : {}),
      },
      ctx,
    );
    if (!r.ok) {
      return failure(`resolve_llm_group 失败: ${JSON.stringify(r.error)}`, oldIds.length);
    }
    resolved = r.data.members;
  } else {
    return failure(`resolver kind=${resolver.kind} 无刷新动作`, oldIds.length);
  }

  // 去重（同一 stockId 保留第一条 reason）
  const seen = new Set<string>();
  const members: Array<{ stockId: string; reason: string }> = [];
  for (const m of resolved) {
    if (seen.has(m.stockId)) continue;
    seen.add(m.stockId);
    members.push(m);
  }

  // 空结果不写空批（防上游抖动 / LLM 输出全被丢弃时清空分组；spec §4「绝不清空」）
  if (members.length === 0) {
    ctx.logger.warn('[refresh-group] 解析结果为空，保留旧快照（不写空批）', { groupId: group.id });
    return failure('解析结果为空，未写空批（保留旧快照）', oldIds.length);
  }

  const refreshId = globalThis.crypto.randomUUID();
  const snapshots: GroupMemberSnapshot[] = members.map((m) => ({
    id: globalThis.crypto.randomUUID(),
    groupId: group.id,
    stockId: m.stockId,
    refreshId,
    reason: m.reason.slice(0, 500),
    createdAt: now,
  }));
  await ctx.repos.groupMember.saveBatch(snapshots);

  const oldSet = new Set(oldIds);
  const newSet = new Set(members.map((m) => m.stockId));
  const entered = members.map((m) => m.stockId).filter((id) => !oldSet.has(id));
  const exited = oldIds.filter((id) => !newSet.has(id));
  return {
    refreshed: true,
    refreshId,
    memberCount: members.length,
    entered,
    exited,
  };
};
