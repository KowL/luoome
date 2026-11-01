import type {
  DataImportBackupRef,
  DataImportPreview,
  DataImportPreviewRef,
  DataImportReceipt,
  DataImportScope,
  DataImportSnapshot,
  DataImportTables,
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
  /**
   * **导出**当前业务事实（task-35）：只读，返回与 `restore` 同一套 `replace ∪ union` 表集合。
   *
   * 为什么在仓储里而不是 tools 里拼 SQL：表集合的唯一真源是 `DATA_IMPORT_MANIFEST`
   * （`packages/db` 持有），tools 拿不到；这样「导出的东西恰好能被吃回去」是**结构性保证**，
   * 而不是两处各自维护的巧合。
   */
  exportBusinessTables(): Promise<{
    readonly tables: DataImportTables;
    readonly digest: string;
  }>;
}
