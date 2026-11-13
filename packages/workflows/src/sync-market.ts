import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';
import { SyncMarketDumpInput, syncMarketDumpOperation } from './sync-market-dump.js';
import { SyncQuotesInput, syncQuotesOperation } from './sync-quotes.js';
import {
  SyncStockUniverseWorkflowInput,
  syncStockUniverseOperation,
} from './sync-stock-universe.js';

/**
 * 行情同步入口：实时报价 / 股票目录 / 全市场 dump。
 *
 * 三条管线保留各自的 tool 调用与错误语义，合并只减少手动入口。
 */
export const SyncMarketWorkflowInput = z.discriminatedUnion('target', [
  SyncQuotesInput.extend({ target: z.literal('quotes') }),
  SyncStockUniverseWorkflowInput.extend({ target: z.literal('universe') }),
  SyncMarketDumpInput.extend({ target: z.literal('dump') }),
]);

export type SyncMarketWorkflowInputT = z.infer<typeof SyncMarketWorkflowInput>;

export const syncMarketWorkflow = defineWorkflow<SyncMarketWorkflowInputT, unknown>({
  name: 'sync-market',
  description: '行情同步入口（target=quotes|universe|dump）：实时报价、股票目录或全市场 dump',
  input: SyncMarketWorkflowInput,
  steps: [
    (prev, ctx) => {
      const { target, ...rest } = prev as SyncMarketWorkflowInputT;
      switch (target) {
        case 'quotes':
          return syncQuotesOperation.run(rest, ctx);
        case 'universe':
          return syncStockUniverseOperation.run(rest, ctx);
        case 'dump':
          return syncMarketDumpOperation.run(rest, ctx);
      }
    },
  ],
});
