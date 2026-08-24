import { createHash } from 'node:crypto';

import type {
  ResearchVaultAdapterLike,
  ResearchVaultEntry,
  ResearchVaultGitSyncAdapterLike,
  ToolContext,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncResearchVaultRemoteWorkflow } from './sync-research-vault-remote.js';

const TOPIC = `---
luoome_schema: "1"
luoome_type: research-topic
luoome_id: topic_remote_sync
title: 远端同步主题
topic_kind: custom
created_at: 2026-08-20T00:00:00.000Z
updated_at: 2026-08-20T00:00:00.000Z
---
# 远端同步主题
`;

const vault = (scanError?: Error): ResearchVaultAdapterLike => {
  const relativePath = 'Research/topic.md';
  const entry: ResearchVaultEntry = {
    relativePath,
    size: Buffer.byteLength(TOPIC),
    modifiedAt: new Date('2026-08-20T00:00:00.000Z'),
    contentHash: createHash('sha256').update(TOPIC).digest('hex'),
  };
  return {
    name: 'workflow-test-vault',
    vaultId: 'workflow-test-vault',
    scan: async () => {
      if (scanError !== undefined) throw scanError;
      return [entry];
    },
    readText: async () => TOPIC,
    createManagedDocument: async () => entry,
    updateManagedDocument: async () => entry,
    importAttachment: async () => entry,
    buildOpenUri: (path) => `obsidian://open?file=${encodeURIComponent(path)}`,
  };
};

const gitSync = (
  result: Awaited<ReturnType<ResearchVaultGitSyncAdapterLike['pull']>>,
): ResearchVaultGitSyncAdapterLike => ({
  name: 'workflow-test-git',
  provider: 'git',
  pull: async () => result,
});

const context = async (
  git: ResearchVaultGitSyncAdapterLike,
  researchVault: ResearchVaultAdapterLike,
): Promise<ToolContext> => ({
  ...(await buildTestContext({ clock: () => new Date('2026-08-20T08:00:00.000Z') })),
  researchVaultGitSync: git,
  researchVault,
});

describe('syncResearchVaultRemoteWorkflow', () => {
  it('Git 成功后只通过既有 sync tool 重建索引并记录 succeeded WorkflowRun', async () => {
    const ctx = await context(
      gitSync({ ok: true, status: 'updated', backupId: 'backup-1' }),
      vault(),
    );

    const result = await syncResearchVaultRemoteWorkflow.run({ mode: 'manual' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'succeeded',
      git: { provider: 'git', status: 'updated', backupId: 'backup-1' },
      index: { status: 'succeeded', scanned: 1 },
    });
    expect(await ctx.repos.researchIndex.findTopic('topic_remote_sync')).toBeDefined();
    expect(await ctx.repos.workflowRun.findById(result.data.workflowRunId)).toMatchObject({
      workflowName: 'sync-research-vault-remote',
      status: 'succeeded',
      providerStatuses: [
        { provider: 'git', ok: true },
        { provider: 'research-index', ok: true },
      ],
    });
  });

  it('Git 安全边界失败时不扫描 Vault，并记录 failed WorkflowRun', async () => {
    let scanned = false;
    const unavailableVault = vault();
    const ctx = await context(
      gitSync({
        ok: false,
        reason: 'dirty-worktree',
        message: '工作树不干净',
        recoverable: true,
      }),
      {
        ...unavailableVault,
        scan: async () => {
          scanned = true;
          return [];
        },
      },
    );

    const result = await syncResearchVaultRemoteWorkflow.run({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', adapter: 'research-vault-git:dirty-worktree' },
    });
    expect(scanned).toBe(false);
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'sync-research-vault-remote' }),
    ).toMatchObject([{ status: 'failed', providerStatuses: [{ provider: 'git', ok: false }] }]);
  });

  it('Git 已更新但索引失败时返回 partial，并保留可恢复审计事实', async () => {
    const ctx = await context(
      gitSync({ ok: true, status: 'updated', backupId: 'backup-partial' }),
      vault(new Error('vault scan unavailable')),
    );

    const result = await syncResearchVaultRemoteWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'partial',
      git: { status: 'updated', backupId: 'backup-partial' },
    });
    expect(result.data.index).toBeUndefined();
    expect(await ctx.repos.workflowRun.findById(result.data.workflowRunId)).toMatchObject({
      status: 'partial',
      outputSummary: { gitStatus: 'updated', indexStatus: 'failed' },
      providerStatuses: [
        { provider: 'git', ok: true },
        { provider: 'research-index', ok: false },
      ],
    });
  });
});
