import { dateInShanghai, isHoliday, isWeekend } from '@luoome/core';
import { z } from 'zod';

import { currentStrategyFingerprint, getAccountPlanBatchStatus } from './account-plan-batch.js';
import { closingReportStrategiesReady, closingReportWorkflow } from './closing-report.js';
import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { executeReportWorkflow } from './internal/report-runner.js';
import { unavailableSection } from './opening-report.js';

export const ClosingReportCutoffInput = z.object({ date: z.string().date().optional() });
export const ClosingReportCutoffOutput = z.object({
  date: z.string().date(),
  created: z.array(z.string()),
  failed: z.array(z.string()),
});
export type ClosingReportCutoffOutputT = z.infer<typeof ClosingReportCutoffOutput>;

const historicalGapSections = [
  ['market-pulse', '市场脉搏'],
  ['account-performance', '账户当日估值变化'],
  ['important-triggers', '重要预警'],
  ['strategy-actions', '策略行动'],
  ['trading-plans', '交易计划'],
  ['prior-day-review', '前一交易日复盘'],
] as const;

const run: WorkflowStep = async (previous, ctx) => {
  const input = previous as z.infer<typeof ClosingReportCutoffInput>;
  const now = ctx.clock();
  const date = input.date ?? dateInShanghai(now);
  const cutoff = new Date(`${date}T18:00:00+08:00`);
  const planStart = new Date(`${date}T16:30:00+08:00`);
  const created: string[] = [];
  const failed: string[] = [];
  if (now < planStart || isWeekend(cutoff) || isHoliday(cutoff)) return { date, created, failed };
  const accounts = await ctx.tools.list_accounts.execute({});
  if (!accounts.ok) return accounts;
  const fingerprint =
    date === dateInShanghai(now) ? await currentStrategyFingerprint(date, ctx) : null;
  const strategiesReady =
    date !== dateInShanghai(now) || (await closingReportStrategiesReady(date, now, ctx));
  const outcomes: Array<'created' | 'failed' | 'existing'> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < accounts.data.accounts.length) {
      const index = next++;
      const account = accounts.data.accounts[index];
      if (account === undefined) break;
      const scope = { kind: 'account' as const, accountId: account.id };
      const existing = await ctx.tools.get_report.execute({
        kind: 'closing',
        scope,
        periodEnd: date,
      });
      if (existing.ok) {
        if (existing.data.report.deliveryStatus === 'sent') {
          outcomes[index] = 'existing';
        } else {
          const retry = await closingReportWorkflow.run(
            { date, scope, mode: 'scheduled', notify: true },
            ctx,
          );
          outcomes[index] = retry.ok ? 'existing' : 'failed';
        }
        continue;
      }
      if (existing.error.kind !== 'not_found') {
        outcomes[index] = 'failed';
        continue;
      }
      if (!strategiesReady) {
        outcomes[index] = 'existing';
        continue;
      }
      if (account.createdAt > cutoff) {
        outcomes[index] = 'existing';
        continue;
      }
      if (date !== dateInShanghai(now)) {
        const recovered = await executeReportWorkflow(
          {
            workflowName: 'closing-report',
            kind: 'closing',
            template: 'closing-historical-gap-v1',
            mode: 'scheduled',
            notify: true,
            scope,
            periodStart: date,
            periodEnd: date,
            title: `${date} 收盘复盘（逾期缺口补记）`,
            inputSummary: { marketDate: date, historicalSnapshotUnavailable: true },
            buildSections: async (generatedAt) => {
              const explanation = `${date} 截止时未留存主报告；本版仅补记缺口。历史行情、账户和计划快照不可重建，不使用当前数据代替。`;
              const historicalUnavailable = (key: string, title: string, dimension: string) => {
                const piece = unavailableSection(
                  key,
                  title,
                  true,
                  generatedAt,
                  dimension,
                  'historical_snapshot_unavailable',
                );
                return {
                  ...piece,
                  section: {
                    ...piece.section,
                    missingDimensions: piece.section.missingDimensions.map((gap) => ({
                      ...gap,
                      retryable: false,
                    })),
                  },
                };
              };
              const marker = historicalUnavailable(
                'historical-recovery',
                '逾期补记说明',
                'historical-recovery',
              );
              return [
                {
                  ...marker,
                  section: {
                    ...marker.section,
                    blocks: [
                      { kind: 'text' as const, tone: 'warning' as const, text: explanation },
                    ],
                    missingDimensions: marker.section.missingDimensions.map((gap) => ({
                      ...gap,
                      reason: explanation,
                    })),
                  },
                },
                ...historicalGapSections.map(([key, title]) =>
                  historicalUnavailable(key, title, `${key}.historical-snapshot`),
                ),
              ];
            },
          },
          ctx,
        );
        outcomes[index] =
          'report' in recovered ? (recovered.created ? 'created' : 'existing') : 'failed';
        continue;
      }
      const facts = await ctx.tools.get_account_facts.execute({ accountId: account.id });
      const planBatchStatus = await getAccountPlanBatchStatus(
        account.id,
        date,
        fingerprint,
        facts.ok ? facts.data.facts.digest : null,
        ctx,
      );
      if (planBatchStatus === 'blocked') {
        outcomes[index] = 'existing';
        continue;
      }
      const report = await closingReportWorkflow.run(
        { date, scope, mode: 'scheduled', planBatchStatus },
        ctx,
      );
      outcomes[index] = report.ok ? (report.data.created ? 'created' : 'existing') : 'failed';
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, accounts.data.accounts.length) }, () => worker()),
  );
  for (const [index, account] of accounts.data.accounts.entries()) {
    if (outcomes[index] === 'created') created.push(account.id);
    if (outcomes[index] === 'failed') failed.push(account.id);
  }
  return { date, created, failed };
};

export const closingReportCutoffWorkflow = defineWorkflow<
  z.infer<typeof ClosingReportCutoffInput>,
  ClosingReportCutoffOutputT
>({
  name: 'closing-report-cutoff',
  description: '等待当日策略与账户计划批次完成后统一发布每账户的一份收盘报告',
  input: ClosingReportCutoffInput,
  steps: [run],
});
