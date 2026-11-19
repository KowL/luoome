import type { DailyAdviceOutput } from '@luoome/workflows';
import { describe, expect, it } from 'vitest';

import {
  dueDailyJudgmentTradingDay,
  startDailyJudgmentScheduler,
} from './daily-judgment-scheduler.js';

const okResult = {
  ok: true as const,
  data: {
    advices: [],
    judgment: { action: '今日不动' as const, reason: '无可执行动作', items: [] },
    summary: { total: 0, highConfidence: 0, holdings: 0, candidates: 0, actionable: 0 },
  },
};

const fakeCtx = (clock: () => Date) =>
  ({
    clock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }) as unknown as Parameters<typeof startDailyJudgmentScheduler>[0];

describe('dueDailyJudgmentTradingDay', () => {
  it('17:30 后触发，返回交易日 key', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-12T09:30:00.000Z'))).toBe('2026-11-12');
  });

  it('17:29 尚未到点', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-12T09:29:00.000Z'))).toBeNull();
  });

  it('周末与节假日不触发', () => {
    expect(dueDailyJudgmentTradingDay(new Date('2026-11-14T09:30:00.000Z'))).toBeNull();
    expect(dueDailyJudgmentTradingDay(new Date('2026-10-01T09:30:00.000Z'))).toBeNull();
  });
});

describe('startDailyJudgmentScheduler', () => {
  it('同一交易日只跑一次', async () => {
    let calls = 0;
    const scheduler = startDailyJudgmentScheduler(
      fakeCtx(() => new Date('2026-11-12T09:35:00.000Z')),
      {
        startImmediately: false,
        run: async () => {
          calls += 1;
          return okResult as unknown as { ok: true; data: DailyAdviceOutput };
        },
      },
    );
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(1);
  });

  it('未到点不跑', async () => {
    let calls = 0;
    const scheduler = startDailyJudgmentScheduler(
      fakeCtx(() => new Date('2026-11-12T08:00:00.000Z')),
      {
        startImmediately: false,
        run: async () => {
          calls += 1;
          return okResult as unknown as { ok: true; data: DailyAdviceOutput };
        },
      },
    );
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(0);
  });
});
