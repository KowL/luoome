import { randomUUID } from 'node:crypto';
import { overrideCarriesNewEvidence } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const OverrideRiskVetoInput = z
  .object({
    accountId: z.string().min(1).optional(),
    vetoId: z.string().min(1),
    overriddenBy: z.literal('user'),
    reason: z.string().trim().min(1).max(1000),
    evidenceContextId: z.string().min(1),
    newFactIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const OverrideRiskVetoOutput = z.object({
  overrideId: z.string().min(1),
  vetoId: z.string().min(1),
  acceptedNewFactIds: z.array(z.string()),
});

export const overrideRiskVetoTool = defineTool({
  name: 'override_risk_veto',
  description: '人工推翻风险官否决；仅限已认证的人工入口，须提供持久化上下文中的新证据。',
  sideEffect: 'write',
  input: OverrideRiskVetoInput,
  output: OverrideRiskVetoOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const authorization = ctx.riskVetoOverrideAuthorization;
    if (
      !authorization ||
      authorization.accountId !== accountId ||
      authorization.vetoId !== input.vetoId ||
      authorization.userId !== ctx.user.id
    )
      return {
        ok: false as const,
        error: {
          kind: 'permission_denied' as const,
          required: 'authenticated human risk-veto override',
        },
      };
    const veto = await ctx.repos.riskVeto.findVetoById(accountId, input.vetoId);
    if (veto === null) return errNotFound('RiskVeto', input.vetoId);
    if (!overrideCarriesNewEvidence({ vetoFactIds: veto.factIds, newFactIds: input.newFactIds }))
      return errInvalidInput('推翻否决必须给出新证据，复述原证据不构成推翻理由。');
    const evidence = await ctx.repos.analysis.findContext(accountId, input.evidenceContextId);
    if (
      !evidence ||
      evidence.subject.kind !== veto.subject.kind ||
      evidence.subject.id !== veto.subject.id ||
      evidence.createdAt <= veto.createdAt ||
      evidence.createdAt > ctx.clock() ||
      input.newFactIds.some((id) => !evidence.factIds.includes(id))
    )
      return errInvalidInput(
        '新证据必须属于同账户、同标的的持久化事实快照，且快照必须晚于否决、不得晚于当前时间。',
      );
    const acceptedNewFactIds = [
      ...new Set(input.newFactIds.filter((id) => !veto.factIds.includes(id))),
    ];
    const overrideId = randomUUID();
    await ctx.repos.riskVeto.saveOverride({
      id: overrideId,
      vetoId: veto.id,
      overriddenBy: 'user',
      actorUserId: authorization.userId,
      evidenceContextId: evidence.id,
      reason: input.reason,
      newFactIds: acceptedNewFactIds,
      overriddenAt: ctx.clock(),
    });
    return { overrideId, vetoId: veto.id, acceptedNewFactIds };
  },
});
