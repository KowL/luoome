import { DeliveryStatusSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const SetReportDeliveryStatusInput = z.object({
  reportId: z.string().min(1),
  deliveryStatus: DeliveryStatusSchema,
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
    await ctx.repos.report.setDeliveryStatus(input.reportId, input.deliveryStatus);
    return input;
  },
});
