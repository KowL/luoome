import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  MoneySchema,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getAShareSentimentTool } from './get-ashare-sentiment.js';

const now = new Date('2026-07-28T07:10:00.000Z');
const observedAt = new Date('2026-07-28T07:00:00.000Z');

const baseSnapshot = (): AShareSentimentSnapshot => ({
  date: '2026-07-28',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: observedAt,
  indexes: {
    status: 'unavailable',
    provenance: [
      {
        provider: 'luoome/market-index',
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable',
        errorKind: 'not_requested',
      },
    ],
    warnings: ['composed by tool'],
  },
  breadth: {
    status: 'unavailable',
    provenance: [
      {
        provider: 'luoome/market-snapshot',
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable',
        errorKind: 'incomplete_coverage',
      },
    ],
    warnings: ['market snapshot completeness envelope is unavailable'],
  },
  limitUp: {
    status: 'complete',
    provenance: [
      {
        provider: 'eastmoney/limit-up',
        observedAt,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    value: {
      sealedCount: 0,
      brokenCount: 0,
      brokenRate: null,
      maxLadderLevel: 0,
      totalSealAmount: 0,
      boardDistribution: {},
      leaders: [],
    },
  },
  themes: {
    status: 'partial',
    provenance: [
      {
        provider: 'eastmoney/limit-up',
        observedAt,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: ['concept themes unavailable'],
    value: { industries: [], concepts: [] },
  },
});

const manager: AShareSentimentManagerLike = {
  status: () => [],
  fetch: async () => ({ ok: true, data: baseSnapshot() }),
};

describe('get_ashare_sentiment', () => {
  it('组合同交易日 IndexQuote，changePct 保持百分点单位', async () => {
    const base = await buildTestContext({ clock: () => now, ashareSentiment: manager });
    const market = {
      ...base.adapters.market,
      name: 'fixture-market',
      fetchIndexQuotes: async () => [
        {
          code: '000001',
          name: '上证指数',
          close: MoneySchema.parse(3600),
          change: 12,
          changePct: 0.33,
          ts: observedAt,
          source: 'eastmoney',
        },
      ],
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const result = await getAShareSentimentTool.execute({ date: '2026-07-28' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshot.indexes).toMatchObject({
      status: 'complete',
      values: [{ code: '000001', changePct: 0.33 }],
    });
    expect(result.data.snapshot.breadth).toMatchObject({
      status: 'unavailable',
      warnings: ['market snapshot completeness envelope is unavailable'],
    });
  });

  it('历史交易日拒绝混入当前实时指数并返回维度 unavailable', async () => {
    const historical = baseSnapshot();
    historical.date = '2026-07-27';
    const historicalManager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async () => ({ ok: true, data: historical }),
    };
    const base = await buildTestContext({
      clock: () => now,
      ashareSentiment: historicalManager,
    });
    const market = {
      ...base.adapters.market,
      fetchIndexQuotes: async () => [
        {
          code: '000001',
          name: '上证指数',
          close: MoneySchema.parse(3600),
          change: 12,
          changePct: 0.33,
          ts: observedAt,
          source: 'eastmoney',
        },
      ],
    };
    const result = await getAShareSentimentTool.execute(
      { date: '2026-07-27' },
      { ...base, adapters: { ...base.adapters, market } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshot.indexes.status).toBe('unavailable');
    expect(result.data.snapshot.indexes.values).toBeUndefined();
    expect(result.data.snapshot.indexes.warnings.join(' ')).toContain('requested date');
  });

  it('指数适配失败不拖垮情绪快照', async () => {
    const base = await buildTestContext({ clock: () => now, ashareSentiment: manager });
    const market = {
      ...base.adapters.market,
      name: 'failed-market',
      fetchIndexQuotes: async (): Promise<never> => {
        throw new Error('timeout');
      },
    };
    const result = await getAShareSentimentTool.execute(
      { date: '2026-07-28' },
      { ...base, adapters: { ...base.adapters, market } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshot.limitUp.status).toBe('complete');
    expect(result.data.snapshot.indexes).toMatchObject({
      status: 'unavailable',
      provenance: [{ provider: 'failed-market', errorKind: 'adapter_error' }],
    });
  });

  it('includeIndexes=false 不调用指数适配器', async () => {
    const base = await buildTestContext({ clock: () => now, ashareSentiment: manager });
    let called = false;
    const market = {
      ...base.adapters.market,
      fetchIndexQuotes: async () => {
        called = true;
        return [];
      },
    };
    const result = await getAShareSentimentTool.execute(
      { date: '2026-07-28', includeIndexes: false, includeBreadth: false },
      { ...base, adapters: { ...base.adapters, market } },
    );
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    if (!result.ok) return;
    expect(result.data.snapshot.indexes.provenance[0]?.errorKind).toBe('not_requested');
    expect(result.data.snapshot.breadth.provenance[0]?.errorKind).toBe('not_requested');
  });

  it('manager 判定非交易日时映射为 invalid_input', async () => {
    const invalidManager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async () => ({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'not a trading day',
          recoverable: false,
        },
      }),
    };
    const ctx = await buildTestContext({ ashareSentiment: invalidManager });
    const result = await getAShareSentimentTool.execute({ date: '2026-07-25' }, ctx);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
