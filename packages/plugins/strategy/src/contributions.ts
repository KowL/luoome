import type { ToolContributions } from '@luoome/toolkit';
import { runStrategyTool, trialStrategyTool } from './tools/run-strategy.js';
import { runStrategyBacktestTool } from './tools/run-strategy-backtest.js';
import {
  createStrictStrategyBacktestTool,
  executeStrictStrategyBacktestTool,
  getStrictStrategyBacktestTool,
  listStrictStrategyBacktestsTool,
} from './tools/strategy-backtest.js';
import {
  compareStrategyDefinitionsTool,
  proposeStrategyVersionDraftTool,
  trialStrategyVersionTool,
} from './tools/strategy-definition.js';
import { generateStrategyInsightTool } from './tools/strategy-insight.js';
import { generateStrategyVersionProposalTool } from './tools/strategy-proposal.js';

export const strategyToolContributions = {
  run_strategy: {
    modes: {
      scan: { data: ['live:strategy-rule-inputs'], conditional: ['live:limit-up-ladder'] },
      scheduled: {
        data: ['local:daily-bars', 'local:stock-universe'],
        conditional: ['live:limit-up-ladder'],
      },
      replay: {
        data: ['local:daily-bars', 'local:stock-universe'],
        conditional: ['archive:limit-up-ladder', 'archive:limit-up-board'],
      },
    },
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: runStrategyTool,
    agent: true,
    dependencies: [],
  },
  run_strategy_backtest: {
    owner: 'business.strategy',
    tool: runStrategyBacktestTool,
    agent: true,
    dependencies: [],
  },
  compare_strategy_definitions: {
    owner: 'shared-query',
    tool: compareStrategyDefinitionsTool,
    agent: false,
  },
  create_strict_strategy_backtest: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: createStrictStrategyBacktestTool,
    agent: false,
  },
  execute_strict_strategy_backtest: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: executeStrictStrategyBacktestTool,
    agent: false,
  },
  generate_strategy_insight: {
    execution: 'p1',
    optionalPlugins: ['strategy.ai-insight'],
    owner: 'business.strategy-insight',
    tool: generateStrategyInsightTool,
    agent: false,
  },
  generate_strategy_version_proposal: {
    owner: 'business.strategy',
    tool: generateStrategyVersionProposalTool,
    agent: false,
  },
  get_strict_strategy_backtest: {
    owner: 'shared-query',
    tool: getStrictStrategyBacktestTool,
    agent: false,
  },
  list_strict_strategy_backtests: {
    owner: 'shared-query',
    tool: listStrictStrategyBacktestsTool,
    agent: false,
  },
  propose_strategy_version_draft: {
    owner: 'business.strategy',
    tool: proposeStrategyVersionDraftTool,
    agent: false,
  },
  trial_strategy: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: trialStrategyTool,
    agent: false,
  },
  trial_strategy_version: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: trialStrategyVersionTool,
    agent: false,
  },
} as const satisfies ToolContributions;
