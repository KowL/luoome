import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { AShareSentimentManager } from './manager.js';
import type { AShareSentimentRawSnapshot, AShareSentimentSource } from './types.js';

const now = new Date('2026-07-28T07:01:00.000Z');
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const rawSnapshot = (brokenOk = true): AShareSentimentRawSnapshot => ({
  date: '2026-07-28',
  coverage: 'CN_A_SHARES_SH_SZ',
  source: 'fixture',
  sealed: {
    ok: true,
    observedAt: new Date('2026-07-28T07:00:00.000Z'),
    fetchedAt: now,
    entries: [
      {
        stockId: '000002.SZ',
        name: '万科A',
        ladderLevel: 2,
        sealAmount: 80_000_000,
        openCount: 0,
        industry: '房地产',
        concepts: [],
      },
      {
        stockId: '600001.SH',
        name: '测试股份',
        ladderLevel: 1,
        sealAmount: null,
        openCount: null,
        industry: '半导体',
        concepts: [],
      },
    ],
  },
  broken: brokenOk
    ? {
        ok: true,
        observedAt: new Date('2026-07-28T07:00:00.000Z'),
        fetchedAt: now,
        entries: [
          {
            stockId: '600519.SH',
            name: '贵州茅台',
            ladderLevel: 5,
            sealAmount: null,
            openCount: 2,
            industry: '白酒',
            concepts: [],
          },
          {
            stockId: '000002.SZ',
            name: '万科A',
            ladderLevel: 2,
            sealAmount: null,
            openCount: 1,
            industry: '房地产',
            concepts: [],
          },
        ],
      }
    : {
        ok: false,
        fetchedAt: now,
        errorKind: 'http_error',
        errorMessage: 'broken pool HTTP 502',
      },
});

const source = (brokenOk = true): AShareSentimentSource => ({
  name: 'fixture',
  capabilities: ['limit-up', 'broken-board', 'themes'],
  fetch: vi.fn(async () => rawSnapshot(brokenOk)),
});

describe('AShareSentimentManager', () => {
  it('聚合、跨池去重并生成封板分布、leader、热点与 provenance', async () => {
    const manager = new AShareSentimentManager({
      sources: [source()],
      clock: () => now,
      logger,
    });

    const result = await manager.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp).toMatchObject({
      status: 'complete',
      value: {
        sealedCount: 2,
        brokenCount: 1,
        brokenRate: 1 / 3,
        maxLadderLevel: 2,
        totalSealAmount: null,
        boardDistribution: { '1': 1, '2': 1 },
      },
    });
    expect(result.data.limitUp.value?.leaders[0]).toMatchObject({
      stockId: '000002.SZ',
      ladderLevel: 2,
      sealAmount: 80_000_000,
      openCount: 0,
    });
    expect(result.data.themes).toMatchObject({
      status: 'partial',
      value: {
        industries: [
          { name: '白酒', count: 1 },
          { name: '半导体', count: 1 },
          { name: '房地产', count: 1 },
        ],
        concepts: [],
      },
    });
    expect(result.data.indexes.status).toBe('unavailable');
    expect(result.data.breadth.status).toBe('unavailable');
  });

  it('炸板端点失败时标 partial 且不携带无法完整表达的 limitUp value', async () => {
    const manager = new AShareSentimentManager({
      sources: [source(false)],
      clock: () => now,
      logger,
    });
    const result = await manager.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('partial');
    expect(result.data.limitUp.value).toBeUndefined();
    expect(result.data.limitUp.warnings.join(' ')).toContain('broken pool HTTP 502');
    expect(result.data.themes.status).toBe('partial');
  });

  it('短 TTL 内复用按日期和 coverage 缓存的快照', async () => {
    const fixtureSource = source();
    const manager = new AShareSentimentManager({
      sources: [fixtureSource],
      clock: () => now,
      logger,
    });
    const input = { date: '2026-07-28', coverage: 'CN_A_SHARES_SH_SZ' as const };
    await manager.fetch(input);
    await manager.fetch(input);
    expect(fixtureSource.fetch).toHaveBeenCalledTimes(1);
  });

  it('主源维度失败时使用 fallback，并在 provenance 记录 fallbackFrom', async () => {
    const primary = source(false);
    const fallback = { ...source(true), name: 'fallback' };
    const manager = new AShareSentimentManager({
      sources: [primary, fallback],
      clock: () => now,
      logger,
    });
    const result = await manager.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('complete');
    expect(result.data.limitUp.provenance[1]).toMatchObject({
      provider: 'fallback/broken-board',
      fallbackFrom: 'fixture/broken-board',
    });
  });

  it('周末不调用外部来源并返回 invalid_input', async () => {
    const fixtureSource = source();
    const manager = new AShareSentimentManager({
      sources: [fixtureSource],
      clock: () => now,
      logger,
    });
    const result = await manager.fetch({
      date: '2026-07-25',
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(fixtureSource.fetch).not.toHaveBeenCalled();
  });
});
