import {
  type Advice,
  parseReportDocument,
  type Report,
  type ReportArtifactWriter,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { writeReportArtifactTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { dailyReviewWorkflow } from './daily-review.js';
import { riskReportWorkflow } from './risk-report.js';

const now = new Date('2026-07-29T09:00:00.000Z');

/** 有账户归属的建议（`basedOn.strategy.accountId` 是归属判定的依据）。 */
const attributedAdvice = (accountId: string, stockId: string): Advice => ({
  id: `s6a-advice-${stockId}`,
  subjectKind: 'stock',
  subjectId: stockId,
  decision: 'hold',
  confidence: 60,
  horizon: 'short',
  reasoning: { premise: 'p', evidence: ['e'], counterEvidence: ['c'] },
  risks: ['r'],
  disclaimers: [...STANDARD_DISCLAIMERS],
  sourceTool: 'analyze_stock',
  basedOn: {
    dataAsOf: now,
    strategy: {
      strategyId: `s6a-strategy-${stockId}`,
      strategyVersionId: `s6a-strategy-${stockId}:v1`,
      runId: `s6a-run-${stockId}`,
      stockId,
      accountId,
      resultEvidence: [],
      signalIds: [],
      observationIds: [],
      recommendationTrigger: 'run',
    },
  },
  validFrom: now,
  validUntil: new Date(now.getTime() + 3 * 86_400_000),
  createdAt: now,
});

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
    // 「rich」必须是有**账户归属**的建议：默认种子没有归属，会被账户归属过滤掉
    // （它们只计入 unattributedCount），那样 rich/lean 看到的建议数就一样了。
    const probe = await buildTestContext({ clock: () => now, advices: [] });
    const accountId = probe.user.defaultAccountId;
    const rich = await buildTestContext({
      clock: () => now,
      advices: [attributedAdvice(accountId, '002594.SZ'), attributedAdvice(accountId, '600519.SH')],
    });
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

  // task-22 回归锚点：北京时间 00:30（= UTC 前一天 16:30）时，报告期与交付物文件名都必须是
  // Asia/Shanghai 当天，不能是 UTC 日。
  it('risk-report 在早盘时段用 Shanghai 日，文件名与内容日期一致', async () => {
    const preDawn = new Date('2026-10-30T16:30:00.000Z'); // 2026-10-31 00:30 +08:00
    const ctx = {
      ...(await buildTestContext({ clock: () => preDawn })),
      reportArtifacts: memoryWriter(),
    };
    const result = await riskReportWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.data.report;
    expect(report).toBeDefined();
    if (report === undefined) return;
    expect(report.periodStart).toBe('2026-10-31');
    expect(report.periodEnd).toBe('2026-10-31');
    const written = await writeArtifact(report, ctx);
    expect(written?.fileName).toContain('2026-10-31');
    // 文件名日期 === 报告内容日期（回归锚点）。
    expect(written?.fileName.slice(0, 10)).toBe(report.periodEnd);
  });
});
