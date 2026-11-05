import { SourceExecutionError } from '../source-error.js';

/**
 * Fuyao 进程级共享请求协调器（设计文档 §4.2）。
 *
 * 所有 Fuyao REST 请求（行情、dump、天梯、财务、资讯等）共享同一并发上限、
 * 启动间隔与冷却窗口；任一请求触发 429/4001 会暂停共享队列，避免多域同时加压。
 * 不读 process.env；配置由 client/factory 解析后注入。
 */

export interface FuyaoRequestCoordinatorConfig {
  /** 共享并发上限（默认 2）。 */
  readonly maxConcurrency: number;
  /** 共享启动间隔毫秒（默认 200；不是上游承诺 QPS）。 */
  readonly minIntervalMs: number;
  /** 未提供有效 Retry-After 时的共享冷却毫秒（默认 30_000）。 */
  readonly rateLimitCooldownMs: number;
  /** 仅幂等 GET 的限流重试上限（默认 2）。 */
  readonly rateLimitMaxRetries: number;
}

export const FUYAO_REQUEST_COORDINATOR_DEFAULTS: FuyaoRequestCoordinatorConfig = {
  maxConcurrency: 2,
  minIntervalMs: 200,
  rateLimitCooldownMs: 30_000,
  rateLimitMaxRetries: 2,
};

export interface FuyaoRequestCoordinatorOptions {
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface QueueItem {
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FuyaoRequestCoordinator {
  private readonly config: FuyaoRequestCoordinatorConfig;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private activeCount = 0;
  private readonly queue: QueueItem[] = [];
  private lastStartAt = 0;
  private cooldownUntil = 0;
  private scheduling = false;

  constructor(config: FuyaoRequestCoordinatorConfig, options: FuyaoRequestCoordinatorOptions = {}) {
    this.config = config;
    this.clock = options.clock ?? ((): number => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * 提交一个请求执行任务。任务在共享并发/间隔/冷却约束下串行调度；
   * 任务内部若抛出 rate_limited，由调用方（client）负责重试并再次提交。
   */
  async execute<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.schedule();
    });
  }

  /** 报告一次限流命中，设置共享冷却窗口。 */
  reportRateLimited(retryAfterMs?: number): void {
    const now = this.clock();
    const cooldownMs =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, 86_400_000)
        : this.config.rateLimitCooldownMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + cooldownMs);
  }

  /** 当前共享冷却截止时间（epoch ms）；0 表示无冷却。 */
  get blockedUntil(): number {
    return this.cooldownUntil;
  }

  private schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    void this.drain().finally(() => {
      this.scheduling = false;
      if (this.queue.length > 0) this.schedule();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const now = this.clock();
      if (now < this.cooldownUntil) {
        await this.sleep(this.cooldownUntil - now);
        continue;
      }
      if (this.activeCount >= this.config.maxConcurrency) {
        await this.sleep(10);
        continue;
      }
      const sinceLast = now - this.lastStartAt;
      if (this.lastStartAt > 0 && sinceLast < this.config.minIntervalMs) {
        await this.sleep(this.config.minIntervalMs - sinceLast);
        continue;
      }
      const item = this.queue.shift();
      if (item === undefined) return;
      this.activeCount += 1;
      this.lastStartAt = this.clock();
      void this.runItem(item);
    }
  }

  private async runItem(item: QueueItem): Promise<void> {
    try {
      const result = await item.run();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeCount -= 1;
      this.schedule();
    }
  }
}

/** 从 env 解析协调器配置；非法值启动期抛错。 */
export const fuyaoRequestCoordinatorConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): FuyaoRequestCoordinatorConfig => {
  const parse = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (raw === undefined || raw.length === 0) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`fuyao coordinator config: ${key} 必须是正整数（当前=${raw}）`);
    }
    return value;
  };
  return {
    maxConcurrency: parse(
      'FUYAO_MAX_CONCURRENCY',
      FUYAO_REQUEST_COORDINATOR_DEFAULTS.maxConcurrency,
    ),
    minIntervalMs: parse('FUYAO_MIN_INTERVAL_MS', FUYAO_REQUEST_COORDINATOR_DEFAULTS.minIntervalMs),
    rateLimitCooldownMs: parse(
      'FUYAO_RATE_LIMIT_COOLDOWN_MS',
      FUYAO_REQUEST_COORDINATOR_DEFAULTS.rateLimitCooldownMs,
    ),
    rateLimitMaxRetries: parse(
      'FUYAO_RATE_LIMIT_MAX_RETRIES',
      FUYAO_REQUEST_COORDINATOR_DEFAULTS.rateLimitMaxRetries,
    ),
  };
};

/** 429 响应的 Retry-After 解析：秒数或 HTTP-date；非法/缺失返回 undefined。 */
export const parseRetryAfterMs = (
  header: string | null,
  clock: () => number = Date.now,
): number | undefined => {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - clock();
    return delta > 0 ? delta : 0;
  }
  return undefined;
};

/** 4001 退避：带抖动的 1s、5s 级（attempt 0 → ~1s，attempt 1 → ~5s）。 */
export const rateLimitBackoffMs = (attempt: number, random: () => number = Math.random): number => {
  const base = attempt === 0 ? 1_000 : 5_000;
  const jitter = Math.floor(random() * 500);
  return base + jitter;
};

/** 判断错误是否为可重试的限流信号。 */
export const isRetryableRateLimit = (error: unknown): boolean =>
  error instanceof SourceExecutionError && error.kind === 'rate_limited';
