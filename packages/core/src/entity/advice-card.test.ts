import { describe, expect, it } from 'vitest';

import { STANDARD_DISCLAIMERS } from './advice.js';
import {
  ADVICE_CARD_SEGMENTS,
  AdviceCardSchema,
  type AdviceCardSource,
  renderAdviceCard,
} from './advice-card.js';

const NOW = new Date('2026-10-31T06:00:00.000Z');

const source = (overrides: Partial<AdviceCardSource> = {}): AdviceCardSource => ({
  id: 'advice-1',
  reasoning: { premise: '趋势向上且量能配合', counterEvidence: ['板块轮动风险'] },
  risks: ['大盘系统性下行'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  validUntil: new Date('2026-11-05T07:00:00.000Z'),
  basedOn: { dataAsOf: new Date('2026-10-30T07:00:00.000Z') },
  ...overrides,
});

describe('B 建议卡片五段：唯一组装实现', () => {
  it('B1 五段齐全 → renderable，五段字段全非空', () => {
    const card = renderAdviceCard(source(), NOW);
    expect(card.status).toBe('renderable');
    if (card.status !== 'renderable') return;
    expect(card.conclusion).toBe('趋势向上且量能配合');
    expect(card.counterEvidence).toEqual(['板块轮动风险']);
    expect(card.risks).toEqual(['大盘系统性下行']);
    expect(card.validity.validUntil.toISOString()).toBe('2026-11-05T07:00:00.000Z');
    expect(card.validity.expired).toBe(false);
    // 免责条数恒等于硬约束常量（schema 里不钉条数，避免循环初始化）。
    expect(card.disclaimer).toHaveLength(STANDARD_DISCLAIMERS.length);
    expect(card.dataAsOf.toISOString()).toBe('2026-10-30T07:00:00.000Z');
    expect(AdviceCardSchema.safeParse(card).success).toBe(true);
  });

  it('B2 缺结论（premise 空）→ blocked，missing === [conclusion]', () => {
    const card = renderAdviceCard(
      source({ reasoning: { premise: '   ', counterEvidence: ['c'] } }),
      NOW,
    );
    expect(card.status).toBe('blocked');
    if (card.status !== 'blocked') return;
    expect(card.missing).toEqual(['conclusion']);
    expect(card.note).toContain('不可渲染');
    expect(card.note).toContain('结论');
  });

  it('B3 缺反证（空数组）→ blocked，missing === [counterEvidence]', () => {
    const card = renderAdviceCard(
      source({ reasoning: { premise: 'p', counterEvidence: [] } }),
      NOW,
    );
    expect(card.status).toBe('blocked');
    if (card.status !== 'blocked') return;
    expect(card.missing).toEqual(['counterEvidence']);
    expect(card.note).toContain('反证');
  });

  it('B4 缺风险（空数组）→ blocked，missing === [risks]', () => {
    const card = renderAdviceCard(source({ risks: [] }), NOW);
    expect(card.status).toBe('blocked');
    if (card.status !== 'blocked') return;
    expect(card.missing).toEqual(['risks']);
    expect(card.note).toContain('风险');
  });

  it('B5 缺有效期（validUntil 非法）→ blocked，missing === [validity]', () => {
    const card = renderAdviceCard(source({ validUntil: new Date(Number.NaN) }), NOW);
    expect(card.status).toBe('blocked');
    if (card.status !== 'blocked') return;
    expect(card.missing).toEqual(['validity']);
    expect(card.note).toContain('有效期');
  });

  it('B6 缺反证 + 风险 → missing 按固定顺序逐项列出', () => {
    const card = renderAdviceCard(
      source({ reasoning: { premise: 'p', counterEvidence: [] }, risks: [] }),
      NOW,
    );
    expect(card.status).toBe('blocked');
    if (card.status !== 'blocked') return;
    expect(card.missing).toEqual(['counterEvidence', 'risks']);
    // 已具备的段也要报出来（可以展示为「部分」，但不冒充完整卡片）。
    expect(card.available).toEqual(['conclusion', 'validity', 'disclaimer']);
  });

  it('B7 负例：disclaimer 永不进入 missing（常量事实源，不是可缺字段）', () => {
    // ① 建议自带免责为空 → 回落到常量事实源，仍然可渲染（不是「缺段」）。
    const fallback = renderAdviceCard(source({ disclaimers: [] }), NOW);
    expect(fallback.status).toBe('renderable');
    if (fallback.status === 'renderable')
      expect(fallback.disclaimer).toEqual([...STANDARD_DISCLAIMERS]);

    // ② 其它段缺失时，disclaimer 依然在 available 里，永不进 missing。
    const cases: AdviceCardSource[] = [
      source({ reasoning: { premise: '', counterEvidence: [] }, risks: [] }),
      source({ validUntil: new Date(Number.NaN), disclaimers: [] }),
    ];
    for (const item of cases) {
      const card = renderAdviceCard(item, NOW);
      expect(card.status).toBe('blocked');
      if (card.status !== 'blocked') continue;
      expect(card.missing).not.toContain('disclaimer');
      expect(card.available).toContain('disclaimer');
    }
  });

  it('B8 负例：过期但五段齐全 → renderable 且 expired === true（过期不是缺失）', () => {
    const card = renderAdviceCard(
      source({ validUntil: new Date('2026-10-01T00:00:00.000Z') }),
      NOW,
    );
    expect(card.status).toBe('renderable');
    if (card.status !== 'renderable') return;
    expect(card.validity.expired).toBe(true);
  });

  it('五段枚举与 note 的段名一一对应（没有「其他」这种兜底段）', () => {
    expect(ADVICE_CARD_SEGMENTS).toEqual([
      'conclusion',
      'counterEvidence',
      'risks',
      'validity',
      'disclaimer',
    ]);
    const card = renderAdviceCard(source({ risks: [] }), NOW);
    if (card.status !== 'blocked') throw new Error('expected blocked');
    expect(card.missing.every((segment) => ADVICE_CARD_SEGMENTS.includes(segment))).toBe(true);
  });

  it('schema 是 strict：多出未声明键直接报错（Zod 默认会静默 strip）', () => {
    const card = renderAdviceCard(source(), NOW);
    expect(AdviceCardSchema.safeParse({ ...card, unexpectedKey: 1 }).success).toBe(false);
  });
});
