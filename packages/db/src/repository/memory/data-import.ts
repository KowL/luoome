import { createHash } from 'node:crypto';
import {
  DATA_IMPORT_PREVIEW_TTL_MS,
  DATA_IMPORT_RESTORE_TOOL,
  type DataImportCommand,
  DataImportError,
  type DataImportReceipt,
  type DataImportRepository,
  type DataImportScope,
  type DataImportTables,
} from '@luoome/core';
import { DATA_IMPORT_BUSINESS_TABLES } from '../../data-import-manifest.js';
import {
  canonicalDataImportJson,
  dataImportBusinessDigest,
  dataImportHash,
  planDataImportRestore,
} from '../../data-transfer-contract.js';

export interface MemoryDataImportOperation {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly tool: string;
  readonly state: string;
}

export interface MemoryDataImportState {
  readonly tables: DataImportTables;
  readonly receipts: readonly {
    readonly scope: DataImportScope;
    readonly receipt: DataImportReceipt;
  }[];
  readonly operations: readonly MemoryDataImportOperation[];
}

export interface InMemoryDataImportOptions {
  /**
   * 生产形态下提交事务的权威非终态检查读 `plugin_operations`（Drizzle 实现在 BEGIN IMMEDIATE 内查询）。
   * 内存替身默认读自身 `state.operations`；互斥 fixture 需要与真实 `PluginAuthorityRepository`
   * 共享同一账本时注入该读取函数。读取发生在状态交换之前，且交换本身不再有 await，
   * 因此替身仍保持「检查 → 交换」的原子段。
   */
  readonly nonTerminalOperations?: () =>
    | Promise<readonly MemoryDataImportOperation[]>
    | readonly MemoryDataImportOperation[];
}

/**
 * 合约替身：与 `DrizzleDataImportRepository` 跑同一批 contract-tests，用来固定
 * preview/commit/receipt/alias 的语义。它持有独立的内存表状态，**不与** 既有 typed
 * in-memory repos 共享数据，也不提供 SQLite 事务/DDL 保证，因此：
 * - 不进入 `createInMemoryRepos`，`RepositoryRegistry.dataImport` 只由 Drizzle 装配提供；
 * - 任何生产路径都不得把它当真实导入实现使用。
 */
export class InMemoryDataImportRepository implements DataImportRepository {
  private state: MemoryDataImportState;
  constructor(
    initial: MemoryDataImportState,
    private readonly options: InMemoryDataImportOptions = {},
  ) {
    this.state = structuredClone(initial);
  }
  snapshot(): MemoryDataImportState {
    return structuredClone(this.state);
  }
  private receipt(scope: DataImportScope, requestId: string): DataImportReceipt | null {
    return (
      this.state.receipts.find(
        (entry) =>
          entry.scope.userId === scope.userId &&
          entry.scope.accountId === scope.accountId &&
          entry.receipt.requestId === requestId,
      )?.receipt ?? null
    );
  }
  async findReceipt(scope: DataImportScope, requestId: string) {
    return structuredClone(this.receipt(scope, requestId));
  }
  async targetDigest(scope: DataImportScope) {
    return dataImportBusinessDigest(this.state.tables, scope);
  }
  /** 导出业务事实（task-35）：与 drizzle 实现同一口径（表集合来自 `DATA_IMPORT_BUSINESS_TABLES`）。 */
  async exportBusinessTables(): Promise<{
    readonly tables: DataImportTables;
    readonly digest: string;
  }> {
    const tables = Object.fromEntries(
      DATA_IMPORT_BUSINESS_TABLES.map((table) => [table, this.state.tables[table] ?? []]),
    ) as DataImportTables;
    return {
      tables,
      digest: createHash('sha256').update(canonicalDataImportJson(tables)).digest('hex'),
    };
  }
  async preview(input: Parameters<DataImportRepository['preview']>[0]) {
    return planDataImportRestore(input.snapshot, this.state.tables, input.scope, input.now).preview;
  }
  async commit(input: DataImportCommand): Promise<DataImportReceipt> {
    const requestHash = dataImportHash({
      scope: input.scope,
      archiveDigest: input.snapshot.archiveDigest,
      mode: 'restore-business-v1',
      version: input.snapshot.manifestVersion,
    });
    const previous = this.receipt(input.scope, input.requestId);
    if (previous !== null) {
      if (previous.requestHash !== requestHash)
        throw new DataImportError('conflict', '相同 requestId 对应不同导入内容');
      return structuredClone(previous);
    }
    const operations = await (this.options.nonTerminalOperations?.() ?? this.state.operations);
    for (const operation of operations) {
      if (!['pending', 'executing', 'unknown'].includes(operation.state)) continue;
      const sameAccount = operation.accountId === input.scope.accountId;
      if (
        sameAccount &&
        operation.id === input.requestId &&
        operation.userId === input.scope.userId &&
        operation.state === 'executing' &&
        operation.tool === DATA_IMPORT_RESTORE_TOOL
      )
        continue;
      throw new DataImportError(
        'busy',
        sameAccount
          ? '存在未终结的 Operation，恢复尚未提交'
          : '其它账户存在未终结的 Operation，全局业务恢复尚未提交',
      );
    }
    const currentDigest = dataImportBusinessDigest(this.state.tables, input.scope);
    const original = this.state.receipts.find(
      (entry) =>
        entry.scope.userId === input.scope.userId &&
        entry.scope.accountId === input.scope.accountId &&
        entry.receipt.requestHash === requestHash &&
        entry.receipt.postDigest === currentDigest,
    )?.receipt;
    let receipt: DataImportReceipt;
    let tables = this.state.tables;
    if (original !== undefined) receipt = { ...original, requestId: input.requestId };
    else {
      // 备份只对「真的要写业务事实」的路径是前置条件（持久 alias 不写数据）：
      // 必须是为本次快照做的、且对应现在这份目标事实。
      if (input.backup === undefined || input.backup.backupId === '')
        throw new DataImportError('stale', '缺少恢复前一致性备份，拒绝提交');
      if (input.backup.archiveDigest !== input.snapshot.archiveDigest)
        throw new DataImportError('conflict', '备份不是为本次快照生成的');
      if (input.backup.targetDigest !== currentDigest)
        throw new DataImportError('stale', '备份对应的目标状态已变化，请重新备份并重新预检');

      if (input.now > input.preview.expiresAt) throw new DataImportError('stale', '导入预检已过期');
      const plan = planDataImportRestore(
        input.snapshot,
        tables,
        input.scope,
        input.preview.expiresAt - DATA_IMPORT_PREVIEW_TTL_MS,
      );
      if (plan.preview.previewHash !== input.preview.previewHash)
        throw new DataImportError('stale', '目标业务内容或快照已变化，请重新预检');
      tables = plan.tables;
      receipt = {
        requestId: input.requestId,
        originalRequestId: input.requestId,
        requestHash,
        archiveDigest: input.snapshot.archiveDigest,
        committedAt: input.now,
        postDigest: plan.preview.postDigest,
        actual: Object.fromEntries(
          Object.entries(tables).map(([table, rows]) => [table, rows.length]),
        ),
      };
    }
    // Both facts and the request identity become visible through one state replacement.
    const committed = structuredClone({
      ...this.state,
      tables,
      receipts: [...this.state.receipts, { scope: input.scope, receipt }],
    });
    this.state = committed;
    return structuredClone(receipt);
  }
}
