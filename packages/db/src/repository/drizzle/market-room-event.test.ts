import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKET_ROOM_EVENT_DEFAULT_RULES,
  type MarketRoomEvent,
  type MarketRoomEventKind,
  MarketRoomEventSchema,
  marketRoomEventId,
} from '@luoome/core';

import { createDrizzleRepos } from '../../client.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const sectorRef = (sectorId: string, name = '扩散题材') => ({
  sectorId,
  kind: 'industry' as const,
  vendorCode: '881001.TI',
  name,
});

const eventOf = (input: {
  readonly sectorId?: string;
  readonly kind?: MarketRoomEventKind;
  readonly sampledAt?: string;
  readonly recordedAt?: string;
}): MarketRoomEvent => {
  const sectorId = input.sectorId ?? 'sector-a';
  const kind = input.kind ?? 'diffusion';
  const sampledAt = at(input.sampledAt ?? '09:45');
  const baseSampledAt = new Date(sampledAt.getTime() - 5 * 60_000);
  const previousSampledAt = baseSampledAt;
  const rotation =
    kind === 'rotation'
      ? {
          from: {
            sector: sectorRef('sector-from', '旧题材'),
            dayRank: 1,
            dayChangePct: 3.2,
            windowChangePct: -0.4,
          },
          to: {
            sector: sectorRef(sectorId, '新题材'),
            dayRank: 2,
            dayChangePct: 3.1,
            windowChangePct: 0.9,
          },
          leadSamples: [
            {
              sampledAt: baseSampledAt,
              fromWindowChangePct: -0.4,
              toWindowChangePct: 0.9,
              deltaPp: 1.3,
            },
          ],
        }
      : undefined;
  return MarketRoomEventSchema.parse({
    id: marketRoomEventId({ tradingDate: TRADING_DATE, kind, sectorId, sampledAt }),
    tradingDate: TRADING_DATE,
    kind,
    sector: sectorRef(sectorId),
    sampledAt,
    previousSampledAt,
    status: 'partial',
    thresholds: MARKET_ROOM_EVENT_DEFAULT_RULES[kind],
    evidence: {
      window: {
        lookbackSamples: 1,
        baseSampledAt,
        sampledAt,
        spanMs: 5 * 60_000,
        status: 'complete',
        changePct: 1.2,
        sampleCount: 3,
        missingCount: 0,
        nonTradableCount: 0,
        method: '窗口涨幅口径',
        reason: null,
        warnings: [],
      },
      ranking: {
        sort: 'day',
        dayRank: 1,
        sectorCount: 2,
        dayChangePct: 2.1,
        method: '名次口径',
      },
      breadth: {
        status: 'complete',
        advancing: 3,
        declining: 0,
        unchanged: 0,
        sampleCount: 3,
        memberCount: 3,
        missingCount: 0,
        nonTradableCount: 0,
        advanceRatio: 100,
        baseAdvanceRatio: 66.67,
        deltaPp: 33.33,
        baseSampledAt,
        method: '上涨面口径',
        warnings: [],
      },
      turnover: {
        status: 'complete',
        sharePct: 50,
        baseSharePct: 45,
        deltaPp: 5,
        numeratorAmount: 100_000_000,
        marketAmountDelta: 200_000_000,
        sampleCount: 3,
        memberCount: 3,
        missingCount: 0,
        baseSampledAt,
        method: '成交占比口径',
        reason: null,
        warnings: [],
      },
      ladder: {
        status: 'unavailable',
        sampledAt: null,
        source: null,
        sealedCount: null,
        stocks: [],
        method: '封板口径',
        reason: 'limit_up_missing: 无对齐天梯样本',
      },
      members: {
        memberCount: 3,
        shownCount: 0,
        truncated: true,
        peers: [],
        method: '成分口径',
      },
      keywords: [],
      ...(rotation === undefined ? {} : { rotation }),
    },
    verification: { status: 'verified', basis: 'sector_catalog:industry:881001.TI' },
    recordedAt: at(input.recordedAt ?? '09:46'),
  });
};

describe('market room event 持久化', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('同一事件重复保存只保留首次写入', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const first = eventOf({});
      await expect(repos.marketRoomEvent.save(first)).resolves.toEqual({
        created: true,
        event: first,
      });

      const retry = eventOf({ recordedAt: '10:30' });
      const second = await repos.marketRoomEvent.save(retry);
      expect(second.created).toBe(false);
      expect(second.event.recordedAt).toEqual(first.recordedAt);
      expect(second.event).toEqual(first);

      expect(await repos.marketRoomEvent.list()).toHaveLength(1);
      expect(await repos.marketRoomEvent.findById(first.id)).toEqual(first);
    } finally {
      handle.close();
    }
  });

  it('进程重启后事件仍只有一条，重复扫描不新增', async () => {
    directory = mkdtempSync(join(tmpdir(), 'luoome-market-room-event-'));
    const dbPath = join(directory, 'luoome.db');
    const first = createDrizzleRepos(dbPath);
    const event = eventOf({ sectorId: 'sector-restart' });
    try {
      await expect(first.repos.marketRoomEvent.save(event)).resolves.toMatchObject({
        created: true,
      });
    } finally {
      first.close();
    }

    const reopened = createDrizzleRepos(dbPath);
    try {
      expect(await reopened.repos.marketRoomEvent.list()).toEqual([event]);
      await expect(reopened.repos.marketRoomEvent.save(event)).resolves.toMatchObject({
        created: false,
      });
      expect(await reopened.repos.marketRoomEvent.list()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('按交易日 / 种类 / 板块 / 时点范围过滤，并按检测时点排序', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const diffusion = eventOf({ sectorId: 'sector-a', sampledAt: '09:45' });
      const divergence = eventOf({
        sectorId: 'sector-a',
        kind: 'divergence',
        sampledAt: '09:50',
      });
      const rotation = eventOf({ sectorId: 'sector-b', kind: 'rotation', sampledAt: '09:55' });
      for (const event of [rotation, diffusion, divergence]) {
        await repos.marketRoomEvent.save(event);
      }

      expect((await repos.marketRoomEvent.list()).map((item) => item.id)).toEqual([
        diffusion.id,
        divergence.id,
        rotation.id,
      ]);
      expect((await repos.marketRoomEvent.list({ order: 'desc' })).map((item) => item.id)).toEqual([
        rotation.id,
        divergence.id,
        diffusion.id,
      ]);
      expect(
        (await repos.marketRoomEvent.list({ kind: 'divergence' })).map((item) => item.id),
      ).toEqual([divergence.id]);
      expect(
        (await repos.marketRoomEvent.list({ sectorId: 'sector-a' })).map((item) => item.id),
      ).toEqual([diffusion.id, divergence.id]);
      expect(await repos.marketRoomEvent.list({ tradingDate: '2026-09-29' })).toEqual([]);
      expect(
        (
          await repos.marketRoomEvent.list({
            from: at('09:48'),
            to: at('09:53'),
          })
        ).map((item) => item.id),
      ).toEqual([divergence.id]);
      expect(await repos.marketRoomEvent.list({ limit: 2 })).toHaveLength(2);
      expect(await repos.marketRoomEvent.findById('missing')).toBeNull();
    } finally {
      handle.close();
    }
  });
});
