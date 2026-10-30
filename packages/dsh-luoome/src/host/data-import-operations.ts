// T48 恢复提交的精确 Operation policy。
//
// 只作 `luoome_confirmed_operation` 的 policy：`restore_data_import` 不进 read/market
// allowlist，也没有 agent 入口。prepare 冻结的是 opaque 参数（uploadId + previewHash + mode），
// 绝不冻结路径、原始字节或 base64 数据库。
//
// `settleFailureAsFailed`：commit 的所有拒绝（busy/stale/conflict/scope/graph/ledger）
// 都发生在事务内且已回滚，因此失败可落终态 `failed`；抛异常仍落 `unknown`（由内核处理）。
// failed 之后同一 requestId 不会重跑，必须换新 operationId/requestId 重新预检。
import { DATA_IMPORT_PREVIEW_TTL_MS, type ToolContext, type ToolResult } from '@luoome/core';
import {
  type ConfirmablePluginTool,
  PluginOperationScopeError,
  type PluginPrincipal,
  RestoreDataImportInput,
  restoreDataImportTool,
} from '@luoome/tools';
import type { DataImportBackupStore, DataImportStaging } from './data-import.js';

export const createDataImportOperationPolicies = (options: {
  readonly staging: Pick<DataImportStaging, 'describe'>;
  readonly backups: Pick<DataImportBackupStore, 'describe'>;
}): readonly ConfirmablePluginTool[] => [
  {
    tool: restoreDataImportTool,
    scheduled: false,
    hostBoundFields: ['accountId', 'requestId'],
    settleFailureAsFailed: true,
    async bind(raw, principal: PluginPrincipal, operationId: string, ctx: ToolContext) {
      // strict schema：路径、原始字节、base64 字段一律是 unknown key → 直接拒绝。
      const input = RestoreDataImportInput.parse(raw);
      if (input.accountId !== undefined && input.accountId !== principal.accountId)
        throw new PluginOperationScopeError('accountId');
      if (input.requestId !== undefined && input.requestId !== operationId)
        throw new PluginOperationScopeError('requestId');
      // 有效期必须落在 (now, now + TTL]：过期或伪造的预检在 prepare 阶段就拒绝。
      const now = ctx.clock().getTime();
      if (
        input.previewExpiresAt <= now ||
        input.previewExpiresAt > now + DATA_IMPORT_PREVIEW_TTL_MS
      )
        throw new Error('预检已过期或有效期非法，请重新预检');
      const staged = await options.staging.describe(input.uploadId);
      // 只接受本 owner、未过期的 opaque 暂存；不在 prepare 阶段读取快照内容。
      if (
        staged === null ||
        staged.userId !== principal.userId ||
        staged.accountId !== principal.accountId
      )
        throw new Error('暂存快照不存在、已过期或不属于当前账户');
      // 恢复前一致性备份：必须已由服务端生成、且是为本次快照做的。缺失即拒，不看 force。
      const backup = await options.backups.describe(input.backupId);
      if (backup === null) throw new Error('恢复前一致性备份不存在或已失效，请重新生成');
      if (backup.archiveDigest !== staged.archiveDigest)
        throw new Error('备份不是为本次快照生成的');
      return {
        ...input,
        accountId: principal.accountId,
        requestId: operationId,
        backup: {
          backupId: backup.backupId,
          archiveDigest: backup.archiveDigest,
          targetDigest: backup.targetDigest,
        },
      };
    },
    async receipt(raw, ctx: ToolContext): Promise<ToolResult<unknown> | null> {
      const input = RestoreDataImportInput.parse(raw);
      const repository = ctx.repos.dataImport;
      if (
        repository === undefined ||
        input.requestId === undefined ||
        input.accountId === undefined
      )
        return null;
      const receipt = await repository.findReceipt(
        { userId: ctx.user.id, accountId: input.accountId },
        input.requestId,
      );
      return receipt === null
        ? null
        : {
            ok: true,
            data: {
              mode: input.mode,
              requestId: receipt.requestId,
              originalRequestId: receipt.originalRequestId,
              archiveDigest: receipt.archiveDigest,
              committedAt: receipt.committedAt,
              postDigest: receipt.postDigest,
              actual: receipt.actual,
            },
          };
    },
  },
];
