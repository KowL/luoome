/* apps/web/public/js/market-room-roles.test.js —— 核心股区块纯函数与接入结构断言。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  coreStocksEmptyText,
  coreStocksMetaText,
  coreStocksQuery,
  evidenceText,
  lookupCards,
  roleCards,
  timelineLines,
} from './market-room-roles.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const at = (time) => new Date(`2026-09-28T${time}+08:00`);

const evidence = (overrides = {}) => ({
  sampledAt: at('09:35'),
  field: 'firstTime',
  value: '09:31:00',
  source: 'limit_up_ladder:eastmoney',
  note: '供应商涨停池封板时间，按原口径展示，不推算',
  ...overrides,
});

const holder = (overrides = {}) => ({
  stockId: '600519.SH',
  code: '600519',
  name: '贵州茅台',
  evidence: [evidence()],
  ...overrides,
});

const role = (kind, overrides = {}) => ({
  kind,
  label: { ignition: '启动先锋', turnover: '成交核心', height: '高度标' }[kind],
  status: 'assigned',
  holders: [holder()],
  method: '角色口径',
  reason: null,
  warnings: [],
  ...overrides,
});

const coreFixture = (overrides = {}) => ({
  state: 'ready',
  sector: { sectorId: 'sector-a', kind: 'concept', vendorCode: '886001.TI', name: '重叠概念' },
  tradingDate: '2026-09-28',
  anchor: { sampledAt: at('14:50') },
  window: 'w15',
  roles: {
    ignition: role('ignition'),
    turnover: role('turnover', {
      holders: [
        holder({
          stockId: '600036.SH',
          code: '600036',
          name: '招商银行',
          evidence: [
            evidence({
              sampledAt: at('14:50'),
              field: 'amount',
              value: 1_406_500_000,
              source: 'market_snapshot_batch:market-day-fixture',
              note: '锚点累计成交额，占板块 active 成分合计 62.50%',
            }),
            evidence({
              sampledAt: at('14:15'),
              field: 'dayChangePct',
              value: 1.6432,
              source: 'market_snapshot_batch:market-day-fixture',
              note: '跑赢板块中位数 1.56%',
            }),
          ],
        }),
      ],
    }),
    height: role('height', {
      holders: [
        holder({
          stockId: '600036.SH',
          code: '600036',
          name: '招商银行',
          evidence: [
            evidence({
              sampledAt: at('14:50'),
              field: 'ladderLevel',
              value: 1,
              source: 'limit_up_ladder:eastmoney',
              note: '14:50 天梯样本中的连板层级',
            }),
          ],
        }),
      ],
    }),
  },
  timeline: [
    {
      sampledAt: at('09:35'),
      previousSampledAt: null,
      kind: 'appear',
      roleKind: 'height',
      from: [],
      to: [{ stockId: '600519.SH', code: '600519', name: '贵州茅台' }],
      basis: '09:35 高度标出现：600519',
      evidence: [evidence({ field: 'ladderLevel', value: 2 })],
    },
    {
      sampledAt: at('13:15'),
      previousSampledAt: at('11:00'),
      kind: 'open_board',
      roleKind: null,
      from: [{ stockId: '600519.SH', code: '600519', name: '贵州茅台' }],
      to: [],
      basis: '11:00 → 13:15 600519 从封板变为未封（开板）',
      evidence: [
        evidence({
          sampledAt: at('13:15'),
          field: 'sealed',
          value: false,
          source: 'limit_up_ladder:eastmoney',
          note: '上一有样本时点 11:00 仍在天梯中',
        }),
      ],
    },
    {
      sampledAt: at('13:15'),
      previousSampledAt: at('11:00'),
      kind: 'rotate',
      roleKind: 'height',
      from: [{ stockId: '600519.SH', code: '600519', name: '贵州茅台' }],
      to: [{ stockId: '600036.SH', code: '600036', name: '招商银行' }],
      basis: '13:15 高度标换位：600519 → 600036',
      evidence: [],
    },
    {
      sampledAt: at('14:50'),
      previousSampledAt: at('14:15'),
      kind: 'appear',
      roleKind: 'turnover',
      from: [],
      to: [{ stockId: '600036.SH', code: '600036', name: '招商银行' }],
      basis: '14:50 成交核心出现：600036',
      evidence: [],
    },
  ],
  lookups: [
    {
      stockId: '600036.SH',
      code: '600036',
      name: '招商银行',
      themeCount: 2,
      roleThemeCount: 2,
      pullsMultipleThemes: true,
      themes: [
        {
          sectorId: 'sector-a',
          kind: 'concept',
          vendorCode: '886001.TI',
          name: '重叠概念',
          roleKinds: ['turnover', 'height'],
          breadth: { status: 'complete', advancing: 2, sampleCount: 2, advanceRatio: 100 },
          thisStock: {
            stockId: '600036.SH',
            code: '600036',
            name: '招商银行',
            memberStatus: 'listed',
            dayChangePct: 2.104,
            windowChangePct: null,
            sealed: true,
            ladderLevel: 1,
            dayRank: 1,
          },
          peerCount: 1,
          peers: [
            {
              stockId: '600519.SH',
              code: '600519',
              name: '贵州茅台',
              memberStatus: 'listed',
              dayChangePct: 1,
              windowChangePct: -0.47,
              sealed: false,
              ladderLevel: null,
              dayRank: 2,
            },
          ],
          warnings: [],
        },
        {
          sectorId: 'sector-b',
          kind: 'industry',
          vendorCode: '881001.TI',
          name: '接力组',
          roleKinds: ['height'],
          breadth: { status: 'complete', advancing: 2, sampleCount: 3, advanceRatio: 66.67 },
          thisStock: {
            stockId: '600036.SH',
            code: '600036',
            name: '招商银行',
            memberStatus: 'listed',
            dayChangePct: 2.104,
            windowChangePct: null,
            sealed: true,
            ladderLevel: 1,
            dayRank: 1,
          },
          peerCount: 12,
          peers: [
            {
              stockId: '000858.SZ',
              code: '000858',
              name: '五粮液',
              memberStatus: 'listed',
              dayChangePct: 1.72,
              windowChangePct: null,
              sealed: false,
              ladderLevel: null,
              dayRank: 2,
            },
          ],
          warnings: ['peers_truncated: 仅展示前 20 只'],
        },
      ],
      warnings: [],
    },
  ],
  coverage: {
    batchCount: 6,
    ladderSampleCount: 6,
    ladderMissingCount: 0,
    timelineEventCount: 4,
    lookupCount: 1,
  },
  notes: [
    '核心角色由本地已发布批次与按采样时点保存的天梯事实复算；只读，不触发采集。',
    '时间线不写入事件存储（事件由 #42 负责）。',
  ],
  ...overrides,
});

describe('coreStocksQuery', () => {
  it('sectorId 必填并编码，kind / at 可选', () => {
    expect(coreStocksQuery({ sectorId: 'sector a' })).toBe('?sectorId=sector%20a');
    expect(coreStocksQuery({ sectorId: 'sector-a', kind: 'height' })).toBe(
      '?sectorId=sector-a&kind=height',
    );
    expect(coreStocksQuery({ sectorId: 'sector-a', at: '2026-09-28T10:15:00+08:00' })).toBe(
      '?sectorId=sector-a&at=2026-09-28T10%3A15%3A00%2B08%3A00',
    );
  });
});

describe('空态与页头', () => {
  it('空态文案带最近批次时点，不写 0', () => {
    const core = {
      state: 'empty',
      emptyReason: 'no_batch',
      anchor: null,
      sector: null,
      window: 'w15',
    };
    expect(coreStocksEmptyText(core)).toBe('尚无已发布的盘中批次');
    expect(coreStocksMetaText(core)).toContain('核心股 · 尚无已发布的盘中批次');
    expect(
      coreStocksEmptyText({
        state: 'empty',
        emptyReason: 'no_members',
        anchor: { tradingDate: '2026-09-28', sampledAt: at('14:50') },
      }),
    ).toBe('该板块没有 active 成分 · 最近批次 2026-09-28 14:50');
    expect(coreStocksEmptyText(coreFixture())).toBeNull();
    expect(coreStocksMetaText(null)).toBe('核心股 · 刷新失败');
  });

  it('ready 页头给板块身份、数据时点、天梯样本覆盖与时间线条数', () => {
    expect(coreStocksMetaText(coreFixture())).toBe(
      '重叠概念 · 概念 886001.TI · 数据时点 14:50 · 天梯样本 6/6 · 时间线 4 条',
    );
  });
});

describe('角色卡与证据', () => {
  it('三个角色按顺序给出状态、持有人与入选依据', () => {
    const cards = roleCards(coreFixture());
    expect(cards.map((card) => card.kind)).toEqual(['ignition', 'turnover', 'height']);
    expect(cards.map((card) => card.label)).toEqual(['启动先锋', '成交核心', '高度标']);
    expect(cards[0]?.statusLabel).toBe('已入选');
    expect(cards[0]?.holders[0]?.href).toBe('#market?stockId=600519.SH&range=3m');
    expect(cards[1]?.holders[0]?.evidence.length).toBe(2);
  });

  it('进个股页时带 returnTo，返回仍停在原作战室现场', () => {
    const returnTo = 'market-room?tab=sectors&sector=886001&at=2026-09-28T02%3A15%3A00.000Z';
    const href = `#market?stockId=600519.SH&range=3m&returnTo=${encodeURIComponent(returnTo)}`;
    const cards = roleCards(coreFixture(), returnTo);
    expect(cards[0]?.holders[0]?.href).toBe(href);
    expect(lookupCards(coreFixture(), returnTo)[0]?.href).toBe(
      `#market?stockId=600036.SH&range=3m&returnTo=${encodeURIComponent(returnTo)}`,
    );
  });

  it('证据行包含时点、字段、数值、来源与说明', () => {
    const text = evidenceText(evidence());
    expect(text).toContain('09:35');
    expect(text).toContain('封板时间 09:31:00');
    expect(text).toContain('limit_up_ladder:eastmoney');
    expect(text).toContain('供应商涨停池封板时间');

    expect(
      evidenceText(
        evidence({ field: 'amount', value: 1_406_500_000, source: 'market_snapshot_batch:x' }),
      ),
    ).toContain('成交额 14.06亿');
    expect(evidenceText(evidence({ field: 'dayChangePct', value: 2.104 }))).toContain('2.10%');
    expect(evidenceText(evidence({ field: 'sealed', value: false }))).toContain('封板状态 未封');
    expect(evidenceText(evidence({ field: 'sealed', value: true }))).toContain('封板状态 封板');
    expect(evidenceText(evidence({ field: 'ladderSample', value: false }))).toContain(
      '天梯样本 缺样本',
    );
    expect(evidenceText(evidence({ value: null }))).toContain('缺失');
  });

  it('证据不足时写原因，不伪造持有人', () => {
    const core = coreFixture({
      roles: {
        ...coreFixture().roles,
        turnover: {
          ...coreFixture().roles.turnover,
          status: 'unavailable',
          holders: [],
          reason:
            'top_contributor_without_sustained_strength: 成交额最高的 600036 只在 1 个连续样本跑赢板块中位数（要求 ≥2）',
        },
      },
    });
    const card = roleCards(core).find((entry) => entry.kind === 'turnover');
    expect(card?.statusLabel).toBe('证据不足');
    expect(card?.statusClass).toBe('room-status-unavailable');
    expect(card?.holders).toEqual([]);
    expect(card?.reason).toContain('top_contributor_without_sustained_strength');
  });
});

describe('时间线', () => {
  it('出现 / 开板 / 换位带时点、角色与依据', () => {
    const lines = timelineLines(coreFixture());
    expect(lines.map((line) => line.kindLabel)).toEqual(['出现', '开板', '换位', '出现']);
    expect(lines.map((line) => line.roleLabel)).toEqual(['高度标', null, '高度标', '成交核心']);
    expect(lines[0]?.to).toBe('600519');
    expect(lines[1]?.from).toBe('600519');
    expect(lines[2]?.text).toContain('高度标换位');
    expect(lines[3]?.time).toBe('14:50');
    expect(lines[1]?.evidence.length).toBe(1);
  });

  it('空态不渲染时间线', () => {
    expect(timelineLines({ state: 'empty' })).toEqual([]);
    expect(timelineLines(null)).toEqual([]);
  });
});

describe('从核心股反查题材', () => {
  it('给出题材、本股角色、上涨面与其他成员同期表现', () => {
    const [card] = lookupCards(coreFixture());
    expect(card?.multiple).toBe(true);
    expect(card?.summary).toContain('2 个题材');
    expect(card?.summary).toContain('拉动多个题材');
    expect(card?.themes[0]?.roleText).toBe('成交核心 / 高度标');
    expect(card?.themes[0]?.breadthText).toBe('上涨比例 100.00%（2/2）');
    expect(card?.themes[0]?.thisStockText).toContain('题材内第 1 名');
    expect(card?.themes[0]?.peers[0]?.code).toBe('600519');
    expect(card?.themes[0]?.peers[0]?.day).toBe('+1.00%');
    expect(card?.themes[0]?.peers[0]?.window).toBe('-0.47%');
    expect(card?.themes[0]?.peers[0]?.sealed).toBe('未封');
    expect(card?.themes[1]?.peerCount).toBe(12);
    expect(card?.themes[1]?.warnings.length).toBe(1);
  });

  it('无核心股时不产生反查卡片', () => {
    expect(lookupCards({ state: 'empty' })).toEqual([]);
    expect(lookupCards(null)).toEqual([]);
  });
});

describe('页面接入结构', () => {
  it('market-room.js 拉取核心股并把区块挂到板块详情之后', () => {
    const source = read('./market-room.js');
    expect(source).toContain("from './market-room-roles.js'");
    expect(source).toContain('fetchCoreStocks(');
    expect(source).toContain('renderCoreStocksPane(');
    expect(source).toContain('Promise.all');
  });

  it('卡片头使用 el(tag, null, children)，不把子节点数组当 className', () => {
    for (const file of ['./market-room-roles.js', './market-room-sector-detail.js']) {
      expect(read(file)).not.toContain("el('div', [");
    }
  });

  it('核心股区块样式已写入 style.css', () => {
    const css = read('../style.css');
    for (const selector of [
      '.room-roles',
      '.room-role-card',
      '.room-role-evidence',
      '.room-timeline',
      '.room-lookup',
    ]) {
      expect(css).toContain(selector);
    }
  });
});
