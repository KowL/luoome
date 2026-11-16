import type { ToolContributions } from '@luoome/toolkit';
import { collectMarketSnapshotTool } from './tools/market-snapshot-batch.js';
import { syncDailyBarsTool } from './tools/sync-daily-bars.js';
import { syncLimitUpBoardHistoryTool } from './tools/sync-limit-up-board-history.js';
import { syncMarketDumpTool } from './tools/sync-market-dump.js';
import { syncQuotesTool } from './tools/sync-quotes.js';
import { syncSectorCatalogTool } from './tools/sync-sector-catalog.js';
import { syncStockUniverseTool } from './tools/sync-stock-universe.js';

export const marketTasksToolContributions = {
  collect_market_snapshot: {
    execution: 'p2',
    owner: 'task.collect-market-snapshot',
    tool: collectMarketSnapshotTool,
    agent: true,
    dependencies: ['market:market-snapshot-envelope'],
  },
  sync_sector_catalog: {
    execution: 'p2',
    owner: 'task.sync-sector-catalog',
    tool: syncSectorCatalogTool,
    agent: true,
    dependencies: ['sectorCatalog'],
  },
  sync_daily_bars: {
    execution: 'p2',
    owner: 'task.daily-bars-sync',
    tool: syncDailyBarsTool,
    agent: false,
    dependencies: ['market:daily-bars'],
  },
  sync_limit_up_board_history: {
    execution: 'p2',
    owner: 'task.sync-limit-up-board-history',
    tool: syncLimitUpBoardHistoryTool,
    agent: false,
    dependencies: ['limitUp'],
  },
  sync_market_dump: {
    execution: 'p2',
    owner: 'task.sync-market-dump',
    tool: syncMarketDumpTool,
    agent: false,
    dependencies: ['marketDump'],
  },
  sync_quotes: {
    execution: 'p2',
    owner: 'task.sync-quotes',
    tool: syncQuotesTool,
    agent: false,
    dependencies: ['market:quote'],
  },
  sync_stock_universe: {
    execution: 'p2',
    owner: 'task.sync-stock-universe',
    tool: syncStockUniverseTool,
    agent: false,
    dependencies: ['stockUniverse'],
  },
} as const satisfies ToolContributions;
