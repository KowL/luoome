import {
  InvariantError,
  type TenantExportRepository,
  type TenantExportRequest,
  TenantExportRequestSchema,
  type TenantExportSnapshotRecord,
  type TenantExportSourceData,
} from '@luoome/core';
import { buildTenantExportRecord } from './tenant-export-record.js';

export class InMemoryTenantExportRepository implements TenantExportRepository {
  private readonly records = new Map<string, TenantExportSnapshotRecord>();

  constructor(private readonly source: () => TenantExportSourceData) {}

  async createSnapshot(
    input: TenantExportRequest,
  ): Promise<TenantExportSnapshotRecord & { readonly replayed: boolean }> {
    const request = TenantExportRequestSchema.parse(input);
    const existing = this.records.get(request.operationId);
    if (existing !== undefined) {
      if (existing.inputHash !== request.inputHash || existing.generation !== request.generation)
        throw new InvariantError('export operation input identity conflict');
      return { ...structuredClone(existing), replayed: true };
    }
    const record = buildTenantExportRecord(request, this.source());
    this.records.set(record.operationId, structuredClone(record));
    return { ...structuredClone(record), replayed: false };
  }

  async findSnapshot(operationId: string): Promise<TenantExportSnapshotRecord | null> {
    return structuredClone(this.records.get(operationId) ?? null);
  }
}
