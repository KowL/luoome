import type { ToolContributions } from '@luoome/toolkit';
import { snapshotAccountPerformanceTool } from './tools/portfolio-performance.js';

export const performanceTaskToolContributions = {
  snapshot_account_performance: {
    execution: 'p3',
    owner: 'task.snapshot-account-performance',
    tool: snapshotAccountPerformanceTool,
    agent: false,
  },
} as const satisfies ToolContributions;
