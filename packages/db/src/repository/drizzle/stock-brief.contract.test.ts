import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvariantError,
  type StockBrief,
  StockBriefSchema,
  type Watchlist,
  WatchlistSchema,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { makeAdvice } from '../contract-tests.js';

const NOW = new Date('2026-11-24T08:00:00.000Z');
const VALID_UNTIL = new Date('2026-11-27T07:00:00.000Z');

const makeBrief = (overrides: Record<string, unknown> = {}): StockBrief =>
  StockBriefSchema.parse({
    id: 'brief-1',
    tradingDate: '2026-11-24',
    phase: 'post-market',
    accountId: 'acc-1',
    stockId: '600519.SH',
    source: 'scheduled',
    decision: 'hold',
    confidence: 20,
    horizon: 'short',
    quality: 'rule-only',
    factDigest: 'digest-1',
    factsAsOf: NOW,
    missing: [],
    dataSources: ['eastmoney'],
    validUntil: VALID_UNTIL,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

const makeWatchlist = (id: string): Watchlist =>
  WatchlistSchema.parse({
    id,
    name: '测试关注列表',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });

describe('StockBriefRepository [drizzle]', () => {
  it('upserts idempotently on (accountId, tradingDate, stockId, phase)', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      const first = makeBrief();
      const saved = await repos.stockBrief.upsert(first);
      expect(saved).toEqual(first);

      const second = makeBrief({
        id: 'brief-2',
        decision: 'watch',
        confidence: 30,
        factDigest: 'digest-2',
        updatedAt: new Date('2026-11-24T09:00:00.000Z'),
      });
      const updated = await repos.stockBrief.upsert(second);
      expect(updated.id).toBe('brief-2');
      expect(updated.decision).toBe('watch');
      // 结论因 factDigest 变化而重算时，被覆盖行 id 进入 revisedFrom。
      expect(updated.revisedFrom).toBe('brief-1');
      expect(updated.createdAt).toEqual(NOW);

      const day = await repos.stockBrief.findByDay({ tradingDate: '2026-11-24' });
      expect(day).toHaveLength(1);
      expect(day[0]).toMatchObject({ id: 'brief-2', revisedFrom: 'brief-1' });
    } finally {
      handle.close();
    }
  });

  it('filters by day, account, phase and stock', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.stockBrief.upsert(makeBrief({ id: 'b-1' }));
      await repos.stockBrief.upsert(
        makeBrief({ id: 'b-2', phase: 'premarket', stockId: '300750.SZ' }),
      );
      await repos.stockBrief.upsert(
        makeBrief({ id: 'b-3', accountId: 'acc-2', stockId: '300750.SZ' }),
      );
      await repos.stockBrief.upsert(
        makeBrief({ id: 'b-4', tradingDate: '2026-11-23', stockId: '600519.SH' }),
      );

      expect(await repos.stockBrief.findByDay({ tradingDate: '2026-11-24' })).toHaveLength(3);
      expect(
        await repos.stockBrief.findByDay({ tradingDate: '2026-11-24', accountId: 'acc-1' }),
      ).toHaveLength(2);
      expect(
        await repos.stockBrief.findByDay({
          tradingDate: '2026-11-24',
          accountId: 'acc-1',
          phase: 'premarket',
        }),
      ).toHaveLength(1);

      const byStock = await repos.stockBrief.findByStock({ stockId: '600519.SH' });
      expect(byStock.map((item) => item.id)).toEqual(['b-1', 'b-4']);
      expect(
        await repos.stockBrief.findByStock({ stockId: '600519.SH', accountId: 'acc-1', limit: 1 }),
      ).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('lists watchlist members only for the requested day and skips archived members', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.watchlist.save(makeWatchlist('wl-1'));
      await repos.watchlistMember.saveMember({
        id: 'member-1',
        watchlistId: 'wl-1',
        stockId: '600519.SH',
        stage: 'watching',
        priority: 'normal',
        firstAddedAt: NOW,
        lastActivityAt: NOW,
      });
      await repos.watchlistMember.saveMember({
        id: 'member-2',
        watchlistId: 'wl-1',
        stockId: '300750.SZ',
        stage: 'archived',
        priority: 'normal',
        firstAddedAt: NOW,
        lastActivityAt: NOW,
        archivedAt: NOW,
      });
      await repos.stockBrief.upsert(makeBrief({ id: 'b-1', stockId: '600519.SH' }));
      await repos.stockBrief.upsert(makeBrief({ id: 'b-2', stockId: '300750.SZ' }));
      await repos.stockBrief.upsert(makeBrief({ id: 'b-3', stockId: '002594.SZ' }));

      const items = await repos.stockBrief.listByWatchlistDay({
        watchlistId: 'wl-1',
        tradingDate: '2026-11-24',
      });
      expect(items.map((item) => item.id)).toEqual(['b-1']);
    } finally {
      handle.close();
    }
  });

  it('sums LLM usage for a trading date', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.stockBrief.upsert(
        makeBrief({
          id: 'b-1',
          quality: 'ai',
          decision: 'buy',
          adviceId: 'advice-1',
          llmHttpCalls: 2,
          llmPromptTokens: 1200,
          llmCompletionTokens: 300,
          llmReasoningTokens: 100,
          llmCostUsd: 0.25,
        }),
      );
      await repos.stockBrief.upsert(
        makeBrief({
          id: 'b-2',
          stockId: '300750.SZ',
          llmHttpCalls: 1,
          llmPromptTokens: 800,
          llmCompletionTokens: 200,
          llmReasoningTokens: 50,
          llmCostUsd: 0.1,
        }),
      );
      await repos.stockBrief.upsert(
        makeBrief({ id: 'b-3', tradingDate: '2026-11-23', llmHttpCalls: 9 }),
      );

      expect(await repos.stockBrief.sumUsage('2026-11-24')).toEqual({
        briefs: 2,
        httpCalls: 3,
        promptTokens: 2000,
        completionTokens: 500,
        reasoningTokens: 150,
        costUsd: 0.35,
      });
      expect(await repos.stockBrief.sumUsage('2026-11-22')).toEqual({
        briefs: 0,
        httpCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      });
    } finally {
      handle.close();
    }
  });

  it('ensureSchema adds stock_briefs to an existing file database and stays repeatable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-stock-brief-'));
    const path = join(dir, 'existing.db');
    const first = createDrizzleRepos(path);
    try {
      // 模拟升级前的存量库：表存在但缺 stock_briefs。
      first.db.run(sql`DROP TABLE stock_briefs`);
      ensureSchema(first.db);
      ensureSchema(first.db);
      const saved = await first.repos.stockBrief.upsert(makeBrief({ id: 'b-1' }));
      expect(saved.id).toBe('b-1');
      expect(await first.repos.stockBrief.findById('b-1')).toMatchObject({ id: 'b-1' });
    } finally {
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upsertWithAdvice writes advice and brief in one transaction and links adviceId', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      const advice = makeAdvice('adv-1');
      const saved = await repos.stockBrief.upsertWithAdvice({
        advice,
        brief: makeBrief({ id: 'b-1', quality: 'ai', decision: 'hold' }),
      });

      expect(saved.advice.id).toBe('adv-1');
      expect(saved.brief.adviceId).toBe('adv-1');
      expect(await repos.advice.findById('adv-1')).toMatchObject({ id: 'adv-1' });
      const day = await repos.stockBrief.findByDay({ tradingDate: '2026-11-24' });
      expect(day.map((item) => item.adviceId)).toEqual(['adv-1']);
    } finally {
      handle.close();
    }
  });

  it('upsertWithAdvice replays the same factDigest without overwriting advice or outcomes', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.stockBrief.upsertWithAdvice({
        advice: makeAdvice('adv-1'),
        brief: makeBrief({ id: 'b-1', quality: 'ai', llmHttpCalls: 1, llmPromptTokens: 10 }),
      });
      await repos.advice.recordOutcome('adv-1', {
        adviceId: 'adv-1',
        outcome: 'followed',
        tradeIds: [],
        recordedAt: NOW,
      });
      const retried = await repos.stockBrief.upsertWithAdvice({
        advice: makeAdvice('adv-2', { decision: 'watch' }),
        brief: makeBrief({
          id: 'b-2',
          quality: 'ai',
          decision: 'watch',
          llmHttpCalls: 2,
          llmPromptTokens: 20,
        }),
      });

      expect(retried.advice.id).toBe('adv-1');
      expect(retried.advice.decision).toBe('hold');
      expect(retried.brief).toMatchObject({
        id: 'b-1',
        llmHttpCalls: 3,
        llmPromptTokens: 30,
      });
      const advices = await repos.advice.query({ subjectId: 'stk-1', limit: 10 });
      expect(advices).toHaveLength(1);
      expect(advices[0]?.decision).toBe('hold');
      expect(await repos.advice.findOutcome('adv-1')).toMatchObject({ outcome: 'followed' });
    } finally {
      handle.close();
    }
  });

  it('upsertWithAdvice creates a new advice when the factDigest changes', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.stockBrief.upsertWithAdvice({
        advice: makeAdvice('adv-1'),
        brief: makeBrief({ id: 'b-1', quality: 'ai' }),
      });
      const revised = await repos.stockBrief.upsertWithAdvice({
        advice: makeAdvice('adv-2', { decision: 'watch' }),
        brief: makeBrief({
          id: 'b-2',
          quality: 'ai',
          decision: 'watch',
          factDigest: 'digest-2',
        }),
      });

      expect(revised.advice.id).toBe('adv-2');
      expect(revised.brief).toMatchObject({ id: 'b-2', adviceId: 'adv-2', revisedFrom: 'b-1' });
      const advices = await repos.advice.query({ subjectId: 'stk-1', limit: 10 });
      expect(advices).toHaveLength(2);
      expect(advices.find((item) => item.id === 'adv-1')?.decision).toBe('hold');
      expect(advices.find((item) => item.id === 'adv-2')?.decision).toBe('watch');
    } finally {
      handle.close();
    }
  });

  it('upsertWithAdvice rolls the advice back when the brief write fails', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await expect(
        repos.stockBrief.upsertWithAdvice({
          advice: makeAdvice('adv-orphan'),
          // 绕过 schema 的非法用量：不变量校验会在同一事务内抛错。
          brief: { ...makeBrief({ id: 'b-1', quality: 'ai' }), llmHttpCalls: -1 },
        }),
      ).rejects.toThrow(InvariantError);

      expect(await repos.advice.findById('adv-orphan')).toBeNull();
      expect(await repos.stockBrief.findByDay({ tradingDate: '2026-11-24' })).toHaveLength(0);
    } finally {
      handle.close();
    }
  });
});
