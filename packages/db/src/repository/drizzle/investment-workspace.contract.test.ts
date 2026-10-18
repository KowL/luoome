import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvestmentConsensusSchema,
  InvestmentResearchSchema,
  InvestmentTrackingSchema,
  type InvestmentWorkspaceRepository,
  investmentMarketEvidenceValidUntil,
  money,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { createInMemoryRepos } from '../memory/index.js';

const now = new Date('2026-10-16T08:00:00Z');
const owner = { ownerUserId: 'user-one', accountId: 'account-one' };
const consensus = (version = 1) =>
  InvestmentConsensusSchema.parse({
    id: `consensus-${version}`,
    ...owner,
    version,
    supersedesId: version === 1 ? null : `consensus-${version - 1}`,
    status: 'confirmed',
    selections: [],
    constraints: ['不自动交易'],
    recentIntent: null,
    source: { userText: '先管理持仓' },
    changeNote: '明确确认',
    effectScope: 'future-research-only',
    reviewAt: new Date('2026-10-19T08:00:00Z'),
    validUntil: new Date('2026-10-23T08:00:00Z'),
    createdAt: now,
  });
const research = () =>
  InvestmentResearchSchema.parse({
    id: 'research-one',
    ...owner,
    requestId: 'research-request',
    requestHash: 'hash-research',
    question: '研究当前方向',
    status: 'unavailable',
    source: { userText: '研究当前方向' },
    directions: [],
    evidence: [],
    limitations: ['没有已发布事实'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    createdAt: now,
  });
const tracking = (requestId = 'tracking-request') =>
  InvestmentTrackingSchema.parse({
    id: `attempt-${requestId}`,
    ...owner,
    consensusVersion: 1,
    requestId,
    requestHash: `hash-${requestId}`,
    action: 'start',
    status: 'starting',
    items: [],
    startedAt: now,
    finishedAt: null,
  });

const marketResearch = () => {
  const source = {
    kind: 'market-snapshot',
    snapshotId: 'actual-snapshot',
    subject: 'market-breadth',
  };
  const provenance = [
    { provider: 'injected-contract-source', observedAt: now, fetchedAt: now, freshness: 'fresh' },
  ];
  const unavailable = {
    status: 'unavailable',
    provenance: [
      { provider: 'not-configured', observedAt: now, fetchedAt: now, freshness: 'unavailable' },
    ],
    warnings: [],
  };
  const value = { total: 100, advancing: 50, declining: 40, unchanged: 10 };
  return InvestmentResearchSchema.parse({
    ...research(),
    id: 'market-research',
    requestId: 'market-request',
    status: 'complete',
    marketSnapshot: {
      id: source.snapshotId,
      snapshot: {
        date: '2026-10-16',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: now,
        breadth: { status: 'complete', value, provenance, warnings: [] },
        indexes: unavailable,
        limitUp: unavailable,
        themes: unavailable,
      },
    },
    evidence: [
      {
        id: 'breadth-fact',
        source,
        dataAsOf: now,
        kind: 'market-breadth',
        text: '已记录100只股票的涨跌分布',
        value,
        provenance,
      },
    ],
    directions: [
      {
        id: 'market-direction',
        name: '广度观察',
        opportunityType: 'market-participation',
        source,
        coverage: {
          kind: 'market-facts',
          scope: 'CN_A_SHARES_SH_SZ',
          observedCount: 100,
          unit: 'stocks',
          dataHealth: 'complete',
          description: '实际快照100只',
        },
        rank: 1,
        stance: 'observe',
        rationale: '只观察市场分布',
        comparisonReason: '只描述该快照，不推断收益',
        evidenceIds: ['breadth-fact'],
        objections: [
          {
            kind: 'known-risk',
            conclusion: '不支持直接买入',
            evidenceIds: ['breadth-fact'],
            risks: ['广度不能替代个股判断'],
            unknowns: ['公司事件'],
            reconsiderWhen: ['取得具体事实'],
            alternatives: ['继续讨论'],
          },
        ],
        risks: ['市场可能反转'],
        waitFor: ['新事实'],
        abandonWhen: ['事实反转'],
        reviewWhen: ['新交易日'],
        horizon: 'short',
        accountFit: 'research-only',
        dataAsOf: now,
        validUntil: investmentMarketEvidenceValidUntil(now),
        tracking: { eligible: false, reason: '没有策略与股票候选映射' },
      },
    ],
  });
};

for (const mode of ['memory', 'drizzle'] as const) {
  describe(`InvestmentWorkspaceRepository [${mode}]`, () => {
    const fixture = () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      return { repo: repos.investmentWorkspace, repos, close: () => handle?.close() };
    };
    const commit = (repo: InvestmentWorkspaceRepository, version = 1) =>
      repo.commitConsensus({
        consensus: consensus(version),
        expectedVersion: version - 1,
        requestId: `confirm-${version}`,
        requestHash: `hash-${version}`,
      });

    it('isolates owners and accounts before limiting, and retains immutable research on retry', async () => {
      const { repo, close } = fixture();
      try {
        const input = research();
        await repo.createResearch(input);
        expect(await repo.createResearch({ ...input, id: 'ignored' })).toEqual(input);
        await expect(repo.createResearch({ ...input, requestHash: 'changed' })).rejects.toThrow(
          'request_id_conflict',
        );
        expect(await repo.findResearch({ ...owner, id: input.id })).toEqual(input);
        expect(
          await repo.findResearch({ ...owner, ownerUserId: 'other', id: input.id }),
        ).toBeNull();
        expect(await repo.listResearch({ ...owner, accountId: 'other', limit: 1 })).toEqual([]);
        const copy = await repo.findResearch({ ...owner, id: input.id });
        copy?.limitations.push('local mutation');
        expect((await repo.findResearch({ ...owner, id: input.id }))?.limitations).toEqual([
          '没有已发布事实',
        ]);
      } finally {
        close();
      }
    });

    it('round-trips market evidence, observation times and non-trackable confirmed directions without fake strategy identities', async () => {
      const { repo, close } = fixture();
      try {
        const data = marketResearch();
        await repo.createResearch(data);
        expect(await repo.findResearch({ ...owner, id: data.id })).toEqual(data);
        const direction = data.directions[0];
        if (direction === undefined) throw new Error('fixture');
        const confirmed = {
          ...consensus(),
          selections: [
            {
              researchId: data.id,
              directionId: direction.id,
              role: 'primary' as const,
              userReason: '只确认讨论范围',
              direction,
            },
          ],
        };
        await repo.commitConsensus({
          consensus: confirmed,
          expectedVersion: 0,
          requestId: 'market-confirm',
          requestHash: 'market-confirm-hash',
        });
        const stored = (await repo.listConsensus({ ...owner, limit: 1 }))[0];
        expect(stored).toEqual(confirmed);
        expect(stored?.selections[0]?.direction).not.toHaveProperty('strategyId');
        expect(stored?.selections[0]?.direction).not.toHaveProperty('runId');
      } finally {
        close();
      }
    });

    it('keeps legacy real strategy direction payloads readable and confirmable with unchanged identities', async () => {
      const { repo, close } = fixture();
      try {
        const market = marketResearch();
        const example = market.directions[0];
        if (example?.opportunityType !== 'market-participation') throw new Error('fixture');
        const { source: _source, tracking: _tracking, ...common } = example;
        const legacy = InvestmentResearchSchema.parse({
          ...research(),
          status: 'complete',
          evidence: [
            {
              id: 'breadth-fact',
              strategyId: 'real-strategy',
              strategyVersionId: 'real-version',
              runId: 'real-run',
              dataAsOf: now,
              kind: 'coverage',
              text: '真实策略运行覆盖',
            },
          ],
          directions: [
            {
              ...common,
              opportunityType: 'strategy-selection',
              strategyId: 'real-strategy',
              strategyVersionId: 'real-version',
              runId: 'real-run',
              coverage: {
                kind: 'explicit-subset',
                universeCount: 100,
                evaluatedCount: 100,
                selectedCount: 3,
                dataHealth: 'complete',
                description: '真实策略子集',
              },
            },
          ],
        });
        await repo.createResearch(legacy);
        expect(await repo.findResearch({ ...owner, id: legacy.id })).toEqual(legacy);
        const direction = legacy.directions[0];
        if (direction === undefined) throw new Error('fixture');
        await repo.commitConsensus({
          consensus: {
            ...consensus(),
            selections: [
              {
                researchId: legacy.id,
                directionId: direction.id,
                role: 'observe',
                userReason: '沿用真实策略',
                direction,
              },
            ],
          },
          expectedVersion: 0,
          requestId: 'legacy-confirm',
          requestHash: 'legacy-hash',
        });
        expect(
          (await repo.listConsensus({ ...owner, limit: 1 }))[0]?.selections[0]?.direction,
        ).toMatchObject({
          opportunityType: 'strategy-selection',
          strategyId: 'real-strategy',
          runId: 'real-run',
        });
      } finally {
        close();
      }
    });

    it('atomically compares versions, preserves prior revisions and returns original receipts', async () => {
      const { repo, close } = fixture();
      try {
        const first = await commit(repo);
        const outcomes = await Promise.allSettled([
          commit(repo, 2),
          repo.commitConsensus({
            consensus: { ...consensus(2), id: 'concurrent' },
            expectedVersion: 1,
            requestId: 'concurrent',
            requestHash: 'concurrent',
          }),
        ]);
        expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const replay = await commit(repo);
        expect(replay).toEqual({ ...first, replayed: true });
        expect(await repo.listConsensus({ ...owner, limit: 1 })).toHaveLength(1);
        expect(
          (await repo.listConsensus({ ...owner, limit: 10 })).map((item) => item.version),
        ).toEqual([2, 1]);
        expect(await repo.listConsensus({ ...owner, ownerUserId: 'other', limit: 10 })).toEqual([]);
        await expect(
          repo.commitConsensus({
            consensus: consensus(1),
            expectedVersion: 0,
            requestId: 'confirm-1',
            requestHash: 'changed',
          }),
        ).rejects.toThrow('request_id_conflict');
      } finally {
        close();
      }
    });

    it('only one tracking attempt can run; stale confirmation and terminal replay cannot mutate it', async () => {
      const { repo, close } = fixture();
      try {
        await commit(repo);
        const attempt = tracking();
        expect((await repo.claimTracking(attempt)).replayed).toBe(false);
        expect((await repo.claimTracking(attempt)).replayed).toBe(true);
        await expect(repo.claimTracking(tracking('second'))).rejects.toThrow(
          'tracking_in_progress',
        );
        await expect(commit(repo, 2)).rejects.toThrow('tracking_in_progress');
        expect(await repo.listTracking({ ...owner, accountId: 'other' })).toEqual([]);
        await repo.finishTracking({ ...attempt, status: 'failed', finishedAt: now });
        await expect(
          repo.finishTracking({ ...attempt, status: 'tracking', finishedAt: now }),
        ).rejects.toThrow('tracking_claim_conflict');
        expect((await repo.claimTracking(attempt)).tracking.status).toBe('failed');
        const retry = tracking('retry');
        await repo.claimTracking(retry);
        await repo.finishTracking({ ...retry, status: 'paused', finishedAt: now });
        expect((await repo.listTracking(owner))[0]?.id).toBe(retry.id);
        await commit(repo, 2);
        await expect(repo.claimTracking(tracking('stale'))).rejects.toThrow(
          'consensus_version_conflict',
        );
      } finally {
        close();
      }
    });

    it('persists exact consensus authorization on strategy subscriptions through reads and cancellation', async () => {
      const { repo, repos, close } = fixture();
      try {
        const saved = await commit(repo);
        const subscription = {
          id: 'bound-subscription',
          strategyId: 'strategy-one',
          watchlistId: 'investment-one',
          sourceKey: 'strategy:strategy-one',
          status: 'active' as const,
          createdBy: owner.ownerUserId,
          createdAt: now,
          updatedAt: now,
          investmentBinding: {
            ...owner,
            consensusId: saved.consensus.id,
            consensusVersion: 1,
            strategyVersionId: 'strategy-one-v1',
          },
        };
        await repos.strategyWatchlistSubscription.save(subscription);
        expect(await repos.strategyWatchlistSubscription.findById(subscription.id)).toEqual(
          subscription,
        );
        await repos.strategyWatchlistSubscription.save({
          ...subscription,
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: owner.ownerUserId,
        });
        expect(
          (await repos.strategyWatchlistSubscription.findById(subscription.id))?.investmentBinding,
        ).toEqual(subscription.investmentBinding);
      } finally {
        close();
      }
    });
  });
}

describe('investment workspace SQLite migration', () => {
  it('keeps confirmed memory, version conflicts and request receipts consistent across independent connections and restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-investment-contract-'));
    const path = join(dir, 'isolated.db');
    const first = createDrizzleRepos(path);
    const second = createDrizzleRepos(path);
    try {
      const input = {
        consensus: consensus(),
        expectedVersion: 0,
        requestId: 'independent-confirm',
        requestHash: 'independent-hash',
      };
      await first.repos.investmentWorkspace.commitConsensus(input);
      const replay = await second.repos.investmentWorkspace.commitConsensus(input);
      expect(replay.replayed).toBe(true);
      await expect(
        second.repos.investmentWorkspace.commitConsensus({
          ...input,
          consensus: { ...consensus(), id: 'stale-second' },
          requestId: 'stale-second',
        }),
      ).rejects.toThrow('consensus_version_conflict');
      const third = createDrizzleRepos(path);
      try {
        expect(
          await third.repos.investmentWorkspace.listConsensus({ ...owner, limit: 10 }),
        ).toEqual([consensus()]);
        expect(
          (
            await third.repos.investmentWorkspace.findConsensusReceipt({
              ...owner,
              requestId: input.requestId,
            })
          )?.consensus,
        ).toEqual(consensus());
      } finally {
        third.close();
      }
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent on an existing database and keeps unrelated rows and confirmed revisions', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save({
        id: owner.accountId,
        name: '隔离账户',
        kind: 'real',
        currency: 'CNY',
        initialCapital: money(0),
        cashBalance: money(0),
        createdAt: now,
      });
      await handle.repos.investmentWorkspace.commitConsensus({
        consensus: consensus(),
        expectedVersion: 0,
        requestId: 'migration-confirm',
        requestHash: 'hash',
      });
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect((await handle.repos.account.findById(owner.accountId))?.name).toBe('隔离账户');
      expect(
        (await handle.repos.investmentWorkspace.listConsensus({ ...owner, limit: 10 }))[0],
      ).toEqual(consensus());
    } finally {
      handle.close();
    }
  });
});
