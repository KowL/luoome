import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

/**
 * sync-quotes workflow（v0.2 起，plan §3.5）。
 *
 * 流程：syncQuotesTool.execute → 报告条数 + 时间戳 + 命中的 stockId 列表。
 * Workflow 存在意义：
 * 1. CLI / TUI 提供「一次性同步」入口，不必手动调 tool；
 * 2. 给后续 v0.3 接 send_notification（同步完成后推送高信心度建议）留挂载点。
 *
 * input.accountId 缺省走 ctx.user.defaultAccountId；走 tool 层后转译。
 */
export const SyncQuotesInput = z.object({
  accountId: z.uuid().optional(),
});

export type SyncQuotesInputT = z.infer<typeof SyncQuotesInput>;

export const SyncQuotesOutput = z.object({
  /** 同步成功的 quote 条数。 */
  syncedCount: z.number().int().nonnegative(),
  /** 请求同步的 stockId 数（去重后）。 */
  totalRequested: z.number().int().nonnegative(),
  /** 同步完成的 ISO 时间戳（UTC），便于审计 + 日报统计。 */
  syncedAt: z.iso.datetime(),
});

export type SyncQuotesOutputT = z.infer<typeof SyncQuotesOutput>;

export const syncQuotesWorkflow = defineWorkflow<SyncQuotesInputT, SyncQuotesOutputT>({
  name: 'sync-quotes',
  description: '同步账户下所有活跃持仓的实时行情（写 quote_snapshot），返回条数与时间戳',
  input: SyncQuotesInput,
  steps: [
    // 1) 调 syncQuotesTool；accountId 缺省走 ctx.user.defaultAccountId
    (prev, ctx) => {
      const input = prev as SyncQuotesInputT;
      return ctx.tools.sync_quotes.execute(
        input.accountId === undefined ? {} : { accountId: input.accountId },
      );
    },
    // 2) 包一层 summary + ISO 时间戳
    (prev) => {
      const data = prev as { synced: readonly unknown[]; totalRequested: number };
      return {
        syncedCount: data.synced.length,
        totalRequested: data.totalRequested,
        syncedAt: new Date().toISOString(),
      };
    },
  ],
});
