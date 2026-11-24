import type { DescendantWaitOutcome } from './agent-tree.js';

/**
 * 根 Agent 首次 idle 之后的追问阶段（docs/ddd/luoome-dsh-transformation-detailed-design.md §5.5）。
 *
 * 官方子 Agent 组合在子 Agent 结算（完成或 abandoned）时把通知写入父会话并唤醒父级，
 * 只等后代终态会在父级追问轮之前结束 Run。这里按官方会话树通知实时计数追问轮，
 * 用官方 `session/wait` 确认根确实静默后才收尾；追问受 Run 截止时间、轮次上限和取消约束。
 * 循环在「没有新的未处理通知、且后代均终态」时结束。
 */

/** 追问阶段关心的官方会话树通知投影。 */
export type FollowUpSignal =
  | { readonly type: 'root-running' }
  | { readonly type: 'root-idle' }
  | { readonly type: 'root-turn-aborted'; readonly reason: string }
  | { readonly type: 'child-finished' };

export interface ParentFollowUpOptions {
  /** 追问轮上限：每唤醒父级成功开一轮计一次。 */
  readonly maxTurns: number;
  /** Run 授权的绝对截止时间（毫秒）。 */
  readonly deadline: number;
  readonly cancelled: () => boolean;
  /**
   * 沿用 D10b 的后代等待，只用于「到位仍有活跃后代」与取消的收尾信号；
   * 正常静默由官方 `session/wait` 确认，因此它不能阻塞通知处理。
   */
  readonly waitForDescendants: () => Promise<DescendantWaitOutcome>;
  /** 官方 `session/wait`：根 idle 且后代结算后 resolve。 */
  readonly settle: () => Promise<void>;
  /** 官方会话树通知的下一条投影；订阅结束后返回 `undefined`。 */
  readonly next: () => Promise<FollowUpSignal | undefined>;
  /** 同步取出已送达但尚未读取的投影，避免官方静默确认抢先于已入队的通知。 */
  readonly drain?: () => FollowUpSignal | undefined;
  /** 父级为消费未处理通知新开一轮时回调，用于审计。 */
  readonly onTurn?: (turn: number, consumed: number) => void | Promise<void>;
  readonly now?: () => number;
}

export type ParentFollowUpOutcome =
  | { readonly kind: 'settled'; readonly turns: number; readonly pending: number }
  | { readonly kind: 'cancelled'; readonly turns: number; readonly pending: number }
  | { readonly kind: 'expired'; readonly turns: number; readonly pending: number }
  | { readonly kind: 'exhausted'; readonly turns: number; readonly pending: number }
  | {
      readonly kind: 'failed';
      readonly turns: number;
      readonly pending: number;
      readonly error: unknown;
    };

type Race =
  | { readonly kind: 'settled' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'signal'; readonly value: FollowUpSignal | undefined }
  | { readonly kind: 'descendants'; readonly outcome: DescendantWaitOutcome };

/** 让同一时刻送达的通知先投影出来；投影链比官方响应多几跳，靠它消除先后偏差。 */
const grace = () =>
  new Promise<undefined>((done) => {
    setTimeout(() => done(undefined), 0);
  });

/**
 * 等到「没有未处理通知、且后代均终态」。
 *
 * 官方静默确认、父级新唤醒、后代等待结案与截止时间竞争：静默确认先到即收尾，
 * 父级每被唤醒一次计一轮并继续，并要求官方重新确认静默。轮次超过上限、Run 到期或
 * 官方等待失败只返回结果，由调用方决定 abandoned 收尾，不把 Run 判失败。
 */
export const awaitParentFollowUps = async (
  options: ParentFollowUpOptions,
): Promise<ParentFollowUpOutcome> => {
  const now = options.now ?? Date.now;
  const status = { turns: 0, pending: 0 };
  let running = false;
  const startSettling = () =>
    options.settle().then(
      () => ({ kind: 'settled' }) as const,
      (error: unknown) => ({ kind: 'failed', error }) as const,
    );
  let settling = startSettling();
  const reconfirm = () => {
    settling = startSettling();
  };
  const observe = () =>
    options.next().then(
      (value) => ({ kind: 'signal', value }) as const,
      (error: unknown) => ({ kind: 'failed', error }) as const,
    );
  let signal = observe();
  // 后代等待只交付一次结案；结案后不再重复登记。
  let descendants: Promise<Race> = options.waitForDescendants().then(
    (outcome) => ({ kind: 'descendants', outcome }) as const,
    (error: unknown) => ({ kind: 'failed', error }) as const,
  );
  const expired = Promise.withResolvers<Race>();
  const timer = setTimeout(
    () => expired.resolve({ kind: 'expired' }),
    Math.max(0, options.deadline - now()),
  );
  /** 处理一条通知；新开一轮时返回 `reconfirm`：此前的静默确认已经失效。 */
  const decide = async (
    value: FollowUpSignal,
  ): Promise<ParentFollowUpOutcome | 'reconfirm' | undefined> => {
    if (value.type === 'root-turn-aborted') {
      // 用户取消/整次 Run 超时仍由既有取消路径结案，不当作追问失败。
      if (options.cancelled()) return { kind: 'cancelled', ...status };
      return {
        kind: 'failed',
        ...status,
        error: new Error(`Follow-up turn ended with ${value.reason}`),
      };
    }
    if (value.type === 'root-idle') {
      running = false;
      return undefined;
    }
    if (value.type === 'child-finished') {
      // 父级运行中的通知由该轮 steer 消费，不再攒到下一轮。
      if (!running) status.pending += 1;
      return undefined;
    }
    // steer 到同一轮不重复计数；新一轮才是一次唤醒。
    if (running) return undefined;
    running = true;
    status.turns += 1;
    const consumed = status.pending;
    status.pending = 0;
    if (status.turns > options.maxTurns) return { kind: 'exhausted', ...status };
    await options.onTurn?.(status.turns, consumed);
    return 'reconfirm';
  };
  const flush = async (): Promise<ParentFollowUpOutcome | 'reconfirm' | undefined> => {
    for (let queued = options.drain?.(); queued !== undefined; queued = options.drain?.()) {
      const applied = await decide(queued);
      if (applied !== undefined) return applied;
    }
    return undefined;
  };
  const dispatch = async (
    outcome: Race,
  ): Promise<ParentFollowUpOutcome | 'reconfirm' | undefined> => {
    if (outcome.kind === 'failed') return { ...outcome, ...status };
    if (outcome.kind === 'expired') return { kind: 'expired', ...status };
    if (outcome.kind === 'descendants') {
      if (outcome.outcome === 'cancelled') return { kind: 'cancelled', ...status };
      if (outcome.outcome === 'abandoned') return { kind: 'expired', ...status };
      descendants = new Promise<Race>(() => {});
      return undefined;
    }
    if (outcome.kind === 'signal') {
      if (outcome.value === undefined)
        return {
          kind: 'failed',
          ...status,
          error: new Error('Follow-up notifications are unavailable'),
        };
      signal = observe();
      return decide(outcome.value);
    }
    // 官方静默确认：给同一时刻送达的唤醒通知一个宏任务的机会再收尾。
    const late = await Promise.race([signal, grace()]);
    if (late === undefined) return { kind: 'settled', ...status };
    const applied = await dispatch(late);
    // 确认之后才处理的投影：已经无法声称根静默。
    return applied === undefined ? 'reconfirm' : applied;
  };
  try {
    for (;;) {
      if (options.cancelled()) return { kind: 'cancelled', ...status };
      let applied = await flush();
      if (applied === 'reconfirm') {
        reconfirm();
        continue;
      }
      if (applied !== undefined) return applied;
      applied = await dispatch(
        await Promise.race([signal, settling, descendants, expired.promise]),
      );
      if (applied === 'reconfirm') {
        reconfirm();
        continue;
      }
      if (applied !== undefined) return applied;
    }
  } finally {
    clearTimeout(timer);
  }
};
