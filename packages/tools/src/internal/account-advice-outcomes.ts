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
            // 存量修订没有 origin：保持缺省，让统计侧能把它单列为 unattested，
            // 而不是悄悄算成用户回填。
            ...(feedback.origin === undefined ? {} : { origin: feedback.origin }),
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

/** 本账户「advice 类」DecisionReview 覆盖的 subject id 集合。 */
export const accountAdviceReviewIds = async (
  ctx: ToolContext,
  accountId: string,
): Promise<ReadonlySet<string>> => {
  const records = await ctx.repos.decisionReview.list({
    accountId,
    subjectKind: 'advice',
    limit: 10000,
  });
  return new Set(records.map(({ review }) => review.subject.id));
};

/**
 * 单条建议的归属判定。
 *
 * - `this-account`：本账户认领（`basedOn.strategy.accountId` 或本账户的 DecisionReview）。
 * - `other-account`：**明确**属于另一个账户（strategy 快照写了别的账户 / portfolio 建议指向别的账户 /
 *   持仓属于别的账户）。
 * - `undetermined`：**只**出现在「stock 建议 + 既无 `basedOn.strategy.accountId`、也无
 *   `provenance.contextId`、本账户也没有 review」——真正的存量无归属行。
 *   它可能被其它账户的 review 认领，需要 `otherAccountAdviceReviewIds` 再判一次。
 * - `unscoped`：没有任何账户能认领（持仓已不存在 / 未知 subjectKind）。
 *
 * 把 `undetermined` 与 `unscoped` 分开是必要的：前者可能是「别人的建议」（正常过滤），
 * 后者才是「谁都不认的存量建议」（必须**数量披露**，不许静默丢弃）。
 */
export type AdviceAttribution = 'this-account' | 'other-account' | 'undetermined' | 'unscoped';

export const adviceAttribution = async (
  ctx: ToolContext,
  accountId: string,
  advice: Advice,
  accountReviewIds: ReadonlySet<string>,
): Promise<AdviceAttribution> => {
  if (accountReviewIds.has(advice.id)) return 'this-account';
  // 1) strategy 快照里写了账户归属（策略候选建议）。
  const owner = advice.basedOn.strategy?.accountId;
  if (owner !== undefined) return owner === accountId ? 'this-account' : 'other-account';
  // 2) portfolio 建议：`subjectId` 就是账户 id。
  if (advice.subjectKind === 'portfolio')
    return advice.subjectId === accountId ? 'this-account' : 'other-account';
  // 3) position 建议：持仓归属。
  if (advice.subjectKind === 'position') {
    const holding = await ctx.repos.holding.findById(advice.subjectId);
    if (holding === null) return 'unscoped';
    return holding.accountId === accountId ? 'this-account' : 'other-account';
  }
  // 4) 其余（stock / market / sector …）：`record_advice` 是把建议写进**某个账户的**
  //    analysis context，context 的归属就是建议的归属（`provenance.contextId`，见 queue/record.ts）。
  //    没有这条，分析面刚写回的建议在 read 面读不回来——那是把「有归属」说成「无归属」。
  const contextId = advice.provenance?.contextId;
  if (contextId !== undefined) {
    const context = await ctx.repos.analysis.findContext(accountId, contextId);
    // 有 context id 说明写入时**有**归属：解析不到本账户就是别的账户的。
    return context === null ? 'other-account' : 'this-account';
  }
  // 5) 没有任何归属信号。stock 建议可能被**其它账户**的复盘记录认领，需要再判一次；
  //    其余 subjectKind 直接判「谁都不认」。
  return advice.subjectKind === 'stock' ? 'undetermined' : 'unscoped';
};

/**
 * 其它账户的 advice review 覆盖的 subject id 集合。
 *
 * `DecisionReviewRepository.list` 的 `accountId` 是**必填**的，所以「全库认领集」只能按账户枚举。
 * 只在该账户真的存在 `undetermined` 建议时才调用（见 `selectAdvices`），常见路径零额外查询。
 */
export const otherAccountAdviceReviewIds = async (
  ctx: ToolContext,
  accountId: string,
): Promise<ReadonlySet<string>> => {
  const accounts = await ctx.repos.account.list();
  const others = accounts.filter((account) => account.id !== accountId);
  const sets = await Promise.all(others.map((account) => accountAdviceReviewIds(ctx, account.id)));
  return new Set(sets.flatMap((set) => [...set]));
};

export const accountScopedAdvices = async (
  ctx: ToolContext,
  accountId: string,
  advices: readonly Advice[],
): Promise<Advice[]> => {
  const accountReviewIds = await accountAdviceReviewIds(ctx, accountId);
  const classified = await Promise.all(
    advices.map((advice) => adviceAttribution(ctx, accountId, advice, accountReviewIds)),
  );
  return advices.filter((_, index) => classified[index] === 'this-account');
};
