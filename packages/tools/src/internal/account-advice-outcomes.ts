import { type Advice, type AdviceOutcome, money, type ToolContext } from '@luoome/core';

export const accountAdviceOutcomes = async (
  ctx: ToolContext,
  accountId: string,
): Promise<Map<string, AdviceOutcome>> => {
  const records = await ctx.repos.decisionReview.list({
    accountId,
    subjectKind: 'advice',
    limit: 10000,
  });
  return new Map(
    records.flatMap(({ review, revision }) => {
      const feedback = revision.content.adviceFeedback;
      if (feedback === null) return [];
      return [
        [
          review.subject.id,
          {
            adviceId: review.subject.id,
            tradeIds: revision.content.tradeIds,
            outcome: feedback.outcome,
            ...(feedback.pnl === undefined ? {} : { pnl: money(feedback.pnl) }),
            ...(feedback.benchmarkPnl === undefined
              ? {}
              : { benchmarkPnl: money(feedback.benchmarkPnl) }),
            ...(feedback.holdingHours === undefined ? {} : { holdingHours: feedback.holdingHours }),
            ...(revision.content.note === null ? {} : { notes: revision.content.note }),
            recordedAt: revision.recordedAt,
          } satisfies AdviceOutcome,
        ],
      ];
    }),
  );
};

export const attachAccountAdviceOutcomes = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): Advice[] =>
  advices.map(({ outcome: _legacyOutcome, ...advice }) => {
    const outcome = outcomes.get(advice.id);
    return outcome === undefined ? advice : { ...advice, outcome };
  });

export const accountScopedAdvices = async (
  ctx: ToolContext,
  accountId: string,
  advices: readonly Advice[],
): Promise<Advice[]> => {
  const records = await ctx.repos.decisionReview.list({
    accountId,
    subjectKind: 'advice',
    limit: 10000,
  });
  const selected = new Set(records.map(({ review }) => review.subject.id));
  const resolved = await Promise.all(
    advices.map(async (advice) => {
      if (advice.subjectKind === 'stock') {
        return advice.basedOn.strategy?.accountId === accountId || selected.has(advice.id);
      }
      if (advice.subjectKind === 'portfolio') return advice.subjectId === accountId;
      if (advice.subjectKind === 'position') {
        const holding = await ctx.repos.holding.findById(advice.subjectId);
        return holding?.accountId === accountId;
      }
      return false;
    }),
  );
  return advices.filter((_, index) => resolved[index]);
};
