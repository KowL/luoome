import { createHash } from 'node:crypto';
import {
  projectTenantExport,
  type TenantExportRequest,
  type TenantExportSnapshotRecord,
  type TenantExportSourceData,
} from '@luoome/core';

export const tenantExportHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const buildTenantExportRecord = (
  request: TenantExportRequest,
  data: TenantExportSourceData,
): TenantExportSnapshotRecord => {
  const snapshot = projectTenantExport(request, data);
  return {
    operationId: request.operationId,
    inputHash: request.inputHash,
    generation: request.generation,
    snapshot,
    receipt: {
      operationId: request.operationId,
      inputHash: request.inputHash,
      resultRef: request.operationId,
      resultHash: tenantExportHash(snapshot),
      status: 'succeeded',
      committedAt: request.now,
    },
  };
};
