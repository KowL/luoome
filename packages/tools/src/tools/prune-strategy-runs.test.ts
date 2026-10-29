import type { StrategyRun } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { selectExpiredRuns } from './prune-strategy-runs.js';

const run = (id: string, startedAt: string): StrategyRun =>
  ({ id, startedAt: new Date(startedAt) }) as unknown as StrategyRun;

describe('strategy run retention', () => {
  it('keeps the newest runs and everything inside the window', () => {
    const runs = [
      run('newest', '2026-10-29T00:00:00Z'),
      run('recent', '2026-10-20T00:00:00Z'),
      run('older', '2026-09-01T00:00:00Z'),
      run('oldest', '2026-07-01T00:00:00Z'),
    ];
    const { kept, expired } = selectExpiredRuns(runs, 2, new Date('2026-10-01T00:00:00Z'));
    expect(kept.map((item) => item.id)).toEqual(['newest', 'recent']);
    expect(expired.map((item) => item.id)).toEqual(['older', 'oldest']);
  });

  it('never expires runs inside the window even beyond the keep count', () => {
    const runs = [
      run('a', '2026-10-29T00:00:00Z'),
      run('b', '2026-10-28T00:00:00Z'),
      run('c', '2026-10-27T00:00:00Z'),
      run('d', '2026-01-01T00:00:00Z'),
    ];
    const { kept, expired } = selectExpiredRuns(runs, 1, new Date('2026-10-01T00:00:00Z'));
    expect(kept.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(expired.map((item) => item.id)).toEqual(['d']);
  });

  it('keeps everything when the retention window is unbounded', () => {
    const runs = [run('a', '2026-10-29T00:00:00Z'), run('b', '2020-01-01T00:00:00Z')];
    const { expired } = selectExpiredRuns(runs, 1, new Date('2019-01-01T00:00:00Z'));
    expect(expired).toEqual([]);
  });
});
