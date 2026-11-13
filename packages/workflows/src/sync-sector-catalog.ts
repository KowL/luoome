import { SyncSectorCatalogInput, SyncSectorCatalogOutput } from '@luoome/tools';
import type { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

export const SyncSectorCatalogWorkflowInput = SyncSectorCatalogInput;
export type SyncSectorCatalogWorkflowInputT = z.input<typeof SyncSectorCatalogWorkflowInput>;

/** 盘前同步行业与概念目录及成分；Web / CLI 都只能经 tool 触发外部访问。 */
export const syncSectorCatalogWorkflow = defineWorkflow<
  z.output<typeof SyncSectorCatalogInput>,
  z.output<typeof SyncSectorCatalogOutput>
>({
  name: 'sync-sector-catalog',
  description: '盘前同步扶摇行业与概念目录及当前成分（多对多、可追溯）',
  input: SyncSectorCatalogWorkflowInput,
  steps: [
    (prev, ctx) =>
      ctx.tools.sync_sector_catalog.execute(
        prev as z.output<typeof SyncSectorCatalogWorkflowInput>,
      ),
  ],
});

export { SyncSectorCatalogOutput };
