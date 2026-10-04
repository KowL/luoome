import { describe, expect, it } from 'bun:test';
import { money, quantity, ReportSchema } from '@luoome/core';
import { createDrizzleRepos } from '../client.js';
import { createInMemoryRepos } from './memory/index.js';

for (const mode of ['memory', 'drizzle'] as const) {
  describe(`DecisionReviewRepository [${mode}]`, () => {
    it('atomically appends a never report supplement and persists its request receipt', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const now = new Date('2026-09-04T10:00:00Z');
        const main = ReportSchema.parse({
          id: 'report-main',
          version: 1,
          kind: 'closing',
          scope: { kind: 'account', accountId: 'account-1' },
          periodStart: '2026-09-03',
          periodEnd: '2026-09-03',
          title: '主版',
          generatedAt: now,
          dataAsOf: now,
          status: 'complete',
          sections: [
            {
              key: 'original',
              title: '原版',
              required: true,
              status: 'complete',
              blocks: [{ kind: 'text', text: '原始事实' }],
              evidenceIds: [],
              missingDimensions: [],
            },
          ],
          evidence: [],
          missingDimensions: [],
          deliveryStatus: 'sent',
          workflowRunId: 'workflow-main',
          createdAt: now,
          updatedAt: now,
        });
        await repos.report.upsertForPeriod(main);
        const supplement = ReportSchema.parse({
          ...main,
          id: 'report-supplement',
          version: 2,
          supersedesReportId: main.id,
          title: '补充版',
          notificationPolicy: 'never',
          deliveryStatus: 'not-requested',
          decisionReviewSnapshot: {
            schemaVersion: 1,
            accountId: 'account-1',
            periodStart: main.periodStart,
            periodEnd: main.periodEnd,
            throughSequence: 0,
            revisionIds: [],
            tradeFactHashes: {},
            inputFingerprint: 'a'.repeat(64),
          },
        });
        const input = {
          report: supplement,
          expectedLatestReportId: main.id,
          requestId: 'request-report-1',
          requestHash: 'hash-report-1',
        };
        const first = await repos.report.appendDecisionReviewSupplement(input);
        expect(first).toMatchObject({ created: true, replayed: false });
        const replay = await repos.report.appendDecisionReviewSupplement(input);
        expect(replay).toMatchObject({ created: false, replayed: true });
        expect(
          (
            await repos.report.findRefreshReceipt({
              accountId: 'account-1',
              requestId: input.requestId,
            })
          )?.report.id,
        ).toBe(supplement.id);
        expect(
          await repos.report.claimDelivery({
            id: supplement.id,
            attemptId: 'forbidden',
            now,
            stalePendingBefore: now,
            failedRetryBefore: now,
          }),
        ).toBe(false);
        await expect(
          repos.report.appendDecisionReviewSupplement({ ...input, requestId: 'request-report-2' }),
        ).rejects.toThrow('latest version changed');
      } finally {
        handle?.close();
      }
    });

    it('commits trade, cash, holding and receipt as one decision write', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const opened = new Date('2026-09-01T00:00:00Z');
        await repos.account.save({
          id: 'acc-trade',
          name: '测试',
          kind: 'real',
          currency: 'CNY',
          initialCapital: money(1000),
          cashBalance: money(1000),
          createdAt: opened,
        });
        const state = await repos.decisionTrade.getLedgerState('acc-trade');
        expect(state?.appendEligibility).toBe('eligible');
        if (state === null) return;
        const at = new Date('2026-09-02T00:00:00Z');
        const trade = {
          id: 'trade-new',
          accountId: 'acc-trade',
          stockId: '002594.SZ',
          side: 'buy' as const,
          quantity: quantity(2),
          price: money(100),
          fee: money(1),
          executedAt: at,
          createdAt: at,
          source: 'manual' as const,
        };
        const holding = {
          id: 'holding-new',
          accountId: 'acc-trade',
          stockId: trade.stockId,
          quantity: 2,
          availableQuantity: 2,
          avgCost: money(100),
          openedAt: at,
          closedAt: null,
        };
        const input = {
          accountId: 'acc-trade',
          requestId: 'request-trade',
          requestHash: 'hash-trade',
          expectedLedgerStateHash: state.hash,
          previousHolding: null,
          trade,
          holding,
          changes: [],
        };
        const first = await repos.decisionTrade.commitTrade(input);
        expect(first.result.account.cashBalance).toBe(money(800));
        const replay = await repos.decisionTrade.commitTrade(input);
        expect(replay.replayed).toBe(true);
        expect(await repos.trade.listByAccount('acc-trade')).toHaveLength(1);
        expect((await repos.account.findById('acc-trade'))?.cashBalance).toBe(money(800));
      } finally {
        handle?.close();
      }
    });
    it('keeps account revisions immutable and request retries idempotent', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        const subject = { kind: 'advice' as const, id: 'advice-1' };
        const review = {
          id: 'review-1',
          accountId: 'account-1',
          subject,
          stockId: '002594.SZ',
          sourceOccurredAt: new Date('2026-09-01T00:00:00Z'),
          context: {
            schemaVersion: 1 as const,
            capturedAt: new Date('2026-09-02T00:00:00Z'),
            sourceDataAsOf: null,
            captureOrigin: 'user' as const,
            source: { id: 'advice-1' },
            contextHash: 'hash-1',
          },
          createdAt: new Date('2026-09-02T00:00:00Z'),
        };
        const content = {
          tradeIds: [],
          adviceFeedback: { outcome: 'followed' as const },
          triggerFeedback: null,
          note: null,
        };
        const firstInput = {
          accountId: review.accountId,
          requestId: 'request-1',
          requestHash: 'request-hash-1',
          expectedRevision: 0,
          review,
          content,
          contentHash: 'content-hash-1',
          tradeFactHashes: {},
          changeNote: null,
          recordedAt: new Date('2026-09-02T00:00:00Z'),
        };
        const first = await repos.decisionReview.commit(firstInput);
        expect(first.result.revision.revision).toBe(1);
        const replay = await repos.decisionReview.commit(firstInput);
        expect(replay.replayed).toBe(true);
        expect(replay.result.revision.sequence).toBe(first.result.revision.sequence);
        expect(
          await repos.decisionReview.findBySubject({ accountId: 'account-2', subject }),
        ).toBeNull();
        await expect(
          repos.decisionReview.commit({
            ...firstInput,
            requestId: 'request-2',
            contentHash: 'changed',
          }),
        ).rejects.toThrow();
        const second = await repos.decisionReview.commit({
          ...firstInput,
          requestId: 'request-3',
          requestHash: 'request-hash-3',
          expectedRevision: 1,
          content: { ...content, note: '更正' },
          contentHash: 'content-hash-2',
        });
        expect(second.result.revision.revision).toBe(2);
        const activity = await repos.decisionReview.listActivity({
          accountId: 'account-1',
          since: new Date('2026-09-02T00:00:00Z'),
          until: new Date('2026-09-03T00:00:00Z'),
          limit: 1,
        });
        expect(activity.map((item) => item.revision.revision)).toEqual([2]);
        const olderActivity = await repos.decisionReview.listActivity({
          accountId: 'account-1',
          since: new Date('2026-09-02T00:00:00Z'),
          until: new Date('2026-09-03T00:00:00Z'),
          cursor: {
            recordedAt: activity[0]!.revision.recordedAt,
            sequence: activity[0]!.revision.sequence,
          },
          limit: 1,
        });
        expect(olderActivity.map((item) => item.revision.revision)).toEqual([1]);
        const old = await repos.decisionReview.findById({
          accountId: 'account-1',
          id: review.id,
          revision: 1,
        });
        expect(old?.revision.content.note).toBeNull();
        expect(
          (
            await repos.decisionReview.listRevisions({
              accountId: 'account-1',
              reviewId: review.id,
            })
          ).map((r) => r.revision),
        ).toEqual([2, 1]);
        expect(await repos.decisionReview.latestSequence('account-1')).toBe(
          second.result.revision.sequence,
        );
        const frozen = await repos.decisionReview.list({
          accountId: 'account-1',
          throughSequence: first.result.revision.sequence,
          since: new Date('2026-09-01T00:00:00Z'),
          until: new Date('2026-09-02T00:00:00Z'),
        });
        expect(frozen.map((item) => item.revision.revision)).toEqual([1]);
        const olderReview = {
          ...review,
          id: 'review-older',
          subject: { kind: 'advice' as const, id: 'advice-older' },
          sourceOccurredAt: new Date('2026-08-31T00:00:00Z'),
        };
        await repos.decisionReview.commit({
          ...firstInput,
          review: olderReview,
          requestId: 'request-older',
          requestHash: 'request-hash-older',
        });
        const firstPage = await repos.decisionReview.list({ accountId: 'account-1', limit: 1 });
        expect(firstPage.map((item) => item.review.id)).toEqual([review.id]);
        const nextPage = await repos.decisionReview.list({
          accountId: 'account-1',
          limit: 1,
          cursor: {
            occurredAt: firstPage[0]!.review.sourceOccurredAt,
            id: firstPage[0]!.review.id,
          },
        });
        expect(nextPage.map((item) => item.review.id)).toEqual([olderReview.id]);
        await repos.trade.save({
          id: 'trade-stale',
          accountId: 'account-1',
          stockId: '002594.SZ',
          side: 'buy',
          quantity: quantity(1),
          price: money(10),
          fee: money(0),
          executedAt: new Date('2026-09-03T00:00:00Z'),
          createdAt: new Date('2026-09-03T00:00:00Z'),
          source: 'manual',
        });
        await expect(
          repos.decisionReview.commit({
            ...firstInput,
            requestId: 'request-stale',
            requestHash: 'request-hash-stale',
            expectedRevision: 2,
            content: { ...content, tradeIds: ['trade-stale'] },
            contentHash: 'content-hash-stale',
            tradeFactHashes: { 'trade-stale': 'old-trade-fact' },
          }),
        ).rejects.toThrow('关联成交事实已变化');
        expect(
          (await repos.decisionReview.findBySubject({ accountId: 'account-1', subject }))?.review
            .currentRevision,
        ).toBe(2);
      } finally {
        handle?.close();
      }
    });
  });
}
