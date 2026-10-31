import { TEST_ACCOUNT, TEST_STOCKS } from '@luoome/adapters/testing';
import type { RepositoryRegistry } from '@luoome/core';
import { type Advice, type AdviceOutcomeOrigin, money, STANDARD_DISCLAIMERS } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { createNodeDrizzleRepos } from '@luoome/db/node';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getAdviceStatsTool } from './get-advice-stats.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

/**
 * 驱动无关性契约：同一批事实在 memory 与 SQLite（drizzle）上必须得到**同一个数**。
 *
 * 为什么这条测试在这里而不是 `packages/db`：`get_advice_stats` 住在 tools 层，
 * 而 db 不得反向依赖 tools。tools 依赖 db 是允许的，所以跨层口径断言只能落在这里。
 * 用 `@luoome/db/node`（node:sqlite）而不是 `@luoome/db`（bun:sqlite），是为了让本文件
 * 能在 vitest/node 下运行（`bun run test`）；仓储映射代码与驱动无关，bun:sqlite 那一侧
 * 由 `bun run test:db` 的共享 contract 覆盖。
 */
const NOW = new Date('2026-01-01T00:00:00.000Z');
const CLOCK = (): Date => new Date('2026-01-05T00:00:00.000Z');

const makeAdvice = (id: string): Advice => ({
  id,
  subjectKind: 'portfolio',
  subjectId: TEST_ACCOUNT.id,
  decision: 'buy',
  confidence: 80,
  horizon: 'short',
  reasoning: { premise: `premise of ${id}`, evidence: [], counterEvidence: [] },
  risks: [],
  disclaimers: [...STANDARD_DISCLAIMERS],
  basedOn: { dataAsOf: NOW },
  validFrom: NOW,
  validUntil: new Date('2026-01-04T00:00:00.000Z'),
  createdAt: NOW,
});

/** 四种来源 + 一条无来源戳：口径必须能分开计数。 */
const SAMPLES: readonly { id: string; origin: AdviceOutcomeOrigin | undefined; pnl: number }[] = [
  { id: 'user-profit', origin: 'user', pnl: 10 },
  { id: 'user-loss', origin: 'user', pnl: -5 },
  { id: 'model-fill', origin: 'model', pnl: 100 },
  { id: 'import-fill', origin: 'import', pnl: 100 },
  { id: 'legacy-unattested', origin: undefined, pnl: 100 },
];

const seed = async (
  repos: RepositoryRegistry,
): Promise<{ stats: unknown; outcomes: Record<string, unknown> }> => {
  // `@luoome/db/node` 不 re-export seedData（那会经 barrel 拉进 bun:sqlite），逐个写。
  await repos.account.save(TEST_ACCOUNT);
  for (const stock of TEST_STOCKS) await repos.stock.save(stock);
  const base = await buildTestContext({ clock: CLOCK, advices: [] });
  const ctx = { ...base, repos };
  for (const sample of SAMPLES) {
    await repos.advice.save(makeAdvice(sample.id));
    const recorded = await recordAdviceOutcomeTool.execute(
      {
        adviceId: sample.id,
        accountId: TEST_ACCOUNT.id,
        outcome: 'followed',
        pnl: sample.pnl,
      },
      // 生产里来源由通道决定（ctx.adviceOutcomeOrigin），模型改不了；这里模拟各通道。
      { ...ctx, adviceOutcomeOrigin: sample.origin ?? 'user' },
    );
    if (!recorded.ok) throw new Error(`record outcome failed: ${sample.id}`);
    if (sample.origin === undefined) {
      // 真正的「无来源戳」：`record_advice_outcome` 一定会写通道值，只有 pre-origin
      // 的历史修订才是 unattested。这里用一次不带 origin 的修订复刻那种存量行。
      const row = await repos.decisionReview.findBySubject({
        accountId: TEST_ACCOUNT.id,
        subject: { kind: 'advice', id: sample.id },
      });
      if (!row?.revision.content.adviceFeedback) throw new Error('missing fixture feedback');
      const { origin: _origin, ...legacy } = row.revision.content.adviceFeedback;
      await repos.decisionReview.commit({
        accountId: TEST_ACCOUNT.id,
        requestId: crypto.randomUUID(),
        requestHash: `legacy-${sample.id}`,
        expectedRevision: row.review.currentRevision,
        review: row.review,
        content: { ...row.revision.content, adviceFeedback: legacy },
        contentHash: `legacy-content-${sample.id}`,
        tradeFactHashes: {},
        changeNote: 'fixture: pre-origin revision',
        recordedAt: CLOCK(),
      });
    }
    // `advice_outcomes` 与 decision review 是两条写入路径：`record_advice_outcome` 只写
    // 后者（统计读的是它），前者由复盘面板/回填投影写入。这里显式写一次，才能比较
    // 两个实现的仓储读回结果。
    await repos.advice.recordOutcome(sample.id, {
      adviceId: sample.id,
      tradeIds: [],
      outcome: 'followed',
      ...(sample.origin === undefined ? {} : { origin: sample.origin }),
      pnl: money(sample.pnl),
      recordedAt: NOW,
    });
  }
  const stats = await getAdviceStatsTool.execute({ accountId: TEST_ACCOUNT.id }, ctx);
  if (!stats.ok) throw new Error('get_advice_stats failed');
  const outcomes = Object.fromEntries(
    await Promise.all(
      SAMPLES.map(
        async (sample) => [sample.id, await repos.advice.findOutcome(sample.id)] as const,
      ),
    ),
  );
  return { stats: stats.data, outcomes };
};

const pickStats = (stats: unknown) => {
  const value = stats as Record<string, unknown>;
  return {
    denominator: value.denominator,
    hits: value.hits,
    originFilter: value.originFilter,
    originCounts: value.originCounts,
    excluded: value.excluded,
  };
};

describe('advice outcome 口径的驱动无关性（REQ-M3-10 / M3-18）', () => {
  it('get_advice_stats 在 memory 与 SQLite 上逐字段相等', async () => {
    const memory = await seed(createInMemoryRepos());
    const handle = createNodeDrizzleRepos(':memory:');
    try {
      const sqlite = await seed(handle.repos);
      const memoryStats = pickStats(memory.stats);
      const sqliteStats = pickStats(sqlite.stats);
      expect(sqliteStats).toEqual(memoryStats);
      // 口径本身也要立得住：默认只算 user，其余进 excluded 并披露条数。
      expect(memoryStats.originFilter).toBe('user');
      expect(memoryStats.denominator).toBe(2);
      expect(memoryStats.hits).toBe(1);
      expect(memoryStats.originCounts).toEqual({
        user: 2,
        model: 1,
        import: 1,
        unattested: 1,
      });
      // 非 user 来源与无戳都必须被排除并披露，而不是悄悄进分母。
      expect(memoryStats.excluded).toMatchObject({ nonUserOrigin: 2, unattested: 1 });
    } finally {
      handle.close();
    }
  });

  // 这条才是 `advice_outcomes.origin` 落库的验收：修复前 memory 有 origin、SQLite 读回是
  // undefined，两边的回填来源会分叉（统计侧把用户回填误判成 unattested）。
  it('advice_outcomes 的 origin 在两实现上一致，且无来源戳的行不带 origin 键', async () => {
    const memory = await seed(createInMemoryRepos());
    const handle = createNodeDrizzleRepos(':memory:');
    try {
      const sqlite = await seed(handle.repos);
      for (const sample of SAMPLES) {
        const expected = sample.origin === undefined ? null : { origin: sample.origin };
        const memoryOutcome = memory.outcomes[sample.id] as { origin?: string } | null;
        const sqliteOutcome = sqlite.outcomes[sample.id] as { origin?: string } | null;
        if (expected === null) {
          // 无来源戳：两边都必须「没有 origin 键」，而不是 null / undefined 键。
          expect(memoryOutcome === null ? null : 'origin' in memoryOutcome).toBe(false);
          expect(sqliteOutcome === null ? null : 'origin' in sqliteOutcome).toBe(false);
        } else {
          expect(memoryOutcome?.origin).toBe(expected.origin);
          expect(sqliteOutcome?.origin).toBe(expected.origin);
        }
      }
    } finally {
      handle.close();
    }
  });
});
