import type {
  DataImportBackupRef,
  DataImportPreview,
  DataImportPreviewRef,
  DataImportReceipt,
  DataImportScope,
  DataImportSnapshot,
} from '../data-import.js';

export interface DataImportCommand {
  readonly scope: DataImportScope;
  readonly requestId: string;
  readonly snapshot: DataImportSnapshot;
  readonly preview: DataImportPreviewRef;
  /**
   * 恢复前一致性备份。缺失即拒（不接受泛用 force）：
   * `archiveDigest` 必须与本次快照一致，`targetDigest` 必须与事务内重算的当前摘要一致。
   */
  readonly backup: DataImportBackupRef;
  readonly now: number;
}

export interface DataImportRepository {
  preview(input: {
    readonly scope: DataImportScope;
    readonly snapshot: DataImportSnapshot;
    readonly now: number;
  }): Promise<DataImportPreview>;
  commit(input: DataImportCommand): Promise<DataImportReceipt>;
  findReceipt(scope: DataImportScope, requestId: string): Promise<DataImportReceipt | null>;
  /** 当前目标业务事实的完整摘要（备份与提交复核用，口径与 previewHash 内的 preDigest 相同）。 */
  targetDigest(scope: DataImportScope): Promise<string>;
}
