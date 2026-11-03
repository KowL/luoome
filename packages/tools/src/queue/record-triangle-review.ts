import { TriangleRolesSchema, triangleEvidenceBelongsToSnapshot } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const RecordTriangleReviewInput = z
  .object({
    accountId: z.string().min(1).optional(),
    contextId: z.string().min(1),
    roles: TriangleRolesSchema,
  })
  .strict();

export const RecordTriangleReviewOutput = z.object({
  contextId: z.string(),
  vetoId: z.string().nullable(),
  blocked: z.boolean(),
  reason: z.string().nullable(),
});

export const recordTriangleReviewTool = defineTool({
  name: 'record_triangle_review',
  description: '记录四角色结构化审查，校验证据并持久化风险官否决；不是模型调用或建议发布。',
  sideEffect: 'queue',
  input: RecordTriangleReviewInput,
  output: RecordTriangleReviewOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const context = await ctx.repos.analysis.findContext(accountId, input.contextId);
    if (!context) return errNotFound('AnalysisContext', input.contextId);
    if (!triangleEvidenceBelongsToSnapshot(input.roles, context.factIds))
      return errInvalidInput('四角色证据必须来自同一持久化上下文。');
    const verdict = input.roles.riskOfficer;
    const vetoId = `triangle:${context.id}`;
    if (
      verdict.status === 'veto' &&
      (await ctx.repos.riskVeto.findVetoById(accountId, vetoId)) === null
    )
      await ctx.repos.riskVeto.save({
        id: vetoId,
        accountId,
        contextId: context.id,
        subject: context.subject,
        reason: verdict.reason,
        factIds: verdict.factIds,
        createdAt: ctx.clock(),
      });
    const active = await ctx.repos.riskVeto.findActiveBySubject({
      accountId,
      subject: context.subject,
    });
    const missing =
      verdict.status === 'need-more-data' || input.roles.judge.status === 'need-more-data';
    return {
      contextId: context.id,
      vetoId: active?.veto.id ?? null,
      blocked: active !== null || missing,
      reason:
        active?.veto.reason ??
        (verdict.status === 'need-more-data'
          ? verdict.reason
          : missing
            ? '裁决官尚有事实缺口。'
            : null),
    };
  },
});
