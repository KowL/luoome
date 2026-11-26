import { describe, expect, it } from 'vitest';
import type { ThemeLibraryMember, ThemeLibraryTheme } from './theme-library.js';
import {
  buildThemeLibraryAutoPlan,
  normalizeThemeLabel,
  splitLimitUpReason,
  THEME_LIBRARY_AUTO_RULES,
  type ThemeLibraryAutoConcept,
  type ThemeLibraryAutoPoolEntry,
  themeLibraryAutoThemeId,
  themeLibraryDirectionRejection,
  themeLibraryRuleThemeId,
} from './theme-library-auto.js';

const TRADING_DAY = '2026-11-26';
const SOURCE = 'fuyao-limit-up-market';
const AT = new Date('2026-11-26T15:00:00+08:00');

const theme = (
  id: string,
  name: string,
  overrides: Partial<ThemeLibraryTheme> = {},
): ThemeLibraryTheme => ({
  id,
  name,
  state: 'active',
  sortOrder: 0,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  ...overrides,
});

const member = (input: {
  themeId: string;
  stockId: string;
  origin?: ThemeLibraryMember['origin'];
  effectiveTo?: Date | null;
}): ThemeLibraryMember => ({
  id: `${input.themeId}|${input.stockId}|${input.effectiveTo?.toISOString() ?? 'open'}`,
  themeId: input.themeId,
  stockId: input.stockId,
  origin: input.origin ?? 'seed',
  effectiveFrom: new Date('2026-01-01T00:00:00+08:00'),
  effectiveTo: input.effectiveTo ?? null,
  createdAt: AT,
});

const poolEntry = (
  stockId: string,
  reason: string | null,
  name = stockId.slice(0, 6),
): ThemeLibraryAutoPoolEntry => ({ stockId, name, reason });

const robotics = themeLibraryRuleThemeId('机器人与具身智能');
const semiconductors = themeLibraryRuleThemeId('芯片与半导体设备');
const retail = themeLibraryRuleThemeId('零售与商贸');

const concept = (name: string, vendorCode = '885000.TI'): ThemeLibraryAutoConcept => ({
  sectorId: `concept-${vendorCode}`,
  vendorCode,
  name,
});

const baseInput = {
  tradingDate: TRADING_DAY,
  source: SOURCE,
  themes: [theme(robotics, '机器人'), theme(semiconductors, '半导体'), theme(retail, '商贸零售')],
  members: [member({ themeId: robotics, stockId: '300001.SZ' })],
  concepts: [] as ThemeLibraryAutoConcept[],
};

describe('题材库自动维护分类规则', () => {
  it('稳定 id 由原类名 SHA256 前 16 位派生，与已部署库一致', () => {
    expect(themeLibraryRuleThemeId('机器人与具身智能')).toBe('nov26-fd6f6626bdb93e4b');
    expect(themeLibraryRuleThemeId('芯片与半导体设备')).toBe('nov26-98cedce81d4590a1');
    expect(themeLibraryRuleThemeId('AI应用与软件')).toBe('nov26-15cd61aab464d804');
    expect(themeLibraryRuleThemeId('光伏')).toBe('nov26-5b570e03c39cb659');
  });

  it('规则原类名唯一，且每条都有可编译的正则', () => {
    expect(THEME_LIBRARY_AUTO_RULES).toHaveLength(42);
    const keys = THEME_LIBRARY_AUTO_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = keys.map(themeLibraryRuleThemeId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of THEME_LIBRARY_AUTO_RULES) expect(() => new RegExp(rule.patterns.join('|')));
  });

  it('原因按 + 拆词，保留出现顺序并去重', () => {
    expect(splitLimitUpReason('工业机器人+柔性自动化装备')).toEqual([
      '工业机器人',
      '柔性自动化装备',
    ]);
    expect(splitLimitUpReason('光伏＋光伏+储能')).toEqual(['光伏', '储能']);
    expect(splitLimitUpReason(null)).toEqual([]);
  });

  it('方向名规范化与泛标签过滤', () => {
    expect(normalizeThemeLabel(' 钙钛矿 概念 ')).toBe('钙钛矿');
    expect(normalizeThemeLabel('“东方”')).toBe('东方');
    expect(themeLibraryDirectionRejection('融资融券')).toBe('generic_label');
    expect(themeLibraryDirectionRejection('ST板块')).toBe('generic_label');
    expect(themeLibraryDirectionRejection('业绩预增')).toBe('generic_label');
    expect(themeLibraryDirectionRejection('子公司签订重大合同并获批量订单')).toBe('sentence');
    expect(themeLibraryDirectionRejection('超长但没有任何长句标记的方向名称示例')).toBe('too_long');
    expect(themeLibraryDirectionRejection('电池')).toBeNull();
  });
});

describe('自动维护计划', () => {
  it('按主催化把封板股票补进已有题材，一只股票只归一个题材', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      pool: [
        poolEntry('300001.SZ', '工业机器人+柔性自动化装备'),
        poolEntry('300002.SZ', '减速器+机器人'),
        poolEntry('600001.SH', '百货零售+首发经济'),
        poolEntry('600002.SH', '存储芯片+机器人概念+粉磨装备'),
      ],
    });
    expect(plan.classifiedCount).toBe(4);
    // 主催化按原因里的词序：600002 的首个标签是存储芯片 → 半导体，不因为后面还有机器人概念而改归属
    expect(plan.additions).toEqual([
      {
        themeId: retail,
        themeName: '商贸零售',
        stocks: [
          {
            stockId: '600001.SH',
            name: '600001',
            reason: '百货零售+首发经济',
            token: '百货零售',
          },
        ],
      },
      {
        themeId: semiconductors,
        themeName: '半导体',
        stocks: [
          {
            stockId: '600002.SH',
            name: '600002',
            reason: '存储芯片+机器人概念+粉磨装备',
            token: '存储芯片',
          },
        ],
      },
      {
        themeId: robotics,
        themeName: '机器人',
        stocks: [
          { stockId: '300002.SZ', name: '300002', reason: '减速器+机器人', token: '减速器' },
        ],
      },
    ]);
    // 300001.SZ 已在生效成分里，不重复写
    expect(plan.alreadyMemberCount).toBe(1);
    expect(plan.pending).toEqual([]);
  });

  it('未覆盖方向要有本地精选概念 + 至少两只不同涨停股才新建题材', () => {
    const concepts = [concept('钙钛矿', '886001.TI')];
    const single = buildThemeLibraryAutoPlan({
      ...baseInput,
      concepts,
      pool: [poolEntry('300101.SZ', '钙钛矿')],
    });
    expect(single.newThemes).toEqual([]);
    expect(single.pending.map((item) => item.kind)).toEqual(['single_stock']);
    expect(single.pending[0]?.label).toBe('钙钛矿');

    const confirmed = buildThemeLibraryAutoPlan({
      ...baseInput,
      concepts,
      pool: [poolEntry('300101.SZ', '钙钛矿'), poolEntry('300102.SZ', '钙钛矿+异质结')],
    });
    expect(confirmed.newThemes).toEqual([
      {
        themeId: themeLibraryAutoThemeId('钙钛矿'),
        name: '钙钛矿',
        sourceConcept: concepts[0],
        stocks: [
          { stockId: '300101.SZ', name: '300101', reason: '钙钛矿', token: '钙钛矿' },
          { stockId: '300102.SZ', name: '300102', reason: '钙钛矿+异质结', token: '钙钛矿' },
        ],
      },
    ]);
    expect(confirmed.pending).toEqual([]);
  });

  it('本地精选概念里找不到事实的方向只进待核对', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      pool: [poolEntry('300201.SZ', '量子织布机'), poolEntry('300202.SZ', '量子织布机')],
    });
    expect(plan.newThemes).toEqual([]);
    expect(plan.pending.every((item) => item.kind === 'unmatched')).toBe(true);
    expect(plan.pending[0]?.reason).toBe('量子织布机');
    expect(plan.pending[0]?.source).toBe(SOURCE);
    expect(plan.pending[0]?.tradingDate).toBe(TRADING_DAY);
  });

  it('泛标签与公告长句不建库、不补成分', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      pool: [
        poolEntry('600101.SH', '融资融券+沪股通'),
        poolEntry('600102.SH', '子公司签订 5 亿元合同并获批量订单'),
        poolEntry('600103.SH', '解禁'),
      ],
    });
    expect(plan.additions).toEqual([]);
    expect(plan.newThemes).toEqual([]);
    expect(plan.pending.map((item) => item.kind)).toEqual([
      'generic_label',
      'sentence',
      'generic_label',
    ]);
  });

  it('没有涨停原因的只进待核对，不猜方向', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      pool: [{ stockId: '600201.SH', name: '示例', reason: null }],
    });
    expect(plan.additions).toEqual([]);
    expect(plan.pending.map((item) => item.kind)).toEqual(['no_reason']);
  });

  it('已在生效区间的跳过；人工删除过的关系永不加回', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      members: [
        ...baseInput.members,
        member({
          themeId: semiconductors,
          stockId: '600301.SH',
          effectiveTo: new Date('2026-11-01T00:00:00+08:00'),
        }),
      ],
      pool: [
        poolEntry('300001.SZ', '机器人'),
        poolEntry('600301.SH', '存储芯片'),
        poolEntry('600302.SH', '存储芯片'),
      ],
    });
    expect(plan.additions).toEqual([
      {
        themeId: semiconductors,
        themeName: '半导体',
        stocks: [{ stockId: '600302.SH', name: '600302', reason: '存储芯片', token: '存储芯片' }],
      },
    ]);
    expect(plan.alreadyMemberCount).toBe(1);
    expect(plan.suppressedCount).toBe(1);
    expect(plan.warnings).toContain('manual_removal_respected: 1');
  });

  it('归档题材不加回，留给人工判断', () => {
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      themes: [theme(robotics, '机器人', { state: 'archived', archivedAt: AT })],
      members: [],
      pool: [poolEntry('300401.SZ', '机器人')],
    });
    expect(plan.additions).toEqual([]);
    expect(plan.pending.map((item) => item.kind)).toEqual(['archived_theme']);
  });

  it('同名方向优先归入已有题材，不重复建库', () => {
    const existingId = themeLibraryAutoThemeId('钙钛矿');
    const plan = buildThemeLibraryAutoPlan({
      ...baseInput,
      themes: [...baseInput.themes, theme(existingId, '钙钛矿')],
      concepts: [concept('钙钛矿', '886001.TI')],
      pool: [poolEntry('300101.SZ', '钙钛矿'), poolEntry('300102.SZ', '钙钛矿')],
    });
    expect(plan.newThemes).toEqual([]);
    expect(plan.additions.map((addition) => addition.themeId)).toEqual([existingId]);
  });

  it('计划幂等：同样的输入不重复产生同一关系', () => {
    const input = {
      ...baseInput,
      concepts: [concept('钙钛矿', '886001.TI')],
      pool: [poolEntry('300101.SZ', '钙钛矿'), poolEntry('300102.SZ', '钙钛矿')],
    };
    const first = buildThemeLibraryAutoPlan(input);
    const created = first.newThemes[0];
    expect(created).toBeDefined();
    const second = buildThemeLibraryAutoPlan({
      ...input,
      themes: [...input.themes, theme(created?.themeId ?? '', '钙钛矿')],
      members: [
        ...input.members,
        ...(created?.stocks ?? []).map((stock) =>
          member({ themeId: created?.themeId ?? '', stockId: stock.stockId, origin: 'auto' }),
        ),
      ],
    });
    expect(second.newThemes).toEqual([]);
    expect(second.additions).toEqual([]);
    expect(second.alreadyMemberCount).toBe(2);
  });
});
