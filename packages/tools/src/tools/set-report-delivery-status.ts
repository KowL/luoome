import { DeliveryStatusSchema } from '@luoome/core';
import { z } from 'zod';

import {
  defineTool,
  errInvalidInput,
  errLeaseLostBeforeCommit,
  errNotFound,
} from '../define-tool.js';

export const SetReportDeliveryStatusInput = z.object({
  reportId: z.string().min(1),
  deliveryStatus: DeliveryStatusSchema,
  attemptId: z.string().min(1).optional(),
});

export const SetReportDeliveryStatusOutput = z.object({
  reportId: z.string(),
  deliveryStatus: DeliveryStatusSchema,
});

export const setReportDeliveryStatusTool = defineTool({
  name: 'set_report_delivery_status',
  description: '更新报告送达状态，并校验状态迁移',
  sideEffect: 'write',
  input: SetReportDeliveryStatusInput,
  output: SetReportDeliveryStatusOutput,
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.reportId);
    if (report === null) return errNotFound('Report', input.reportId);
    if (input.attemptId !== undefined) {
      const status = input.deliveryStatus;
      if (status !== 'sent' && status !== 'fallback-log' && status !== 'failed') {
        return errInvalidInput('报告投递领取只能结束为成功、降级或失败');
      }
      const finished = await ctx.repos.report.finishDelivery({
        id: input.reportId,
        attemptId: input.attemptId,
        status,
        now: ctx.clock(),
      });
      if (!finished) return errLeaseLostBeforeCommit('报告投递领取已失效');
      return input;
    }
    await ctx.repos.report.setDeliveryStatus(input.reportId, input.deliveryStatus);
    return input;
  },
});
