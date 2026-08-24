import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

export const GetResearchVaultRemoteSyncStatusInput = z.object({});
export const GetResearchVaultRemoteSyncStatusOutput = z.object({
  configured: z.boolean(),
  provider: z.literal('git').optional(),
});

export const getResearchVaultRemoteSyncStatusTool = defineTool({
  name: 'get_research_vault_remote_sync_status',
  description: '查看 Research Vault 可选远端同步是否已显式启用（不返回远端或凭证）',
  sideEffect: 'read',
  input: GetResearchVaultRemoteSyncStatusInput,
  output: GetResearchVaultRemoteSyncStatusOutput,
  handler: (_input, ctx) => ({
    configured: ctx.researchVaultGitSync !== undefined,
    ...(ctx.researchVaultGitSync === undefined ? {} : { provider: 'git' as const }),
  }),
});

export const PullResearchVaultGitInput = z.object({
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});
export const PullResearchVaultGitOutput = z.object({
  provider: z.literal('git'),
  status: z.enum(['updated', 'up-to-date']),
  backupId: z.string().min(1).optional(),
});

/** Workflow-only：Web/MCP 不直接暴露，确保远端更新后必经既有本地索引流程。 */
export const pullResearchVaultGitTool = defineTool({
  name: 'pull_research_vault_git',
  description: 'workflow-only：安全 fast-forward Research Vault Git 工作树',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: PullResearchVaultGitInput,
  output: PullResearchVaultGitOutput,
  handler: async (input, ctx) => {
    if (ctx.researchVaultGitSync === undefined) {
      return {
        ok: false as const,
        error: {
          kind: 'permission_denied' as const,
          required: 'LUOOME_RESEARCH_REMOTE_SYNC=git',
        },
      };
    }
    const result = await ctx.researchVaultGitSync.pull({
      timeoutMs: input.timeoutMs,
      ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
    });
    if (!result.ok) {
      return errAdapterError(
        `research-vault-git:${result.reason}`,
        result.message,
        result.recoverable,
      );
    }
    return {
      provider: 'git' as const,
      status: result.status,
      ...(result.backupId === undefined ? {} : { backupId: result.backupId }),
    };
  },
});
