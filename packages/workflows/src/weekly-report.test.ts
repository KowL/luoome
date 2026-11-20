import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { reportWorkflow } from './report.js';
import { weeklyReportOperation } from './weekly-report.js';

const MONDAY_NOON = new Date('2026-11-16T04:00:00Z'); // 12:00 上海，周一

const context = async () =>
  buildTestContext({
    clock: () => MONDAY_NOON,
  });

describe('weekly-report 成绩单', () => {
  it('生成每周成绩单：只含成绩单相关 section，模板与周期正确', async () => {
    const ctx = await context();
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { report, created, notified } = result.data;
    expect(created).toBe(true);
    expect(notified).toBe(false);
    expect(report.kind).toBe('weekly');
    // 周一生成回顾上一周（11-09 至 11-13）
    expect(report.periodStart).toBe('2026-11-09');
    expect(report.periodEnd).toBe('2026-11-13');
    expect(report.sections.map((section) => section.key)).toEqual([
      'advice-scorecard',
      'advice-week',
      'advice-feedback',
    ]);
  });

  it('没有已结算样本时成绩单标 unavailable，门禁给出样本不足的原因', async () => {
    const ctx = await context();
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scorecard = result.data.report.sections.find((s) => s.key === 'advice-scorecard');
    expect(scorecard?.status).toBe('unavailable');
    expect(scorecard?.missingDimensions.map((m) => m.dimension)).toContain(
      'advice-scorecard.settlement',
    );
    const texts = (scorecard?.blocks ?? []).flatMap((block) =>
      block.kind === 'text' ? [block.text] : [],
    );
    expect(texts.join('\n')).toContain('不足');
  });

  it('同一周期重复运行不新建报告', async () => {
    const ctx = await context();
    const first = await weeklyReportOperation.run({}, ctx);
    const second = await weeklyReportOperation.run({}, ctx);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.created).toBe(true);
    expect(second.data.created).toBe(false);
    expect(second.data.report.id).toBe(first.data.report.id);
  });

  it('非交易日直接拒绝，不生成报告', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-11-15T04:00:00Z') });
    const result = await weeklyReportOperation.run({}, ctx);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(await ctx.repos.report.list()).toEqual([]);
  });

  it('reportWorkflow 只接受 weekly，并转交同一套生成逻辑', async () => {
    const ctx = await context();
    const result = await reportWorkflow.run({ kind: 'weekly' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { report: { kind: string } }).report.kind).toBe('weekly');
  });
});
