import type { StockGroup } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * refresh-groups workflow（分组化起，docs/stock-group-design.md §4；盘外执行）。
 *
 * 单轮刷新所有 enabled 动态分组（formula / llm），也可按 groupIds 指定子集：
 *   1. 加载 enabled 且 resolver ∈ {formula, llm} 的分组（有 groupIds 取交集）
 *   2. 逐组走 refresh_stock_group tool（与手动刷新同款逻辑，ARCHITECTURE §4.6
 *      workflow 只经 ctx.tools 编排；写快照由 tool 完成）：
 *      - formula → run_tactic(scope='all-stocks', persistSignals=true) 命中且
 *        score ≥ minScore（缺省 60）→ 新批次快照
 *      - llm → resolve_llm_group（LLM 产出 + 逐条存在性校验 + 截断）
 *      - 失败 / 空结果组：保留旧快照，计入 failed，绝不写空批
 *   3. 成员变化检测由 tool 返回（entered / exited），本 workflow 聚合
 *
 * 触发时机：`luoome watch` 每日首个交易轮次前自动跑一轮（intraday-watch step 0），
 * 也可手动 `luoome workflow run refresh-groups` 或 `luoome tools call refresh_stock_group`。
 */

export const RefreshGroupsInput = z.object({
  /** 仅刷新这些分组（id 列表）；缺省 = 全部 enabled 动态分组。 */
  groupIds: z.array(z.string().min(1)).optional(),
});

export type RefreshGroupsInputT = z.infer<typeof RefreshGroupsInput>;

export const RefreshGroupsOutput = z.object({
  /** 成功写入新批次的分组 id。 */
  refreshed: z.array(z.string()),
  /** 刷新失败 / 空结果（保留旧快照）的分组。 */
  failed: z.array(z.object({ groupId: z.string(), reason: z.string() })),
  /** 相对各组旧批新进的成员。 */
  entered: z.array(z.object({ groupId: z.string(), stockId: z.string() })),
  /** 相对各组旧批退出的成员。 */
  exited: z.array(z.object({ groupId: z.string(), stockId: z.string() })),
});

export type RefreshGroupsOutputT = z.infer<typeof RefreshGroupsOutput>;

interface LoadedState {
  readonly input: RefreshGroupsInputT;
  readonly groups: readonly StockGroup[];
}

const stepLoadGroups: WorkflowStep = async (prev, ctx) => {
  const input = prev as RefreshGroupsInputT;
  const all = await ctx.repos.stockGroup.list(true);
  const dynamic = all.filter((g) => g.resolver.kind === 'formula' || g.resolver.kind === 'llm');
  const groups =
    input.groupIds === undefined || input.groupIds.length === 0
      ? dynamic
      : dynamic.filter((g) => input.groupIds?.includes(g.id));
  if (input.groupIds !== undefined) {
    const found = new Set(groups.map((g) => g.id));
    for (const id of input.groupIds) {
      if (!found.has(id)) {
        ctx.logger.warn('[refresh-groups] 指定分组不存在或非 enabled 动态分组，跳过', {
          groupId: id,
        });
      }
    }
  }
  return { input, groups } satisfies LoadedState;
};

const stepRefreshAll: WorkflowStep = async (prev, ctx) => {
  const state = prev as LoadedState;
  const refreshed: string[] = [];
  const failed: Array<{ groupId: string; reason: string }> = [];
  const entered: Array<{ groupId: string; stockId: string }> = [];
  const exited: Array<{ groupId: string; stockId: string }> = [];

  for (const group of state.groups) {
    const r = await ctx.tools.refresh_stock_group.execute({ groupId: group.id });
    if (!r.ok) {
      failed.push({ groupId: group.id, reason: JSON.stringify(r.error) });
      continue;
    }
    if (!r.data.refreshed) {
      failed.push({
        groupId: group.id,
        reason: r.data.failureReason ?? '未知原因（保留旧快照）',
      });
      continue;
    }
    refreshed.push(group.id);
    for (const stockId of r.data.entered) entered.push({ groupId: group.id, stockId });
    for (const stockId of r.data.exited) exited.push({ groupId: group.id, stockId });
  }

  return RefreshGroupsOutput.parse({ refreshed, failed, entered, exited });
};

/**
 * refresh-groups workflow：盘外单轮刷新 enabled 动态分组（formula / llm）。
 *
 * 用法：CLI `luoome workflow run refresh-groups`（全量）或
 * `--input '{"groupIds":["grp-a"]}'`（子集）；intraday-watch 每日首轮前自动调用。
 */
export const refreshGroupsWorkflow = defineWorkflow<
  z.infer<typeof RefreshGroupsInput>,
  z.infer<typeof RefreshGroupsOutput>
>({
  name: 'refresh-groups',
  description:
    '盘外刷新 enabled 动态分组（formula→run_tactic / llm→resolve_llm_group），失败保留旧快照',
  input: RefreshGroupsInput,
  steps: [stepLoadGroups, stepRefreshAll],
});
