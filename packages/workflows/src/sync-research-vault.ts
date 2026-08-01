import { SyncResearchVaultInput, type SyncResearchVaultOutput } from '@luoome/tools';
import type { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

export const syncResearchVaultWorkflow = defineWorkflow<
  z.output<typeof SyncResearchVaultInput>,
  z.output<typeof SyncResearchVaultOutput>
>({
  name: 'sync-research-vault',
  description: '同步本地研究 Vault 索引',
  input: SyncResearchVaultInput,
  steps: [
    (input, ctx) =>
      ctx.tools.sync_research_vault.execute(input as z.output<typeof SyncResearchVaultInput>),
  ],
});
