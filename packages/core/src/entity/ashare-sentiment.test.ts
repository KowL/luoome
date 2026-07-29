import { describe, expect, it } from 'vitest';
import { MoneySchema } from '../types/branded.js';
import {
  type AShareSentimentSnapshot,
  AShareSentimentSnapshotSchema,
  assertAShareSentimentSnapshotInvariants,
} from './ashare-sentiment.js';

const observedAt = new Date('2026-07-28T07:00:00.000Z');

const provenance = {
  provider: 'eastmoney',
  observedAt,
  fetchedAt: new Date('2026-07-28T07:00:10.000Z'),
  freshness: 'fresh' as const,
};

const makeSnapshot = (): AShareSentimentSnapshot => ({
  date: '2026-07-28',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: observedAt,
  indexes: {
    status: 'complete',
    provenance: [{ ...provenance, provider: 'market/eastmoney' }],
    warnings: [],
    values: [
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
  },
  breadth: {
    status: 'unavailable',
    provenance: [
      {
        ...provenance,
        provider: 'luoome',
        freshness: 'unavailable',
        errorKind: 'incomplete_coverage',
      },
    ],
    warnings: ['market snapshot completeness envelope is unavailable'],
  },
  limitUp: {
    status: 'complete',
    provenance: [provenance],
    warnings: [],
    value: {
      sealedCount: 2,
      brokenCount: 1,
      brokenRate: 1 / 3,
      maxLadderLevel: 2,
      totalSealAmount: 120_000_000,
      boardDistribution: { '1': 1, '2': 1 },
      leaders: [
        {
          stockId: '000002.SZ',
          name: '万科A',
          ladderLevel: 2,
          sealAmount: 80_000_000,
          openCount: 0,
        },
      ],
    },
  },
  themes: {
    status: 'partial',
    provenance: [provenance],
    warnings: ['concepts unavailable from source'],
    value: {
      industries: [{ name: '房地产', count: 2 }],
      concepts: [],
    },
  },
});

describe('AShareSentimentSnapshot', () => {
  it('接受包含维度状态、真实零值与溯源的快照', () => {
    const parsed = AShareSentimentSnapshotSchema.parse(makeSnapshot());
    expect(parsed.limitUp.value?.brokenRate).toBeCloseTo(1 / 3);
    expect(() => assertAShareSentimentSnapshotInvariants(parsed)).not.toThrow();
  });

  it('拒绝 unavailable 维度携带伪造 value', () => {
    const snapshot = makeSnapshot();
    snapshot.breadth = {
      ...snapshot.breadth,
      value: { advancing: 0, declining: 0, unchanged: 1, total: 1 },
    };
    expect(() => assertAShareSentimentSnapshotInvariants(snapshot)).toThrow(
      /unavailable breadth.*value/,
    );
  });

  it('拒绝 complete 维度缺少 value', () => {
    const snapshot = makeSnapshot();
    snapshot.limitUp = { ...snapshot.limitUp, value: undefined };
    expect(() => assertAShareSentimentSnapshotInvariants(snapshot)).toThrow(
      /complete limitUp.*value/,
    );
  });

  it('完整封板和炸板数据按样本数计算 brokenRate，零分母为 null', () => {
    const incorrect = makeSnapshot();
    if (incorrect.limitUp.value === undefined) throw new Error('fixture');
    incorrect.limitUp.value = { ...incorrect.limitUp.value, brokenRate: 0.5 };
    expect(() => assertAShareSentimentSnapshotInvariants(incorrect)).toThrow(/brokenRate/);

    const empty = makeSnapshot();
    if (empty.limitUp.value === undefined) throw new Error('fixture');
    empty.limitUp.value = {
      ...empty.limitUp.value,
      sealedCount: 0,
      brokenCount: 0,
      brokenRate: null,
      maxLadderLevel: 0,
      totalSealAmount: 0,
      boardDistribution: {},
      leaders: [],
    };
    expect(() => assertAShareSentimentSnapshotInvariants(empty)).not.toThrow();
  });

  it('市场宽度 total 必须等于涨跌平数量之和', () => {
    const snapshot = makeSnapshot();
    snapshot.breadth = {
      status: 'complete',
      provenance: [provenance],
      warnings: [],
      value: { advancing: 2, declining: 1, unchanged: 1, total: 5 },
    };
    expect(() => assertAShareSentimentSnapshotInvariants(snapshot)).toThrow(/breadth total/);
  });
});
