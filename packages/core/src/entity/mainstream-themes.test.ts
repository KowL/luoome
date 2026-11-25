import { describe, expect, it } from 'vitest';
import {
  assertMainstreamThemeDefinitions,
  buildMainstreamThemeMap,
  buildMainstreamThemeMapEmpty,
  MAINSTREAM_PARENT_SECTORS,
  MAINSTREAM_THEME_RULE_VERSION,
  MAINSTREAM_THEMES,
  mainstreamThemeByVendorCode,
  mainstreamThemesOf,
} from './mainstream-themes.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const sector = (input: {
  readonly id: string;
  readonly vendorCode: string;
  readonly name: string;
}): SectorCatalogEntry => ({
  id: input.id,
  kind: 'concept',
  source: 'fuyao',
  vendorCode: input.vendorCode,
  name: input.name,
  state: 'active',
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

const AI = sector({ id: 'concept-ai', vendorCode: '885728.TI', name: '人工智能' });
const AI_APP = sector({ id: 'concept-ai-app', vendorCode: '886108.TI', name: 'AI应用' });
const CHIP = sector({ id: 'concept-chip', vendorCode: '885756.TI', name: '芯片概念' });
const ROBOT = sector({ id: 'concept-robot', vendorCode: '885517.TI', name: '机器人概念' });
const MARKET_LABEL = sector({ id: 'concept-margin', vendorCode: '885338.TI', name: '融资融券' });

const item = (
  id: string,
  close: number,
  changePct: number,
  amount: number,
): MarketSnapshotItem => ({
  id,
  code: id.split('.')[0] as string,
  exchange: 'SH',
  name: id,
  close,
  changePct,
  amount,
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

const A = '000001.SZ';
const B = '000002.SZ';
const C = '000003.SZ';

const anchor = batch('10:15', [item(A, 11, 2, 1100), item(B, 9, -1, 900), item(C, 7, -3, 700)]);
const start15 = batch('10:00', [item(A, 10, 1, 1000), item(B, 10, 0, 1000), item(C, 10, 0, 1000)]);
const start5 = batch('10:10', [item(A, 10.5, 1, 1050), item(B, 9.5, 0, 950), item(C, 9.5, 0, 950)]);

const buildMap = (overrides: Partial<Parameters<typeof buildMainstreamThemeMap>[0]> = {}) =>
  buildMainstreamThemeMap({
    sort: 'day',
    window: 'w15',
    anchor,
    windowStarts: { w5: start5, w15: start15 },
    sectors: [AI, AI_APP, CHIP, ROBOT, MARKET_LABEL],
    members: [
      membership(AI.id, A),
      membership(AI_APP.id, A),
      membership(AI.id, B),
      membership(CHIP.id, A),
      membership(ROBOT.id, C),
      membership(MARKET_LABEL.id, '000004.SZ'),
    ],
    limitUp: null,
    limitUpError: null,
    ...overrides,
  });

const theme = (map: ReturnType<typeof buildMap>, themeId: string) => {
  const found = map.parents
    .flatMap((parent) => parent.themes)
    .find((row) => row.themeId === themeId);
  if (found === undefined) throw new Error(`未找到标准题材 ${themeId}`);
  return found;
};

const parent = (map: ReturnType<typeof buildMap>, parentId: string) => {
  const found = map.parents.find((row) => row.parentId === parentId);
  if (found === undefined) throw new Error(`未找到父板块 ${parentId}`);
  return found;
};

describe('mainstream theme definitions', () => {
  it('固定父板块顺序与稳定 id，vendorCode 全局唯一', () => {
    expect(() => assertMainstreamThemeDefinitions()).not.toThrow();
    expect(MAINSTREAM_PARENT_SECTORS.map((entry) => entry.name)).toEqual([
      '科技',
      '新能源',
      '汽车与智能出行',
      '医药医疗',
      '消费',
      '周期资源',
      '金融',
      '军工与高端制造',
      '地产基建',
      '公用事业与交通运输',
      '农业',
    ]);
    for (const [index, entry] of MAINSTREAM_PARENT_SECTORS.entries()) {
      expect(entry.order).toBe(index);
    }
    const codes = MAINSTREAM_THEMES.flatMap((entry) => entry.vendorCodes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('科技至少拆出 AI 与算力、半导体、软件与信创、消费电子、机器人/智能制造', () => {
    const names = mainstreamThemesOf('tech').map((entry) => entry.name);
    for (const required of ['AI与算力', '半导体', '软件与信创', '消费电子', '机器人/智能制造']) {
      expect(names).toContain(required);
    }
  });

  it('其他父板块也覆盖主流方向，而不是只实现科技', () => {
    for (const entry of MAINSTREAM_PARENT_SECTORS) {
      const themes = mainstreamThemesOf(entry.id);
      expect(themes.length).toBeGreaterThan(0);
      expect(themes.every((theme) => theme.parentId === entry.id)).toBe(true);
    }
    expect(mainstreamThemeByVendorCode('885431.TI')?.name).toBe('新能源汽车');
    expect(mainstreamThemeByVendorCode('885531.TI')?.name).toBe('光伏');
    expect(mainstreamThemeByVendorCode('885700.TI')?.name).toBe('军工装备');
    expect(mainstreamThemeByVendorCode('885525.TI')?.name).toBe('食品饮料');
    expect(mainstreamThemeByVendorCode('885812.TI')?.name).toBe('种植与种业');
  });
});

describe('buildMainstreamThemeMap', () => {
  it('父板块与标准题材按固定定义全部返回，科技在下跌日仍存在', () => {
    const map = buildMap();
    expect(map.state).toBe('ready');
    expect(map.ruleVersion).toBe(MAINSTREAM_THEME_RULE_VERSION);
    expect(map.parents.map((row) => row.name)).toEqual(
      MAINSTREAM_PARENT_SECTORS.map((entry) => entry.name),
    );
    const tech = parent(map, 'tech');
    expect(tech.themes.map((row) => row.name)).toContain('AI与算力');
    const ai = theme(map, 'ai-computing');
    expect(ai.day.value).toBeCloseTo(0.5, 4);
    expect(ai.day.declining).toBe(1);
    expect(tech.day.memberCount).toBe(3);
    expect(tech.day.value).toBeCloseTo((2 - 1 - 3) / 3, 4);
  });

  it('标准题材按来源概念 active 成分并集去重：同一股票属于多个概念只计一次', () => {
    const map = buildMap();
    const ai = theme(map, 'ai-computing');
    expect(ai.sources.map((source) => source.name)).toEqual(['人工智能', 'AI应用']);
    expect(ai.sources.map((source) => source.memberCount)).toEqual([2, 1]);
    expect(ai.day.memberCount).toBe(2);
    expect(ai.day.sampleCount).toBe(2);
    expect(ai.day.advancing).toBe(1);
    expect(ai.day.declining).toBe(1);
    const chip = theme(map, 'semiconductor');
    expect(chip.day.memberCount).toBe(1);
    // 父板块是子题材并集：A 同时出现在 AI 与半导体，父板块只计一次。
    expect(parent(map, 'tech').day.memberCount).toBe(3);
  });

  it('宽概念不再按成分数剔除，可作为主流锚点', () => {
    const wideMembers = Array.from({ length: 501 }, (_, index) =>
      membership(AI.id, `${String(index + 100000).padStart(6, '0')}.SZ`),
    );
    const map = buildMap({ members: wideMembers });
    const ai = theme(map, 'ai-computing');
    expect(ai.sources.find((source) => source.vendorCode === '885728.TI')?.memberCount).toBe(501);
    expect(ai.day.memberCount).toBe(501);
    expect(parent(map, 'tech').day.memberCount).toBe(501);
  });

  it('缺样本记为缺失并从均值中剔除，不补 0；无样本时整列为 null', () => {
    const partial = buildMap({ anchor: batch('10:15', [item(A, 11, 2, 1100)]) });
    const ai = theme(partial, 'ai-computing');
    expect(ai.day.value).toBeCloseTo(2, 4);
    expect(ai.day.sampleCount).toBe(1);
    expect(ai.day.missingCount).toBe(1);
    expect(ai.day.value).not.toBeCloseTo(1, 4);

    const missing = buildMap({ anchor: batch('10:15', [item('000009.SZ', 5, 0, 100)]) });
    const noSample = theme(missing, 'ai-computing');
    expect(noSample.day.value).toBeNull();
    expect(noSample.day.status).toBe('unavailable');
    expect(noSample.day.warnings.length).toBeGreaterThan(0);
    expect(noSample.day.advancing).toBe(0);
    expect(noSample.day.unchanged).toBe(0);
  });

  it('无天梯快照时封板数为 null 而不是 0', () => {
    const map = buildMap();
    expect(map.limitUp.status).toBe('unavailable');
    expect(theme(map, 'ai-computing').limitUp.value).toBeNull();
    expect(parent(map, 'tech').limitUp.value).toBeNull();
  });

  it('version / 来源 vendorCode / 未映射与缺失来源统计随响应返回', () => {
    const map = buildMap();
    expect(map.coverage.ruleVersion).toBe(MAINSTREAM_THEME_RULE_VERSION);
    expect(map.coverage.parentCount).toBe(11);
    expect(map.coverage.themeCount).toBe(MAINSTREAM_THEMES.length);
    expect(map.coverage.catalogConceptCount).toBe(5);
    expect(map.coverage.unmappedConcepts).toEqual([{ vendorCode: '885338.TI', name: '融资融券' }]);
    expect(map.coverage.unmappedConceptCount).toBe(1);
    expect(map.coverage.matchedVendorCodeCount).toBe(4);
    expect(map.coverage.missingVendorCodeCount).toBe(map.coverage.mappedVendorCodeCount - 4);
    expect(theme(map, 'ai-computing').vendorCodes).toContain('885728.TI');
    expect(theme(map, 'ai-computing').missingVendorCodes).toContain('886100.TI');
  });

  it('历史成分口径由输入决定：不同时点的成分集合得到不同并集', () => {
    const map = buildMap();
    expect(theme(map, 'ai-computing').day.memberCount).toBe(2);
    const historical = buildMap({
      members: [membership(AI.id, A), membership(CHIP.id, C)],
    });
    expect(theme(historical, 'ai-computing').day.memberCount).toBe(1);
    expect(parent(historical, 'tech').day.memberCount).toBe(2);
  });

  it('空态给出原因且不伪造父板块行', () => {
    const map = buildMainstreamThemeMapEmpty({
      sort: 'day',
      window: 'w15',
      reason: 'no_batch',
      latest: null,
    });
    expect(map.state).toBe('empty');
    expect(map.parents).toEqual([]);
    expect(map.coverage.themeCount).toBe(MAINSTREAM_THEMES.length);
    expect(map.ruleVersion).toBe(MAINSTREAM_THEME_RULE_VERSION);
  });
});
