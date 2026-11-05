import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import {
  FUYAO_REQUEST_COORDINATOR_DEFAULTS,
  FuyaoRequestCoordinator,
  fuyaoRequestCoordinatorConfigFromEnv,
  isRetryableRateLimit,
  parseRetryAfterMs,
  rateLimitBackoffMs,
} from './request-coordinator.js';

/** 手动推进的假时钟 + sleep：sleep 记录时长并立即推进时钟，测试零真实等待。 */
const fakeClockSleep = (
  start = 1_000_000,
): { clock: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } => {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
  };
};

const testConfig = (
  overrides: Partial<{
    maxConcurrency: number;
    minIntervalMs: number;
    rateLimitCooldownMs: number;
    rateLimitMaxRetries: number;
  }> = {},
) => ({
  maxConcurrency: 2,
  minIntervalMs: 200,
  rateLimitCooldownMs: 30_000,
  rateLimitMaxRetries: 2,
  ...overrides,
});

const flushMicrotasks = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

describe('fuyao/FuyaoRequestCoordinator 并发与间隔', () => {
  it('并发上限：同时运行的任务不超过 maxConcurrency', async () => {
    const { clock, sleep } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig({ maxConcurrency: 2 }), {
      clock,
      sleep,
    });
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const task = (): Promise<string> =>
      coordinator.execute(
        () =>
          new Promise<string>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            gate.push(() => {
              active -= 1;
              resolve('done');
            });
          }),
      );
    const pending = [task(), task(), task(), task()];
    await flushMicrotasks();
    expect(peak).toBe(2); // 上限 2，其余排队
    expect(gate).toHaveLength(2);
    gate.shift()?.();
    await flushMicrotasks();
    expect(gate).toHaveLength(2); // 释放一个槽位后补进一个
    while (gate.length > 0) {
      gate.shift()?.();
      await flushMicrotasks();
    }
    await expect(Promise.all(pending)).resolves.toEqual(['done', 'done', 'done', 'done']);
    expect(peak).toBe(2);
  });

  it('共享启动间隔：连续任务启动间隔不小于 minIntervalMs', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(
      testConfig({ maxConcurrency: 1, minIntervalMs: 200 }),
      { clock, sleep },
    );
    const starts: number[] = [];
    const task = (): Promise<number> =>
      coordinator.execute(() => {
        starts.push(clock());
        return Promise.resolve(clock());
      });
    const results = Promise.all([task(), task(), task()]);
    await expect(results).resolves.toHaveLength(3);
    // 启动间隔恰好 200ms（等待总时长等于两次间隔；内部忙等可能拆分多次 sleep，
    // 行为以启动时刻为准）
    expect(starts).toEqual([1_000_000, 1_000_200, 1_000_400]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(400);
  });

  it('任务抛错原样透传，不影响后续队列', async () => {
    const { clock, sleep } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    const boom = new Error('boom');
    await expect(coordinator.execute(() => Promise.reject(boom))).rejects.toBe(boom);
    await expect(coordinator.execute(() => Promise.resolve(42))).resolves.toBe(42);
  });
});

describe('fuyao/FuyaoRequestCoordinator 共享冷却', () => {
  it('reportRateLimited() 无 Retry-After → 默认 30s 共享冷却，期间任务暂停', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    await coordinator.execute(() => Promise.resolve('first')); // 建立 lastStartAt
    coordinator.reportRateLimited();
    expect(coordinator.blockedUntil).toBe(1_000_000 + 30_000);
    const starts: number[] = [];
    const pending = coordinator.execute(() => {
      starts.push(clock());
      return Promise.resolve('second');
    });
    await expect(pending).resolves.toBe('second');
    expect(starts).toEqual([1_030_000]); // 冷却结束后才启动
    expect(sleeps).toEqual([30_000]); // 只等待一次冷却窗口
  });

  it('reportRateLimited(retryAfterMs) → 冷却窗口取 Retry-After，覆盖默认 30s', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    await coordinator.execute(() => Promise.resolve('first'));
    coordinator.reportRateLimited(2_500);
    expect(coordinator.blockedUntil).toBe(1_000_000 + 2_500);
    const starts: number[] = [];
    await coordinator.execute(() => {
      starts.push(clock());
      return Promise.resolve('second');
    });
    expect(starts).toEqual([1_002_500]);
    expect(sleeps).toEqual([2_500]);
  });

  it('冷却是共享的：一个调用方报告的限流暂停所有后续任务', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    await coordinator.execute(() => Promise.resolve('warmup'));
    // 模拟 client A 命中 4001：报告 1s 级冷却
    coordinator.reportRateLimited(1_200);
    const starts: number[] = [];
    const a = coordinator.execute(() => {
      starts.push(clock());
      return Promise.resolve('A');
    });
    const b = coordinator.execute(() => {
      starts.push(clock());
      return Promise.resolve('B');
    });
    await expect(Promise.all([a, b])).resolves.toEqual(['A', 'B']);
    // 两个任务都在冷却结束后启动；第二个再间隔 minIntervalMs
    expect(starts[0]).toBe(1_001_200);
    expect(starts[1]).toBe(1_001_400);
    expect(sleeps).toEqual([1_200, 200]);
  });

  it('重复报告取更晚的截止时刻（max 语义）', async () => {
    const { clock, sleep } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    coordinator.reportRateLimited(5_000);
    coordinator.reportRateLimited(1_000); // 更早，不缩短窗口
    expect(coordinator.blockedUntil).toBe(1_000_000 + 5_000);
  });

  it('非法 retryAfterMs（0 / 负数 / NaN）→ 回退默认冷却', async () => {
    const { clock, sleep } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(testConfig(), { clock, sleep });
    coordinator.reportRateLimited(0);
    expect(coordinator.blockedUntil).toBe(1_000_000 + 30_000);
    coordinator.reportRateLimited(Number.NaN);
    expect(coordinator.blockedUntil).toBe(1_000_000 + 30_000);
  });
});

describe('fuyao/parseRetryAfterMs', () => {
  it('秒数形式 → 毫秒', () => {
    expect(parseRetryAfterMs('7')).toBe(7_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('HTTP-date 形式 → 相对时钟的毫秒差；过去时刻归 0', () => {
    const now = Date.parse('Wed, 04 Nov 2026 00:00:00 GMT');
    const clock = () => now;
    expect(parseRetryAfterMs('Wed, 04 Nov 2026 00:00:05 GMT', clock)).toBe(5_000);
    expect(parseRetryAfterMs('Wed, 03 Nov 2026 23:59:00 GMT', clock)).toBe(0);
  });

  it('缺失 / 非法 → undefined', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    expect(parseRetryAfterMs('')).toBe(0); // Number('') === 0，按秒数 0 处理
  });
});

describe('fuyao/rateLimitBackoffMs', () => {
  it('attempt 0 → 1s 级（1000-1499），attempt ≥1 → 5s 级（5000-5499）', () => {
    expect(rateLimitBackoffMs(0, () => 0)).toBe(1_000);
    expect(rateLimitBackoffMs(0, () => 0.999)).toBeGreaterThanOrEqual(1_000);
    expect(rateLimitBackoffMs(0, () => 0.999)).toBeLessThan(1_500);
    expect(rateLimitBackoffMs(1, () => 0)).toBe(5_000);
    expect(rateLimitBackoffMs(2, () => 0)).toBe(5_000);
    expect(rateLimitBackoffMs(1, () => 0.999)).toBeLessThan(5_500);
  });
});

describe('fuyao/isRetryableRateLimit', () => {
  it('仅 SourceExecutionError 且 kind=rate_limited 可重试', () => {
    expect(isRetryableRateLimit(new SourceExecutionError('rate_limited', 'x'))).toBe(true);
    expect(isRetryableRateLimit(new SourceExecutionError('permission', 'x'))).toBe(false);
    expect(isRetryableRateLimit(new Error('x'))).toBe(false);
    expect(isRetryableRateLimit('rate_limited')).toBe(false);
  });
});

describe('fuyao/fuyaoRequestCoordinatorConfigFromEnv', () => {
  it('缺省 → 设计默认值（2 / 200 / 30000 / 2）', () => {
    expect(fuyaoRequestCoordinatorConfigFromEnv({})).toEqual(FUYAO_REQUEST_COORDINATOR_DEFAULTS);
    expect(FUYAO_REQUEST_COORDINATOR_DEFAULTS).toEqual({
      maxConcurrency: 2,
      minIntervalMs: 200,
      rateLimitCooldownMs: 30_000,
      rateLimitMaxRetries: 2,
    });
  });

  it('env 覆盖生效；非法值启动期抛错', () => {
    const parsed = fuyaoRequestCoordinatorConfigFromEnv({
      FUYAO_MAX_CONCURRENCY: '4',
      FUYAO_MIN_INTERVAL_MS: '50',
      FUYAO_RATE_LIMIT_COOLDOWN_MS: '5000',
      FUYAO_RATE_LIMIT_MAX_RETRIES: '3',
    });
    expect(parsed).toEqual({
      maxConcurrency: 4,
      minIntervalMs: 50,
      rateLimitCooldownMs: 5_000,
      rateLimitMaxRetries: 3,
    });
    expect(() => fuyaoRequestCoordinatorConfigFromEnv({ FUYAO_MAX_CONCURRENCY: '0' })).toThrow(
      /FUYAO_MAX_CONCURRENCY/,
    );
    expect(() => fuyaoRequestCoordinatorConfigFromEnv({ FUYAO_MIN_INTERVAL_MS: 'abc' })).toThrow(
      /FUYAO_MIN_INTERVAL_MS/,
    );
  });
});
