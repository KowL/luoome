import { describe, expect, it } from 'bun:test';
import { MarketDayFixtureAdapter } from '@luoome/adapters/testing';
import { buildTestContext } from '@luoome/tools/testing';
import { createWebApp } from './server.js';

interface OverviewBody {
  readonly ok: boolean;
  readonly data?: {
    readonly overview: {
      readonly state: string;
      readonly emptyReason?: string;
      readonly asOf?: string;
      readonly tradingDate: string;
      readonly latestBatch: { readonly tradingDate: string; readonly sampledAt: string } | null;
      readonly coverage: {
        readonly status: string;
        readonly value?: { readonly sampledAt: string; readonly receivedCount: number };
      };
      readonly breadth: {
        readonly status: string;
        readonly value?: { readonly sampleCount: number };
      };
      readonly amount: {
        readonly status: string;
        readonly value?: {
          readonly currentAmount: number;
          readonly currentSampleCount: number;
        };
      };
      readonly limitUp: { readonly status: string; readonly value?: unknown };
      readonly indexes: {
        readonly status: string;
        readonly value?: { readonly values: readonly { readonly code: string }[] };
      };
    };
  };
}

interface CollectBody {
  readonly ok: boolean;
  readonly data?: { readonly created: boolean; readonly batch: { readonly id: string } };
}

/**
 * P1-7 作战室盘中批次离线验收：受控时钟 + MarketDayFixtureAdapter 生成一个盘中批次，
 * 再通过 `/api/market/room/*` 读出非空总览与回放，不访问真实行情。
 */
describe('作战室盘中批次离线验收（fixture 行情 + 假时钟）', () => {
  it('采集一个盘中批次后可读出非空总览，刷新与回放都不重复采集', async () => {
    const now = new Date('2026-09-28T10:16:00+08:00');
    const ctx = await buildTestContext({ clock: () => new Date(now.getTime()) });
    const adapter = new MarketDayFixtureAdapter({ clock: () => new Date(now.getTime()) });
    const web = createWebApp(
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
      { exposeWrite: true, exposeExternal: true },
    );
    const getOverview = async (query = ''): Promise<OverviewBody> => {
      const response = await web.fetch(new Request(`http://test/api/market/room/overview${query}`));
      expect(response.status).toBe(200);
      return (await response.json()) as OverviewBody;
    };

    const before = await getOverview();
    expect(before.data?.overview).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      tradingDate: '2026-09-28',
    });
    expect(adapter.envelopeCalls).toBe(0);

    const collected = await web.fetch(
      new Request('http://test/api/market/room/collect', { method: 'POST' }),
    );
    expect(collected.status).toBe(200);
    const collectBody = (await collected.json()) as CollectBody;
    expect(collectBody.data?.created).toBe(true);
    expect(adapter.envelopeCalls).toBe(1);

    const overview = (await getOverview()).data?.overview;
    expect(overview?.state).toBe('ready');
    expect(overview?.emptyReason).toBeUndefined();
    expect(overview?.latestBatch?.sampledAt).toBe('2026-09-28T02:16:00.000Z');
    expect(overview?.coverage.value).toMatchObject({
      sampledAt: '2026-09-28T02:16:00.000Z',
      receivedCount: 10,
    });
    expect(overview?.breadth.value).toMatchObject({ sampleCount: 10 });
    expect(overview?.amount.value?.currentAmount ?? 0).toBeGreaterThan(0);
    expect(overview?.amount.value?.currentSampleCount).toBe(10);
    expect(overview?.limitUp.value).toBeUndefined();
    expect(overview?.indexes.value?.values.map((entry) => entry.code)).toEqual([
      '000001',
      '399001',
      '399006',
      '000300',
    ]);

    const replay = (await getOverview(`?at=${encodeURIComponent('2026-09-28T10:16:00+08:00')}`))
      .data?.overview;
    expect(replay?.state).toBe('ready');
    expect(replay?.asOf).toBe('2026-09-28T02:16:00.000Z');
    expect(replay?.breadth.value).toMatchObject({ sampleCount: 10 });
    expect(replay?.indexes.status).toBe('unavailable');
    expect(adapter.envelopeCalls).toBe(1);
  }, 30_000);
});
