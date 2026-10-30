// T48 数据导入 tools 切片。
//
// 两个 tool 都不接受路径、原始字节或 base64：只认 host 暂存后发放的 opaque `uploadId`。
// - `preview_data_import`（read）：只读预检，不创建 Operation、不写目标库。
// - `restore_data_import`（write）：**只作 Operation policy**，不进 agent 面
//   （不在 read/market allowlist，也没有独立 agent 入口）；prepare 冻结
//   uploadId + previewHash + mode，confirm 才真正提交。
import { DATA_IMPORT_PREVIEW_TTL_MS, DataImportError, type DataImportPreview } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';

const uploadId = z
  .string()
  .regex(/^[a-f0-9]{32,64}$/, 'uploadId must be an opaque hex id issued by the host');

export const DataImportModeSchema = z.literal('restore-business-v1');

const countSchema = z.object({
  policy: z.enum(['replace', 'union', 'preserve', 'transient', 'rebuild']),
  source: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

const previewPayload = (preview: DataImportPreview, mode: string) => ({
  mode,
  archiveDigest: preview.archiveDigest,
  previewHash: preview.previewHash,
  expiresAt: preview.expiresAt,
  counts: preview.counts,
  validation: preview.validation,
  structuralOnly: preview.structuralOnly,
  limitations: [
    '只做结构校验的表：这些表仅校验主键存在、布尔列 0/1、JSON 列可解析，不校验领域不变量。',
    '来源必须是关闭后或一致性 backup 产生的独立快照；附加非空 WAL/journal 的快照会被拒绝，',
    '本检查无法识别“上游漏带已提交 WAL”的所有情形。',
    '恢复按 manifest 分类替换业务事实；本机 Operation/授权/导入回执与 DSH 状态不在范围内。',
  ],
});

export const PreviewDataImportInput = z
  .object({
    uploadId,
    mode: DataImportModeSchema,
  })
  .strict();

export const PreviewDataImportOutput = z.object({
  mode: z.literal('restore-business-v1'),
  archiveDigest: z.string(),
  previewHash: z.string(),
  expiresAt: z.number().int().nonnegative(),
  counts: z.record(z.string(), countSchema),
  validation: z.record(z.string(), z.enum(['domain', 'structural'])),
  structuralOnly: z.array(z.string()),
  limitations: z.array(z.string()),
});

export const previewDataImportTool = defineTool({
  name: 'preview_data_import',
  description:
    '只读预检 SQLite 业务快照：按表给出 source/current/expected 计数、校验级别与保护/遗漏说明。不创建 Operation，不改写目标库。',
  sideEffect: 'read',
  input: PreviewDataImportInput,
  output: PreviewDataImportOutput,
  handler: async (input, ctx) => {
    const staging = ctx.dataImport;
    const repository = ctx.repos.dataImport;
    if (staging === undefined || repository === undefined)
      return errAdapterError('data-import', 'staging adapter is not configured', false);
    const staged = await staging.describe(input.uploadId);
    if (staged === null) return errNotFound('Upload', input.uploadId);
    if (staged.userId !== ctx.user.id || staged.accountId !== ctx.user.defaultAccountId)
      return { ok: false, error: { kind: 'permission_denied', required: 'current owner upload' } };
    let snapshot: Awaited<ReturnType<typeof staging.load>>;
    try {
      snapshot = await staging.load(input.uploadId);
    } catch (error) {
      return importFailure(error, 'preview');
    }
    if (snapshot.archiveDigest !== staged.archiveDigest)
      return errInvalidInput('暂存快照在预检期间发生变化');
    try {
      const preview = await repository.preview({
        scope: { userId: ctx.user.id, accountId: ctx.user.defaultAccountId },
        snapshot,
        now: ctx.clock().getTime(),
      });
      return previewPayload(preview, input.mode);
    } catch (error) {
      return importFailure(error, 'preview');
    }
  },
});

const backupRefSchema = z
  .object({
    backupId: z.string().regex(/^[a-f0-9]{32}$/),
    archiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const RestoreDataImportInput = z
  .object({
    /** host 绑定：客户端只能省略，或等于当前 owner 账户。 */
    accountId: z.string().min(1).optional(),
    /** host 绑定：顶层 operationId；客户端提交的值必须与之一致。 */
    requestId: z.string().min(1).optional(),
    uploadId,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * 预检有效期（ms epoch）。previewHash 已绑定它，提交据此复现同一份预检；
     * 客户端改这个值只会让摘要对不上，不会放宽任何检查。
     */
    previewExpiresAt: z.number().int().positive(),
    /** host 绑定的 opaque 备份 id；客户端只提供它，服务端据此解析出摘要。 */
    backupId: z.string().regex(/^[a-f0-9]{32}$/),
    /** host 在 bind 时由 backupId 解析并冻结；客户端提供会被覆盖。 */
    backup: backupRefSchema.optional(),
    mode: DataImportModeSchema,
  })
  .strict();

export const RestoreDataImportOutput = z.object({
  mode: z.literal('restore-business-v1'),
  requestId: z.string(),
  archiveDigest: z.string(),
  committedAt: z.number().int().nonnegative(),
  postDigest: z.string(),
  actual: z.record(z.string(), z.number().int().nonnegative()),
  structuralOnly: z.array(z.string()),
});

/**
 * 把 `DataImportError` 翻成 ToolResult。这些错误都发生在**任何业务写入之前**且事务已回滚，
 * 因此 policy 可以声明 `settleFailureAsFailed`，让 Operation 落终态 `failed` 而不是 `unknown`。
 */
const importFailure = (error: unknown, stage: 'preview' | 'commit') => {
  if (error instanceof DataImportError)
    return {
      ok: false as const,
      error: {
        kind: 'invalid_input' as const,
        message: `${stage}_${error.code}: ${error.message}`,
        issues: [],
      },
    };
  throw error;
};

export const restoreDataImportTool = defineTool({
  name: 'restore_data_import',
  description:
    '按已冻结的 uploadId + previewHash 提交业务快照恢复（仅作精确 Operation policy，不直接对 agent 暴露）。' +
    '失败（busy/stale/conflict/scope）发生在事务内且已回滚，Operation 落终态 failed；' +
    'failed 后同一 requestId 不会重跑，必须用新的 operationId/requestId 重新预检并提交。',
  sideEffect: 'write',
  input: RestoreDataImportInput,
  output: RestoreDataImportOutput,
  handler: async (input, ctx) => {
    const staging = ctx.dataImport;
    const repository = ctx.repos.dataImport;
    if (staging === undefined || repository === undefined)
      return errAdapterError('data-import', 'staging adapter is not configured', false);
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const requestId = input.requestId;
    if (requestId === undefined) return errInvalidInput('Host must bind requestId');
    const backup = input.backup;
    // 备份是提交的前置条件：没有服务端解析出的备份引用就不提交（不接受 force）。
    if (backup === undefined || backup.backupId !== input.backupId)
      return errInvalidInput('commit_backup: 缺少服务端生成的恢复前一致性备份');
    if (accountId !== ctx.user.defaultAccountId)
      return { ok: false, error: { kind: 'permission_denied', required: 'current owner account' } };
    const staged = await staging.describe(input.uploadId);
    if (staged === null) return errNotFound('Upload', input.uploadId);
    if (staged.userId !== ctx.user.id || staged.accountId !== accountId)
      return { ok: false, error: { kind: 'permission_denied', required: 'current owner upload' } };
    let snapshot: Awaited<ReturnType<typeof staging.load>>;
    try {
      snapshot = await staging.load(input.uploadId);
    } catch (error) {
      return importFailure(error, 'commit');
    }
    // 暂存不可被客户端改写：提交前再核原始字节摘要。
    if (snapshot.archiveDigest !== staged.archiveDigest)
      return errInvalidInput('commit_digest: 暂存快照在提交前发生变化');
    if (backup.archiveDigest !== snapshot.archiveDigest)
      return errInvalidInput('commit_backup: 备份不是为本次快照生成的');
    // 提交前（事务外）复核备份文件仍可读且字节未变：文件损坏时安全网已不存在。
    const backupIntact = await staging.verifyBackup?.(backup.backupId);
    if (backupIntact !== true)
      return errInvalidInput('commit_backup: 备份文件校验失败，请重新生成备份');
    const scope = { userId: ctx.user.id, accountId };
    const now = ctx.clock().getTime();
    try {
      // 用冻结的有效期复现预检：摘要相同才说明目标业务内容与快照都没变。
      const preview = await repository.preview({
        scope,
        snapshot,
        now: input.previewExpiresAt - DATA_IMPORT_PREVIEW_TTL_MS,
      });
      if (preview.previewHash !== input.previewHash)
        return errInvalidInput('commit_stale: 目标业务内容或快照已变化，请重新预检');
      const receipt = await repository.commit({
        scope,
        requestId,
        snapshot,
        preview: { previewHash: preview.previewHash, expiresAt: input.previewExpiresAt },
        backup,
        now,
      });
      return {
        mode: input.mode,
        requestId: receipt.requestId,
        archiveDigest: receipt.archiveDigest,
        committedAt: receipt.committedAt,
        postDigest: receipt.postDigest,
        actual: receipt.actual,
        structuralOnly: preview.structuralOnly,
      };
    } catch (error) {
      return importFailure(error, 'commit');
    }
  },
});
