import type { ResearchVaultGitSyncAdapterLike, ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { toolRegistry } from '../registry.js';
import {
  getResearchVaultRemoteSyncStatusTool,
  pullResearchVaultGitTool,
} from './research-vault-git-sync.js';

const withGitSync = async (
  adapter: ResearchVaultGitSyncAdapterLike,
  extra: Partial<ToolContext> = {},
): Promise<ToolContext> => ({
  ...(await buildTestContext()),
  researchVaultGitSync: adapter,
  ...extra,
});

describe('Research Vault Git sync tools', () => {
  it('仅公开无敏感信息的只读配置状态，pull 保持 workflow-only', async () => {
    const base = await buildTestContext();
    expect(await getResearchVaultRemoteSyncStatusTool.execute({}, base)).toEqual({
      ok: true,
      data: { configured: false },
    });
    expect(toolRegistry.get('get_research_vault_remote_sync_status')).toBeDefined();
    expect(toolRegistry.get('pull_research_vault_git')).toBeUndefined();
  });

  it('pull 声明 external/write 双能力并透传成功结果与取消信号', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const ctx = await withGitSync(
      {
        name: 'test-git',
        provider: 'git',
        pull: async (input) => {
          receivedSignal = input.signal;
          return { ok: true, status: 'updated', backupId: 'backup-1' };
        },
      },
      { abortSignal: controller.signal },
    );

    expect(pullResearchVaultGitTool.sideEffect).toBe('external');
    expect(pullResearchVaultGitTool.requiredCapabilities).toEqual(['write', 'external']);
    expect(await pullResearchVaultGitTool.execute({ timeoutMs: 5_000 }, ctx)).toEqual({
      ok: true,
      data: { provider: 'git', status: 'updated', backupId: 'backup-1' },
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('未显式配置时拒绝，adapter 失败转换为可审计 ToolError', async () => {
    const base = await buildTestContext();
    expect(await pullResearchVaultGitTool.execute({}, base)).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'LUOOME_RESEARCH_REMOTE_SYNC=git' },
    });
    const ctx = await withGitSync({
      name: 'test-git',
      provider: 'git',
      pull: async () => ({
        ok: false,
        reason: 'dirty-worktree',
        message: '工作树不干净',
        recoverable: true,
      }),
    });
    expect(await pullResearchVaultGitTool.execute({}, ctx)).toEqual({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'research-vault-git:dirty-worktree',
        cause: '工作树不干净',
        recoverable: true,
      },
    });
  });
});
