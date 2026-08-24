import { randomUUID } from 'node:crypto';

import type { ToolError, ToolResult } from '@luoome/core';
import { PullResearchVaultGitOutput, SyncResearchVaultOutput } from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';

export const SyncResearchVaultRemoteInput = z.object({
  mode: z.enum(['manual', 'scheduled']).default('manual'),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});
export const SyncResearchVaultRemoteOutput = z.object({
  workflowRunId: z.string().min(1),
  status: z.enum(['succeeded', 'partial']),
  git: PullResearchVaultGitOutput,
  index: SyncResearchVaultOutput.optional(),
  diagnostic: z.string().max(500).optional(),
});

type RemoteSyncInput = z.output<typeof SyncResearchVaultRemoteInput>;
type RemoteSyncOutput = z.output<typeof SyncResearchVaultRemoteOutput>;

const errorMessage = (error: ToolError): string => {
  switch (error.kind) {
    case 'invalid_input':
    case 'invariant_violation':
    case 'lease_lost_before_commit':
      return error.message;
    case 'adapter_error':
    case 'llm_error':
    case 'internal':
      return error.cause;
    case 'not_found':
      return `${error.entity} not found`;
    case 'permission_denied':
      return `需要 ${error.required}`;
  }
};

const executeRemoteSync = async (
  input: RemoteSyncInput,
  ctx: WorkflowContext,
): Promise<RemoteSyncOutput | ToolResult<never>> => {
  const startedAt = ctx.clock();
  const workflowRunId = `workflow-research-vault-remote-${randomUUID()}`;
  const inputSummary = { provider: 'git', timeoutMs: input.timeoutMs };
  const running = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: 'sync-research-vault-remote',
      mode: input.mode,
      status: 'running',
      startedAt,
      inputSummary,
      providerStatuses: [],
    },
  });
  if (!running.ok) return running;

  const git = await ctx.tools.pull_research_vault_git.execute({ timeoutMs: input.timeoutMs });
  if (!git.ok) {
    const message = errorMessage(git.error).slice(0, 500);
    const audited = await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: 'sync-research-vault-remote',
        mode: input.mode,
        status: 'failed',
        startedAt,
        finishedAt: ctx.clock(),
        inputSummary,
        providerStatuses: [{ provider: 'git', ok: false, errorKind: git.error.kind }],
        error: message,
      },
    });
    return audited.ok ? git : audited;
  }

  const index = await ctx.tools.sync_research_vault.execute({ mode: input.mode });
  if (!index.ok) {
    const diagnostic = `远端 fast-forward 已完成；索引重建失败：${errorMessage(index.error)}`.slice(
      0,
      500,
    );
    const audited = await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: 'sync-research-vault-remote',
        mode: input.mode,
        status: 'partial',
        startedAt,
        finishedAt: ctx.clock(),
        inputSummary,
        outputSummary: {
          gitStatus: git.data.status,
          ...(git.data.backupId === undefined ? {} : { backupId: git.data.backupId }),
          indexStatus: 'failed',
        },
        providerStatuses: [
          { provider: 'git', ok: true },
          { provider: 'research-index', ok: false, errorKind: index.error.kind },
        ],
      },
    });
    if (!audited.ok) return audited;
    return {
      workflowRunId,
      status: 'partial',
      git: git.data,
      diagnostic,
    };
  }

  const status = index.data.status === 'succeeded' ? ('succeeded' as const) : ('partial' as const);
  const audited = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: 'sync-research-vault-remote',
      mode: input.mode,
      status,
      startedAt,
      finishedAt: ctx.clock(),
      inputSummary,
      outputSummary: {
        gitStatus: git.data.status,
        ...(git.data.backupId === undefined ? {} : { backupId: git.data.backupId }),
        indexStatus: index.data.status,
        scanned: index.data.scanned,
        invalid: index.data.invalid,
        conflicts: index.data.conflicts,
      },
      providerStatuses: [
        { provider: 'git', ok: true },
        { provider: 'research-index', ok: index.data.status === 'succeeded' },
      ],
    },
  });
  if (!audited.ok) return audited;
  return {
    workflowRunId,
    status,
    git: git.data,
    index: index.data,
    ...(status === 'partial' ? { diagnostic: 'Git 同步完成，但 Vault 索引包含无效或冲突项' } : {}),
  };
};

export const syncResearchVaultRemoteWorkflow = defineWorkflow<RemoteSyncInput, RemoteSyncOutput>({
  name: 'sync-research-vault-remote',
  description: '安全 fast-forward Git Research Vault，并通过既有流程重建本地索引',
  input: SyncResearchVaultRemoteInput,
  steps: [(input, ctx) => executeRemoteSync(input as RemoteSyncInput, ctx)],
});
