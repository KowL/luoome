import { defineWorkflow } from './define-workflow.js';
import { SyncResearchVaultInput, SyncResearchVaultOutput } from '@luoome/tools';

export const syncResearchVaultWorkflow = defineWorkflow({
  name: 'sync-research-vault',
  description: '同步本地研究 Vault 索引',
  input: SyncResearchVaultInput,
  output: SyncResearchVaultOutput,
  steps: [async (input, ctx) => ctx.tools.sync_research_vault.execute(input)],
});
