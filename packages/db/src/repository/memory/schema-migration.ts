import type { SchemaMigrationRecord, SchemaMigrationRepository } from '@luoome/core';

export class InMemorySchemaMigrationRepository implements SchemaMigrationRepository {
  private readonly records: SchemaMigrationRecord[];
  constructor(records: readonly SchemaMigrationRecord[] = []) {
    this.records = records.map((record) => ({ ...record, appliedAt: new Date(record.appliedAt) }));
  }

  async list(): Promise<readonly SchemaMigrationRecord[]> {
    // Date 必须复制：浅拷贝会让调用方改到内部状态（诊断读模型是只读契约）。
    return this.records.map((record) => ({ ...record, appliedAt: new Date(record.appliedAt) }));
  }
}
