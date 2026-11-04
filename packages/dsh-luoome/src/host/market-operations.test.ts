import { randomUUID } from 'node:crypto';
import type { MarketDumpSyncResultLike, SideEffect } from '@luoome/core';
import { createPluginOperationService } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { syncMarketDumpOperation } from './market-operations.js';

const result: MarketDumpSyncResultLike = {
  runId: 'dump-run',
  kind: 'daily-k-10d',
  dumpId: 'daily-k-10d-fixture',
  artifactSha256: 'a'.repeat(64),
  status: 'complete',
  resumed: false,
  processedRows: 3,
  nextRowOffset: 3,
  minDate: null,
  maxDate: null,
  recordedAt: new Date('2026-11-04T00:00:00Z'),
  startedAt: new Date('2026-11-04T00:00:00Z'),
  finishedAt: new Date('2026-11-04T00:00:00Z'),
  errorKind: null,
  errorMessage: null,
};

const fixture = async (capabilities: readonly Exclude<SideEffect, 'trade'>[]) => {
  const sync = vi.fn(async () => result);
  const ctx = await buildTestContext({
    marketDump: { name: 'market-dump', sync, status: async () => [] },
  });
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: [syncMarketDumpOperation],
    capabilities,
    policyVersion: 1,
    now: Date.now,
    context: () => ctx,
  });
  return { ctx, principal, service, sync };
};

describe('market dump Operation', () => {
  it.each([
    { capabilities: ['external'] },
    { capabilities: ['write'] },
    { capabilities: [] },
  ] satisfies { capabilities: SideEffect[] }[])(
    'requires both capabilities: $capabilities',
    async ({ capabilities }) => {
      const { service, principal, sync } = await fixture(capabilities);
      try {
        expect(
          await service.prepare(principal, {
            id: randomUUID(),
            tool: 'sync_market_dump',
            input: { kind: 'daily-k-10d' },
          }),
        ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
        expect(sync).not.toHaveBeenCalled();
      } finally {
        service.dispose();
      }
    },
  );

  it('executes once through Operation and replays the persisted receipt', async () => {
    const { service, principal, sync } = await fixture(['external', 'write']);
    try {
      expect(syncMarketDumpOperation.scheduled).toBe(false);
      const id = randomUUID();
      const prepared = await service.prepare(principal, {
        id,
        tool: 'sync_market_dump',
        input: { kind: 'daily-k-10d', resumeRunId: 'resume-run' },
      });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const token = (prepared.data as { confirmationToken: string }).confirmationToken;
      expect(sync).not.toHaveBeenCalled();
      for (let index = 0; index < 2; index++) {
        expect(
          await service.confirm(principal, { id, token }, new AbortController().signal),
        ).toMatchObject({
          ok: true,
          data: { state: 'succeeded', result: { ok: true, data: { runId: result.runId } } },
        });
      }
      expect(sync).toHaveBeenCalledExactlyOnceWith({
        kind: 'daily-k-10d',
        resumeRunId: 'resume-run',
      });
    } finally {
      service.dispose();
    }
  });

  it('binds the owner and rejects extra fields without guessing an interrupted run receipt', async () => {
    const { ctx, principal, service } = await fixture(['external', 'write']);
    try {
      expect(() =>
        syncMarketDumpOperation.bind(
          { kind: 'daily-k' },
          { ...principal, userId: 'other' },
          randomUUID(),
          ctx,
        ),
      ).toThrow();
      expect(() =>
        syncMarketDumpOperation.bind(
          { kind: 'daily-k', accountId: 'other' },
          principal,
          randomUUID(),
          ctx,
        ),
      ).toThrow();
      expect(await syncMarketDumpOperation.receipt({ kind: 'daily-k' }, ctx)).toBeNull();
    } finally {
      service.dispose();
    }
  });
});
