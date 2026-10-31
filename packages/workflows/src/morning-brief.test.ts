import {
  assertReportInvariants,
  money,
  parseReportDocument,
  type ReportArtifactWriter,
  type ReportSection,
} from '@luoome/core';
import { writeReportArtifactTool } from '@luoome/tools';
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

const contextWithOvernight = async (options: { readonly withEvents: boolean }) => {
  const base = await buildTestContext({ clock: () => generatedAt });
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

  it('does not fabricate an existing-advice section it cannot source', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
    const section = sectionOf(result.data.report, 'existing-advice');
    expect(section.status).toBe('unavailable');
    expect(section.blocks.every((block) => block.kind === 'text' && block.tone === 'warning')).toBe(
      true,
    );
  });

  // 端到端：workflow 产出的 Report 必须能真的落盘成可交付文件。
  it('writes a deliverable file from the generated report', async () => {
    const ctx = await contextWithOvernight({ withEvents: true });
    const result = await morningBriefWorkflow.run({ date: '2026-07-29', notify: false }, ctx);
    if (!result.ok) throw new Error('report failed');
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
