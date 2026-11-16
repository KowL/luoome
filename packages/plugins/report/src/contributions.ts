import type { ToolContributions } from '@luoome/toolkit';
import { saveReportTool } from './tools/save-report.js';
import { setReportDeliveryStatusTool } from './tools/set-report-delivery-status.js';

export const reportToolContributions = {
  save_report: {
    execution: 'p3',
    owner: 'business.report',
    optionalPlugins: ['business.notification'],
    tool: saveReportTool,
    agent: false,
  },
  set_report_delivery_status: {
    execution: 'p3',
    owner: 'business.report',
    tool: setReportDeliveryStatusTool,
    agent: false,
  },
} as const satisfies ToolContributions;
