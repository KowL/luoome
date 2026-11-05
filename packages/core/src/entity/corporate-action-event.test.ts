import { describe, expect, it } from 'vitest';

import {
  CorporateActionEventRevisionSchema,
  corporateActionEventContent,
} from './corporate-action-event.js';

const HASH = 'd'.repeat(64);

const base = {
  stockId: '600519.SH',
  exDate: '2026-06-26T00:00:00.000Z',
  dividendPerShare: 28.02423,
  perShareBonus: 0,
  allotmentRatio: null,
  allotmentPrice: null,
  currency: 'CNY',
  source: 'fuyao',
  sourceRecordId: '600519.SH:2026-06-26:dividend',
  dumpId: 'a_share_adjustment_factors_event_none_all',
  artifactSha256: HASH,
  recordedAt: '2026-11-03T16:00:00.000Z',
  contentHash: 'e'.repeat(64),
} as const;

describe('CorporateActionEventRevisionSchema', () => {
  it('接受 dump 来源的现金分红事件', () => {
    const event = CorporateActionEventRevisionSchema.parse(base);
    expect(event.dividendPerShare).toBe(28.02423);
  });

  it('接受配股事件（allotment 成对）', () => {
    const event = CorporateActionEventRevisionSchema.parse({
      ...base,
      dividendPerShare: 0,
      allotmentRatio: 0.15,
      allotmentPrice: 16.62,
    });
    expect(event.allotmentRatio).toBe(0.15);
  });

  it('allotmentRatio 与 allotmentPrice 必须成对', () => {
    expect(() =>
      CorporateActionEventRevisionSchema.parse({ ...base, allotmentRatio: 0.15 }),
    ).toThrow(/allotmentRatio/);
  });

  it('dumpId 与 artifactSha256 必须成对（在线补取同为 null）', () => {
    const online = CorporateActionEventRevisionSchema.parse({
      ...base,
      dumpId: null,
      artifactSha256: null,
    });
    expect(online.dumpId).toBeNull();
    expect(() =>
      CorporateActionEventRevisionSchema.parse({ ...base, artifactSha256: null }),
    ).toThrow(/dumpId/);
  });

  it('保留零值行（配股除权日在线呈现为 0/0，不得丢弃）', () => {
    const event = CorporateActionEventRevisionSchema.parse({
      ...base,
      dividendPerShare: 0,
      perShareBonus: 0,
      dumpId: null,
      artifactSha256: null,
    });
    expect(event.dividendPerShare).toBe(0);
    expect(event.perShareBonus).toBe(0);
  });

  it('保留实测负股数变动比例，但拒绝归零或负股数倍数', () => {
    expect(
      CorporateActionEventRevisionSchema.parse({ ...base, perShareBonus: -0.67335 }).perShareBonus,
    ).toBe(-0.67335);
    for (const perShareBonus of [-1, -1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => CorporateActionEventRevisionSchema.parse({ ...base, perShareBonus })).toThrow();
    }
  });

  it('拒绝负现金与非 CNY', () => {
    expect(() =>
      CorporateActionEventRevisionSchema.parse({ ...base, dividendPerShare: -0.1 }),
    ).toThrow();
    expect(() => CorporateActionEventRevisionSchema.parse({ ...base, currency: 'USD' })).toThrow();
  });
});

describe('corporateActionEventContent', () => {
  it('同日不同事件内容产生不同规范化视图（同日多事件保留）', () => {
    const shared = {
      stockId: '600030.SH',
      exDate: new Date('2022-01-19T00:00:00.000Z'),
      currency: 'CNY' as const,
      source: 'fuyao' as const,
    };
    const dividend = corporateActionEventContent({
      ...shared,
      dividendPerShare: 0.5,
      perShareBonus: 0,
      allotmentRatio: null,
      allotmentPrice: null,
    });
    const allotment = corporateActionEventContent({
      ...shared,
      dividendPerShare: 0,
      perShareBonus: 0,
      allotmentRatio: 0.15,
      allotmentPrice: 16.62,
    });
    expect(dividend).not.toBe(allotment);
  });

  it('相同内容视图稳定（幂等去重键）', () => {
    const event = {
      stockId: '600519.SH',
      exDate: new Date('2026-06-26T00:00:00.000Z'),
      dividendPerShare: 28.02423,
      perShareBonus: 0,
      allotmentRatio: null,
      allotmentPrice: null,
      currency: 'CNY' as const,
      source: 'fuyao' as const,
    };
    expect(corporateActionEventContent(event)).toBe(corporateActionEventContent({ ...event }));
  });
});
