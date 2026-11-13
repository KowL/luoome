/* apps/web/public/js/market-room-sector-detail.test.js —— 板块详情纯函数与入口结构断言。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  breadthAdvanceText,
  breadthSampleText,
  compareCandidates,
  detailMetaText,
  detailNotes,
  latestLeaderText,
  leaderChangeLines,
  memberRowCells,
  missingSamplesText,
  sectorDetailEmptyText,
  sectorDetailHash,
  sectorDetailParamsFromHash,
  sectorDetailQuery,
  sortedMembers,
  toggleCompareSelection,
  trendChartModel,
  trendMethodText,
} from './market-room-sector-detail.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const at = (time) => new Date(`2026-09-28T${time}+08:00`);

const trendSeries = (sectorId, name, values, overrides = {}) => ({
  sectorId,
  kind: 'industry',
  vendorCode: `88100${sectorId.slice(-1)}.TI`,
  name,
  method: 'constituent_equal_weight',
  methodNote: '成分等权合成',
  indexFallbackReason: 'sector_index_unavailable: 本地未保存板块指数序列',
  coverage: {
    batchCount: values.length,
    pointCount: values.length,
    availablePointCount: values.filter((value) => value !== null).length,
    missingPointCount: values.filter((value) => value === null).length,
    firstSampledAt: at('09:35'),
    baseSampledAt: at('09:35'),
    lastSampledAt: at('10:15'),
  },
  points: values.map((value, index) => ({
    sampledAt: at(['09:35', '10:00', '10:10', '10:15'][index] ?? '10:15'),
    value,
    sampleCount: value === null ? 0 : 3,
    memberCount: 3,
    missingCount: value === null ? 3 : 0,
    nonTradableCount: 0,
    status: value === null ? 'unavailable' : 'complete',
    warnings: value === null ? ['missing_trend_sample: 该时点没有可比较的成分，走势缺失'] : [],
  })),
  warnings: [],
  ...overrides,
});

const member = (overrides = {}) => ({
  stockId: '600519.SH',
  code: '600519',
  name: '贵州茅台',
  memberStatus: 'listed',
  inBatch: true,
  dayChangePct: 1.23,
  windowChangePct: -0.45,
  windowAmountDelta: 150_000_000,
  windowAmountSharePct: 42.5,
  sealed: true,
  ladderLevel: 2,
  warnings: [],
  ...overrides,
});

const detailFixture = (overrides = {}) => {
  const trend = trendSeries('a', '领涨行业', [100, 100.4, 100.1, 99.5]);
  return {
    state: 'ready',
    sector: { sectorId: 'a', kind: 'industry', vendorCode: '881001.TI', name: '领涨行业' },
    tradingDate: '2026-09-28',
    anchor: { sampledAt: at('10:15') },
    window: 'w5',
    trend,
    comparisons: [trendSeries('b', '接力行业', [100, 100.2, 101.5, 104])],
    unresolvedSectorIds: [],
    breadth: {
      status: 'complete',
      advancing: 2,
      declining: 1,
      unchanged: 0,
      sampleCount: 3,
      memberCount: 4,
      missingCount: 0,
      nonTradableCount: 1,
      advanceRatio: 66.67,
      thinSample: false,
      method: '成分上涨比例 = 上涨成分数 ÷ 有效成分数 × 100',
      warnings: [],
    },
    day: { value: 1.2, status: 'complete', warnings: [] },
    windowMetric: { value: -0.4, status: 'complete', warnings: [] },
    windows: {
      w5: {
        status: 'complete',
        startSampledAt: at('10:10'),
        spanMs: 300_000,
        reason: null,
      },
    },
    turnover: { value: 12.3, numeratorAmount: 350_000_000, status: 'complete', warnings: [] },
    limitUp: { value: 1, status: 'complete', warnings: [] },
    members: [
      member(),
      member({
        stockId: '600036.SH',
        code: '600036',
        name: '招商银行',
        memberStatus: 'suspended',
        inBatch: false,
        dayChangePct: null,
        windowChangePct: null,
        windowAmountDelta: null,
        windowAmountSharePct: null,
        sealed: false,
        ladderLevel: null,
      }),
      member({
        stockId: '000001.SZ',
        code: '000001',
        name: '平安银行',
        dayChangePct: -1.5,
        windowChangePct: null,
        windowAmountSharePct: null,
        sealed: null,
        ladderLevel: null,
      }),
    ],
    leaderOrder: [
      {
        sampledAt: at('09:35'),
        entries: [
          { sectorId: 'a', name: '领涨行业', value: 100, rank: 1 },
          { sectorId: 'b', name: '接力行业', value: 100, rank: 2 },
        ],
        missingSectorIds: [],
        reordered: false,
        previousOrder: null,
      },
      {
        sampledAt: at('10:10'),
        entries: [
          { sectorId: 'b', name: '接力行业', value: 101.5, rank: 1 },
          { sectorId: 'a', name: '领涨行业', value: 100.1, rank: 2 },
        ],
        missingSectorIds: [],
        reordered: true,
        previousOrder: ['a', 'b'],
      },
    ],
    coverage: {
      batchCount: 4,
      trendPointCount: 4,
      memberCount: 3,
      comparisonCount: 1,
      unresolvedComparisonCount: 0,
    },
    notes: ['板块走势为成分等权合成', '缺失样本一律不补零'],
    ...overrides,
  };
};

describe('板块详情深链接与请求参数', () => {
  it('sector / compare 从 hash 读取，compare 去重、排除目标并截断到 3 个', () => {
    expect(sectorDetailParamsFromHash('#market-room?tab=sectors')).toEqual({
      sectorId: null,
      compareSectorIds: [],
      at: null,
    });
    expect(
      sectorDetailParamsFromHash('#market-room?tab=sectors&sector=a&compare=b,c,b,a,d,e'),
    ).toEqual({ sectorId: 'a', compareSectorIds: ['b', 'c', 'd'], at: null });
    expect(sectorDetailParamsFromHash('#market-room?tab=sectors&sector=%20')).toEqual({
      sectorId: null,
      compareSectorIds: [],
      at: null,
    });
  });

  it('深链接与请求路径互相对应，window / at / compare 显式带上', () => {
    const hash = sectorDetailHash({
      kind: 'concept',
      sort: 'window5',
      window: 'w5',
      sectorId: 'a',
      compareSectorIds: ['b', 'c'],
    });
    expect(hash).toBe(
      'market-room?tab=sectors&kind=concept&sort=window5&window=w5&sector=a&compare=b%2Cc',
    );
    expect(sectorDetailQuery({ sectorId: 'a', window: 'w5', compareSectorIds: ['b', 'c'] })).toBe(
      '?sectorId=a&window=w5&compare=b%2Cc',
    );
    expect(
      sectorDetailQuery({
        sectorId: 'a',
        window: 'w15',
        at: '2026-09-28T10:12:00+08:00',
      }),
    ).toBe('?sectorId=a&window=w15&at=2026-09-28T10%3A12%3A00%2B08%3A00');
  });

  it('对照选择可切换并遵守上限，但不修改入参', () => {
    const current = ['b', 'c'];
    expect(toggleCompareSelection(current, 'd')).toEqual(['b', 'c', 'd']);
    expect(toggleCompareSelection(current, 'b')).toEqual(['c']);
    expect(toggleCompareSelection(['b', 'c', 'd'], 'e')).toEqual(['b', 'c', 'd']);
    expect(current).toEqual(['b', 'c']);
  });
});

describe('走势图模型', () => {
  it('并列序列共用时点，基准 100 与较高值映射到更靠上的位置', () => {
    const model = trendChartModel(detailFixture(), { width: 640, height: 220 });
    expect(model).not.toBeNull();
    expect(model?.series.map((series) => series.name)).toEqual(['领涨行业', '接力行业']);
    expect(model?.series[0]?.segments).toHaveLength(1);
    expect(model?.xTicks.length).toBeGreaterThan(0);
    const firstA = model?.series[0]?.segments[0]?.[0];
    const lastB = model?.series[1]?.segments[0]?.at(-1);
    expect(firstA?.[0]).toBeLessThan(lastB?.[0] ?? 0);
    // 104 > 100：终点更高的序列 y 更小（屏幕坐标）。
    expect(lastB?.[1]).toBeLessThan(firstA?.[1] ?? 0);
  });

  it('缺失时点断线而不是补 0 或连线穿过', () => {
    const fixture = detailFixture({
      trend: trendSeries('a', '领涨行业', [100, null, 101, 102]),
    });
    const model = trendChartModel(fixture);
    expect(model?.series[0]?.segments).toHaveLength(2);
    expect(model?.series[0]?.missingPointCount).toBe(1);
    expect(model?.series[0]?.segments.flat()).toHaveLength(3);
  });

  it('全部缺失或没有序列时返回 null，交由渲染层写缺失', () => {
    expect(trendChartModel({ trend: null, comparisons: [] })).toBeNull();
    expect(
      trendChartModel({
        trend: trendSeries('a', '领涨行业', [null, null]),
        comparisons: [],
      }),
    ).toBeNull();
  });
});

describe('口径与上涨比例文案', () => {
  it('走势口径明确标注非板块指数，并带指数不可用原因', () => {
    const method = trendMethodText(detailFixture().trend);
    expect(method?.label).toBe('成分等权合成走势（非板块指数）');
    expect(method?.reason).toContain('sector_index_unavailable');
    expect(method?.label).not.toContain('大盘');
  });

  it('成分上涨比例独立展示，缺失时不写 0%', () => {
    const breadth = detailFixture().breadth;
    expect(breadthAdvanceText(breadth)).toBe('成分上涨比例 66.67%（上涨 2 / 有效 3）');
    expect(breadthSampleText(breadth)).toBe('成分 4 · 有效 3 · 缺失 0 · 停牌退市 1');
    expect(breadthAdvanceText({ ...breadth, advanceRatio: null, sampleCount: 0 })).toBe(
      '成分上涨比例缺失（无有效成分）',
    );
    expect(breadthAdvanceText(null)).toBeNull();
  });

  it('页头写板块、交易日、数据时点与窗口；空态保留最近批次', () => {
    expect(detailMetaText(detailFixture())).toBe(
      '领涨行业 · 行业 881001.TI · 交易日 2026-09-28 · 数据时点 10:15 · 窗口 5 分钟',
    );
    expect(
      sectorDetailEmptyText({
        state: 'empty',
        emptyReason: 'pre_open',
        anchor: { tradingDate: '2026-09-24', sampledAt: at('10:15') },
      }),
    ).toContain('盘前');
    expect(
      sectorDetailEmptyText({ state: 'empty', emptyReason: 'sector_not_found', anchor: null }),
    ).toContain('不在当前目录');
    expect(sectorDetailEmptyText(detailFixture())).toBeNull();
    expect(detailMetaText(null)).toContain('刷新失败');
  });
});

describe('领先顺序变化', () => {
  it('只列发生变化的时点，带上一顺序与缺失板块', () => {
    const fixture = detailFixture();
    fixture.leaderOrder[1].missingSectorIds = ['c'];
    fixture.comparisons.push(trendSeries('c', '重叠概念', [100, 100.1, null, null]));
    const changes = leaderChangeLines(fixture);
    expect(changes.changed).toBe(true);
    expect(changes.lines).toHaveLength(1);
    expect(changes.lines[0]?.text).toBe('10:10 接力行业 › 领涨行业');
    expect(changes.lines[0]?.previous).toBe('09:35：领涨行业 › 接力行业');
    expect(changes.lines[0]?.missing).toBe('该时点缺少：重叠概念');
  });

  it('没有变化时明确写事实，不编造事件', () => {
    const fixture = detailFixture({
      leaderOrder: [
        {
          sampledAt: at('09:35'),
          entries: [{ sectorId: 'a', name: '领涨行业', value: 100, rank: 1 }],
          missingSectorIds: [],
          reordered: false,
          previousOrder: null,
        },
      ],
    });
    expect(leaderChangeLines(fixture)).toEqual({ lines: [], changed: false });
    expect(latestLeaderText(fixture)).toBe('09:35 领先：领涨行业');
  });
});

describe('成分明细与缺失样本', () => {
  it('成分行给出代码 / 名称 / 日涨幅 / 窗口涨幅 / 增量占比 / 封板 / 状态与个股链接', () => {
    const cells = memberRowCells(member());
    expect(cells).toMatchObject({
      code: '600519',
      name: '贵州茅台',
      day: '+1.23%',
      window: '-0.45%',
      amount: '1.50亿',
      share: '42.50%',
      sealed: '封板 2 板',
      status: '正常',
      inBatch: true,
      href: '#market?stockId=600519.SH&range=3m',
    });
    const returnTo = 'market-room?tab=sectors&sector=a&at=2026-09-28T02%3A15%3A00.000Z';
    expect(memberRowCells(member(), returnTo).href).toBe(
      `#market?stockId=600519.SH&range=3m&returnTo=${encodeURIComponent(returnTo)}`,
    );
  });

  it('停牌 / 缺批次 / 无天梯时全部写缺失而不是 0', () => {
    const cells = memberRowCells(
      member({
        memberStatus: 'suspended',
        inBatch: false,
        dayChangePct: null,
        windowChangePct: null,
        windowAmountDelta: null,
        windowAmountSharePct: null,
        sealed: null,
        ladderLevel: null,
      }),
    );
    expect(cells.day).toBeNull();
    expect(cells.window).toBeNull();
    expect(cells.amount).toBeNull();
    expect(cells.share).toBeNull();
    expect(cells.sealed).toBeNull();
    expect(cells.status).toBe('停牌');
    expect(cells.inBatch).toBe(false);
    expect(cells.day).not.toBe('0.00%');
  });

  it('负的成交额增量保留负号并按亿 / 万格式化', () => {
    const cells = memberRowCells(member({ windowAmountDelta: -150_000_000 }));
    expect(cells.amount).toBe('-1.50亿');
    expect(memberRowCells(member({ windowAmountDelta: 12_000 })).amount).toBe('1.20万');
  });

  it('成分排序把缺失日涨幅排到最后，其余按日涨幅降序', () => {
    const sorted = sortedMembers(detailFixture());
    expect(sorted.map((entry) => entry.code)).toEqual(['600519', '000001', '600036']);
  });

  it('缺失样本逐时点列出，完整时不伪造问题', () => {
    const fixture = detailFixture();
    fixture.trend.points[2] = {
      ...fixture.trend.points[2],
      value: null,
      sampleCount: 0,
      missingCount: 3,
      status: 'unavailable',
      warnings: ['missing_trend_sample: 该时点没有可比较的成分，走势缺失'],
    };
    fixture.trend.points[1] = {
      ...fixture.trend.points[1],
      missingCount: 1,
      sampleCount: 2,
      status: 'partial',
    };
    const lines = missingSamplesText(fixture);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('样本 2 / 成分 3');
    expect(lines[1]).toContain('走势缺失');
    expect(lines[1]).toContain('missing_trend_sample');
    expect(missingSamplesText({ trend: { points: [] } })).toEqual([]);
  });

  it('口径说明合并去重，包含 method 原因与未解析对照', () => {
    const notes = detailNotes(
      detailFixture({
        unresolvedSectorIds: ['missing'],
        notes: ['板块走势为成分等权合成', '缺失样本一律不补零', '板块走势为成分等权合成'],
      }),
    );
    expect(notes.filter((note) => note === '板块走势为成分等权合成')).toHaveLength(1);
    expect(notes.some((note) => note.includes('sector_index_unavailable'))).toBe(true);
    expect(detailNotes({ state: 'empty' })).toEqual([]);
  });

  it('对照候选取榜前 6 个并保留已选，不包含目标板块', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      sectorId: `s${index}`,
      name: `板块${index}`,
      kind: 'industry',
    }));
    const fixture = detailFixture({
      sector: { sectorId: 's0', kind: 'industry', vendorCode: '881001.TI', name: '领涨行业' },
      comparisons: [trendSeries('far', '榜外题材', [100, 101])],
    });
    const candidates = compareCandidates({ rows }, fixture);
    expect(candidates.map((entry) => entry.sectorId)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      'far',
    ]);
  });
});

describe('板块详情入口结构', () => {
  const room = read('./market-room.js');
  const detail = read('./market-room-sector-detail.js');
  const marketRoutes = read('../../src/routes/market.ts');

  it('market-room.js 只加最小接入点：导入详情模块并在点击板块时进入详情', () => {
    expect(room).toContain("from './market-room-sector-detail.js'");
    expect(room).toContain('sectorDetailParamsFromHash');
    expect(room).toContain('fetchSectorDetail');
    expect(room).toContain('renderSectorDetailPane');
    expect(room).toContain('room-sector-detail-slot');
  });

  it('详情模块只读详情接口，不触发采集，也不把大盘指数冒充板块走势', () => {
    expect(detail).toContain('/api/market/room/sector-detail');
    expect(detail).not.toContain('/api/market/room/collect');
    expect(detail).toContain('成分等权合成走势（非板块指数）');
    expect(detail).toContain("from './market-room-return.js'");
    expect(detail).toContain('stockHref(member.stockId, returnTo)');
  });

  it('服务端暴露只读板块详情 API', () => {
    expect(marketRoutes).toContain("app.get('/api/market/room/sector-detail'");
    expect(marketRoutes).toContain("invokeTool('get_market_room_sector_detail'");
  });
});

describe('回放（ticket #43）', () => {
  const at = new Date('2026-09-28T10:15:00+08:00');

  it('板块详情深链接保留同一个 at，避免下钻回到最新', () => {
    const params = {
      kind: 'industry',
      sort: 'day',
      window: 'w15',
      sectorId: 'a',
      compareSectorIds: ['b'],
      at,
    };
    const hash = sectorDetailHash(params);
    expect(hash).toContain('sector=a');
    expect(hash).toContain('compare=b');
    expect(hash).toContain('at=2026-09-28T02%3A15%3A00.000Z');
    expect(sectorDetailParamsFromHash(`#${hash}`)).toEqual({
      sectorId: 'a',
      compareSectorIds: ['b'],
      at,
    });
  });
});
