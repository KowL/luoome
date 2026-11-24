import type { ToolContributions } from '@luoome/toolkit';
import { analyzePositionTool } from './tools/analyze-position.js';
import { analyzeStockTool } from './tools/analyze-stock.js';
import { analyzeStrategyCandidateTool } from './tools/analyze-strategy-candidate.js';
import { generateStockBriefsTool } from './tools/generate-stock-briefs.js';
import { marketOutlookTool } from './tools/market-outlook.js';

export const analysisToolContributions = {
  generate_stock_briefs: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: generateStockBriefsTool,
    agent: false,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  analyze_stock: {
    execution: 'p3',
    modes: {
      stock: { data: ['llm', 'market:quote', 'market:daily-bars'] },
      market: { data: ['market-outlook:inputs'] },
      'strategy-candidate': { data: ['strategy-candidate:inputs'] },
    },
    owner: 'business.analysis',
    tool: analyzeStockTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  analyze_position: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: analyzePositionTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  analyze_strategy_candidate: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: analyzeStrategyCandidateTool,
    agent: false,
    dependencies: ['llm'],
  },
  market_outlook: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: marketOutlookTool,
    agent: false,
    dependencies: ['llm', 'market:quote'],
  },
} as const satisfies ToolContributions;
