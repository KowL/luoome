/* apps/web/public/js/market-room-events.test.js —— 盘中事件区纯函数与接入结构断言。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  eventDetailFacts,
  eventKeywordText,
  eventKindLabel,
  eventLadderLines,
  eventMemberLines,
  eventNotes,
  eventSummaryText,
  eventsEmptyText,
  eventsHash,
  eventsMetaText,
  eventsParamsFromHash,
  renderEventsPane,
  rotationLeadLines,
  sortEventsDesc,
  thresholdsText,
} from './market-room-events.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const at = (time) => new Date(`2026-09-28T${time}+08:00`);

const diffusionThresholds = {
  kind: 'diffusion',
  lookbackSamples: 1,
  minSampleCount: 3,
  advanceRatioGainPp: 8,
  windowChangePctAbove: 0,
  turnoverShareDeltaPpAtLeast: 0,
};

const diffusionEvent = (overrides = {}) => ({
  id: '2026-09-28|diffusion|sector-a|2026-09-28T01:45:00.000Z',
  tradingDate: '2026-09-28',
  kind: 'diffusion',
  sector: { sectorId: 'sector-a', kind: 'industry', vendorCode: '881101.TI', name: '扩散题材' },
  sampledAt: at('09:45'),
  previousSampledAt: at('09:40'),
  status: 'partial',
  thresholds: diffusionThresholds,
  evidence: {
    window: {
      lookbackSamples: 1,
      baseSampledAt: at('09:40'),
      sampledAt: at('09:45'),
      spanMs: 300_000,
      status: 'complete',
      changePct: 2.6669,
      sampleCount: 3,
      missingCount: 0,
      nonTradableCount: 0,
      method: '窗口涨幅 = 板块 active 成分窗口两端价格比值 - 1 后等权',
      reason: null,
      warnings: [],
    },
    ranking: { sort: 'day', dayRank: 2, sectorCount: 2, dayChangePct: 3, method: '名次口径' },
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
      baseSampledAt: at('09:40'),
      method: '上涨面口径',
      warnings: [],
    },
    turnover: {
      status: 'complete',
      sharePct: 50,
      baseSharePct: 50,
      deltaPp: 0,
      numeratorAmount: 300_000_000,
      marketAmountDelta: 600_000_000,
      sampleCount: 3,
      memberCount: 3,
      missingCount: 0,
      baseSampledAt: at('09:40'),
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
      reason: 'limit_up_missing: 检测样本没有对齐的连板天梯样本',
    },
    members: {
      memberCount: 3,
      shownCount: 2,
      truncated: true,
      peers: [
        {
          stockId: '600001.SH',
          code: '600001',
          name: '甲',
          dayChangePct: 3,
          windowChangePct: 1.98,
          sealed: true,
          ladderLevel: 1,
          firstTime: '09:41:00',
          reason: '锂电池',
        },
        {
          stockId: '600002.SH',
          code: '600002',
          name: null,
          dayChangePct: null,
          windowChangePct: null,
          sealed: false,
          ladderLevel: null,
          firstTime: null,
          reason: null,
        },
      ],
      method: '成分口径',
    },
    keywords: [{ text: '锂电池', source: 'limit_up_ladder_reason' }],
  },
  verification: { status: 'verified', basis: 'sector_catalog:industry:881101.TI' },
  recordedAt: at('09:45'),
  ...overrides,
});

const rotationEvent = (overrides = {}) => ({
  ...diffusionEvent(),
  id: '2026-09-28|rotation|sector-b|2026-09-28T06:15:00.000Z',
  kind: 'rotation',
  sector: { sectorId: 'sector-b', kind: 'industry', vendorCode: '881102.TI', name: '接力题材' },
  sampledAt: at('14:15'),
  thresholds: {
    kind: 'rotation',
    lookbackSamples: 1,
    minSampleCount: 3,
    consecutiveSamples: 2,
    windowLeadPpAtLeast: 1,
  },
  evidence: {
    ...diffusionEvent().evidence,
    rotation: {
      from: {
        sector: {
          sectorId: 'sector-a',
          kind: 'industry',
          vendorCode: '881101.TI',
          name: '领涨题材',
        },
        dayRank: 2,
        dayChangePct: 1.68,
        windowChangePct: -0.47,
      },
      to: {
        sector: {
          sectorId: 'sector-b',
          kind: 'industry',
          vendorCode: '881102.TI',
          name: '接力题材',
        },
        dayRank: 1,
        dayChangePct: 1.75,
        windowChangePct: 0.48,
      },
      leadSamples: [
        {
          sampledAt: at('14:05'),
          fromWindowChangePct: -0.47,
          toWindowChangePct: 0.48,
          deltaPp: 0.95,
        },
        {
          sampledAt: at('14:15'),
          fromWindowChangePct: -0.42,
          toWindowChangePct: 0.53,
          deltaPp: 0.95,
        },
      ],
    },
  },
  ...overrides,
});

const viewFixture = (overrides = {}) => ({
  state: 'ready',
  tradingDate: '2026-09-28',
  filters: { date: null, from: null, to: null, kind: null, sectorId: null },
  counts: { total: 2, diffusion: 1, divergence: 0, rotation: 1 },
  events: [rotationEvent(), diffusionEvent()],
  notes: ['事件按检测时点升序返回；页面按时间倒序展示。'],
  ...overrides,
});

describe('事件文案', () => {
  it('种类标签与阈值逐项写出', () => {
    expect(eventKindLabel('diffusion')).toBe('扩散');
    expect(eventKindLabel('divergence')).toBe('分化');
    expect(eventKindLabel('rotation')).toBe('换位');
    expect(eventKindLabel('unknown')).toBe('unknown');
    expect(thresholdsText(diffusionThresholds)).toBe(
      '上涨面 ≥ +8.00pp · 窗口 > 0.00% · 占比 ≥ 0.00pp（回看 1 个样本）',
    );
    expect(
      thresholdsText({
        kind: 'divergence',
        lookbackSamples: 1,
        minSampleCount: 3,
        dayRankMax: 5,
        advanceRatioDropPp: 8,
        windowChangePctBelow: 0,
      }),
    ).toBe('日涨幅名次 ≤ 5 · 上涨面回落 ≥ +8.00pp · 窗口 < 0.00%（回看 1 个样本）');
    expect(
      thresholdsText({
        kind: 'rotation',
        lookbackSamples: 1,
        minSampleCount: 3,
        consecutiveSamples: 2,
        windowLeadPpAtLeast: 1,
      }),
    ).toBe('连续 2 个样本窗口差 ≥ +1.00pp（回看 1 个样本）');
    expect(thresholdsText(null)).toBe('缺失');
  });

  it('一行摘要覆盖扩散 / 分化 / 换位', () => {
    expect(eventSummaryText(diffusionEvent())).toBe(
      '上涨面 66.67% → 100.00%（+33.33pp） · 窗口 +2.67% · 占比 50.00%（0.00pp）',
    );
    expect(eventSummaryText(rotationEvent())).toBe(
      '领涨 领涨题材 → 接力题材 · 连续 2 个样本 窗口差 +0.95pp',
    );
  });

  it('证据事实包含时点、名次、上涨面、窗口、占比、封板与阈值', () => {
    const facts = eventDetailFacts(diffusionEvent());
    const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact.value]));
    expect(byLabel['检测时点']).toBe('09:45 · 交易日 2026-09-28');
    expect(byLabel['板块']).toBe('扩散题材 · 行业 881101.TI');
    expect(byLabel['日涨幅名次']).toBe('第 2 / 2 名');
    expect(byLabel['日涨幅']).toBe('+3.00%');
    expect(byLabel['窗口涨幅']).toBe('+2.67%（回看 1 个样本）');
    expect(byLabel['上涨面']).toBe('上涨 3 / 有效 3（100.00%，成分 3）');
    expect(byLabel['上涨面变化']).toBe('+33.33pp（基准 66.67%）');
    expect(byLabel['窗口成交占比']).toBe('50.00%（较上一窗口 0.00pp）');
    expect(byLabel['封板数']).toBe('缺失');
    expect(byLabel['事件状态']).toBe('证据部分缺失');
    expect(byLabel['核实状态']).toBe('已核实 · 已收录目录板块');
    expect(byLabel['触发阈值']).toContain('上涨面 ≥ +8.00pp');
  });

  it('天梯证据缺失写原因；有样本时给出封板时间与涨停原因', () => {
    expect(eventLadderLines(diffusionEvent())[0]).toContain('limit_up_missing');
    const withLadder = diffusionEvent();
    withLadder.evidence.ladder = {
      ...withLadder.evidence.ladder,
      status: 'complete',
      sealedCount: 1,
      stocks: [
        {
          code: '600001',
          name: '甲',
          ladderLevel: 2,
          firstTime: null,
          reason: null,
        },
      ],
    };
    expect(eventLadderLines(withLadder)).toEqual(['600001 甲 · 2 板 · 封板 缺失 · 涨停原因 缺失']);
    withLadder.evidence.ladder = {
      ...withLadder.evidence.ladder,
      sealedCount: 0,
      stocks: [],
    };
    expect(eventLadderLines(withLadder)).toEqual(['该时点板块内没有封板成分（天梯样本存在）']);
  });

  it('关键词与已知成分缺失时不编造', () => {
    expect(eventKeywordText(diffusionEvent())).toBe('锂电池');
    expect(eventKeywordText({ evidence: { keywords: [] } })).toBeNull();
    const members = eventMemberLines(diffusionEvent());
    expect(members.lines).toEqual([
      '600001 甲 +3.00% / +1.98% · 1 板',
      '600002 缺失 / 缺失 · 未封',
    ]);
    expect(members.caption).toBe('仅展示日涨幅前 2 / 3 只 active 成分');
  });

  it('换位领先样本逐条给出旧 / 新领先者窗口涨幅与差值', () => {
    const lines = rotationLeadLines(rotationEvent());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('14:05 领涨题材 -0.47% / 接力题材 +0.48%（+0.95pp）');
    expect(eventNotes(rotationEvent())).toContain(
      '14:05 领涨题材 -0.47% / 接力题材 +0.48%（+0.95pp）',
    );
  });

  it('口径与缺失说明去重后包含方法、警告与缺失原因', () => {
    const notes = eventNotes(diffusionEvent());
    expect(notes).toContain('窗口涨幅 = 板块 active 成分窗口两端价格比值 - 1 后等权');
    expect(notes).toContain('limit_up_missing: 检测样本没有对齐的连板天梯样本');
    expect(new Set(notes).size).toBe(notes.length);
  });
});

describe('排序、空态与页头', () => {
  it('按时间倒序，同一样本按种类稳定排序', () => {
    const events = sortEventsDesc([diffusionEvent(), rotationEvent()]);
    expect(events.map((event) => event.kind)).toEqual(['rotation', 'diffusion']);
    const sameTime = sortEventsDesc([diffusionEvent({ id: 'b' }), diffusionEvent({ id: 'a' })]);
    expect(sameTime.map((event) => event.id)).toEqual(['a', 'b']);
  });

  it('空态文案与页头统计', () => {
    const noBatch = { state: 'empty', emptyReason: 'no_batch', tradingDate: null };
    expect(eventsEmptyText(noBatch)).toBe('尚无已发布的盘中批次');
    expect(eventsMetaText(noBatch)).toBe('盘中事件 · 尚无已发布的盘中批次');
    expect(eventsEmptyText({ state: 'empty', emptyReason: 'no_events' })).toBe(
      '该交易日没有扩散 / 分化 / 换位事件',
    );
    expect(eventsEmptyText(viewFixture())).toBeNull();
    expect(eventsMetaText(viewFixture())).toBe(
      '交易日 2026-09-28 · 共 2 条（扩散 1 / 分化 0 / 换位 1）· 按时间倒序',
    );
    expect(eventsMetaText(null)).toBe('盘中事件 · 刷新失败');
  });

  it('选中事件通过 hash 往返，事件 id 的 | 与 + 正确编码', () => {
    const eventId = '2026-09-28|rotation|sector-b|2026-09-28T06:15:00.000Z';
    const hash = eventsHash({ eventId });
    expect(hash).toContain('tab=events');
    expect(hash).toContain(encodeURIComponent(eventId));
    expect(eventsParamsFromHash(`#${hash}`)).toEqual({ eventId });
    expect(eventsParamsFromHash('#market-room?tab=events')).toEqual({ eventId: null });
    expect(eventsHash({ eventId: null })).toBe('market-room?tab=events');
  });
});

describe('页面接入结构', () => {
  it('market-room.js 增加盘中事件 tab 并拉取事件', () => {
    const source = read('./market-room.js');
    expect(source).toContain("from './market-room-events.js'");
    expect(source).toContain('fetchRoomEvents(');
    expect(source).toContain('renderEventsPane(');
    expect(source).toContain("events: '盘中事件'");
    expect(source).toContain('eventsParamsFromHash(');
  });

  it('事件行有选中态并可展开证据，不伪造待核实状态', () => {
    const source = read('./market-room-events.js');
    expect(source).toContain("button.setAttribute('aria-pressed'");
    expect(source).toContain('room-event-evidence');
    expect(source).not.toContain('pending');
  });

  it('事件样式已写入 style.css', () => {
    const css = read('../style.css');
    for (const selector of [
      '.room-events',
      '.room-event-item',
      '.room-event-row',
      '.room-event-summary',
      '.room-event-evidence',
    ]) {
      expect(css).toContain(selector);
    }
  });

  it('Web 路由暴露 GET /api/market/room/events 并调用 list_market_room_events', () => {
    const source = read('../../src/routes/market.ts');
    expect(source).toContain("app.get('/api/market/room/events'");
    expect(source).toContain("invokeTool('list_market_room_events'");
  });
});

describe('渲染结构', () => {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.className = '';
      this.textContent = '';
      this.listeners = {};
    }

    append(...nodes) {
      this.children.push(...nodes);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }
  }

  const findAll = (node, className) => {
    const found = [];
    const walk = (current) => {
      if (
        typeof current?.className === 'string' &&
        current.className.split(' ').includes(className)
      ) {
        found.push(current);
      }
      for (const child of current?.children ?? []) walk(child);
    };
    walk(node);
    return found;
  };

  const withFakeDom = (run) => {
    const previous = {
      document: globalThis.document,
      Node: globalThis.Node,
      window: globalThis.window,
    };
    globalThis.Node = FakeNode;
    globalThis.document = {
      createElement: (tagName) => new FakeNode(tagName),
      createTextNode: (text) => ({ textContent: text }),
    };
    globalThis.window = { location: { hash: '' } };
    try {
      run();
    } finally {
      globalThis.document = previous.document;
      globalThis.Node = previous.Node;
      globalThis.window = previous.window;
    }
  };

  it('按时间倒序渲染事件行；选中行才展开证据', () => {
    withFakeDom(() => {
      const collapsed = renderEventsPane(viewFixture(), { eventId: null });
      const rows = findAll(collapsed, 'room-event-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.children[0]?.textContent).toBe('14:15');
      expect(rows[1]?.children[0]?.textContent).toBe('09:45');
      expect(rows[0]?.attributes['aria-pressed']).toBe('false');
      expect(findAll(collapsed, 'room-event-evidence')).toHaveLength(0);

      const expanded = renderEventsPane(viewFixture(), { eventId: rotationEvent().id });
      const selected = findAll(expanded, 'room-event-row').filter(
        (row) => row.attributes['aria-pressed'] === 'true',
      );
      expect(selected).toHaveLength(1);
      expect(selected[0]?.attributes['aria-expanded']).toBe('true');
      expect(findAll(expanded, 'room-event-evidence')).toHaveLength(1);
      expect(findAll(expanded, 'room-fact').length).toBeGreaterThan(5);
    });
  });

  it('空态与读取失败不渲染事件行', () => {
    withFakeDom(() => {
      const empty = renderEventsPane(
        { state: 'empty', emptyReason: 'no_events', tradingDate: '2026-09-28' },
        { eventId: null },
      );
      expect(empty.className).toContain('room-empty');
      expect(findAll(empty, 'room-event-row')).toHaveLength(0);
      const failed = renderEventsPane(null, { eventId: null });
      expect(failed.className).toContain('room-empty');
    });
  });
});
