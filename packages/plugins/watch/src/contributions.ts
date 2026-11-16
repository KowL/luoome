import type { ToolContributions } from '@luoome/toolkit';
import { saveWatchTriggerTool } from './tools/save-watch-trigger.js';
import {
  beginWatchDeliveryTool,
  commitWatchEvaluationTool,
  saveWatchRuleStatesTool,
  setWatchTriggerDeliveryStatusTool,
} from './tools/workflow-operations.js';

export const watchToolContributions = {
  begin_watch_delivery: {
    optionalPlugins: ['business.notification'],
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: beginWatchDeliveryTool,
    agent: false,
  },
  commit_watch_evaluation: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: commitWatchEvaluationTool,
    agent: false,
  },
  save_watch_rule_states: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: saveWatchRuleStatesTool,
    agent: false,
  },
  save_watch_trigger: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: saveWatchTriggerTool,
    agent: false,
  },
  set_watch_trigger_delivery_status: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: setWatchTriggerDeliveryStatusTool,
    agent: false,
  },
} as const satisfies ToolContributions;
