import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import type { LimitUpLadder, LimitUpLadderEntry } from './limit-up-ladder.js';
import { buildLimitUpLadderSample } from './limit-up-ladder-sample.js';
import {
  buildMarketRoomEventsView,
  detectMarketRoomEvents,
  MARKET_ROOM_EVENT_DEFAULT_RULES,
  type MarketRoomEvent,
  type MarketRoomEventRuleOverrides,
  marketRoomEventId,
} from './market-room-events.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch, MarketSnapshotBatchSchema } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  SectorCatalogEntrySchema,
  type SectorKind,
  type StockSectorMembership,
  StockSectorMembershipSchema,
} from './sector-catalog.js';

/**
 * 盘中事件检测的纯函数测试：六时点夹具 + 手工天梯样本。
 *
 * 每个场景都显式给出各样本的日涨幅；收盘价由固定前收推出，因此窗口涨幅与日涨幅自洽。
 * 成交额按样本序号等比放大，板块占比在同一场景内保持稳定，便于单独验证上涨面 / 窗口规则。
 */

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const PREV_CLOSE = 10;

interface SectorSpec {
  readonly id: string;
  readonly kind: SectorKind;
  readonly vendorCode: string;
  readonly name: string;
  readonly stocks: readonly string[];
}

interface SampleSpec {
  readonly time: string;
  /** stockId → 日涨幅（%）；缺省表示该样本缺涨幅，不用 0 补齐。 */
  readonly changePct: Readonly<Record<string, number>>;
}

const sectorEntryOf = (spec: SectorSpec): SectorCatalogEntry =>
  SectorCatalogEntrySchema.parse({
    id: spec.id,
    kind: spec.kind,
    source: 'fuyao',
    vendorCode: spec.vendorCode,
    name: spec.name,
    state: 'active',
    firstSeenAt: at('09:00'),
    lastSeenAt: at('09:00'),
    retiredAt: null,
  });

const membershipsOf = (sectors: readonly SectorSpec[]): StockSectorMembership[] =>
  sectors.flatMap((sector) =>
    sector.stocks.map((stockId) =>
      StockSectorMembershipSchema.parse({
        sectorId: sector.id,
        stockId,
        source: 'fuyao',
        state: 'active',
        memberStatus: 'listed',
        firstSeenAt: at('09:00'),
        lastSeenAt: at('09:00'),
        missingSince: null,
      }),
    ),
  );

const itemOf = (
  stockId: string,
  changePct: number | undefined,
  amount: number,
): MarketSnapshotItem => ({
  id: stockId,
  code: stockId.split('.')[0] ?? stockId,
  exchange: stockId.endsWith('.SH') ? 'SH' : 'SZ',
  name: stockId,
  close: PREV_CLOSE * (1 + (changePct ?? 0) / 100),
  ...(changePct === undefined ? {} : { changePct }),
  amount,
});

const batchesOf = (sectors: readonly SectorSpec[], samples: readonly SampleSpec[]) => {
  const stockIds = sectors.flatMap((sector) => sector.stocks);
  return samples.map((sample, index) =>
    MarketSnapshotBatchSchema.parse(
      buildMarketSnapshotBatch({
        sampledAt: at(sample.time),
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'event-fixture',
          fetchedAt: at(sample.time),
          observedAt: at(sample.time),
          items: stockIds.map((stockId) =>
            itemOf(stockId, sample.changePct[stockId], 1e8 * (index + 1)),
          ),
          completeness: {
            expectedCount: stockIds.length,
            receivedCount: stockIds.length,
            missingCount: 0,
            duplicateCount: 0,
            complete: true,
          },
        },
      }),
    ),
  );
};

const ladderEntryOf = (input: {
  readonly code: string;
  readonly ladderLevel: number;
  readonly firstTime: string | null;
  readonly reason: string;
}): LimitUpLadderEntry => ({
  code: input.code,
  name: input.code,
  industry: '测试行业',
  ladderLevel: input.ladderLevel,
  uncategorized: false,
  firstTime: input.firstTime,
  finalTime: input.firstTime,
  reason: input.reason,
  price: 11,
  rawClose: 11,
  corrected: false,
  changePct: 0.1,
  limitUpDate: TRADING_DATE,
  board: 'main_board',
});

const ladderSampleAt = (time: string, entries: readonly LimitUpLadderEntry[]) => {
  const levels = [...new Set(entries.map((entry) => entry.ladderLevel))]
    .sort((left, right) => right - left)
    .map((level) => {
      const stocks = entries.filter((entry) => entry.ladderLevel === level);
      return { level, name: `${level} 板`, count: stocks.length, stocks };
    });
  const ladder: LimitUpLadder = {
    date: TRADING_DATE,
    total: entries.length,
    maxLevel: Math.max(0, ...entries.map((entry) => entry.ladderLevel)),
    source: 'eastmoney',
    levels,
    warnings: [],
    asOf: at(time),
  };
  return buildLimitUpLadderSample({ ladder, sampledAt: at(time) });
};

const scan = (input: {
  readonly sectors: readonly SectorSpec[];
  readonly samples: readonly SampleSpec[];
  readonly ladder?: readonly ReturnType<typeof ladderSampleAt>[];
  readonly ruleOverrides?: MarketRoomEventRuleOverrides;
}): MarketRoomEvent[] =>
  detectMarketRoomEvents({
    tradingDate: TRADING_DATE,
    batches: batchesOf(input.sectors, input.samples),
    sectors: input.sectors.map(sectorEntryOf),
    members: membershipsOf(input.sectors),
    ladderSamples: input.ladder ?? [],
    recordedAt: at('14:55'),
    ...(input.ruleOverrides === undefined ? {} : { ruleOverrides: input.ruleOverrides }),
  });

const ofKind = (events: readonly MarketRoomEvent[], kind: MarketRoomEvent['kind']) =>
  events.filter((event) => event.kind === kind);

const sectorOf = (
  id: string,
  vendorCode: string,
  name: string,
  stocks: readonly string[],
): SectorSpec => ({ id, kind: 'industry', vendorCode, name, stocks });

const A = sectorOf('sector-diffusion-a', '881101.TI', '扩散题材', [
  '600001.SH',
  '600002.SH',
  '600003.SH',
]);
const B = sectorOf('sector-diffusion-b', '881102.TI', '接力题材', [
  '600004.SH',
  '600005.SH',
  '600006.SH',
]);

const stableB: readonly number[] = [2, 4, 8, 9];

const diffusionSamples = (overrides: Partial<Record<string, Partial<SampleSpec>>> = {}) =>
  (
    [
      { time: '09:35', changePct: { '600001.SH': -1, '600002.SH': -1, '600003.SH': -1 } },
      { time: '09:40', changePct: { '600001.SH': 1, '600002.SH': 1, '600003.SH': -1 } },
      { time: '09:45', changePct: { '600001.SH': 3, '600002.SH': 3, '600003.SH': 3 } },
      { time: '09:50', changePct: { '600001.SH': 3, '600002.SH': 3, '600003.SH': 3 } },
    ] as SampleSpec[]
  ).map((sample, index) => {
    const override = overrides[sample.time];
    const stable = {
      '600004.SH': stableB[index] ?? 9,
      '600005.SH': stableB[index] ?? 9,
      '600006.SH': stableB[index] ?? 9,
    };
    return {
      ...sample,
      ...override,
      changePct:
        override?.changePct === undefined
          ? { ...sample.changePct, ...stable }
          : { ...stable, ...override.changePct },
    };
  });

/* 扩散：上涨面 0% → 66.7% → 100%，窗口为正、占比不降。 */
const diffusionScenario = (overrides: Partial<Record<string, Partial<SampleSpec>>> = {}) => ({
  sectors: [A, B],
  samples: diffusionSamples(overrides),
});

describe('盘中事件：扩散', () => {
  it('上涨面在 N 个样本内提升、窗口为正且成交占比不降时产生扩散事件', () => {
    const events = ofKind(scan(diffusionScenario()), 'diffusion');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing diffusion event');
    expect(event.sector.name).toBe('扩散题材');
    expect(event.sampledAt).toEqual(at('09:45'));
    expect(event.previousSampledAt).toEqual(at('09:40'));
    expect(event.evidence.window.baseSampledAt).toEqual(at('09:40'));
    expect(event.evidence.breadth.advanceRatio).toBe(100);
    expect(event.evidence.breadth.baseAdvanceRatio).toBe(66.67);
    expect(event.evidence.breadth.deltaPp).toBe(33.33);
    expect(event.evidence.window.changePct).toBeCloseTo(2.6669, 4);
    expect(event.evidence.turnover.sharePct).toBe(50);
    expect(event.evidence.turnover.baseSharePct).toBe(50);
    expect(event.evidence.turnover.deltaPp).toBe(0);
    expect(event.evidence.ranking.dayRank).toBe(2);
    expect(event.evidence.ranking.sectorCount).toBe(2);
    expect(event.evidence.members.memberCount).toBe(3);
    expect(event.evidence.members.peers).toHaveLength(3);
    expect(event.thresholds).toMatchObject({
      kind: 'diffusion',
      advanceRatioGainPp: MARKET_ROOM_EVENT_DEFAULT_RULES.diffusion.advanceRatioGainPp,
    });
    expect(event.status).toBe('partial');
    expect(event.verification).toEqual({
      status: 'verified',
      basis: 'sector_catalog:industry:881101.TI',
    });
  });

  it('阈值改动会改变结果，事件的 thresholds 记录当时判定依据', () => {
    const strict = scan({
      ...diffusionScenario(),
      ruleOverrides: { diffusion: { advanceRatioGainPp: 40 } },
    });
    expect(ofKind(strict, 'diffusion')).toHaveLength(0);

    const loose = scan({
      ...diffusionScenario(),
      ruleOverrides: { diffusion: { advanceRatioGainPp: 30 } },
    });
    const events = ofKind(loose, 'diffusion');
    expect(events).toHaveLength(1);
    expect(events[0]?.thresholds).toMatchObject({ kind: 'diffusion', advanceRatioGainPp: 30 });
    expect(MARKET_ROOM_EVENT_DEFAULT_RULES.diffusion.advanceRatioGainPp).toBe(8);
  });

  it('不同事件种类的回看口径互不污染', () => {
    const events = ofKind(
      scan({
        ...diffusionScenario(),
        ruleOverrides: { rotation: { lookbackSamples: 2 } },
      }),
      'diffusion',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.evidence.window.lookbackSamples).toBe(1);
    expect(events[0]?.evidence.window.changePct).toBeCloseTo(2.6669, 4);
  });

  it('缺涨幅不产生事件、也不把缺失当成 0', () => {
    const missing = scan({
      ...diffusionScenario({
        '09:45': {
          changePct: { '600001.SH': 3, '600002.SH': 3 },
        },
      }),
    });
    expect(ofKind(missing, 'diffusion')).toHaveLength(0);
  });

  it('有效成分少于下限不产生事件；放宽下限后同一数据产生事件', () => {
    const small = sectorOf('sector-thin', '881107.TI', '小样本题材', ['600031.SH', '600032.SH']);
    const samples: readonly SampleSpec[] = [
      { time: '09:35', changePct: { '600031.SH': -1, '600032.SH': -1 } },
      { time: '09:40', changePct: { '600031.SH': 1, '600032.SH': -1 } },
      { time: '09:45', changePct: { '600031.SH': 3, '600032.SH': 3 } },
    ].map((sample, index) => ({
      ...sample,
      changePct: {
        ...sample.changePct,
        '600004.SH': stableB[index] ?? 9,
        '600005.SH': stableB[index] ?? 9,
        '600006.SH': stableB[index] ?? 9,
      },
    }));
    expect(scan({ sectors: [small, B], samples })).toHaveLength(0);
    const relaxed = ofKind(
      scan({
        sectors: [small, B],
        samples,
        ruleOverrides: { diffusion: { minSampleCount: 2 } },
      }),
      'diffusion',
    );
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.sector.sectorId).toBe('sector-thin');
    expect(relaxed[0]?.evidence.breadth.sampleCount).toBe(2);
  });
});

const divergenceScenario = {
  sectors: [A, B],
  samples: [
    {
      time: '09:35',
      changePct: {
        '600001.SH': 5,
        '600002.SH': 5,
        '600003.SH': 5,
        '600004.SH': 5,
        '600005.SH': 5,
        '600006.SH': 5,
      },
    },
    {
      time: '09:40',
      changePct: {
        '600001.SH': 6,
        '600002.SH': 6,
        '600003.SH': 6,
        '600004.SH': 6,
        '600005.SH': 6,
        '600006.SH': 6,
      },
    },
    {
      time: '09:45',
      changePct: {
        '600001.SH': 7,
        '600002.SH': 7,
        '600003.SH': 7,
        '600004.SH': -3,
        '600005.SH': -3,
        '600006.SH': -3,
      },
    },
    {
      time: '09:50',
      changePct: {
        '600001.SH': 7,
        '600002.SH': 7,
        '600003.SH': 7,
        '600004.SH': -4,
        '600005.SH': -4,
        '600006.SH': -4,
      },
    },
  ] satisfies SampleSpec[],
};

describe('盘中事件：分化', () => {
  it('日涨幅仍靠前但上涨面回落、窗口转负时产生分化事件', () => {
    const events = ofKind(scan(divergenceScenario), 'divergence');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing divergence event');
    expect(event.sector.name).toBe('接力题材');
    expect(event.sampledAt).toEqual(at('09:45'));
    expect(event.evidence.ranking.dayRank).toBe(2);
    expect(event.evidence.breadth.advanceRatio).toBe(0);
    expect(event.evidence.breadth.baseAdvanceRatio).toBe(100);
    expect(event.evidence.breadth.deltaPp).toBe(-100);
    expect(event.evidence.window.changePct).toBeLessThan(0);
    expect(event.thresholds).toMatchObject({ kind: 'divergence', dayRankMax: 5 });
  });

  it('分化最早可在第二个样本成立；上一窗口缺失时占比记缺失而不是崩溃', () => {
    const samples: readonly SampleSpec[] = [
      {
        time: '09:35',
        changePct: {
          '600001.SH': 5,
          '600002.SH': 5,
          '600003.SH': 5,
          '600004.SH': 5,
          '600005.SH': 5,
          '600006.SH': 5,
        },
      },
      {
        time: '09:40',
        changePct: {
          '600001.SH': 6,
          '600002.SH': 6,
          '600003.SH': 6,
          '600004.SH': -3,
          '600005.SH': -3,
          '600006.SH': -3,
        },
      },
    ];
    const events = ofKind(scan({ sectors: [A, B], samples }), 'divergence');
    expect(events).toHaveLength(1);
    expect(events[0]?.sampledAt).toEqual(at('09:40'));
    expect(events[0]?.evidence.turnover.baseSharePct).toBeNull();
    expect(events[0]?.evidence.turnover.deltaPp).toBeNull();
    expect(events[0]?.evidence.window.changePct).toBeLessThan(0);
  });

  it('名次超出阈值不产生分化；放宽同一数据产生事件', () => {
    const sectors = [
      A,
      B,
      sectorOf('sector-rank-c', '881103.TI', '题材丙', ['600007.SH', '600008.SH', '600009.SH']),
      sectorOf('sector-rank-d', '881104.TI', '题材丁', ['600010.SH', '600011.SH', '600012.SH']),
      sectorOf('sector-rank-e', '881105.TI', '题材戊', ['600013.SH', '600014.SH', '600015.SH']),
      sectorOf('sector-rank-f', '881106.TI', '题材己', ['600016.SH', '600017.SH', '600018.SH']),
    ];
    const times = ['09:35', '09:40', '09:45'];
    const dayChange: Readonly<Record<string, readonly number[]>> = {
      [A.id]: [5, 5, 10],
      [B.id]: [5, 5, 9],
      'sector-rank-c': [5, 5, 8],
      'sector-rank-d': [5, 5, 7],
      'sector-rank-e': [5, 5, 6],
      'sector-rank-f': [5, 5, -5],
    };
    const scenario: { sectors: SectorSpec[]; samples: SampleSpec[] } = {
      sectors,
      samples: times.map((time, index) => ({
        time,
        changePct: Object.fromEntries(
          sectors.flatMap((sector) =>
            sector.stocks.map((stockId) => [
              stockId,
              dayChange[sector.id]?.[index] ?? dayChange[sector.id]?.[0] ?? 0,
            ]),
          ),
        ),
      })),
    };
    expect(ofKind(scan(scenario), 'divergence')).toHaveLength(0);
    const relaxed = ofKind(
      scan({ ...scenario, ruleOverrides: { divergence: { dayRankMax: 6 } } }),
      'divergence',
    );
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.sector.sectorId).toBe('sector-rank-f');
    expect(relaxed[0]?.evidence.ranking.dayRank).toBe(6);
  });
});

describe('盘中事件：换位', () => {
  const rotationSamples: readonly SampleSpec[] = [
    {
      time: '09:35',
      changePct: {
        '600001.SH': 5,
        '600002.SH': 5,
        '600003.SH': 5,
        '600004.SH': 1,
        '600005.SH': 1,
        '600006.SH': 1,
      },
    },
    {
      time: '09:40',
      changePct: {
        '600001.SH': 5,
        '600002.SH': 5,
        '600003.SH': 5,
        '600004.SH': 3,
        '600005.SH': 3,
        '600006.SH': 3,
      },
    },
    {
      time: '09:45',
      changePct: {
        '600001.SH': 4,
        '600002.SH': 4,
        '600003.SH': 4,
        '600004.SH': 6,
        '600005.SH': 6,
        '600006.SH': 6,
      },
    },
    {
      time: '09:50',
      changePct: {
        '600001.SH': 4,
        '600002.SH': 4,
        '600003.SH': 4,
        '600004.SH': 6,
        '600005.SH': 6,
        '600006.SH': 6,
      },
    },
  ];

  it('领先板块变化且新领先者连续样本窗口跑赢旧领先者时产生换位事件', () => {
    const events = ofKind(scan({ sectors: [A, B], samples: rotationSamples }), 'rotation');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing rotation event');
    expect(event.sector.sectorId).toBe(B.id);
    expect(event.sampledAt).toEqual(at('09:45'));
    expect(event.evidence.rotation?.from.sector.sectorId).toBe(A.id);
    expect(event.evidence.rotation?.to.sector.sectorId).toBe(B.id);
    expect(event.evidence.rotation?.leadSamples.map((entry) => entry.sampledAt)).toEqual([
      at('09:40'),
      at('09:45'),
    ]);
    expect(event.evidence.rotation?.leadSamples.every((entry) => entry.deltaPp >= 1)).toBe(true);
    expect(event.thresholds).toMatchObject({ kind: 'rotation', consecutiveSamples: 2 });
  });

  it('单次排名抖动不产生换位事件', () => {
    const jitter: readonly SampleSpec[] = [
      {
        time: '09:35',
        changePct: {
          '600001.SH': 5,
          '600002.SH': 5,
          '600003.SH': 5,
          '600004.SH': 1,
          '600005.SH': 1,
          '600006.SH': 1,
        },
      },
      {
        time: '09:40',
        changePct: {
          '600001.SH': 2,
          '600002.SH': 2,
          '600003.SH': 2,
          '600004.SH': 5,
          '600005.SH': 5,
          '600006.SH': 5,
        },
      },
      {
        time: '09:45',
        changePct: {
          '600001.SH': 6,
          '600002.SH': 6,
          '600003.SH': 6,
          '600004.SH': 3,
          '600005.SH': 3,
          '600006.SH': 3,
        },
      },
      {
        time: '09:50',
        changePct: {
          '600001.SH': 6,
          '600002.SH': 6,
          '600003.SH': 6,
          '600004.SH': 3,
          '600005.SH': 3,
          '600006.SH': 3,
        },
      },
    ];
    expect(ofKind(scan({ sectors: [A, B], samples: jitter }), 'rotation')).toHaveLength(0);
  });
});

describe('盘中事件：证据与幂等候选', () => {
  it('天梯样本给出涨停原因、封板时间与关键词；缺失时标缺失而不编造', () => {
    const ladder = ladderSampleAt('09:45', [
      ladderEntryOf({
        code: '600001',
        ladderLevel: 2,
        firstTime: '09:41:00',
        reason: '锂电池+固态电池',
      }),
      ladderEntryOf({ code: '600002', ladderLevel: 1, firstTime: null, reason: '--' }),
    ]);
    const events = ofKind(scan({ ...diffusionScenario(), ladder: [ladder] }), 'diffusion');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing diffusion event');
    expect(event.evidence.ladder.status).toBe('complete');
    expect(event.evidence.ladder.sealedCount).toBe(2);
    expect(event.evidence.ladder.stocks).toEqual([
      {
        code: '600001',
        name: '600001',
        ladderLevel: 2,
        firstTime: '09:41:00',
        reason: '锂电池+固态电池',
      },
      { code: '600002', name: '600002', ladderLevel: 1, firstTime: null, reason: null },
    ]);
    expect(event.evidence.keywords).toEqual([
      { text: '锂电池', source: 'limit_up_ladder_reason' },
      { text: '固态电池', source: 'limit_up_ladder_reason' },
    ]);
    expect(event.status).toBe('complete');

    const withoutLadder = ofKind(scan(diffusionScenario()), 'diffusion');
    const bare = withoutLadder[0];
    if (bare === undefined) throw new Error('missing diffusion event without ladder');
    expect(bare.evidence.ladder.status).toBe('unavailable');
    expect(bare.evidence.ladder.sealedCount).toBeNull();
    expect(bare.evidence.ladder.reason).toContain('limit_up_missing');
    expect(bare.evidence.keywords).toEqual([]);
    expect(bare.status).toBe('partial');
  });

  it('同一批数据重复扫描得到相同事件身份，recordedAt 不参与身份', () => {
    const first = scan(diffusionScenario());
    const second = scan(diffusionScenario());
    expect(second.map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(second).toEqual(first);
    for (const event of first) {
      expect(event.id).toBe(
        marketRoomEventId({
          tradingDate: event.tradingDate,
          kind: event.kind,
          sectorId: event.sector.sectorId,
          sampledAt: event.sampledAt,
        }),
      );
    }
  });

  it('没有批次或没有目录成分时不产生事件', () => {
    expect(
      detectMarketRoomEvents({
        tradingDate: TRADING_DATE,
        batches: [],
        sectors: [],
        members: [],
        ladderSamples: [],
        recordedAt: at('14:55'),
      }),
    ).toEqual([]);
    const batches = batchesOf([A, B], diffusionSamples());
    expect(
      detectMarketRoomEvents({
        tradingDate: TRADING_DATE,
        batches,
        sectors: [A, B].map(sectorEntryOf),
        members: [],
        ladderSamples: [],
        recordedAt: at('14:55'),
      }),
    ).toEqual([]);
  });
});

describe('盘中事件：只读视图', () => {
  const filters = { date: null, from: null, to: null, kind: null, sectorId: null };

  it('按检测时点与种类排序，并给出三类事件计数', () => {
    const events = [...scan(divergenceScenario), ...scan(diffusionScenario())];
    const view = buildMarketRoomEventsView({ tradingDate: TRADING_DATE, events, filters });
    expect(view.state).toBe('ready');
    expect(view.emptyReason).toBeUndefined();
    expect(view.tradingDate).toBe(TRADING_DATE);
    expect(view.counts).toEqual({ total: 2, diffusion: 1, divergence: 1, rotation: 0 });
    expect(view.events.map((event) => event.kind)).toEqual(['diffusion', 'divergence']);
    expect(view.notes.length).toBeGreaterThan(0);
  });

  it('空视图必须给出原因，非空视图不得携带原因', () => {
    expect(() =>
      buildMarketRoomEventsView({ tradingDate: TRADING_DATE, events: [], filters }),
    ).toThrow(InvariantError);
    const empty = buildMarketRoomEventsView({
      tradingDate: null,
      events: [],
      filters,
      emptyReason: 'no_batch',
    });
    expect(empty.state).toBe('empty');
    expect(empty.emptyReason).toBe('no_batch');
    expect(empty.counts.total).toBe(0);
    expect(() =>
      buildMarketRoomEventsView({
        tradingDate: TRADING_DATE,
        events: scan(diffusionScenario()),
        filters,
        emptyReason: 'no_events',
      }),
    ).toThrow(InvariantError);
  });
});
