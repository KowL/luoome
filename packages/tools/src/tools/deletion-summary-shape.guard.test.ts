import { describe, expect, it } from 'vitest';

import { AlertPlanDeletionSummarySchema, DeleteAlertPlanOutput } from './alert-plan.js';
import { ChatSessionDeletionSummarySchema, deleteChatSessionTool } from './chat-session.js';
import { DeleteAdviceOutput } from './delete-advice.js';
import { DeleteReportOutput, ReportDeletionSummarySchema } from './delete-report.js';
import { DeleteStockEventOutput, StockEventDeletionSummarySchema } from './delete-stock-event.js';
import { DeleteStrategyOutput, StrategyDeletionSummarySchema } from './strategy-lifecycle.js';

/**
 * 守卫（决策 3-B）：6 个删除摘要**形状因对象而异**，不是同一个通用形状。
 *
 * ## 这条守卫守的是什么
 *
 * Codex 明确否决「统一套用完整 `XxxSchema.optional()`」，理由是不同对象该保留的东西不同：
 * 会话绝不能带标题（PII），策略绝不能展开级联（体积）。
 *
 * 后人为了「省事」把这些合并成一个通用 `DeleteSummary` 时，**功能测试很可能全绿**
 * ——因为字段还在，只是名字统一了。本守卫用「字段集合必须互不相同」把这条路堵死：
 * 一旦合并，`delete_chat_session` 就不再独有 `messageCount`、`delete_strategy`
 * 就不再独有 `notCounted`，断言立刻红。
 *
 * 守的不是「防止重名」，而是**防止定制摘要退化成通用形状**。
 */
const shapes: ReadonlyArray<{ name: string; keys: readonly string[] }> = [
  {
    name: 'delete_strategy',
    keys: Object.keys(StrategyDeletionSummarySchema.shape).sort(),
  },
  {
    name: 'delete_chat_session',
    keys: Object.keys(ChatSessionDeletionSummarySchema.shape).sort(),
  },
  {
    name: 'delete_alert_plan',
    keys: Object.keys(AlertPlanDeletionSummarySchema.shape).sort(),
  },
  {
    name: 'delete_report',
    keys: Object.keys(ReportDeletionSummarySchema.shape).sort(),
  },
  {
    name: 'delete_stock_event',
    keys: Object.keys(StockEventDeletionSummarySchema.shape).sort(),
  },
];

describe('6 个删除摘要形状守卫（决策 3-B）', () => {
  it('每个摘要形状都非空', () => {
    for (const shape of shapes) expect(shape.keys.length, shape.name).toBeGreaterThan(0);
  });

  it('**没有任何两个摘要的字段集合完全相同**（合并成通用形状会立刻红）', () => {
    const seen = new Map<string, string>();
    for (const shape of shapes) {
      const signature = shape.keys.join(',');
      const previous = seen.get(signature);
      expect(
        previous,
        `${shape.name} 与 ${previous ?? ''} 的字段集合完全相同——摘要被合并成通用形状了`,
      ).toBeUndefined();
      seen.set(signature, shape.name);
    }
  });

  it('各对象独有字段仍在（定制化的证据）', () => {
    const byName = new Map(shapes.map((shape) => [shape.name, shape.keys]));
    // 会话独有：消息计数（PII 边界下唯一可给的数量信息）
    expect(byName.get('delete_chat_session')).toContain('messageCount');
    // 策略独有：拿不到计数的类别声明
    expect(byName.get('delete_strategy')).toContain('notCounted');
    // 告警方案独有：规则条数（不展开 rules）
    expect(byName.get('delete_alert_plan')).toContain('ruleCount');
    // 报告独有：体积指标（口径写明是字符数，不叫 bytes）
    expect(byName.get('delete_report')).toContain('serializedChars');
    expect(byName.get('delete_report')).not.toContain('bytes');
    // 会话**不许**有标题字段（PII）
    expect(byName.get('delete_chat_session')).not.toContain('title');
  });

  it('6 个工具的 summary 都是**必填**，不是 optional（可选等于允许退化成布尔值）', () => {
    const outputs = [
      DeleteStrategyOutput,
      DeleteAlertPlanOutput,
      DeleteReportOutput,
      DeleteStockEventOutput,
      DeleteAdviceOutput,
    ];
    for (const output of outputs) {
      const shape = output.shape as Record<string, unknown>;
      if (!('summary' in shape)) continue;
      // 必填字段的 optional 标记为 undefined；`.optional()` 会是 true。
      const field = shape.summary as { isOptional?: () => boolean };
      expect(field.isOptional?.() ?? false).toBe(false);
    }
    // 会话工具的输出在 defineTool 里内联，单独从工具定义取。
    const chatOutput = deleteChatSessionTool.outputSchema as {
      shape?: Record<string, { isOptional?: () => boolean }>;
    };
    expect(chatOutput.shape?.summary?.isOptional?.() ?? false).toBe(false);
  });
});
