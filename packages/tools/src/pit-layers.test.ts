import { KANGMEI_2017_CORRECTION_DELTA, mockDisclosureSource } from '@luoome/adapters';
import type { FinancialFact } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  correctionDeltaMatches,
  missingExplanation,
  observeIngestSnapshot,
  resolveVintages,
  strictPitAsOf,
} from './pit-layers.js';

/**
 * REQ-M4-05 三层检测。
 *
 * 层 1 因果 / 层 2 校验 / 层 3 **告警（不入库）**。
 * 合并层 3 会让上游漂移被当成真实修订 —— PIT 退化成「数据商说什么就是什么」。
 */
describe('层 2：差值校验用容差，不用 ===', () => {
  it('spike 实测的三版差额**必须**通过校验', () => {
    // 26,476,970,977.57 → 17,578,618,640.06，公告累计影响 −8,898,352,337.51
    expect(
      correctionDeltaMatches({
        previousValue: 26_476_970_977.57,
        nextValue: 17_578_618_640.06,
        announcedDelta: KANGMEI_2017_CORRECTION_DELTA,
      }),
    ).toBe(true);
  });

  it('**`===` 会在这里失败**（浮点减法得到 ...509995）', () => {
    const actual = 17_578_618_640.06 - 26_476_970_977.57;
    // 先证明「精确比较必然不等」——这正是不能写 `===` 的原因
    expect(actual).not.toBe(KANGMEI_2017_CORRECTION_DELTA);
    // 容差比较才通过
    expect(Math.abs(actual - KANGMEI_2017_CORRECTION_DELTA)).toBeLessThan(0.01);
  });

  it('差得远则拒绝（容差不是无底洞）', () => {
    expect(
      correctionDeltaMatches({
        previousValue: 100,
        nextValue: 200,
        announcedDelta: -8_898_352_337.51,
      }),
    ).toBe(false);
  });
});

describe('层 1：publishedAt 只来自公告，缺失不 fallback', () => {
  it('取首个**定期报告**的公告时间', async () => {
    const source = mockDisclosureSource();
    const announcements = await source.listAnnouncements({
      stockId: '600518.SH',
      periodEnd: new Date('2017-12-31'),
    });
    const vintages = resolveVintages(announcements);
    // 按 **+08** 取日期：公告日 2018-04-26 00:00 (+08) 在 UTC 下是 04-25。
    const shanghaiDate = (date: Date | null) =>
      date === null ? null : new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
    expect(shanghaiDate(vintages.publishedAt)).toBe('2018-04-26');
    expect(vintages.announcements).toHaveLength(3);
  });

  it('**没有公告 → publishedAt 为 null**（调用方必须落 missing，不许用 now()）', () => {
    const vintages = resolveVintages([]);
    expect(vintages.publishedAt).toBeNull();
  });
});

describe('层 3：**只告警，不入库**', () => {
  it('快照写入 `financial_ingest_snapshots`，**不动 `financial_fact_revisions`**', async () => {
    const ctx = await buildTestContext();
    const before = (await ctx.repos.financialFact.listRevisions({ stockIds: ['600518.SH'] }))
      .length;

    const observation = await observeIngestSnapshot({
      source: mockDisclosureSource(),
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd: new Date('2017-12-31T00:00:00+08:00'),
      ctx,
      now: new Date('2026-11-02T00:00:00Z'),
    });

    const after = (await ctx.repos.financialFact.listRevisions({ stockIds: ['600518.SH'] })).length;
    // **核心断言**：层 3 跑完后 revisions 行数不变
    expect(after).toBe(before);
    // 但它确实记录了观测
    expect(observation.ingestHash).toHaveLength(64);
    const stored = await ctx.repos.financialIngestSnapshot.latest({
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd: new Date('2017-12-31T00:00:00+08:00'),
    });
    expect(stored?.ingestHash).toBe(observation.ingestHash);
  });

  it('**哈希变 + 公告未变 → vendor-drift**（这是告警，不是修订）', async () => {
    const ctx = await buildTestContext();
    const periodEnd = new Date('2017-12-31T00:00:00+08:00');
    // 第一次观测
    await observeIngestSnapshot({
      source: mockDisclosureSource({
        announcements: [
          {
            announcementId: 'a1',
            announcementTime: new Date('2018-04-26'),
            title: '年报',
            kind: 'periodic-report',
          },
        ],
      }),
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd,
      ctx,
      now: new Date('2026-11-01T00:00:00Z'),
    });
    // 第二次：值变了（数据商改口径），但**公告仍只有一条**
    const second = await observeIngestSnapshot({
      source: mockDisclosureSource({
        announcements: [
          {
            announcementId: 'a1',
            announcementTime: new Date('2018-04-26'),
            title: '年报',
            kind: 'periodic-report',
          },
        ],
        snapshots: [
          {
            stockId: '600518.SH',
            metricId: 'revenue',
            periodEnd,
            value: 99_999, // 改了值
            vendorUpdatedAt: new Date('2026-10-30'),
          },
        ],
      }),
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd,
      ctx,
      now: new Date('2026-11-02T00:00:00Z'),
    });
    expect(second.verdict).toBe('vendor-drift');
  });

  it('哈希没变 → unchanged', async () => {
    const ctx = await buildTestContext();
    const periodEnd = new Date('2017-12-31T00:00:00+08:00');
    const source = mockDisclosureSource();
    await observeIngestSnapshot({
      source,
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd,
      ctx,
      now: new Date('2026-11-01T00:00:00Z'),
    });
    const again = await observeIngestSnapshot({
      source,
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd,
      ctx,
      now: new Date('2026-11-02T00:00:00Z'),
    });
    expect(again.verdict).toBe('unchanged');
  });

  it('mock 源必须在观测里标明（假数据比没数据危险）', async () => {
    const ctx = await buildTestContext();
    const observation = await observeIngestSnapshot({
      source: mockDisclosureSource(),
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd: new Date('2017-12-31T00:00:00+08:00'),
      ctx,
      now: new Date('2026-11-02T00:00:00Z'),
    });
    expect(observation.sourceNote).toContain('夹具数据');
  });
});

describe('T+1：当日公告当日不可见', () => {
  const announcedAt = new Date('2026-03-15T00:00:00Z');

  it('**asOf = 当天 23:59 → 取不到**', () => {
    const shifted = strictPitAsOf(new Date('2026-03-15T23:59:59Z'), announcedAt);
    expect(shifted.getTime()).toBeGreaterThan(new Date('2026-03-15T23:59:59Z').getTime());
  });

  it('**asOf = 次日 00:00 → 取得**', () => {
    const asOf = new Date('2026-03-16T00:00:00Z');
    const shifted = strictPitAsOf(asOf, announcedAt);
    // 次日的 00:00 已经被推到下一个可见边界之外时，用「可见性」判断更直接
    expect(shifted.getTime()).toBeLessThanOrEqual(asOf.getTime());
  });

  it('公告日之前的 asOf 不受影响', () => {
    const asOf = new Date('2026-03-14T10:00:00Z');
    expect(strictPitAsOf(asOf, announcedAt).getTime()).toBe(asOf.getTime());
  });
});

describe('missing 说明：覆盖率下降，不是前视', () => {
  it('`recorded-after-cutoff` 的文案必须点出「覆盖率下降」', () => {
    const explained = missingExplanation('recorded-after-cutoff');
    expect(explained.text).toContain('覆盖率下降');
    expect(explained.text).toContain('不是前视');
    // PRD 原文要求「这是覆盖率下降，不是前视」。文案必须**明确否定**「数据缺失」这个误解，
    // 所以这里断言的是「否定表述存在」，不是「不许出现该词」。
    expect(explained.text).toMatch(/不是.{0,6}数据缺失|也不是数据缺失/);
  });
});

void (0 as unknown as FinancialFact);
