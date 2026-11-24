import { describe, expect, it } from 'vitest';
import type { DescendantWaitOutcome } from './agent-tree.js';
import { awaitParentFollowUps, type FollowUpSignal } from './parent-followup.js';

const deferred = <T>() => {
  const value = Promise.withResolvers<T>();
  return { promise: value.promise, resolve: value.resolve, reject: value.reject };
};

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

const feed = () => {
  const queue: FollowUpSignal[] = [];
  let waiter: ((value: FollowUpSignal | undefined) => void) | undefined;
  let closed = false;
  return {
    push(signal: FollowUpSignal) {
      if (waiter === undefined) queue.push(signal);
      else {
        const resolve = waiter;
        waiter = undefined;
        resolve(signal);
      }
    },
    close() {
      closed = true;
      waiter?.(undefined);
      waiter = undefined;
    },
    next: async (): Promise<FollowUpSignal | undefined> => {
      const queued = queue.shift();
      if (queued !== undefined) return queued;
      if (closed) return undefined;
      return new Promise<FollowUpSignal | undefined>((resolve) => {
        waiter = resolve;
      });
    },
    drain: () => queue.shift(),
  };
};

const base = (overrides: {
  maxTurns?: number;
  deadline?: number;
  descendants?: DescendantWaitOutcome[];
  settle?: Promise<void>;
  feed?: ReturnType<typeof feed>;
  turned?: Array<[number, number]>;
  cancelled?: () => boolean;
  now?: () => number;
}) => {
  const descendants = [...(overrides.descendants ?? ['settled'])];
  return {
    maxTurns: overrides.maxTurns ?? 8,
    deadline: overrides.deadline ?? 60000,
    now: overrides.now ?? (() => 0),
    cancelled: overrides.cancelled ?? (() => false),
    // 后代等待耗尽时只返回一次 abandoned；后续调用保持终态。
    waitForDescendants: async (): Promise<DescendantWaitOutcome> =>
      descendants.length > 1
        ? (descendants.shift() as DescendantWaitOutcome)
        : (descendants[0] as DescendantWaitOutcome),
    settle: () => overrides.settle ?? new Promise<void>(() => {}),
    next: () => (overrides.feed ?? feed()).next(),
    drain: () => (overrides.feed ?? feed()).drain(),
    onTurn: (turn: number, consumed: number) => {
      overrides.turned?.push([turn, consumed]);
    },
  };
};

describe('parent follow-up turns after the root Agent idles', () => {
  it('settles as soon as the official wait confirms silence', async () => {
    const turned: Array<[number, number]> = [];
    const outcome = await awaitParentFollowUps({
      ...base({ settle: Promise.resolve(), turned }),
      // 官方静默确认与新唤醒通知竞争，官方先到即收尾。
      next: () => new Promise<FollowUpSignal | undefined>(() => {}),
      drain: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'settled', turns: 0, pending: 0 });
    expect(turned).toEqual([]);
  });

  it('counts a follow-up turn that consumes a settlement notice arriving after idle', async () => {
    const turned: Array<[number, number]> = [];
    const signals = feed();
    const settle = deferred<void>();
    const running = awaitParentFollowUps({
      ...base({ settle: settle.promise, feed: signals, turned }),
    });
    await tick();
    signals.push({ type: 'child-finished' });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    settle.resolve();
    await expect(running).resolves.toEqual({ kind: 'settled', turns: 1, pending: 0 });
    expect(turned).toEqual([[1, 1]]);
  });

  it('stops waking the parent at the turn limit and reports exhaustion', async () => {
    const signals = feed();
    const running = awaitParentFollowUps({
      ...base({ maxTurns: 1, feed: signals }),
    });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    signals.push({ type: 'root-idle' });
    await tick();
    signals.push({ type: 'root-running' });
    await expect(running).resolves.toEqual({ kind: 'exhausted', turns: 2, pending: 0 });
  });

  it('does not count a steer into the running turn as another follow-up turn', async () => {
    const turned: Array<[number, number]> = [];
    const signals = feed();
    const settle = deferred<void>();
    const running = awaitParentFollowUps({
      ...base({ feed: signals, settle: settle.promise, turned }),
    });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    signals.push({ type: 'child-finished' });
    await tick();
    signals.push({ type: 'child-finished' });
    await tick();
    signals.push({ type: 'root-idle' });
    await tick();
    signals.push({ type: 'child-finished' });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    settle.resolve();
    await expect(running).resolves.toEqual({ kind: 'settled', turns: 2, pending: 0 });
    expect(turned).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('confirms silence again when a wake lands together with the official confirmation', async () => {
    const turned: Array<[number, number]> = [];
    const signals = feed();
    const first = deferred<void>();
    const second = deferred<void>();
    let confirmations = 0;
    const running = awaitParentFollowUps({
      ...base({ feed: signals, turned }),
      settle: () => {
        confirmations += 1;
        return confirmations === 1 ? first.promise : second.promise;
      },
    });
    await tick();
    signals.push({ type: 'root-running' });
    first.resolve();
    await tick();
    // 同一时刻的唤醒不能被当作已收尾：父级追问轮要重新确认静默。
    expect(confirmations).toBe(2);
    expect(turned).toEqual([[1, 0]]);
    second.resolve();
    await expect(running).resolves.toEqual({ kind: 'settled', turns: 1, pending: 0 });
  });

  it('reports expiry when the run deadline passes with notices still pending', async () => {
    const outcome = await awaitParentFollowUps({
      ...base({ deadline: 100, now: () => 100 }),
      next: () => new Promise<FollowUpSignal | undefined>(() => {}),
      drain: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'expired', turns: 0, pending: 0 });
  });

  it('reports expiry when descendants stay active past the deadline', async () => {
    const outcome = await awaitParentFollowUps({
      ...base({ descendants: ['abandoned'] }),
      next: () => new Promise<FollowUpSignal | undefined>(() => {}),
      drain: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'expired', turns: 0, pending: 0 });
  });

  it('leaves cancellation to the existing cancel path', async () => {
    const outcome = await awaitParentFollowUps({
      ...base({ cancelled: () => true }),
      next: () => new Promise<FollowUpSignal | undefined>(() => {}),
      drain: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'cancelled', turns: 0, pending: 0 });
  });

  it('reports a cancelled follow-up turn as cancelled, not as a follow-up failure', async () => {
    let cancelled = false;
    const signals = feed();
    const running = awaitParentFollowUps({
      ...base({ feed: signals, cancelled: () => cancelled }),
    });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    cancelled = true;
    signals.push({ type: 'root-turn-aborted', reason: 'user' });
    await expect(running).resolves.toEqual({ kind: 'cancelled', turns: 1, pending: 0 });
  });

  it('reports a silent failure (budget exhausted) without owning the run outcome', async () => {
    const budget = deferred<void>();
    const signals = feed();
    const running = awaitParentFollowUps({
      ...base({ settle: budget.promise, feed: signals }),
    });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    budget.reject(new Error('Run model-call limit exceeded'));
    const outcome = await running;
    expect(outcome).toMatchObject({
      kind: 'failed',
      turns: 1,
      pending: 0,
      error: expect.objectContaining({ message: 'Run model-call limit exceeded' }),
    });
  });

  it('rejects a follow-up turn that ends without a committed completed turn', async () => {
    const signals = feed();
    const running = awaitParentFollowUps({ ...base({ feed: signals }) });
    await tick();
    signals.push({ type: 'child-finished' });
    await tick();
    signals.push({ type: 'root-running' });
    await tick();
    signals.push({ type: 'root-turn-aborted', reason: 'aborted' });
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: 'failed', turns: 1 });
    expect((outcome as { error: Error }).error.message).toContain('aborted');
  });

  it('fails when the notification stream closes before the run settles', async () => {
    const signals = feed();
    const running = awaitParentFollowUps({ ...base({ feed: signals }) });
    await tick();
    signals.close();
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: 'failed', turns: 0 });
  });
});
