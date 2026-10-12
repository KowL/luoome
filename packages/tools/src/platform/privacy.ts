import { createHash } from 'node:crypto';
import {
  HostedDeletionSchema,
  HostedExportMetadataSchema,
  TenantSchema,
  TenantTombstoneSchema,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { errNotFound } from '../define-tool.js';
import { randomAuthId } from './crypto.js';
import { definePlatformTool, type PlatformTool } from './define-platform-tool.js';

const Id = z.string().min(1).max(160);
const Generation = z.number().int().positive().safe();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export const requestHostedExportTool = definePlatformTool({
  name: 'request_hosted_export',
  description: '请求当前租户的私有业务数据导出，保留24小时的鉴权下载窗口',
  sideEffect: 'write',
  actors: ['user'],
  input: z.object({ requestId: Id }).strict(),
  output: z.object({ export: HostedExportMetadataSchema, replayed: z.boolean() }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return denied('actor:user');
    const now = ctx.clock();
    const principal = ctx.principal;
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify([
          'hosted-export-v1',
          principal.tenantId,
          principal.tenantGeneration,
          input.requestId,
        ]),
      )
      .digest('hex');
    return ctx.repos.privacy.requestExport({
      userId: principal.userId,
      now,
      metadata: {
        id: randomAuthId(),
        tenantId: principal.tenantId,
        generation: principal.tenantGeneration,
        requestId: input.requestId,
        operationId: randomAuthId(),
        inputHash,
        state: 'requested',
        artifactRef: null,
        resultHash: null,
        byteLength: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        completedAt: null,
        errorKind: null,
      },
    });
  },
});

export const getHostedExportTool = definePlatformTool({
  name: 'get_hosted_export',
  description: '读取本人导出状态，不包含服务器文件路径或公开下载地址',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ id: Id }).strict(),
  output: z.object({ export: HostedExportMetadataSchema }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return denied('actor:user');
    const metadata = await ctx.repos.privacy.findExport({
      id: input.id,
      tenantId: ctx.principal.tenantId,
      generation: ctx.principal.tenantGeneration,
      now: ctx.clock(),
    });
    return metadata === null ? errNotFound('HostedExport', input.id) : { export: metadata };
  },
});

export const resolveHostedExportDownloadTool = definePlatformTool({
  name: 'resolve_hosted_export_download',
  description: '校验当前用户、租户代际和24小时有效期后给出私有产物引用',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ id: Id }).strict(),
  output: z.object({
    exportId: Id,
    artifactRef: Id,
    resultHash: Hash,
    byteLength: z.number().int().nonnegative().safe(),
    expiresAt: z.coerce.date(),
  }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return denied('actor:user');
    const metadata = await ctx.repos.privacy.findExport({
      id: input.id,
      tenantId: ctx.principal.tenantId,
      generation: ctx.principal.tenantGeneration,
      now: ctx.clock(),
    });
    if (
      metadata === null ||
      metadata.state !== 'ready' ||
      metadata.artifactRef === null ||
      metadata.resultHash === null ||
      metadata.byteLength === null
    )
      return errNotFound('HostedExport', input.id);
    return {
      exportId: metadata.id,
      artifactRef: metadata.artifactRef,
      resultHash: metadata.resultHash,
      byteLength: metadata.byteLength,
      expiresAt: metadata.expiresAt,
    };
  },
});

export const completeHostedExportTool = definePlatformTool({
  name: 'complete_hosted_export',
  description: '在私有产物写入后保存不可变摘要和文件长度，供鉴权下载核对',
  sideEffect: 'write',
  actors: ['worker'],
  input: z
    .object({
      id: Id,
      generation: Generation,
      resultHash: Hash,
      byteLength: z.number().int().nonnegative().safe(),
    })
    .strict(),
  output: HostedExportMetadataSchema,
  handler: (input, ctx) => ctx.repos.privacy.completeExport({ ...input, now: ctx.clock() }),
});

export const listHostedExportsTool = definePlatformTool({
  name: 'list_hosted_exports',
  description: '为可信worker读取等待生成或清理的私有导出元数据',
  sideEffect: 'read',
  actors: ['worker'],
  input: z
    .object({
      tenantId: Id.optional(),
      states: z.array(z.enum(['requested', 'ready', 'failed', 'expired'])).optional(),
    })
    .strict(),
  output: z.array(HostedExportMetadataSchema),
  handler: (input, ctx) =>
    ctx.repos.privacy.listExports({
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      ...(input.states === undefined ? {} : { states: input.states }),
    }),
});

export const failHostedExportTool = definePlatformTool({
  name: 'fail_hosted_export',
  description: '记录导出失败类别，不保存私人正文或路径',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ id: Id, errorKind: z.string().min(1).max(100) }).strict(),
  output: HostedExportMetadataSchema,
  handler: (input, ctx) => ctx.repos.privacy.failExport({ ...input, now: ctx.clock() }),
});

export const expireHostedExportsTool = definePlatformTool({
  name: 'expire_hosted_exports',
  description: '原子失效过期导出并返回待清理的opaque身份',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({}).strict(),
  output: z.array(HostedExportMetadataSchema),
  handler: (_input, ctx) => ctx.repos.privacy.expireExports(ctx.clock()),
});

export const requestHostedDeletionTool = definePlatformTool({
  name: 'request_hosted_deletion',
  description: '最近10分钟重新验证并确认当前租户后进入排空和删除流程',
  sideEffect: 'write',
  actors: ['user'],
  input: z.object({ requestId: Id, confirmationTenantId: Id }).strict(),
  output: z.object({ deletion: HostedDeletionSchema, tenant: TenantSchema, replayed: z.boolean() }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return denied('actor:user');
    const principal = ctx.principal;
    return ctx.repos.privacy.requestDeletion({
      ...input,
      id: randomAuthId(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      generation: principal.tenantGeneration,
      sessionId: principal.sessionId,
      now: ctx.clock(),
    });
  },
});

export const listHostedDeletionsTool = definePlatformTool({
  name: 'list_hosted_deletions',
  description: '读取可信worker需要排空或复核的删除请求',
  sideEffect: 'read',
  actors: ['worker'],
  input: z
    .object({ states: z.array(z.enum(['draining', 'needs-review', 'completed'])).optional() })
    .strict(),
  output: z.array(HostedDeletionSchema),
  handler: (input, ctx) =>
    ctx.repos.privacy.listDeletions(input.states === undefined ? {} : { states: input.states }),
});

export const markHostedDeletionNeedsReviewTool = definePlatformTool({
  name: 'mark_hosted_deletion_needs_review',
  description: '排空失败时保持删除中并保存可审计的错误类别',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ id: Id, errorKind: z.string().min(1).max(100) }).strict(),
  output: HostedDeletionSchema,
  handler: (input, ctx) =>
    ctx.repos.privacy.markDeletionNeedsReview({ ...input, now: ctx.clock() }),
});

export const completeHostedDeletionTool = definePlatformTool({
  name: 'complete_hosted_deletion',
  description: '可信worker排空、持久化独立tombstone并移除文件后清理平台PII并完成删除',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ id: Id, generation: Generation }).strict(),
  output: z.object({ deletion: HostedDeletionSchema, tombstone: TenantTombstoneSchema }),
  handler: (input, ctx) => ctx.repos.privacy.completeDeletion({ ...input, now: ctx.clock() }),
});

export const platformPrivacyTools: readonly PlatformTool[] = [
  requestHostedExportTool,
  getHostedExportTool,
  resolveHostedExportDownloadTool,
  completeHostedExportTool,
  listHostedExportsTool,
  failHostedExportTool,
  expireHostedExportsTool,
  requestHostedDeletionTool,
  listHostedDeletionsTool,
  markHostedDeletionNeedsReviewTool,
  completeHostedDeletionTool,
];
