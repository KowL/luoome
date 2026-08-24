import { dateInShanghai, type ProviderStatus, type WorkflowRun } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext, type WorkflowStep } from './define-workflow.js';

const DAY_MS = 86_400_000;

export const ACCOUNT_PERFORMANCE_HISTORY_DAYS = 365;
export const ACCOUNT_PERFORMANCE_MAX_HISTORY_DAYS = 3_660;
export const ACCOUNT_PERFORMANCE_MAX_ACCOUNTS = 1_000;

export const SnapshotAccountPerformanceInput = z
  .object({
    accountIds: z
      .array(z.string().min(1))
      .max(ACCOUNT_PERFORMANCE_MAX_ACCOUNTS)
      .transform((accountIds) => [...new Set(accountIds)])
      .optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    historyDays: z
      .number()
      .int()
      .positive()
      .max(ACCOUNT_PERFORMANCE_MAX_HISTORY_DAYS)
      .default(ACCOUNT_PERFORMANCE_HISTORY_DAYS),
    benchmarkStockId: z.string().min(1).optional(),
    mode: z.enum(['manual', 'scheduled', 'daemon']).default('scheduled'),
  })
  .refine((input) => input.from === undefined || input.to === undefined || input.from <= input.to, {
    message: 'from 不能晚于 to',
    path: ['from'],
  });

const SnapshotAccountPerformanceItem = z.object({
  accountId: z.string().min(1),
  from: z.string().date(),
  to: z.string().date(),
  status: z.enum(['complete', 'partial', 'unavailable', 'failed']),
  benchmarkStatus: z.enum(['available', 'partial', 'unavailable']).optional(),
  snapshotId: z.string().min(1).optional(),
  inputFingerprint: z.string().min(1).optional(),
  cacheStatus: z.enum(['created', 'reused']).optional(),
  calculationDurationMs: z.number().finite().nonnegative().optional(),
  priceSeries: z.number().int().nonnegative().optional(),
  dailyBars: z.number().int().nonnegative().optional(),
  errorKind: z.string().min(1).optional(),
});

export const SnapshotAccountPerformanceOutput = z.object({
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'partial', 'failed']),
  from: z.string().date(),
  to: z.string().date(),
  requestedAccounts: z.number().int().nonnegative(),
  completedAccounts: z.number().int().nonnegative(),
  partialAccounts: z.number().int().nonnegative(),
  failedAccounts: z.number().int().nonnegative(),
  createdSnapshots: z.number().int().nonnegative(),
  reusedSnapshots: z.number().int().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
  items: z.array(SnapshotAccountPerformanceItem),
});

export type SnapshotAccountPerformanceInputT = z.output<typeof SnapshotAccountPerformanceInput>;
export type SnapshotAccountPerformanceOutputT = z.output<typeof SnapshotAccountPerformanceOutput>;

const recordRun = async (ctx: WorkflowContext, run: WorkflowRun): Promise<void> => {
  const result = await ctx.tools.record_workflow_run.execute({ run });
  if (!result.ok) throw new Error(`record_workflow_run: ${result.error.kind}`);
};

const dateAtUtcMidnight = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

const rollingFrom = (to: string, historyDays: number): string =>
  new Date(dateAtUtcMidnight(to).getTime() - (historyDays - 1) * DAY_MS).toISOString().slice(0, 10);

const stepRun: WorkflowStep = async (prev, ctx) => {
  const input = prev as SnapshotAccountPerformanceInputT;
  const startedAt = ctx.clock();
  const startedMs = Date.now();
  const runId = `workflow-account-performance-${globalThis.crypto.randomUUID()}`;
  const to = input.to ?? dateInShanghai(startedAt);
  const requestedFrom = input.from ?? rollingFrom(to, input.historyDays);
  const running: WorkflowRun = {
    id: runId,
    workflowName: 'snapshot-account-performance',
    mode: input.mode,
    status: 'running',
    startedAt,
    inputSummary: {
      from: requestedFrom,
      to,
      historyDays: input.historyDays,
      accountSelection: input.accountIds === undefined ? 'all' : 'explicit',
      requestedAccountCount: input.accountIds?.length ?? null,
    },
    providerStatuses: [],
  };
  await recordRun(ctx, running);

  try {
    const listed = await ctx.tools.list_accounts.execute({});
    if (!listed.ok) throw new Error(`list_accounts: ${listed.error.kind}`);
    const selected =
      input.accountIds === undefined
        ? [...listed.data.accounts]
        : input.accountIds.map((id) => listed.data.accounts.find((account) => account.id === id));
    const missingIds =
      input.accountIds?.filter(
        (id) => !listed.data.accounts.some((account) => account.id === id),
      ) ?? [];
    const items: z.output<typeof SnapshotAccountPerformanceItem>[] = missingIds.map(
      (accountId) => ({
        accountId,
        from: requestedFrom,
        to,
        status: 'failed',
        errorKind: 'not_found',
      }),
    );
    const providerStatuses: ProviderStatus[] = missingIds.map((_, index) => ({
      provider: `account-${index + 1}`,
      ok: false,
      errorKind: 'not_found',
    }));

    for (const [index, account] of selected.entries()) {
      if (account === undefined) continue;
      const accountStart = dateInShanghai(account.createdAt);
      const from =
        accountStart > to ? to : accountStart > requestedFrom ? accountStart : requestedFrom;
      const result = await ctx.tools.get_account_performance.execute({
        accountId: account.id,
        from: dateAtUtcMidnight(from),
        to: dateAtUtcMidnight(to),
        ...(input.benchmarkStockId === undefined
          ? {}
          : { benchmarkStockId: input.benchmarkStockId }),
      });
      if (!result.ok) {
        items.push({
          accountId: account.id,
          from,
          to,
          status: 'failed',
          errorKind: result.error.kind,
        });
        providerStatuses.push({
          provider: `account-${missingIds.length + index + 1}`,
          ok: false,
          errorKind: result.error.kind,
        });
        continue;
      }
      const audit = result.data.audit;
      items.push({
        accountId: account.id,
        from,
        to,
        status: result.data.completeness,
        benchmarkStatus: result.data.benchmarkStatus,
        ...(audit?.snapshotId === undefined ? {} : { snapshotId: audit.snapshotId }),
        ...(audit?.inputFingerprint === undefined
          ? {}
          : { inputFingerprint: audit.inputFingerprint }),
        ...(audit?.cacheStatus === undefined ? {} : { cacheStatus: audit.cacheStatus }),
        ...(audit?.calculationDurationMs === undefined
          ? {}
          : { calculationDurationMs: audit.calculationDurationMs }),
        ...(audit?.inputFacts?.priceSeries === undefined
          ? {}
          : { priceSeries: audit.inputFacts.priceSeries }),
        ...(audit?.inputFacts?.dailyBars === undefined
          ? {}
          : { dailyBars: audit.inputFacts.dailyBars }),
      });
      providerStatuses.push({
        provider: `account-${missingIds.length + index + 1}`,
        ok: result.data.completeness === 'complete' && result.data.benchmarkStatus === 'available',
        ...(result.data.completeness === 'complete' && result.data.benchmarkStatus === 'available'
          ? {}
          : {
              errorKind: `portfolio-${result.data.completeness}-benchmark-${result.data.benchmarkStatus}`,
            }),
      });
    }

    const failedAccounts = items.filter((item) => item.status === 'failed').length;
    const partialAccounts = items.filter(
      (item) =>
        item.status === 'partial' ||
        item.status === 'unavailable' ||
        (item.status === 'complete' && item.benchmarkStatus !== 'available'),
    ).length;
    const completedAccounts = items.length - failedAccounts;
    const status: WorkflowRun['status'] =
      items.length > 0 && failedAccounts === items.length
        ? 'failed'
        : failedAccounts > 0 || partialAccounts > 0
          ? 'partial'
          : 'succeeded';
    const durationMs = Math.max(0, Date.now() - startedMs);
    const output = SnapshotAccountPerformanceOutput.parse({
      runId,
      status,
      from: requestedFrom,
      to,
      requestedAccounts: items.length,
      completedAccounts,
      partialAccounts,
      failedAccounts,
      createdSnapshots: items.filter((item) => item.cacheStatus === 'created').length,
      reusedSnapshots: items.filter((item) => item.cacheStatus === 'reused').length,
      durationMs,
      items,
    });
    await recordRun(ctx, {
      ...running,
      status,
      finishedAt: ctx.clock(),
      outputSummary: {
        from: output.from,
        to: output.to,
        requestedAccounts: output.requestedAccounts,
        completedAccounts: output.completedAccounts,
        partialAccounts: output.partialAccounts,
        failedAccounts: output.failedAccounts,
        createdSnapshots: output.createdSnapshots,
        reusedSnapshots: output.reusedSnapshots,
        durationMs: output.durationMs,
        maxAccountDurationMs: Math.max(0, ...items.map((item) => item.calculationDurationMs ?? 0)),
        priceSeries: items.reduce((total, item) => total + (item.priceSeries ?? 0), 0),
        dailyBars: items.reduce((total, item) => total + (item.dailyBars ?? 0), 0),
      },
      providerStatuses,
      ...(status === 'failed' ? { error: '全部账户绩效快照失败' } : {}),
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(ctx, {
      ...running,
      status: 'failed',
      finishedAt: ctx.clock(),
      error: message.slice(0, 500),
    });
    throw error;
  }
};

export const snapshotAccountPerformanceWorkflow = defineWorkflow<
  SnapshotAccountPerformanceInputT,
  SnapshotAccountPerformanceOutputT
>({
  name: 'snapshot-account-performance',
  description: '按账户持续生成可幂等复用、可修订追溯的绩效快照，并写入 WorkflowRun 审计',
  input: SnapshotAccountPerformanceInput,
  steps: [stepRun],
});
