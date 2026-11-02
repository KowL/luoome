import {
  ADVICE_SEGMENTS,
  type Advice,
  assertReportInvariants,
  missingAdviceSegments,
  money,
  parseReportDocument,
  REPORT_ENVELOPE_SECTION_KEYS,
  type ReportArtifactWriter,
  type ReportSection,
  reportDocumentFromReport,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { publishReportTool, writeReportArtifactTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { morningBriefWorkflow } from './morning-brief.js';

const generatedAt = new Date('2026-07-29T00:45:00.000Z'); // 08:45 +08:00
const overnightTs = new Date('2026-07-28T07:00:00.000Z'); // 前一交易日 15:00

const memoryWriter = (): ReportArtifactWriter & { readonly files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    directory: '/tmp/luoome-reports',
    files,
    async write({ fileName, content, overwrite }) {
      if (files.has(fileName) && !overwrite)
        return { path: `/tmp/luoome-reports/${fileName}`, written: false, bytes: content.length };
      files.set(fileName, content);
      return { path: `/tmp/luoome-reports/${fileName}`, written: true, bytes: content.length };
    },
    async read(fileName) {
      return files.get(fileName) ?? null;
    },
  };
};

const adviceFixture = (overrides: Partial<Advice> = {}): Advice => ({
  id: 'advice-fixture',
  subjectKind: 'portfolio',
  subjectId: 'account-fixture',
  decision: 'hold',
  confidence: 60,
  horizon: 'short',
  reasoning: {
    premise: 'fixture premise',
    evidence: ['fixture evidence'],
    counterEvidence: ['fixture counter evidence'],
  },
  risks: ['fixture risk'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  basedOn: { dataAsOf: generatedAt },
  validFrom: generatedAt,
  validUntil: new Date('2026-08-05T00:00:00.000Z'),
  createdAt: generatedAt,
  ...overrides,
});

const contextWithOvernight = async (options: {
  readonly withEvents: boolean;
  readonly advices?: readonly Advice[];
}) => {
  const base = await buildTestContext({
    clock: () => generatedAt,
    ...(options.advices === undefined ? {} : { advices: [...options.advices] }),
  });
  const market = Object.create(base.adapters.market, {
    fetchIndexQuotes: {
      value: async () => [
        {
          code: '000001',
          name: '上证指数',
          close: money(3500.5),
          change: -12.3,
          changePct: -0.35,
          ts: overnightTs,
          source: 'fixture-index',
        },
      ],
    },
  }) as typeof base.adapters.market;
  const ctx = { ...base, adapters: { ...base.adapters, market }, reportArtifacts: memoryWriter() };
  if (options.withEvents) {
    await ctx.repos.stockEvent.save({
      id: 'event-1',
      stockId: '600519.SH',
      kind: 'dividend',
      title: '分红公告',
      occursAt: new Date('2026-07-29T00:10:00.000Z'), // 当日 08:10，早于报告生成时间
      allDay: false,
      importance: 'important',
      status: 'scheduled',
      source: 'manual',
      provider: 'fixture-events',
      observedAt: new Date('2026-07-29T00:10:00.000Z'),
      fetchedAt: new Date('2026-07-29T00:10:00.000Z'),
      stale: false,
      remindBeforeDays: [],
      createdAt: overnightTs,
      updatedAt: overnightTs,
    });
  }
  return ctx;
};

const sectionOf = (report: { sections: readonly ReportSection[] }, key: string): ReportSection => {
  const section = report.sections.find((item) => item.key === key);
  if (section === undefined) throw new Error(`missing section ${key}`);
  return section;
};

describe('REQ-M3-17 盘前简报 workflow', () => {
  it('produces the four sections in fixed order followed by the envelope sections', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data.report;
    expect(report.kind).toBe('morning-brief');
    expect(report.sections.slice(0, 4).map((section) => section.key)).toEqual([
      'account-overview',
      'overnight-facts',
      'existing-advice',
      'watch-conditions',
    ]);
    expect(report.sections.map((section) => section.key)).toEqual(
      expect.arrayContaining([
        'envelope-conclusion',
        'envelope-counter-evidence',
        'envelope-risks',
        'envelope-validity',
        'envelope-disclaimer',
      ]),
    );
    for (const key of [
      'account-overview',
      'overnight-facts',
      'existing-advice',
      'watch-conditions',
    ])
      expect(sectionOf(report, key).dataAsOf, key).toBeInstanceOf(Date);
    // 四段排在前、envelope 段在后（`assertReportInvariants` 的前缀断言要求）。
    expect(
      report.sections.findIndex((section) => section.key === 'envelope-conclusion'),
    ).toBeGreaterThan(report.sections.findIndex((section) => section.key === 'watch-conditions'));
    expect(() => assertReportInvariants(report)).not.toThrow();
  });

  it('keeps every overnight fact with a source and an observation time not later than the report', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const section = sectionOf(result.data.report, 'overnight-facts');
    const items = section.blocks.flatMap((block) => (block.kind === 'list' ? block.items : []));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.detail).toContain('来源 ');
      const observed = /(?:观测于|观察于) (\S+)/.exec(item.detail ?? '');
      expect(observed, item.detail).not.toBeNull();
      const at = new Date((observed as RegExpExecArray)[1] as string);
      expect(at.getTime()).toBeLessThanOrEqual(result.data.report.generatedAt.getTime());
      // 也不许用「今天 15:00 之后」的时点：那是收盘后，不是隔夜/盘前。
      expect(at.getTime()).toBeLessThan(new Date('2026-07-29T15:00:00+08:00').getTime());
    }
  });

  it('derives counter-evidence and risks from the actual data (not fixed strings)', async () => {
    const withEvents = await contextWithOvernight({ withEvents: true });
    const withoutEvents = await contextWithOvernight({ withEvents: false });
    const a = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, withEvents);
    const b = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, withoutEvents);
    if (!a.ok || !b.ok) throw new Error('report failed');
    const titles = (report: typeof a.data.report, key: string) =>
      sectionOf(report, key).blocks.flatMap((block) =>
        block.kind === 'list' ? block.items.map((item) => item.title) : [],
      );
    const counterA = titles(a.data.report, 'envelope-counter-evidence');
    const counterB = titles(b.data.report, 'envelope-counter-evidence');
    const risksA = titles(a.data.report, 'envelope-risks');
    expect(counterA.length).toBeGreaterThanOrEqual(1);
    expect(risksA.length).toBeGreaterThanOrEqual(1);
    const risksB = titles(b.data.report, 'envelope-risks');
    // 不同输入 → 不同反证与风险内容（不是固定字符串）。
    expect(counterA).not.toEqual(counterB);
    expect(counterB.join(' ')).toContain('没有公司事件');
    expect(risksA).not.toEqual(risksB);
    expect(risksA.join(' ')).toContain('公司事件');
  });

  it('sets validity to the report period close (15:00 Asia/Shanghai) with report-period basis', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const metrics = sectionOf(result.data.report, 'envelope-validity').blocks.find(
      (block) => block.kind === 'metrics',
    );
    const items = metrics?.kind === 'metrics' ? metrics.items : [];
    expect(items.find((item) => item.key === 'validUntil')?.value).toBe('2026-07-29T07:00:00.000Z');
    expect(items.find((item) => item.key === 'basis')?.value).toBe('report-period');
  });

  // 账户没有生效中的建议时才 unavailable；不推断、不编造。
  it('marks existing-advice unavailable only when the account has no advice', async () => {
    const ctx = await contextWithOvernight({ withEvents: true, advices: [] });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const section = sectionOf(result.data.report, 'existing-advice');
    expect(section.status).toBe('unavailable');
    expect(section.blocks.every((block) => block.kind === 'text' && block.tone === 'warning')).toBe(
      true,
    );
  });

  // 归属与过期语义复用同一实现：本账户的建议出现，别的账户的不出现。
  it('lists the account’s own advice with id, validity and counter-evidence', async () => {
    const base = await buildTestContext({ clock: () => generatedAt, advices: [] });
    const accountId = base.user.defaultAccountId;
    const mine = adviceFixture({ id: 'advice-mine', subjectId: accountId });
    const others = adviceFixture({ id: 'advice-other-account', subjectId: 'someone-else-account' });
    const ctx = await contextWithOvernight({ withEvents: true, advices: [mine, others] });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const section = sectionOf(result.data.report, 'existing-advice');
    expect(section.status).toBe('complete');
    const items = section.blocks.flatMap((block) => (block.kind === 'list' ? block.items : []));
    expect(items.map((item) => item.entityId)).toEqual(['advice-mine']);
    expect(items[0]?.detail).toContain('有效期至 2026-08-05T00:00:00.000Z');
    expect(items[0]?.detail).toContain('反证：');
    expect(items[0]?.detail).not.toContain('反证：未提供');
  });

  // 端到端：workflow 产出的 Report 必须能真的落盘成可交付文件。
  it('writes a deliverable file from the generated report', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    // REQ-M5-02：先发布再导出。
    const published = await publishReportTool.execute({ reportId: result.data.report.id }, ctx);
    expect(published.ok).toBe(true);
    const written = await writeReportArtifactTool.execute({ reportId: result.data.report.id }, ctx);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.data.deliverablePath).toBe(
      '/tmp/luoome-reports/2026-07-29-morning-brief-all-accounts.md',
    );
    expect(written.data.presentArgs.files).toHaveLength(1);
    expect(written.data.presentArgs.files[0]?.path).toBe(written.data.deliverablePath);
    const stored = (ctx.reportArtifacts as unknown as { files: Map<string, string> }).files.get(
      written.data.fileName,
    );
    const parsed = parseReportDocument(stored as string);
    expect(parsed).toEqual(written.data.document);
    expect(parsed.envelope.conclusion).toContain('盘前');
  });
});

// ---------------------------------------------------------------------------
// U2/U3：「缺段」判据只有一份 —— 卡片与文档用同一套
// ---------------------------------------------------------------------------

describe('U3 缺段判据单一化：卡片 blocked 与文档抛错报同一个缺口集合', () => {
  const missingFromError = (message: string): string[] =>
    ADVICE_SEGMENTS.filter((segment) => message.includes(segment));

  it('缺同一批段时，卡片 missing 与文档报错段名集合相等', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const report = result.data.report;

    // 先确认完整报告能渲染（否则这条测试没有意义）。
    expect(() => reportDocumentFromReport(report)).not.toThrow();

    // 去掉「反证」与「风险」两个槽的 section。
    const withoutTwo = {
      ...report,
      sections: report.sections.filter(
        (item) =>
          item.key !== REPORT_ENVELOPE_SECTION_KEYS.counterEvidence &&
          item.key !== REPORT_ENVELOPE_SECTION_KEYS.risks,
      ),
    };
    let thrown: string | undefined;
    try {
      reportDocumentFromReport(withoutTwo);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toBeDefined();
    const docMissing = missingFromError(thrown ?? '');
    expect(new Set(docMissing)).toEqual(new Set(['counterEvidence', 'risks']));

    // 卡片侧：同一个「已具备」集合（缺反证与风险）应报同一批段。
    const present: Record<string, boolean> = {};
    for (const segment of ADVICE_SEGMENTS) present[segment] = true;
    present.counterEvidence = false;
    present.risks = false;
    const cardMissing = missingAdviceSegments(present);
    expect(new Set(cardMissing)).toEqual(new Set(docMissing));
    // 顺序也一致（都按 ADVICE_SEGMENTS）。
    expect(cardMissing).toEqual([...ADVICE_SEGMENTS].filter((s) => docMissing.includes(s)));
  });

  it('六槽段键只有一份定义：workflow 组装出的段键能被 reportDocumentFromReport 取到', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const keys = result.data.report.sections.map((item) => item.key);
    // 五段的段键全部来自 core 的同一份映射（副本分叉时这里会红）。
    for (const segment of ADVICE_SEGMENTS)
      expect(keys).toContain(REPORT_ENVELOPE_SECTION_KEYS[segment]);
  });
});
