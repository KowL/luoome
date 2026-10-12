import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Tenant,
  type TenantTombstone,
  TenantTombstoneSchema,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { createTenantExportSnapshotTool } from '@luoome/tools/hosted';
import {
  completeHostedDeletionTool,
  completeHostedExportTool,
  expireHostedExportsTool,
  failHostedExportTool,
  getWorkerTenantTool,
  listHostedDeletionsTool,
  listHostedExportsTool,
  listWorkerHostedDeliveriesTool,
  listWorkerHostedJobsTool,
  markHostedDeletionNeedsReviewTool,
  type PlatformContext,
  recoverSendingHostedDeliveryTool,
  stopHostedJobTool,
} from '@luoome/tools/platform';
import type { HostedService } from './hosted-composition.js';
import {
  TenantManifestSchema,
  type TenantRuntimeLease,
  writePrivateArtifact,
} from './hosted-runtime.js';

const value = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
};
export const prepareDeletionLedger = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid_deletion_ledger');
  chmodSync(directory, 0o700);
};
export const readDeletionLedger = (directory: string): readonly TenantTombstone[] => {
  if (!existsSync(directory)) throw new Error('deletion_ledger_missing');
  prepareDeletionLedger(directory);
  return readdirSync(directory)
    .filter((leaf) => !/^\.write-[a-f0-9-]{36}\.tmp$/.test(leaf))
    .map((leaf) => {
      if (!leaf.endsWith('.json')) throw new Error('invalid_deletion_ledger');
      const id = leaf.slice(0, -5);
      TenantManifestSchema.shape.tenantId.parse(id);
      const path = join(directory, leaf);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_deletion_ledger');
      const tombstone = TenantTombstoneSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (tombstone.id !== id) throw new Error('invalid_deletion_ledger');
      return tombstone;
    });
};
export const persistDeletionTombstone = (
  directory: string,
  tombstone: TenantTombstone,
): TenantTombstone => {
  TenantTombstoneSchema.parse(tombstone);
  TenantManifestSchema.shape.tenantId.parse(tombstone.id);
  prepareDeletionLedger(directory);
  const existing = readDeletionLedger(directory).find((entry) => entry.id === tombstone.id);
  if (existing !== undefined) {
    if (existing.generation !== tombstone.generation)
      throw new Error('deletion_ledger_generation_conflict');
    return existing;
  }
  writePrivateArtifact(directory, `${tombstone.id}.json`, JSON.stringify(tombstone));
  return tombstone;
};

export const processHostedPrivacy = async (
  service: HostedService,
  platform: PlatformContext,
  context: (tenant: Tenant, lease: TenantRuntimeLease) => ToolContext | Promise<ToolContext>,
): Promise<boolean> => {
  let processed = false;
  for (const metadata of value(await expireHostedExportsTool.execute({}, platform)))
    service.runtimes.removeExport(metadata.tenantId, metadata.id);
  for (const metadata of value(
    await listHostedExportsTool.execute({ states: ['requested'] }, platform),
  ).slice(0, 20)) {
    let lease: TenantRuntimeLease | undefined;
    try {
      const tenant = value(
        await getWorkerTenantTool.execute({ tenantId: metadata.tenantId }, platform),
      );
      if (
        !['active', 'suspended'].includes(tenant.status) ||
        tenant.generation !== metadata.generation
      )
        continue;
      const manifest = {
        tenantId: tenant.id,
        ownerUserId: tenant.ownerUserId,
        generation: tenant.generation,
        schemaVersion: tenant.schemaVersion,
      };
      lease = service.runtimes.acquire(manifest);
      const snapshot = value(
        await createTenantExportSnapshotTool.execute(
          {
            operationId: metadata.operationId,
            inputHash: metadata.inputHash,
            generation: metadata.generation,
          },
          await context(tenant, lease),
        ),
      );
      const content = JSON.stringify(snapshot.snapshot);
      const resultHash = createHash('sha256').update(content).digest('hex');
      if (resultHash !== snapshot.receipt.resultHash) throw new Error('export_receipt_mismatch');
      service.runtimes.writeExport(manifest, metadata.id, content);
      value(
        await completeHostedExportTool.execute(
          {
            id: metadata.id,
            generation: metadata.generation,
            resultHash,
            byteLength: Buffer.byteLength(content, 'utf8'),
          },
          platform,
        ),
      );
      processed = true;
    } catch {
      value(
        await failHostedExportTool.execute(
          { id: metadata.id, errorKind: 'private-export-unavailable' },
          platform,
        ),
      );
    } finally {
      lease?.release();
    }
  }
  await service.runtimes.pruneUnavailable();
  for (const deletion of value(
    await listHostedDeletionsTool.execute({ states: ['draining', 'needs-review'] }, platform),
  )) {
    try {
      if (
        !service.runtimes.drain(deletion.tenantId) ||
        service.maintenance.runtimeCount(deletion.tenantId) !== 0
      ) {
        if (service.clock().getTime() - deletion.createdAt.getTime() > 60_000)
          value(
            await markHostedDeletionNeedsReviewTool.execute(
              { id: deletion.id, errorKind: 'tenant-drain-pending' },
              platform,
            ),
          );
        continue;
      }
      for (const job of value(
        await listWorkerHostedJobsTool.execute({ tenantId: deletion.tenantId }, platform),
      )) {
        if (job.state !== 'running' || job.attemptId === null) continue;
        value(
          await stopHostedJobTool.execute(
            {
              jobId: job.id,
              fence: job.fence,
              attemptId: job.attemptId,
              state: 'cancelled',
              errorKind: 'tenant-deleting',
              executionStopped: true,
            },
            platform,
          ),
        );
      }
      for (const delivery of value(
        await listWorkerHostedDeliveriesTool.execute({ tenantId: deletion.tenantId }, platform),
      )) {
        if (delivery.state === 'sending')
          value(
            await recoverSendingHostedDeliveryTool.execute({ deliveryId: delivery.id }, platform),
          );
      }
      persistDeletionTombstone(service.config.deletionLedgerRoot, {
        id: deletion.tenantId,
        generation: deletion.generation,
        deletedAt: service.clock(),
      });
      if (!service.runtimes.removeTenant(deletion.tenantId)) continue;
      value(
        await completeHostedDeletionTool.execute(
          { id: deletion.id, generation: deletion.generation },
          platform,
        ),
      );
      processed = true;
    } catch {
      value(
        await markHostedDeletionNeedsReviewTool.execute(
          { id: deletion.id, errorKind: 'private-deletion-unavailable' },
          platform,
        ),
      );
    }
  }
  return processed;
};
