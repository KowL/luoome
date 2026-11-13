import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketSnapshotBatch } from '@luoome/core';

import { createDrizzleRepos } from '../../client.js';

const batch: MarketSnapshotBatch = {
  id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:15:00.000Z',
  coverage: 'CN_A_SHARES_SH_SZ',
  tradingDate: '2026-09-28',
  sampledAt: new Date('2026-09-28T02:15:00.000Z'),
  source: 'eastmoney',
  fetchedAt: new Date('2026-09-28T02:16:02.000Z'),
  observedAt: new Date('2026-09-28T02:16:00.000Z'),
  dataAsOf: new Date('2026-09-28T02:16:00.000Z'),
  completeness: {
    expectedCount: 1,
    receivedCount: 1,
    missingCount: 0,
    duplicateCount: 0,
    complete: true,
  },
  gaps: [],
  items: [
    {
      id: '600519.SH',
      code: '600519',
      exchange: 'SH',
      name: '贵州茅台',
      close: 1500,
      changePct: 1.2,
      amount: 3_000_000_000,
    },
  ],
};

describe('market snapshot batch 持久化', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('进程重启后已发布批次仍可读取，且重复打开保持幂等', async () => {
    directory = mkdtempSync(join(tmpdir(), 'luoome-market-batch-'));
    const dbPath = join(directory, 'luoome.db');
    const first = createDrizzleRepos(dbPath);
    try {
      await expect(first.repos.marketSnapshotBatch.publish(batch)).resolves.toEqual({
        created: true,
        batch,
      });
    } finally {
      first.close();
    }

    const reopened = createDrizzleRepos(dbPath);
    try {
      expect(await reopened.repos.marketSnapshotBatch.findLatest()).toEqual(batch);
      expect(await reopened.repos.marketSnapshotBatch.findById(batch.id)).toEqual(batch);
      await expect(reopened.repos.marketSnapshotBatch.publish(batch)).resolves.toEqual({
        created: false,
        batch,
      });
    } finally {
      reopened.close();
    }
  });
});
