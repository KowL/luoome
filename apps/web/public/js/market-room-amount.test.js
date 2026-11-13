/* apps/web/public/js/market-room-amount.test.js —— 成交分布纯函数与入口结构断言（ticket #40）。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  amountConcentrationReason,
  amountConcentrationText,
  amountDeltaText,
  amountDeltaTone,
  amountEmptyText,
  amountHash,
  amountMetaText,
  amountNumeratorText,
  amountParamsFromHash,
  amountQuery,
  amountRowCells,
  amountSampleText,
  amountScopeNotes,
  amountShareText,
  amountWindowText,
} from './market-room-amount.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const shareMetric = (overrides = {}) => ({
  value: 29.25,
  status: 'complete',
  memberCount: 3,
  sampleCount: 3,
  missingCount: 0,
  nonTradableCount: 0,
  numeratorAmount: 310,
  method: '窗口成交占比 = 成分增量 ÷ 全市场去重增量',
  warnings: [],
  ...overrides,
});

const amountRow = (overrides = {}) => ({
  sectorId: 'sec-w',
  kind: 'industry',
  vendorCode: '881004.TI',
  name: '丁行业',
  rank: 1,
  share: shareMetric(),
  previousShare: shareMetric({ value: 25, numeratorAmount: 210 }),
  deltaPp: {
    value: 4.25,
    status: 'complete',
    reason: null,
    method: '环比 = 本窗口占比 − 上一窗口占比（百分点）',
    warnings: [],
  },
  ...overrides,
});

const amountDistribution = (overrides = {}) => ({
  state: 'ready',
  kind: 'industry',
  window: 'w5',
  tradingDate: '2026-09-28',
  anchor: { sampledAt: '2026-09-28T02:15:00.000Z' },
  windows: {
    current: {
      status: 'complete',
      startSampledAt: '2026-09-28T02:10:00.000Z',
      spanMs: 300000,
      reason: null,
    },
    previous: {
      status: 'unavailable',
      startSampledAt: null,
      spanMs: null,
      reason: 'window_start_missing: 10:05 及之前没有已发布批次',
    },
  },
  turnover: {
    current: {
      status: 'complete',
      reason: null,
      marketAmountDelta: 1060,
      marketSampleCount: 12,
      marketTotalCount: 12,
    },
    previous: {
      status: 'unavailable',
      reason: 'window_start_missing: 10:05 及之前没有已发布批次',
      marketAmountDelta: null,
      marketSampleCount: 0,
      marketTotalCount: 0,
    },
  },
  concentration: {
    basis: 'CR3',
    definition: 'CR3 = 本窗口成交占比排名前 3 的板块占比之和（百分点）；概念可重叠，占比不可加总。',
    value: 79.25,
    status: 'complete',
    reason: null,
    sectorCount: 4,
    top: [
      { sectorId: 'sec-w', name: '丁行业', share: 29.25 },
      { sectorId: 'sec-z', name: '丙行业', share: 27.36 },
      { sectorId: 'sec-x', name: '甲行业', share: 22.64 },
    ],
    method: 'CR3 = 前 3 名板块窗口成交占比之和（百分点）',
    warnings: [],
  },
  coverage: { sectorCount: 4, rowCount: 4, omittedSectorCount: 0 },
  rows: [amountRow()],
  notes: [
    '窗口成交占比 = 板块 active 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量；同一股票只在窗口两端批次都出现且都有成交额时计入分母。',
    '概念间成分可重叠，各板块占比不可加总为市场总量；CR3 只作「成交是否集中在少数方向」的指示值。',
    '停牌 / 退市成分从占比中排除，但不算缺失、也不计作零成交；漏采（批次缺条目、缺成交额）标注为缺失样本，同样不补零。',
  ],
  ...overrides,
});

describe('成交分布深链接与请求参数', () => {
  it('默认行业 / 15 分钟窗口，非法值回退默认', () => {
    expect(amountParamsFromHash('#market-room?tab=turnover')).toEqual({
      kind: 'industry',
      window: 'w15',
    });
    expect(amountParamsFromHash('#market-room?tab=turnover&kind=concept&window=w5')).toEqual({
      kind: 'concept',
      window: 'w5',
    });
    expect(amountParamsFromHash('#market-room?tab=turnover&kind=futures&window=w1')).toEqual({
      kind: 'industry',
      window: 'w15',
    });
    expect(amountParamsFromHash('')).toEqual({ kind: 'industry', window: 'w15' });
  });

  it('请求路径与深链接互相对应，口径显式带在 URL 上', () => {
    const params = { kind: 'concept', window: 'w5' };
    expect(amountQuery(params)).toBe('?kind=concept&window=w5');
    expect(amountHash(params)).toBe('market-room?tab=turnover&kind=concept&window=w5');
    expect(amountQuery(amountParamsFromHash(`#${amountHash(params)}`))).toBe(amountQuery(params));
  });
});

describe('占比 / 环比 / 集中度文案', () => {
  it('占比保留两位小数，缺失返回 null 由渲染层写缺失', () => {
    expect(amountShareText(shareMetric())).toBe('29.25%');
    expect(amountShareText(shareMetric({ value: 0 }))).toBe('0.00%');
    expect(amountShareText(shareMetric({ value: null, status: 'unavailable' }))).toBeNull();
    expect(amountShareText(undefined)).toBeNull();
  });

  it('环比以百分点表示，正数带 + 号，配色红涨绿跌', () => {
    expect(amountDeltaText({ value: 4.25 })).toBe('+4.25pp');
    expect(amountDeltaText({ value: -4.78 })).toBe('-4.78pp');
    expect(amountDeltaText({ value: 0 })).toBe('0.00pp');
    expect(amountDeltaText({ value: null })).toBeNull();

    expect(amountDeltaTone({ value: 4.25 })).toBe('text-pos');
    expect(amountDeltaTone({ value: -4.78 })).toBe('text-neg');
    expect(amountDeltaTone({ value: 0 })).toBe('muted');
    expect(amountDeltaTone({ value: null })).toBe('muted');
  });

  it('集中度文案带 CR3 与前 3 名板块；口径不可用时给原因而不是 0', () => {
    const concentration = amountDistribution().concentration;
    expect(amountConcentrationText(concentration)).toBe('79.25%（丁行业 · 丙行业 · 甲行业）');
    expect(amountConcentrationReason(concentration)).toBeNull();

    const unavailable = {
      value: null,
      status: 'unavailable',
      reason: 'concentration_insufficient_sectors: 只有 1 个板块有可用占比，CR3 需要至少 3 个',
      top: [],
      sectorCount: 1,
    };
    expect(amountConcentrationText(unavailable)).toBeNull();
    expect(amountConcentrationReason(unavailable)).toContain('concentration_insufficient_sectors');
    expect(amountConcentrationText({ value: null, top: [] })).toBeNull();
  });

  it('样本口径与分子 / 分母分开写，分母缺失时不给算术结果', () => {
    expect(amountSampleText(shareMetric({ missingCount: 1, nonTradableCount: 2 }))).toBe(
      '有效 3 / 成分 3 · 缺失 1 · 停牌退市 2',
    );
    expect(amountSampleText(null)).toBeNull();

    const distribution = amountDistribution();
    expect(amountNumeratorText(amountRow(), distribution)).toBe('310 / 1060');
    expect(
      amountNumeratorText(
        amountRow(),
        amountDistribution({
          turnover: {
            ...distribution.turnover,
            current: { ...distribution.turnover.current, marketAmountDelta: null },
          },
        }),
      ),
    ).toBeNull();
    expect(
      amountNumeratorText(
        amountRow({ share: shareMetric({ numeratorAmount: null }) }),
        distribution,
      ),
    ).toBeNull();
  });

  it('窗口两端与跨度写明；不可比时给出原因而不是 0', () => {
    expect(amountWindowText(amountDistribution().windows.current)).toBe('10:10 → 10:15 · 5 分钟');
    expect(amountWindowText(amountDistribution().windows.previous)).toContain(
      'window_start_missing',
    );
    expect(amountWindowText(undefined)).toBe('窗口缺失');
  });
});

describe('行文案、空态与页头', () => {
  it('缺失口径不编造数字：null 值、无名次与缺失原因都明确', () => {
    const row = amountRow({
      rank: null,
      share: shareMetric({ value: null, status: 'unavailable', numeratorAmount: null }),
      previousShare: shareMetric({ value: null, status: 'unavailable', numeratorAmount: null }),
      deltaPp: {
        value: null,
        status: 'unavailable',
        reason: 'current_window_missing: window_start_missing',
        warnings: [],
      },
    });
    const cells = amountRowCells(row);
    expect(cells.rank).toBe('—');
    expect(cells.share).toBeNull();
    expect(cells.previous).toBeNull();
    expect(cells.delta).toBeNull();
    expect(cells.deltaTone).toBe('muted');
    expect(cells.share).not.toBe('0.00%');
  });

  it('口径说明包含重叠 / 停牌 / 漏采 / 分母与行内缺失原因，且去重', () => {
    const distribution = amountDistribution({
      concentration: {
        ...amountDistribution().concentration,
        value: null,
        status: 'unavailable',
        reason: 'concentration_insufficient_sectors: 只有 1 个板块有可用占比',
        top: [],
      },
      rows: [
        amountRow({
          deltaPp: {
            value: null,
            status: 'unavailable',
            reason: 'previous_window_missing: window_start_missing: 10:05 及之前没有已发布批次',
            warnings: ['previous_window_missing: window_start_missing: 10:05 及之前没有已发布批次'],
          },
          share: shareMetric({ warnings: ['non_tradable: 1 只停牌 / 退市成分已排除'] }),
        }),
      ],
    });
    const notes = amountScopeNotes(distribution);
    expect(notes.join(' ')).toContain('不可加总');
    expect(notes.join(' ')).toContain('停牌');
    expect(notes.join(' ')).toContain('漏采');
    expect(notes.join(' ')).toContain('window_start_missing');
    expect(notes.join(' ')).toContain('concentration');
    expect(new Set(notes).size).toBe(notes.length);
    expect(amountScopeNotes(null)).toEqual([]);
  });

  it('空态与页头区分批次 / 目录 / 成分三类缺失，页头写明窗口与环比单位', () => {
    expect(
      amountEmptyText({ state: 'empty', emptyReason: 'no_sector_catalog', anchor: null }),
    ).toContain('目录尚未同步');
    expect(amountEmptyText({ state: 'empty', emptyReason: 'no_batch', anchor: null })).toBe(
      '尚无已发布的盘中批次',
    );
    expect(amountEmptyText(amountDistribution())).toBeNull();
    expect(amountMetaText(amountDistribution())).toBe(
      '行业 · 交易日 2026-09-28 · 数据时点 10:15 · 5 分钟窗口 · 环比单位 pp',
    );
    expect(amountMetaText(amountDistribution({ kind: 'concept', window: 'w15' }))).toContain(
      '概念 · 交易日 2026-09-28 · 数据时点 10:15 · 15 分钟窗口',
    );
    expect(
      amountMetaText(
        amountDistribution({ state: 'empty', emptyReason: 'non_trading_day', anchor: null }),
      ),
    ).toContain('非交易日');
    expect(amountMetaText(null)).toContain('刷新失败');
  });
});

describe('成交分布页面入口结构', () => {
  const room = read('./market-room.js');
  const amount = read('./market-room-amount.js');
  const marketRoutes = read('../../src/routes/market.ts');

  it('market-room.js 只接入成交分布模块，不复制请求逻辑', () => {
    expect(room).toContain("from './market-room-amount.js'");
    expect(room).toContain('/api/market/room/amount-distribution');
    expect(room).toContain('amountParamsFromHash');
    expect(room).toContain('renderAmountPane');
    expect(room).not.toContain('/api/market/room/collect');
  });

  it('成交分布前端模块包含窗口切换、占比、环比、集中度与口径说明', () => {
    expect(amount).toContain('AMOUNT_WINDOWS');
    expect(amount).toContain("w5: '5 分钟'");
    expect(amount).toContain("w15: '15 分钟'");
    expect(amount).toContain('环比（pp）');
    expect(amount).toContain('成交集中度');
    expect(amount).toContain('口径说明');
    expect(amount).toContain('不可加总');
    expect(amount).toContain('停牌');
    expect(amount).toContain('漏采');
  });

  it('服务端暴露只读成交分布 API', () => {
    expect(marketRoutes).toContain("app.get('/api/market/room/amount-distribution'");
    expect(marketRoutes).toContain("invokeTool('get_market_room_amount_distribution'");
  });
});
