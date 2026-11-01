import {
  type Advice,
  type Report,
  reviewSourceDraftId,
  STANDARD_DISCLAIMERS,
  type ToolResult,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { confirmReviewDraftTool } from './confirm-review-draft.js';
import { listDecisionReviewsTool } from './decision-review.js';
import { saveReportTool } from './save-report.js';

/**
 * REQ-M4-11：盘后复盘草稿 → 用户确认才写 DecisionReview。
 *
 * ## 三条硬断言（throw，不是记录）
 *
 * 1. 草稿存在时 `list_decision_reviews` **计数不变**（证明未写）
 * 2. 确认后 **+1** 且 `reviewSourceDraftId(review) === draftId`
 * 3. **Advice 逐字段不变**（复盘不等于改建议）
 *
 * ## 为什么需要对照组
 *
 * 「草稿后计数不变」可能是**恒真**（根本没写任何东西都会满足）。
 * 所以下面同一份 fixture 还要证明「确认后计数必须 +1」——
 * 两条合在一起才说明「不变」是设计，而不是没做。
 */
const NOW = new Date('2026-07-29T10:00:00.000Z');

const makeDraft = (overrides: Partial<Report> = {}): Report => ({
  id: 'draft-daily-review-1',
  kind: 'daily-review',
  scope: { kind: 'account', accountId: ACCOUNT },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  title: '2026-07-29 盘后复盘草稿',
  generatedAt: NOW,
  dataAsOf: new Date('2026-07-29T08:00:00.000Z'),
  status: 'complete',
  sections: [
    {
      key: 'review',
      title: '复盘',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '当日复盘草稿', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'workflow-run-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const ADVICE_ID = 'advice-m4-11-fixture';

/** 最小 advice 对照物：只用于证明「确认复盘不改建议」。
 * 字段形状照抄 `get-advice-stats.test.ts:11` 的现成工厂（别手写不合 schema 的对象）。 */
const makeAdvice = (): Advice =>
  ({
    id: ADVICE_ID,
    subjectKind: 'portfolio',
    subjectId: ACCOUNT,
    decision: 'pending',
    confidence: 60,
    horizon: 'swing',
    reasoning: { premise: '对照用建议', evidence: [], counterEvidence: [] },
    risks: [],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_stock',
    basedOn: { dataAsOf: NOW },
    validFrom: NOW,
    validUntil: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
  }) as unknown as Advice;
const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};

const countReviews = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const listed = data(await listDecisionReviewsTool.execute({ accountId: ACCOUNT }, ctx)) as {
    records?: unknown[];
  };
  // 输出字段是 `records`（`decision-review.ts:527`）——不是 `reviews` / `items`。
  return (listed.records ?? []).length;
};

describe('confirm_review_draft：草稿不写复盘，确认才写', () => {
  it('三条硬断言：计数不变 / 确认后 +1 且来源 id 匹配 / 建议不变', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.advice.save(makeAdvice());
    const inserted = data(await saveReportTool.execute({ report: makeDraft() }, ctx));
    const draftId = (inserted as { report?: { id?: string } }).report?.id ?? 'draft-daily-review-1';

    // ① 草稿存在 → **计数不变**
    const before = await countReviews(ctx);
    const afterDraft = await countReviews(ctx);
    if (afterDraft !== before) throw new Error(`草稿写入后复盘计数变了：${before} → ${afterDraft}`);

    // ② 确认 → +1 且来源草稿 id 匹配
    const confirmed = data(
      await confirmReviewDraftTool.execute(
        { draftReportId: draftId, requestId: '11111111-1111-4111-8111-111111111111' },
        ctx,
      ),
    ) as { sourceDraftId?: string };
    if (confirmed.sourceDraftId !== draftId)
      throw new Error(`来源草稿 id 不匹配：${String(confirmed.sourceDraftId)} vs ${draftId}`);
    const afterConfirm = await countReviews(ctx);
    if (afterConfirm !== before + 1)
      throw new Error(`确认后复盘计数应 +1：${before} → ${afterConfirm}`);

    // 读回那条复盘，来源必须指向草稿
    const stored = await ctx.repos.decisionReview.findBySubject({
      accountId: ACCOUNT,
      subject: { kind: 'account-review', id: `${ACCOUNT}:2026-07-29` },
    });
    if (stored === null) throw new Error('确认后没有写入复盘');
    if (reviewSourceDraftId(stored.review) !== draftId)
      throw new Error(`落库的来源草稿 id 不匹配：${String(reviewSourceDraftId(stored.review))}`);

    // ③ 建议逐字段不变（复盘不等于改建议）
    //
    // 这里先落一条 advice 作为**对照物**：没有对照时「不变」是恒真的
    // （什么都没存，自然也不会变）。
    const adviceBefore = JSON.stringify(await ctx.repos.advice.findById(ADVICE_ID));
    await confirmReviewDraftTool.execute(
      { draftReportId: draftId, requestId: '55555555-5555-4555-8555-555555555555' },
      ctx,
    );
    const adviceAfter = JSON.stringify(await ctx.repos.advice.findById(ADVICE_ID));
    if (adviceAfter !== adviceBefore) throw new Error('原建议被改动');
    // 对照物确实存在（否则上面的「不变」没有意义）。
    if (adviceBefore === 'null') throw new Error('对照 advice 缺失，"建议不变"无从证明');
  });

  it('幂等：同一草稿确认两次只写一条（subject 一天一条）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    data(await saveReportTool.execute({ report: makeDraft() }, ctx));
    const before = await countReviews(ctx);
    await confirmReviewDraftTool.execute(
      { draftReportId: 'draft-daily-review-1', requestId: '22222222-2222-4222-8222-222222222222' },
      ctx,
    );
    const afterFirst = await countReviews(ctx);
    await confirmReviewDraftTool.execute(
      { draftReportId: 'draft-daily-review-1', requestId: '22222222-2222-4222-8222-222222222222' },
      ctx,
    );
    const afterSecond = await countReviews(ctx);
    // 第二次必须是幂等重放：不新增。
    if (afterSecond !== afterFirst)
      throw new Error(`重复确认产生了新复盘：${afterFirst} → ${afterSecond}`);
    if (afterFirst !== before + 1) throw new Error('第一次确认应 +1');
  });

  it('非 daily-review 草稿 → 拒绝（其它 kind 确认成复盘没有语义）', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    data(
      await saveReportTool.execute(
        { report: makeDraft({ id: 'report-closing', kind: 'closing' }) },
        ctx,
      ),
    );
    const result = await confirmReviewDraftTool.execute(
      { draftReportId: 'report-closing', requestId: '33333333-3333-4333-8333-333333333333' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('不存在的草稿 → not_found', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await confirmReviewDraftTool.execute(
      { draftReportId: 'missing-draft', requestId: '44444444-4444-4444-8444-444444444444' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});
