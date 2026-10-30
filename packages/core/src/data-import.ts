import { z } from 'zod';

export const DATA_IMPORT_VERSION = 1 as const;
/**
 * 导入提交对应的 Operation 工具名。提交事务内的权威复查据此排除「本次导入自身」：
 * 只有当 requestId（= operationId）、账户、状态与工具名同时对上时才跳过，
 * 其它任何 pending/executing/unknown 都阻断。
 */
export const DATA_IMPORT_RESTORE_TOOL = 'restore_data_import';
/** 预检有效期：previewHash 绑定 expiresAt，因此提交必须能复现同一个有效期。 */
export const DATA_IMPORT_PREVIEW_TTL_MS = 600_000;
export const DataImportScopeSchema = z
  .object({
    userId: z.string().min(1),
    accountId: z.string().min(1),
  })
  .strict();
export type DataImportScope = z.infer<typeof DataImportScopeSchema>;
export type DataImportValue = string | number | null;
export type DataImportRow = Readonly<Record<string, DataImportValue>>;
export type DataImportTables = Readonly<Record<string, readonly DataImportRow[]>>;
export type DataImportTablePolicy = 'replace' | 'union' | 'preserve' | 'transient' | 'rebuild';

export interface DataImportColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: number;
  readonly hidden: number;
}
export interface DataImportTableStorageSchema {
  readonly columns: readonly DataImportColumn[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    readonly partial: boolean;
    readonly sql: string | null;
  }[];
}
export type DataImportStorageSchema = Readonly<Record<string, DataImportTableStorageSchema>>;

export interface DataImportSnapshot {
  readonly format: 'sqlite';
  readonly manifestVersion: typeof DATA_IMPORT_VERSION;
  readonly archiveDigest: string;
  readonly tables: DataImportTables;
  readonly ignoredCounts: Readonly<Record<string, number>>;
  readonly schema: DataImportStorageSchema;
}

export interface DataImportTableCount {
  readonly policy: DataImportTablePolicy;
  readonly source: number;
  readonly current: number;
  readonly expected: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly unchanged: number;
}
export type DataImportValidationLevel = 'domain' | 'structural';
/**
 * 提交只需要「摘要 + 有效期」两项：摘要绑定 archiveDigest/manifest/mode/scope/
 * preDigest/postDigest/expiresAt/validation，所以给定 expiresAt 就能完全复现预检。
 */
export interface DataImportPreviewRef {
  readonly previewHash: string;
  readonly expiresAt: number;
}
export interface DataImportPreview extends DataImportPreviewRef {
  readonly archiveDigest: string;
  readonly preDigest: string;
  readonly postDigest: string;
  readonly counts: Readonly<Record<string, DataImportTableCount>>;
  /** 每表校验级别：domain 走领域不变量，structural 只钉存储形态（Lead 裁定 round-15 §4.1）。 */
  readonly validation: Readonly<Record<string, DataImportValidationLevel>>;
  /** 只做结构校验的表清单，预检与回执必须原样披露。 */
  readonly structuralOnly: readonly string[];
}
/**
 * 恢复前一致性备份的引用。`archiveDigest` 绑定「这份备份是为哪个快照做的」，
 * `targetDigest` 绑定「备份时目标业务事实的完整摘要」；commit 在事务内复核后者，
 * 备份后目标被改过就拒绝提交。
 */
export interface DataImportBackupRef {
  readonly backupId: string;
  readonly archiveDigest: string;
  readonly targetDigest: string;
}
export interface DataImportBackup extends DataImportBackupRef {
  /** 备份文件字节的 SHA-256。 */
  readonly digest: string;
  readonly size: number;
  readonly createdAt: number;
}

export interface DataImportReceipt {
  readonly requestId: string;
  readonly originalRequestId: string;
  readonly archiveDigest: string;
  readonly requestHash: string;
  readonly committedAt: number;
  readonly postDigest: string;
  readonly actual: Readonly<Record<string, number>>;
}

export class DataImportError extends Error {
  constructor(
    readonly code:
      | 'format'
      | 'schema'
      | 'scope'
      | 'conflict'
      | 'stale'
      | 'busy'
      | 'graph'
      | 'ledger'
      | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'DataImportError';
  }
}

/** 专用有界上传的暂存描述；不含本机路径、原始文件名或任何凭证。 */
export interface DataImportStagedUpload {
  readonly uploadId: string;
  readonly archiveDigest: string;
  readonly size: number;
  readonly userId: string;
  readonly accountId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * host 侧暂存读取器（载体 IO）。tools 只通过它拿到已封存的快照，
 * 不接受路径、原始字节或 base64，也不负责暂存文件的创建/清理/TTL。
 */
export interface DataImportStagingAdapter {
  describe(uploadId: string): Promise<DataImportStagedUpload | null>;
  /** 以真只读方式打开暂存快照并校验；不改写目标库。 */
  load(uploadId: string): Promise<DataImportSnapshot>;
  /**
   * 提交前复核备份文件仍存在、字节未变（在 BEGIN 之前调用，不进事务）。
   * 未实现时提交按「无法证明安全网有效」拒绝，不静默放过。
   */
  verifyBackup?(backupId: string): Promise<boolean>;
}
