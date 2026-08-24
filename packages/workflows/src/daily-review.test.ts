import type { LimitUpLadder, LimitUpLadderDiff, LimitUpLadderManagerLike } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { dailyReviewWorkflow } from './daily-review.js';

const mkLadderManager = (
  opts: { readonly fail?: boolean; readonly ladder?: LimitUpLadder } = {},
): LimitUpLadderManagerLike => {
  const fakeLadder: LimitUpLadder = opts.ladder ?? {
    date: '2026-07-25',
    total: 2,
    maxLevel: 3,
    source: 'eastmoney',
    levels: [
      { level: 3, name: '3 连板', count: 1, stocks: [] },
      { level: 1, name: '首板', count: 1, stocks: [] },
    ],
    warnings: [],
    asOf: new Date('2026-07-25T12:00:00Z'),
  };
  const fakePrev: LimitUpLadder = {
    date: '2026-07-24',
    total: 1,
    maxLevel: 3,
    source: 'eastmoney',
    levels: [{ level: 3, name: '3 连板', count: 1, stocks: [] }],
    warnings: [],
    asOf: new Date('2026-07-24T12:00:00Z'),
  };
  const fakeDiff: LimitUpLadderDiff = {
    totalDelta: 1,
    maxLevelDelta: 0,
    topLevelAdded: ['600519'],
    topLevelRemoved: [],
    topLevelRetained: ['000001'],
  };
  return {
    name: 'limit-up-ladder',
    sources: ['eastmoney'],
    status: () => [],
    fetchLadder: async () =>
      opts.fail === true
        ? {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'limit-up-ladder',
              message: 'x',
              recoverable: false,
            },
          }
        : { ok: true, data: fakeLadder },
    compareLadder: async () =>
      opts.fail === true
        ? {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'limit-up-ladder',
              message: 'x',
              recoverable: false,
            },
          }
        : { ok: true, data: { curr: fakeLadder, prev: fakePrev, diff: fakeDiff } },
  };
};

describe('daily-review workflow Phase 2 (含天梯)', () => {
  it('limitUpLadder 未注入 → ladder 为 null，summary 仍出', async () => {
    const ctx = await buildTestContext();
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).toBeNull();
    expect(r.data.summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.data.summary.totalAdvices).toBeGreaterThanOrEqual(0);
  });

  it('manager 成功 → ladder 段包含 curr/prev/diff', async () => {
    const manager = mkLadderManager();
    const ctx = await buildTestContext({ limitUpLadder: manager });
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).not.toBeNull();
    const ladder = r.data.ladder;
    if (ladder === null) return;
    expect(ladder.curr.date).toBe('2026-07-25');
    expect(ladder.prev.date).toBe('2026-07-24');
    expect(ladder.curr.total).toBe(2);
    expect(ladder.prev.total).toBe(1);
    expect(ladder.diff.totalDelta).toBe(1);
    expect(ladder.diff.topLevelAdded).toEqual(['600519']);
  });

  it('compareLadder 失败 → ladder 为 null', async () => {
    const manager = mkLadderManager({ fail: true });
    const ctx = await buildTestContext({ limitUpLadder: manager });
    const r = await dailyReviewWorkflow.run({ timezoneOffsetHours: 8 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ladder).toBeNull();
  });
});
