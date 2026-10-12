import { InvariantError, TenantExportSnapshotRecordSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const createTenantExportSnapshotTool = defineTool({
  name: 'create_tenant_export_snapshot',
  description: '冻结当前租户允许的个人业务类别和独立导出收据，排除控制库与市场原始缓存',
  sideEffect: 'write',
  input: z
    .object({
      operationId: z.string().min(1).max(160),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      generation: z.number().int().positive().safe(),
    })
    .strict(),
  output: TenantExportSnapshotRecordSchema.extend({ replayed: z.boolean() }),
  handler: (input, ctx) => {
    if (
      ctx.identity?.mode !== 'hosted' ||
      ctx.identity.actor !== 'worker' ||
      ctx.identity.tenantGeneration !== input.generation
    ) {
      return {
        ok: false as const,
        error: { kind: 'permission_denied' as const, required: 'hosted:worker-generation' },
      };
    }
    if (ctx.repos.hostedExports === undefined)
      throw new InvariantError('tenant export repository missing');
    return ctx.repos.hostedExports.createSnapshot({ ...input, now: ctx.clock() });
  },
});
