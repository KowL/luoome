import { createHash } from 'node:crypto';
import {
  type Advice,
  money,
  type Report,
  STANDARD_DISCLAIMERS,
  type ToolContext,
} from '@luoome/core';
import {
  getAccountFactsTool,
  getAdviceStatsTool,
  getConfidenceCalibrationTool,
  recordAdviceOutcomeTool,
  renderReportTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentStrategyFingerprint } from './account-plan-batch.js';
import { buildWorkflowTools } from './define-workflow.js';
import { hostedReportsWorkflow } from './hosted-reports.js';

const NOW = new Date('2026-10-15T10:00:00Z');
const SINCE = new Date('2026-09-16T00:00:00+08:00');
const OTHER_ACCOUNT = 'ds6-other-account';
const advice = (id: string, accountId: string | null, createdAt = NOW): Advice => ({
  id,
  subjectKind: 'stock',
  subjectId: '600519.SH',
  decision: 'buy',
  confidence: 80,
  horizon: 'short',
  reasoning: { premise: 'fixture', evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  basedOn: {
    dataAsOf: createdAt,
    ...(accountId === null
      ? {}
      : {
          strategy: {
            strategyId: 'fixture-strategy',
            strategyVersionId: 'fixture-version',
            runId: 'fixture-run',
            stockId: '600519.SH',
            accountId,
            resultEvidence: [],
            signalIds: [],
            observationIds: [],
            recommendationTrigger: 'run' as const,
          },
        }),
  },
  validFrom: createdAt,
  validUntil: new Date(createdAt.getTime() + 86_400_000),
  createdAt,
});
const setup = async () => {
  let now = NOW;
  const base = await buildTestContext({ clock: () => now, advices: [] });
  const ctx: ToolContext = {
    ...base,
    identity: {
      mode: 'hosted',
      actor: 'worker',
      tenantId: 'ds6-tenant',
      tenantGeneration: 1,
      userId: base.user.id,
      requestId: 'ds6-fixture',
    },
    hostedAuthorization: async () => null,
  };
  const account = await ctx.repos.account.findById(ctx.user.defaultAccountId);
  if (!account) throw new Error('fixture account missing');
  await ctx.repos.account.save({ ...account, id: OTHER_ACCOUNT, name: 'other account' });
  const facts = await getAccountFactsTool.execute({ accountId: ctx.user.defaultAccountId }, ctx);
  if (!facts.ok) throw new Error('fixture facts missing');
  const fingerprint = await currentStrategyFingerprint('2026-10-15', {
    ...ctx,
    tools: buildWorkflowTools(ctx),
  });
  if (fingerprint === null) throw new Error('fixture fingerprint missing');
  const digest = createHash('sha256')
    .update(`${fingerprint}:${facts.data.facts.digest}`)
    .digest('hex')
    .slice(0, 16);
  await ctx.repos.workflowRun.save({
    id: `account-plan-batch:2026-10-15:${ctx.user.defaultAccountId}:${digest}`,
    workflowName: 'account-plan-batch',
    mode: 'scheduled',
    status: 'succeeded',
    startedAt: NOW,
    finishedAt: NOW,
    inputSummary: {},
    outputSummary: { status: 'complete' },
    providerStatuses: [],
  });
  const run = async (): Promise<Report> => {
    const result = await hostedReportsWorkflow.run({}, ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    const report = reports[0];
    if (!report) throw new Error('closing fixture report missing');
    return report;
  };
  return {
    ctx,
    run,
    advance: () => {
      now = new Date(now.getTime() + 60_000);
    },
  };
};
const summary = (report: Report) => {
  const section = report.sections.find((section) => section.key === 'advice-calibration');
  if (!section) throw new Error('calibration section missing');
  const metrics = section.blocks.flatMap((block) => (block.kind === 'metrics' ? block.items : []));
  return {
    section,
    metrics,
    values: Object.fromEntries(metrics.map((item) => [item.key, item.value])),
  };
};
const feedback = async (
  ctx: ToolContext,
  id: string,
  outcome: 'followed' | 'partially_followed' | 'ignored',
  pnl?: number,
  accountId = ctx.user.defaultAccountId,
) => {
  const result = await recordAdviceOutcomeTool.execute(
    { adviceId: id, accountId, outcome, ...(pnl === undefined ? {} : { pnl }) },
    ctx,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
};
afterEach(() => vi.restoreAllMocks());

describe('DS-6 closing report calibration', () => {
  it('托管 worker 固定嵌入摘要，与原 DecisionReview 统计完全一致并披露账户/窗口/覆盖率/样本量', async () => {
    const h = await setup();
    for (const id of [
      'profit',
      'zero',
      'loss',
      'unknown',
      'partial',
      'ignored',
      'pending',
      'legacy',
    ])
      await h.ctx.repos.advice.save(
        advice(
          id,
          id === 'profit' ? null : h.ctx.user.defaultAccountId,
          id === 'pending' ? SINCE : NOW,
        ),
      );
    await feedback(h.ctx, 'profit', 'followed', 100);
    await feedback(h.ctx, 'zero', 'followed', 0);
    await feedback(h.ctx, 'loss', 'followed', -10);
    await feedback(h.ctx, 'unknown', 'followed');
    await feedback(h.ctx, 'partial', 'partially_followed', 100);
    await feedback(h.ctx, 'ignored', 'ignored', 100);
    await feedback(h.ctx, 'profit', 'ignored', 9000, OTHER_ACCOUNT);
    await h.ctx.repos.advice.save(advice('foreign-shared', null));
    await feedback(h.ctx, 'foreign-shared', 'followed', 9000, OTHER_ACCOUNT);
    await h.ctx.repos.advice.recordOutcome('legacy', {
      adviceId: 'legacy',
      tradeIds: [],
      outcome: 'followed',
      pnl: money(9000),
      recordedAt: NOW,
    });
    await h.ctx.repos.advice.save(
      advice('before-window', h.ctx.user.defaultAccountId, new Date(SINCE.getTime() - 1)),
    );
    await feedback(h.ctx, 'before-window', 'followed', 9000);
    await h.ctx.repos.advice.save(
      advice('after-cutoff', h.ctx.user.defaultAccountId, new Date(NOW.getTime() + 1)),
    );
    const filters = { accountId: h.ctx.user.defaultAccountId, since: SINCE, until: NOW };
    const stats = await getAdviceStatsTool.execute(filters, h.ctx);
    const calibration = await getConfidenceCalibrationTool.execute(filters, h.ctx);
    if (!stats.ok || !calibration.ok) throw new Error('fixture stats missing');
    const report = await h.run();
    const { section, values } = summary(report);
    expect(section.title).toBe('近期建议校准摘要');
    expect(section.required).toBe(true);
    expect(values).toEqual({
      adviceSampleCount: 8,
      explicitFeedbackCount: 6,
      feedbackCoverage: 0.75,
      followedWithReportedPnlCount: 3,
      reportedProfitShare: 1 / 3,
    });
    expect(values.adviceSampleCount).toBe(calibration.data.totalAdvices);
    expect(values.explicitFeedbackCount).toBe(calibration.data.totalWithOutcome);
    expect(values.explicitFeedbackCount).toBe(stats.data.feedbackCount);
    expect(values.followedWithReportedPnlCount).toBe(stats.data.followedWithPnl);
    expect(values.reportedProfitShare).toBe(calibration.data.overallHitRate);
    expect(values.reportedProfitShare).toBe(stats.data.hitRate);
    const text = section.blocks
      .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain(h.ctx.user.defaultAccountId);
    expect(text).not.toContain(OTHER_ACCOUNT);
    expect(text).toContain('2026-09-16');
    expect(text).toContain('反馈覆盖率 = 当前账户明确反馈样本量 / 账户建议样本量');
    expect(text).toContain('不代表账户收益率、预测准确率或未来成功概率');
    expect(section.dataAsOf).toEqual(NOW);
    expect(report.sections.filter((section) => section.key === 'advice-calibration')).toHaveLength(
      1,
    );
    const opening = (await h.ctx.repos.report.list({ kind: 'opening' }))[0];
    expect(opening?.sections.some((section) => section.key === 'advice-calibration')).toBe(false);
  });

  it.each(['no-advice', 'no-feedback', 'unknown-pnl'] as const)(
    '%s：无样本显示明确提示，比例缺失不伪装成零',
    async (kind) => {
      const h = await setup();
      if (kind !== 'no-advice')
        await h.ctx.repos.advice.save(advice('unsettled', h.ctx.user.defaultAccountId));
      if (kind === 'unknown-pnl') await feedback(h.ctx, 'unsettled', 'followed');
      const report = await h.run();
      const { metrics, values } = summary(report);
      expect(values.reportedProfitShare).toBeNull();
      expect(values.followedWithReportedPnlCount).toBe(0);
      expect(metrics.find((item) => item.key === 'reportedProfitShare')?.displayValue).toContain(
        '暂无有效盈亏样本',
      );
      if (kind === 'no-advice') expect(values.feedbackCoverage).toBeNull();
      const rendered = await renderReportTool.execute(
        { reportId: report.id, format: 'markdown' },
        h.ctx,
      );
      if (!rendered.ok) throw new Error('render fixture failed');
      const text = rendered.data.content.split('## 近期建议校准摘要')[1]?.split('\n## ')[0];
      expect(text).toContain('暂无有效盈亏样本，无法计算');
      expect(text).not.toContain('填报盈利占比：0');
    },
  );

  it('只有明确填报的零盈亏进入分母，未知盈亏仍缺省；字段不命名为准确率或收益率', async () => {
    const h = await setup();
    for (const id of ['unknown', 'explicit-zero'])
      await h.ctx.repos.advice.save(advice(id, h.ctx.user.defaultAccountId));
    await feedback(h.ctx, 'unknown', 'followed');
    await feedback(h.ctx, 'explicit-zero', 'followed', 0);
    const { section, metrics, values } = summary(await h.run());
    expect(values.followedWithReportedPnlCount).toBe(1);
    expect(values.reportedProfitShare).toBe(0);
    const revisions = await h.ctx.repos.decisionReview.list({
      accountId: h.ctx.user.defaultAccountId,
      subjectKind: 'advice',
      limit: 100,
    });
    const unknown = revisions.find(({ review }) => review.subject.id === 'unknown');
    const zero = revisions.find(({ review }) => review.subject.id === 'explicit-zero');
    expect(unknown?.revision.content.adviceFeedback).not.toHaveProperty('pnl');
    expect(zero?.revision.content.adviceFeedback?.pnl).toBe(0);
    for (const item of metrics) {
      expect(item.key).not.toMatch(/hitRate|accuracy|winRate|yield|return/i);
      expect(item.label).not.toMatch(/收益率|准确率|命中率|胜率/);
    }
    expect(
      section.blocks.some(
        (block) => block.kind === 'text' && block.text.includes('未知盈亏保持缺失'),
      ),
    ).toBe(true);
  });

  it('生成后新增或修订反馈，重复 worker pass 复用原报告，不改写摘要', async () => {
    const h = await setup();
    await h.ctx.repos.advice.save(advice('later-feedback', h.ctx.user.defaultAccountId));
    const first = await h.run();
    const snapshot = JSON.stringify(summary(first).section);
    await feedback(h.ctx, 'later-feedback', 'followed', 100);
    h.advance();
    const again = await h.run();
    expect(again.id).toBe(first.id);
    expect(JSON.stringify(summary(again).section)).toBe(snapshot);
    expect(await h.ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
  });

  it('统计读取失败仍保留固定区块与账户范围，标 unavailable 并保留缺失原因', async () => {
    const h = await setup();
    vi.spyOn(getConfidenceCalibrationTool, 'execute').mockResolvedValue({
      ok: false,
      error: { kind: 'internal', cause: 'fixture stats unavailable' },
    });
    const report = await h.run();
    const { section, metrics } = summary(report);
    expect(section.status).toBe('unavailable');
    expect(metrics).toHaveLength(0);
    expect(JSON.stringify(section.blocks)).toContain(h.ctx.user.defaultAccountId);
    expect(section.missingDimensions).toEqual([
      expect.objectContaining({ errorKind: 'internal', retryable: true }),
    ]);
  });
});
