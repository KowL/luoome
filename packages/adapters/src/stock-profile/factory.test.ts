import { describe, expect, it } from 'vitest';

import { createStockProfileManagerFromEnv } from './factory.js';

const now = new Date('2026-01-01T00:00:00Z');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const create = (fetchImpl: typeof fetch) =>
  createStockProfileManagerFromEnv({}, { logger, clock: () => now, fetchImpl });

describe('stock profile source integration', () => {
  it('keeps report date separate from retrieval and source health timestamps', async () => {
    const manager = create((async (url: Parameters<typeof fetch>[0]) => {
      const holder = String(url).includes('RPT_HOLDERNUMLATEST');
      return Response.json({
        success: true,
        result: {
          data: holder
            ? [{ SECUCODE: '300476.SZ', END_DATE: '2025-09-30 00:00:00', HOLDER_NUM: 12000 }]
            : [
                {
                  SECUCODE: '300476.SZ',
                  NEW_BOARD_CODE: 'BK0001',
                  BOARD_NAME: '合成板块',
                  IS_PRECISE: '1',
                },
              ],
        },
      });
    }) as unknown as typeof fetch);
    const result = await manager.fetchProfile({ stockId: '300476.SZ' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      asOf: now.toISOString(),
      holders: [{ endDate: '2025-09-30' }],
    });
    expect(manager.status()[0]).toMatchObject({ lastSuccessAt: now });
    expect(manager.status()[0]?.dataAsOf).toBeUndefined();
  });

  it('does not record malformed HTTP 200 as successful empty data', async () => {
    const manager = create((async () =>
      Response.json({ unexpected: 'payload' })) as unknown as typeof fetch);
    expect((await manager.fetchProfile({ stockId: '300476.SZ' })).ok).toBe(false);
    expect(manager.status()[0]?.lastErrorKind).toBe('invalid_payload');
    expect(manager.status()[0]?.lastSuccessAt).toBeUndefined();
  });

  it('keeps temporary upstream failures retryable', async () => {
    const manager = create(
      (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    );
    expect(await manager.fetchProfile({ stockId: '300476.SZ' })).toMatchObject({
      ok: false,
      error: { recoverable: true },
    });
  });
});
