import { parseReportDocument, type Report, type ReportArtifactWriter } from '@luoome/core';
import { writeReportArtifactTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { dailyReviewWorkflow } from './daily-review.js';
import { riskReportWorkflow } from './risk-report.js';

const now = new Date('2026-07-29T09:00:00.000Z');

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

const titlesOf = (report: Report, key: string): string[] =>
  (report.sections.find((section) => section.key === key)?.blocks ?? []).flatMap((block) =>
    block.kind === 'list' ? block.items.map((item) => item.title) : [],
  );

const writeArtifact = async (report: Report, ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const written = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
  expect(written.ok).toBe(true);
  if (!written.ok) return null;
  const stored = (ctx.reportArtifacts as unknown as { files: Map<string, string> }).files.get(
    written.data.fileName,
  );
  const parsed = parseReportDocument(stored as string);
  expect(parsed).toEqual(written.data.document);
  return written.data;
};

describe('S6a：日复盘 / 风险日报产出可交付 Report', () => {
  it('daily-review 落 Report，六槽齐全，并按 all-accounts 披露', async () => {
    const ctx = {
      ...(await buildTestContext({ clock: () => now })),
      reportArtifacts: memoryWriter(),
    };
    const result = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data.report;
    expect(report).toBeDefined();
    if (report === undefined) return;
    expect(report.kind).toBe('daily-review');
    expect(report.scope).toEqual({ kind: 'all-accounts' });
    for (const key of [
      'envelope-conclusion',
      'envelope-counter-evidence',
      'envelope-risks',
      'envelope-validity',
      'envelope-disclaimer',
    ])
      expect(
        report.sections.some((section) => section.key === key),
        key,
      ).toBe(true);
    // R6 披露：正文必须写明「按当前默认账户统计，不合并跨账户」。
    const serialized = JSON.stringify(report.sections);
    expect(serialized).toContain('不合并跨账户');

    const written = await writeArtifact(report, ctx);
    expect(written?.deliverablePath).toContain('daily-review');
  });

  it('daily-review 的反证随样本变化（不是固定字符串）', async () => {
    const rich = await buildTestContext({ clock: () => now });
    const lean = await buildTestContext({ clock: () => now, advices: [] });
    const a = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, rich);
    const b = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, lean);
    if (!a.ok || !b.ok) throw new Error('workflow failed');
    const counterA = titlesOf(a.data.report as Report, 'envelope-counter-evidence');
    const counterB = titlesOf(b.data.report as Report, 'envelope-counter-evidence');
    expect(counterA.length).toBeGreaterThanOrEqual(1);
    expect(counterA).not.toEqual(counterB);
  });

  it('risk-report 落 Report（scope=该账户）并可落盘', async () => {
    const ctx = {
      ...(await buildTestContext({ clock: () => now })),
      reportArtifacts: memoryWriter(),
    };
    const result = await riskReportWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data.report;
    expect(report).toBeDefined();
    if (report === undefined) return;
    expect(report.kind).toBe('risk');
    expect(report.scope.kind).toBe('account');
    for (const key of ['envelope-conclusion', 'envelope-risks', 'envelope-validity'])
      expect(
        report.sections.some((section) => section.key === key),
        key,
      ).toBe(true);
    const risks = titlesOf(report, 'envelope-risks');
    expect(risks.length).toBeGreaterThanOrEqual(1);
    // 风险来自真实数据（数据健康 / VaR 口径），不是模板。
    expect(risks.join(' ')).toMatch(/数据健康|VaR|集中度/);

    const written = await writeArtifact(report, ctx);
    expect(written?.deliverablePath).toContain('risk');
  });
});
