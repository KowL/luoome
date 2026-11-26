import { describe, expect, it } from 'vitest';
import type { MainstreamThemeDefinition } from './mainstream-themes.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';
import {
  buildThemeLibraryRotation,
  buildThemeLibraryRotationEmpty,
  buildThemeLibrarySeed,
  isThemeLibraryMemberEffectiveAt,
  selectThemeLibraryMembersAt,
  type ThemeLibraryMember,
  type ThemeLibraryTheme,
  type ThemeLibraryThemeSource,
} from './theme-library.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const concept = (input: {
  readonly id: string;
  readonly vendorCode: string;
  readonly name: string;
  readonly state?: 'active' | 'retired';
}): SectorCatalogEntry => ({
  id: input.id,
  kind: 'concept',
  source: 'fuyao',
  vendorCode: input.vendorCode,
  name: input.name,
  state: input.state ?? 'active',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:30'),
  retiredAt: null,
});

const membership = (
  sectorId: string,
  stockId: string,
  overrides: Partial<StockSectorMembership> = {},
): StockSectorMembership => ({
  sectorId,
  stockId,
  source: 'fuyao',
  state: 'active',
  memberStatus: 'listed',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:30'),
  missingSince: null,
  ...overrides,
});

const item = (id: string, changePct: number, close = 10): MarketSnapshotItem => ({
  id,
  code: id.split('.')[0] as string,
  exchange: 'SH',
  name: id,
  close,
  changePct,
  amount: 1_000_000,
});

const batch = (time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: at(time),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'fixture',
      fetchedAt: at(time),
      items: [...items],
      completeness: {
        expectedCount: items.length,
        receivedCount: items.length,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    },
  });

const theme = (input: {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly state?: 'active' | 'archived';
}): ThemeLibraryTheme => ({
  id: input.id,
  name: input.name,
  state: input.state ?? 'active',
  sortOrder: input.sortOrder,
  createdAt: at('09:00'),
  updatedAt: at('09:00'),
  archivedAt: input.state === 'archived' ? at('09:10') : null,
});

const member = (input: {
  readonly id: string;
  readonly themeId: string;
  readonly stockId: string;
  readonly from: string;
  readonly to?: string;
}): ThemeLibraryMember => ({
  id: input.id,
  themeId: input.themeId,
  stockId: input.stockId,
  origin: 'seed',
  effectiveFrom: at(input.from),
  effectiveTo: input.to === undefined ? null : at(input.to),
  createdAt: at(input.from),
});

const AI = concept({ id: 'concept-ai', vendorCode: '885728.TI', name: '人工智能' });
const AI_APP = concept({ id: 'concept-ai-app', vendorCode: '886108.TI', name: 'AI应用' });
const EMPTY_CONCEPT = concept({ id: 'concept-empty', vendorCode: '886999.TI', name: '空概念' });

const DEFINITIONS: readonly MainstreamThemeDefinition[] = [
  {
    id: 'ai-computing',
    parentId: 'tech',
    name: 'AI与算力',
    vendorCodes: ['885728.TI', '886108.TI'],
  },
  {
    id: 'empty-theme',
    parentId: 'tech',
    name: '无成分题材',
    vendorCodes: ['886999.TI'],
  },
  {
    id: 'missing-source',
    parentId: 'tech',
    name: '缺来源题材',
    vendorCodes: ['888888.TI'],
  },
];

describe('buildThemeLibrarySeed', () => {
  it('merges concept members with stable ids and dedupes overlapping stocks', () => {
    const plan = buildThemeLibrarySeed({
      definitions: DEFINITIONS,
      catalog: [AI, AI_APP, EMPTY_CONCEPT],
      members: [
        membership(AI.id, '600519.SH'),
        membership(AI.id, '000001.SZ'),
        membership(AI_APP.id, '600519.SH'),
        membership(AI_APP.id, '300750.SZ'),
      ],
    });
    expect(plan.themes).toHaveLength(1);
    expect(plan.themes[0]).toMatchObject({
      id: 'ai-computing',
      name: 'AI与算力',
      sortOrder: 0,
      stockIds: ['000001.SZ', '300750.SZ', '600519.SH'],
    });
    expect(plan.themes[0]?.sources.map((source) => source.vendorCode)).toEqual([
      '885728.TI',
      '886108.TI',
    ]);
    expect(plan.skipped).toEqual([
      { themeId: 'empty-theme', name: '无成分题材', reason: 'no_members' },
      { themeId: 'missing-source', name: '缺来源题材', reason: 'no_source' },
    ]);
  });

  it('ignores retired concepts and missing memberships', () => {
    const plan = buildThemeLibrarySeed({
      definitions: DEFINITIONS.slice(0, 1),
      catalog: [{ ...AI, state: 'retired' }, AI_APP],
      members: [
        membership(AI.id, '600519.SH'),
        membership(AI_APP.id, '600519.SH', { state: 'missing' }),
        membership(AI_APP.id, '000001.SZ'),
      ],
    });
    expect(plan.themes[0]?.stockIds).toEqual(['000001.SZ']);
    expect(plan.themes[0]?.sources.map((source) => source.vendorCode)).toEqual(['886108.TI']);
  });
});

describe('theme library effective intervals', () => {
  it('treats effectiveFrom as inclusive and effectiveTo as exclusive', () => {
    const interval = member({
      id: 'm1',
      themeId: 'ai-computing',
      stockId: '600519.SH',
      from: '10:00',
      to: '10:30',
    });
    expect(isThemeLibraryMemberEffectiveAt(interval, at('09:59'))).toBe(false);
    expect(isThemeLibraryMemberEffectiveAt(interval, at('10:00'))).toBe(true);
    expect(isThemeLibraryMemberEffectiveAt(interval, at('10:29'))).toBe(true);
    expect(isThemeLibraryMemberEffectiveAt(interval, at('10:30'))).toBe(false);
    expect(
      selectThemeLibraryMembersAt(
        [
          interval,
          member({ id: 'm2', themeId: 'ai-computing', stockId: '000001.SZ', from: '09:30' }),
        ],
        at('10:15'),
      ).map((entry) => entry.stockId),
    ).toEqual(['600519.SH', '000001.SZ']);
  });
});

describe('buildThemeLibraryRotation', () => {
  const themes = [
    theme({ id: 'ai-computing', name: 'AI与算力', sortOrder: 0 }),
    theme({ id: 'second', name: '第二题材', sortOrder: 1 }),
    theme({ id: 'archived', name: '归档题材', sortOrder: 2, state: 'archived' }),
  ];
  const sources: ThemeLibraryThemeSource[] = [
    {
      themeId: 'ai-computing',
      vendorCode: '885728.TI',
      sectorId: AI.id,
      name: AI.name,
      createdAt: at('08:00'),
    },
  ];
  const members = [
    member({
      id: 'm1',
      themeId: 'ai-computing',
      stockId: '600519.SH',
      from: '09:40',
      to: '10:02',
    }),
    member({ id: 'm2', themeId: 'ai-computing', stockId: '000001.SZ', from: '09:40' }),
    member({ id: 'm3', themeId: 'second', stockId: '300750.SZ', from: '09:40' }),
  ];
  const batches = [
    batch('09:30', [item('600519.SH', 1), item('000001.SZ', 2), item('300750.SZ', -1)]),
    batch('09:45', [item('600519.SH', 3, 10), item('000001.SZ', 4, 10), item('300750.SZ', -2, 10)]),
    batch('09:55', [
      item('600519.SH', 5, 10.2),
      item('000001.SZ', 6, 10.2),
      item('300750.SZ', -3, 10.2),
    ]),
    batch('10:00', [
      item('600519.SH', 7, 10.5),
      item('000001.SZ', 8, 10.5),
      item('300750.SZ', -4, 10.5),
    ]),
    batch('10:05', [item('600519.SH', 11), item('000001.SZ', 12), item('300750.SZ', -5)]),
  ];
  const anchor = batches[3]!;

  it('uses only effective members per batch and keeps the fixed order', () => {
    const rotation = buildThemeLibraryRotation({
      window: 'w15',
      anchor,
      windowStarts: { w5: batches[2]!, w15: batches[1]! },
      batches,
      themes,
      sources,
      members,
      statusByStock: new Map([
        ['600519.SH', 'listed'],
        ['000001.SZ', 'listed'],
        ['300750.SZ', 'listed'],
      ]),
      namesByStock: new Map([
        ['600519.SH', '贵州茅台'],
        ['000001.SZ', '平安银行'],
        ['300750.SZ', '宁德时代'],
      ]),
      limitUp: null,
      limitUpError: null,
      detailThemeId: 'ai-computing',
    });
    expect(rotation.state).toBe('ready');
    expect(rotation.themes.map((row) => row.themeId)).toEqual(['ai-computing', 'second']);
    const ai = rotation.themes[0]!;
    expect(ai.memberCount).toBe(2);
    expect(ai.day.value).toBe(7.5);
    expect(ai.window15.value).toBe(5);
    expect(ai.members.map((row) => row.stockId)).toEqual(['000001.SZ', '600519.SH']);
    expect(ai.members[0]).toMatchObject({
      name: '平安银行',
      dayChangePct: 8,
      window15ChangePct: 5,
      sealed: null,
    });
    expect(ai.trend.points.map((point) => point.value)).toEqual([null, 3.5, 5.5, 7.5]);
    expect(ai.trend.points[0]).toMatchObject({ memberCount: 0, status: 'unavailable' });
    expect(ai.trend.points[1]).toMatchObject({ memberCount: 2, sampleCount: 2, status: 'partial' });
    expect(ai.trend.coverage.availablePointCount).toBe(3);
  });

  it('excludes archived themes and returns explicit empty reasons', () => {
    const archivedOnly = buildThemeLibraryRotation({
      window: 'w15',
      anchor,
      windowStarts: { w5: null, w15: null },
      batches,
      themes: [themes[2]!],
      sources,
      members,
      statusByStock: new Map(),
      namesByStock: new Map(),
      limitUp: null,
      limitUpError: null,
    });
    expect(archivedOnly).toMatchObject({ state: 'empty', emptyReason: 'no_active_theme' });

    const noLibrary = buildThemeLibraryRotationEmpty({
      window: 'w15',
      reason: 'no_theme_library',
      latest: anchor,
      batches,
    });
    expect(noLibrary).toMatchObject({ state: 'empty', emptyReason: 'no_theme_library' });
    expect(noLibrary.themes).toEqual([]);
    // 空态也带当日批次：回放时可以继续拖动时间轴或返回最新
    expect(noLibrary.batches.map((batch) => batch.sampledAt.toISOString())).toHaveLength(
      batches.length,
    );
  });

  it('给卡内前五只：方向随题材符号，按当前方向从强到弱，缺数据不补位', () => {
    const rotation = buildThemeLibraryRotation({
      window: 'w15',
      anchor,
      windowStarts: { w5: batches[2]!, w15: batches[1]! },
      batches,
      themes,
      sources,
      members,
      statusByStock: new Map([
        ['600519.SH', 'listed'],
        ['000001.SZ', 'listed'],
        ['300750.SZ', 'listed'],
      ]),
      namesByStock: new Map([
        ['600519.SH', '贵州茅台'],
        ['000001.SZ', '平安银行'],
        ['300750.SZ', '宁德时代'],
      ]),
      limitUp: null,
      limitUpError: null,
    });
    const ai = rotation.themes[0]!;
    // 日涨幅 7.5 > 0：取涨幅最高的五只，第 1 只是涨幅最大的
    expect(ai.leaders.day.map((leader) => [leader.stockId, leader.value])).toEqual([
      ['000001.SZ', 8],
      ['600519.SH', 7],
    ]);
    expect(ai.leaders.day[0]).toMatchObject({ name: '平安银行', sealed: null });
    // 15 分钟两者同涨幅：同值按股票代码定序
    expect(ai.leaders.window.map((leader) => leader.stockId)).toEqual(['000001.SZ', '600519.SH']);
    // 下跌题材取下排一侧，跌幅最大的在前，第 5 只可以是正涨幅
    const second = rotation.themes[1]!;
    expect(second.day.value).toBe(-4);
    expect(second.leaders.day.map((leader) => [leader.stockId, leader.value])).toEqual([
      ['300750.SZ', -4],
    ]);
    expect(second.leaders.window.map((leader) => leader.value)).toEqual([5]);
    // 时间轴列当日全部已发布批次（含锚点之后的 10:05），与选中时点无关
    expect(rotation.batches.map((batch) => batch.sampledAt.getTime())).toEqual(
      batches.map((batch) => batch.sampledAt.getTime()),
    );
  });

  it('持平和缺失的题材不给卡内个股列表', () => {
    const flatBatches = [batch('10:00', [item('600519.SH', 0), item('000001.SZ', 0)])];
    const rotation = buildThemeLibraryRotation({
      window: 'w15',
      anchor: flatBatches[0]!,
      windowStarts: { w5: null, w15: null },
      batches: flatBatches,
      themes: [themes[0]!],
      sources,
      members,
      statusByStock: new Map([
        ['600519.SH', 'listed'],
        ['000001.SZ', 'listed'],
      ]),
      namesByStock: new Map(),
      limitUp: null,
      limitUpError: null,
    });
    expect(rotation.themes[0]?.day.value).toBe(0);
    expect(rotation.themes[0]?.leaders.day).toEqual([]);
    expect(rotation.themes[0]?.leaders.window).toEqual([]);
  });
});
