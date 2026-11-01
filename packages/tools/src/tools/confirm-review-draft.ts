import { reviewSourceDraftId, type ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { getDecisionReviewContextTool, saveDecisionReviewTool } from './decision-review.js';

/**
 * 把**盘后复盘草稿**确认成 DecisionReview（REQ-M4-11）。
 *
 * ## 核心纪律：草稿存在 ≠ 复盘已写
 *
 * 草稿是一份 `Report`（kind `daily-review`），落 `$LUOOME_HOME/reports/`；
 * **只有调用本工具才会写 DecisionReview**。生成路径（`daily-review` workflow）
 * 不得碰 `save_decision_review` / `record_advice_outcome` —— 有源码级守卫钉住。
 *
 * ## 为什么调既有 `save_decision_review`，而不是自己写一份
 *
 * 它已经处理了：修订链、requestId 幂等回执、内容规范化、`contextHash` 校验。
 * 复制这些逻辑 = 两份规则，早晚漂移。本工具**只负责**「从草稿取出内容 + 盖来源 id」。
 *
 * ## 幂等靠 subject 唯一性
 *
 * `accountId + subject.kind + subject.id` 天然唯一，而 `account-review` 的
 * `id = <accountId>:<YYYY-MM-DD>` 一天一条。用户点两次「确认」不会写两条复盘。
 */
export const ConfirmReviewDraftInput = z
  .object({
    /** 草稿的 Report id（`write_report_artifact` 落盘的那份报告）。 */
    draftReportId: z.string().min(1),
    /** 幂等键；缺省按草稿 id 派生，保证同一草稿重复确认不产生多条。 */
    requestId: z.uuid().optional(),
    /** 用户确认时的备注（覆盖草稿的默认标题）。 */
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const ConfirmReviewDraftOutput = z.object({
  /** 复盘视图（`save_decision_review` 的返回，语义一致）。 */
  result: z.unknown(),
  /** true = 该草稿此前已确认过，本次为幂等重放。 */
  replayed: z.boolean(),
  /** 来源草稿 id（原样回显，便于调用方核对）。 */
  sourceDraftId: z.string().min(1),
});

/** 从草稿 Report 推出复盘主体；非单账户草稿不可确认。 */
const subjectOfDraft = (
  report: {
    readonly scope: { readonly kind: string; readonly accountId?: string };
  },
  day: string,
): { accountId: string; subject: { kind: 'account-review'; id: string } } | null => {
  if (report.scope.kind !== 'account' || report.scope.accountId === undefined) return null;
  const accountId = report.scope.accountId;
  return {
    accountId,
    // 一天一条：`<accountId>:<YYYY-MM-DD>`，这同时是幂等键。
    subject: { kind: 'account-review', id: `${accountId}:${day}` },
  };
};

/** 幂等键：同一草稿永远派生同一个 uuid（稳定、可重放）。 */
const derivedRequestId = (draftReportId: string): string => {
  const hex = [...draftReportId]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
    .padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const confirmReviewDraftTool = defineTool({
  name: 'confirm_review_draft',
  description:
    '把盘后复盘草稿确认成 DecisionReview：草稿本身不写复盘，只有本工具会写，并记录来源草稿 id。',
  sideEffect: 'write',
  input: ConfirmReviewDraftInput,
  output: ConfirmReviewDraftOutput,
  handler: async (input, ctx: ToolContext) => {
    const report = await ctx.repos.report.findById(input.draftReportId);
    if (report === null) return errNotFound('Report', input.draftReportId);
    // 只接受**复盘草稿**：其它 kind 的报告确认成复盘没有语义。
    if (report.kind !== 'daily-review')
      return errInvalidInput(`只有 daily-review 草稿可以确认成复盘，实际 kind=${report.kind}`);

    // `periodStart` 已是 `YYYY-MM-DD` 字符串（单日报告 periodStart === periodEnd）。
    const day = String(report.periodStart).slice(0, 10);
    const scope = subjectOfDraft(report, day);
    if (scope === null)
      return errInvalidInput('该草稿不是单账户范围的复盘草稿，无法确认成账户复盘');

    // **幂等**：同一草稿重复确认直接返回既有结论，不重复写。
    const existing = await ctx.repos.decisionReview.findBySubject({
      accountId: scope.accountId,
      subject: scope.subject,
    });
    if (existing !== null && reviewSourceDraftId(existing.review) === input.draftReportId)
      return { result: existing, replayed: true, sourceDraftId: input.draftReportId };

    // **复用**既有写入工具：不复制它的校验、哈希、回执与修订语义。
    // `contextHash` 由 `get_decision_review_context` 计算 —— **不自己拼**。
    // 自己拼的话，只要内部 digest 的输入形状一变，这里就会永远「来源已变化」。
    const contextRead = await getDecisionReviewContextTool.execute(
      { accountId: scope.accountId, subject: scope.subject },
      ctx,
    );
    if (!contextRead.ok) return contextRead;
    const expectedContextHash = contextRead.data.context?.contextHash;
    if (expectedContextHash === undefined)
      return errInvalidInput('无法计算复盘来源哈希，请刷新后重试');

    const saved = await saveDecisionReviewTool.execute(
      {
        accountId: scope.accountId,
        subject: scope.subject,
        requestId: input.requestId ?? derivedRequestId(input.draftReportId),
        contextHash: expectedContextHash,
        expectedRevision:
          contextRead.data.current?.review.currentRevision ?? existing?.review.currentRevision ?? 0,
        // 来源草稿 id：由 `resolveSource` 盖进 `context.source`（唯一写入点）。
        sourceDraftId: input.draftReportId,
        content: {
          tradeIds: [],
          adviceFeedback: null,
          triggerFeedback: null,
          note: input.note === undefined ? report.title || null : input.note,
        },
      },
      ctx,
    );
    if (!saved.ok) return saved;

    return {
      result: saved.data.result,
      replayed: saved.data.replayed,
      sourceDraftId: input.draftReportId,
    };
  },
});
