import { createHash, randomUUID } from 'node:crypto';

import { dateInShanghai } from '@luoome/core';

import type { WorkflowContext } from './define-workflow.js';
import { tradingPlanDailyCycleWorkflow } from './trading-plan-daily-cycle.js';

export type AccountPlanBatchStatus = 'complete' | 'partial' | 'blocked';
export type AccountPlanBatchResult = {
  readonly status: AccountPlanBatchStatus;
  readonly newlyFinished: boolean;
};

const batchId = (
  accountId: string,
  date: string,
  strategyFingerprint: string,
  accountFactsDigest: string,
): string =>
  `account-plan-batch:${date}:${accountId}:${createHash('sha256')
    .update(`${strategyFingerprint}:${accountFactsDigest}`)
    .digest('hex')
    .slice(0, 16)}`;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const currentStrategyFingerprint = async (
  date: string,
  ctx: WorkflowContext,
): Promise<string | null> => {
  const since = new Date(`${date}T00:00:00+08:00`);
  const until = new Date(since.getTime() + 24 * 60 * 60_000 - 1);
  const runs = await ctx.tools.list_strategy_runs.execute({
    scope: 'operational',
    publication: 'published',
    since,
    until,
    limit: 500,
  });
  if (!runs.ok) return null;
  if (runs.data.runs.length === 500) return null;
  const ids = runs.data.runs
    .filter((run) => dateInShanghai(run.startedAt) === date)
    .map((run) => run.id)
    .sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
};

export const getAccountPlanBatchStatus = async (
  accountId: string,
  date: string,
  strategyFingerprint: string | null,
  accountFactsDigest: string | null,
  ctx: WorkflowContext,
): Promise<AccountPlanBatchStatus> => {
  if (strategyFingerprint === null || accountFactsDigest === null) return 'blocked';
  const result = await ctx.tools.get_account_plan_batch.execute({
    id: batchId(accountId, date, strategyFingerprint, accountFactsDigest),
  });
  if (!result.ok || result.data.run === null) return 'blocked';
  const run = result.data.run;
  if (run.status === 'running' || run.status === 'failed') return 'blocked';
  const status = run.outputSummary?.status;
  return status === 'complete' || status === 'partial' ? status : 'blocked';
};

export const runAccountPlanBatch = async (
  accountId: string,
  date: string,
  strategyFingerprint: string,
  accountFactsDigest: string,
  ctx: WorkflowContext,
): Promise<AccountPlanBatchResult> => {
  const id = batchId(accountId, date, strategyFingerprint, accountFactsDigest);
  const startedAt = ctx.clock();
  const claimToken = randomUUID();
  const inputSummary = { accountId, date, strategyFingerprint, accountFactsDigest, claimToken };
  const claim = await ctx.tools.begin_account_plan_batch.execute({
    run: {
      id,
      workflowName: 'account-plan-batch',
      mode: 'scheduled',
      status: 'running',
      startedAt,
      inputSummary,
      providerStatuses: [],
    },
  });
  if (!claim.ok) return { status: 'blocked', newlyFinished: false };
  if (!claim.data.claimed)
    return {
      status: await getAccountPlanBatchStatus(
        accountId,
        date,
        strategyFingerprint,
        accountFactsDigest,
        ctx,
      ),
      newlyFinished: false,
    };

  let status: AccountPlanBatchStatus = 'blocked';
  let error: string | undefined;
  let outputSummary: Record<string, unknown>;
  try {
    const result = await tradingPlanDailyCycleWorkflow.run({ accountId, date }, ctx);
    if (!result.ok) {
      error = errorText(result.error);
      outputSummary = { status: 'blocked', error };
    } else {
      status = result.data.status;
      if (result.data.accountFactsDigest !== accountFactsDigest) {
        status = 'blocked';
        error = 'account_facts_changed_during_batch';
      }
      if (status === 'blocked')
        error ??= result.data.errors[0]?.reason ?? 'account_plan_batch_blocked';
      outputSummary = {
        status,
        holdingReviews: result.data.holdingReviews,
        candidateReviews: result.data.candidateReviews,
        planCount: result.data.plans.length,
        errors: result.data.errors,
      };
    }
  } catch (cause) {
    error = errorText(cause);
    outputSummary = { status: 'blocked', error };
  }
  const finishedAt = new Date(Math.max(ctx.clock().getTime(), startedAt.getTime()));
  const finished = await ctx.tools.finish_account_plan_batch.execute({
    claimToken,
    run: {
      id,
      workflowName: 'account-plan-batch',
      mode: 'scheduled',
      status: error === undefined ? (status === 'complete' ? 'succeeded' : 'partial') : 'failed',
      startedAt,
      finishedAt,
      inputSummary,
      outputSummary,
      providerStatuses: [],
      ...(error === undefined ? {} : { error: error.slice(0, 500) }),
    },
  });
  if (!finished.ok || !finished.data.finished) return { status: 'blocked', newlyFinished: false };
  return { status, newlyFinished: true };
};
