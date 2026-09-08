import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';

import {
  getAccountSnapshotTool,
  listAccountSnapshotsTool,
  saveAccountSnapshotTool,
} from './account-snapshot.js';

describe('account snapshot tools', () => {
  it('saves a complete manual version with a consistent asset denominator', async () => {
    const ctx = await buildTestContext();
    const input = {
      accountId: ctx.user.defaultAccountId,
      asOf: new Date('2026-09-08T01:00:00.000Z'),
      cashBalance: 700,
      positions: [
        {
          stockId: '002594.SZ',
          quantity: 10,
          availableQuantity: 10,
          marketValue: 300,
          industry: '汽车',
        },
      ],
    };
    const saved = await saveAccountSnapshotTool.execute(input, ctx);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.snapshot.version).toBe(1);
    expect(saved.data.snapshot.stockMarketValue).toBe(300);
    expect(saved.data.snapshot.totalAssets).toBe(1000);

    const read = await getAccountSnapshotTool.execute(
      { accountId: ctx.user.defaultAccountId },
      ctx,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.snapshot.id).toBe(saved.data.snapshot.id);

    const second = await saveAccountSnapshotTool.execute(
      { ...input, cashBalance: 600, asOf: new Date('2026-09-08T02:00:00.000Z') },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.snapshot.version).toBe(2);
    const history = await listAccountSnapshotsTool.execute(
      { accountId: ctx.user.defaultAccountId, limit: 10 },
      ctx,
    );
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.data.snapshots.map((item) => item.version)).toEqual([2, 1]);
  });

  it('keeps a needs-reconciliation snapshot but does not expose precise total assets', async () => {
    const ctx = await buildTestContext();
    const result = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        status: 'needs-reconciliation',
        cashBalance: 700,
        positions: [{ stockId: '002594.SZ', quantity: 10, availableQuantity: 0, marketValue: 300 }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.snapshot.totalAssets).toBe(null);
      expect(result.data.snapshot.stockMarketValue).toBe(null);
    }
  });

  it('rejects an unavailable quantity greater than the holding quantity', async () => {
    const ctx = await buildTestContext();
    const result = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        cashBalance: 1000,
        positions: [
          { stockId: '002594.SZ', quantity: 10, availableQuantity: 11, marketValue: 300 },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });
});
