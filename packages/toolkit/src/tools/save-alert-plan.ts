import { AlertPlanSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { CreateAlertPlanInput, createAlertPlanTool, updateAlertPlanTool } from './alert-plan.js';

export const SaveAlertPlanInput = CreateAlertPlanInput.partial()
  .extend({ alertPlanId: z.string().min(1).optional() })
  .superRefine((input, ctx) => {
    if (input.alertPlanId === undefined) {
      for (const field of ['name', 'watchlistId', 'rules'] as const) {
        if (input[field] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `创建预警需要 ${field}（更新请提供 alertPlanId）`,
          });
        }
      }
      return;
    }
    if (Object.keys(input).filter((key) => key !== 'alertPlanId').length === 0) {
      ctx.addIssue({ code: 'custom', path: ['alertPlanId'], message: '至少提供一个更新字段' });
    }
  });

export const SaveAlertPlanOutput = z.object({ plan: AlertPlanSchema });

export const saveAlertPlanTool = defineTool({
  name: 'save_alert_plan',
  description:
    '创建或更新股票池盘中预警规则：带 alertPlanId 更新，否则创建（含触发条件、优先级、冷却与每日上限）。' +
    '只能写入用户本次明确说出的规则与阈值，不得自行追加涨跌幅、止盈止损或回撤规则，也不得因“更稳妙”扩大 Watchlist 范围；' +
    '需求不完整时先追问，不要用默认规则补齐。',
  sideEffect: 'write',
  input: SaveAlertPlanInput,
  output: SaveAlertPlanOutput,
  handler: async (input, ctx) => {
    const { alertPlanId, ...fields } = input;
    const result =
      alertPlanId === undefined
        ? await createAlertPlanTool.execute(fields as never, ctx)
        : await updateAlertPlanTool.execute({ ...fields, alertPlanId }, ctx);
    if (!result.ok) return result;
    return { plan: AlertPlanSchema.parse(result.data.plan) };
  },
});
