import { SyncStockUniverseInput, SyncStockUniverseOutput } from '@luoome/tools';
import type { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

export const SyncStockUniverseWorkflowInput = SyncStockUniverseInput;
export type SyncStockUniverseWorkflowInputT = z.input<typeof SyncStockUniverseWorkflowInput>;

export const syncStockUniverseWorkflow = defineWorkflow<
  z.output<typeof SyncStockUniverseInput>,
  z.output<typeof SyncStockUniverseOutput>
>({
  name: 'sync-stock-universe',
  description: '同步明确覆盖范围内的完整股票目录到本地数据库',
  input: SyncStockUniverseWorkflowInput,
  steps: [
    (prev, ctx) =>
      ctx.tools.sync_stock_universe.execute(
        prev as z.output<typeof SyncStockUniverseWorkflowInput>,
      ),
  ],
});

export { SyncStockUniverseOutput };
