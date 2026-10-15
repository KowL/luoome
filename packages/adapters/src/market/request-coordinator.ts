import { createHash, randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import {
  type PublicMarketStore,
  type Quote,
  QuoteSchema,
  type SourceErrorKind,
} from '@luoome/core';
import { z } from 'zod';
import {
  httpStatusErrorKind,
  isAbortError,
  SourceExecutionError,
  sourceErrorKindOf,
} from '../source-error.js';
import {
  type MarketCapability,
  type MarketCapabilityHandle,
  type MarketCapabilityMap,
  quoteMatchesStock,
} from './source-registry.js';

const positive = z.coerce.number().int().positive().safe();
export const marketRequestConfigFromEnv = (env: Readonly<Record<string, string | undefined>>) => ({
  requestsPerWindow: positive.max(10_000).parse(env.LUOOME_MARKET_REQUESTS_PER_WINDOW ?? 30),
  windowMs: positive.max(3_600_000).parse(env.LUOOME_MARKET_REQUEST_WINDOW_MS ?? 60_000),
  cooldownMs: positive.max(86_400_000).parse(env.LUOOME_MARKET_FAILURE_COOLDOWN_MS ?? 60_000),
  cacheTtlMs: positive.max(60_000).parse(env.LUOOME_MARKET_CACHE_TTL_MS ?? 10_000),
  leaseMs: positive
    .min(100)
    .max(300_000)
    .parse(env.LUOOME_MARKET_REQUEST_LEASE_MS ?? 30_000),
});

interface RequestEntry {
  payload?: string;
  expiresAt?: number;
  owner?: string;
  leaseUntil?: number;
  errorKind?: SourceErrorKind;
  retryAt?: number;
  batchMissing?: boolean;
}
interface ProviderEntry {
  attempts: number[];
  blockedUntil: number;
  errorKind?: SourceErrorKind;
  limit: number;
  windowMs: number;
}

type Config = ReturnType<typeof marketRequestConfigFromEnv>;
type Claim = { kind: 'cached'; payload: string } | { kind: 'owned' | 'waiting' };
const encode = (value: unknown): string => serialize(value).toString('base64');
const decode = <T>(payload: string): T => deserialize(Buffer.from(payload, 'base64')) as T;

class SuppressedMarketRequest extends SourceExecutionError {
  constructor(
    kind: SourceErrorKind,
    readonly retryAt: number,
  ) {
    super(kind, 'public market provider unavailable');
  }
}

class CoordinatedTransportError extends SourceExecutionError {}

const providerOf = (input: Parameters<typeof fetch>[0], fallback: string): string => {
  // Tencent 全市场快照还会读取新浪目录，不能只按 capability 的来源名称扣额。
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  for (const [source, domains] of [
    ['eastmoney', ['eastmoney.com']],
    ['tencent', ['gtimg.cn', 'qq.com']],
    ['sina', ['sina.com.cn', 'sinajs.cn', 'sina.cn']],
    ['tushare', ['tushare.pro']],
    ['fuyao', ['aicubes.cn']],
    ['10jqka', ['10jqka.com.cn']],
  ] as const) {
    if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return source;
  }
  return fallback;
};

export class MarketRequestCoordinator {
  constructor(
    private readonly store: PublicMarketStore,
    readonly config: Config,
    private readonly clock: () => number = Date.now,
  ) {}

  private entry(key: string): RequestEntry {
    const value = this.store.read(key, this.clock());
    return value === null ? {} : (JSON.parse(value) as RequestEntry);
  }

  private update<T>(key: string, change: (entry: RequestEntry, now: number) => T): T {
    const now = this.clock();
    return this.store.update(
      key,
      now,
      now + this.config.leaseMs + this.config.cacheTtlMs + this.config.cooldownMs,
      (value) => {
        const entry: RequestEntry = value === null ? {} : JSON.parse(value);
        const result = change(entry, this.clock());
        return { value: JSON.stringify(entry), result };
      },
    );
  }

  private claim(key: string, owner: string, singleQuote = false): Claim {
    return this.update(key, (entry, now) => {
      if (entry.payload !== undefined && (entry.expiresAt ?? 0) > now) {
        return { kind: 'cached', payload: entry.payload };
      }
      if ((entry.retryAt ?? 0) > now && !(singleQuote && entry.batchMissing === true))
        throw new SourceExecutionError(
          entry.errorKind ?? 'upstream_error',
          'public market request cooling down',
        );
      if (entry.owner !== undefined && (entry.leaseUntil ?? 0) > now) return { kind: 'waiting' };
      entry.owner = owner;
      entry.leaseUntil = now + this.config.leaseMs;
      delete entry.retryAt;
      delete entry.errorKind;
      delete entry.batchMissing;
      return { kind: 'owned' };
    });
  }

  private finish(
    key: string,
    owner: string,
    payload: string | undefined,
    kind?: SourceErrorKind,
    batchMissing = false,
    retryAt?: number,
  ): void {
    this.update(key, (entry, now) => {
      if (entry.owner !== owner || (entry.leaseUntil ?? 0) <= now) return;
      delete entry.owner;
      delete entry.leaseUntil;
      if (payload !== undefined) {
        entry.payload = payload;
        entry.expiresAt = now + this.config.cacheTtlMs;
        delete entry.errorKind;
        delete entry.retryAt;
        delete entry.batchMissing;
      } else {
        entry.errorKind = kind ?? 'upstream_error';
        entry.retryAt = retryAt ?? now + this.config.cooldownMs;
        entry.batchMissing = batchMissing;
      }
    });
  }

  private async wait(key: string): Promise<string> {
    const deadline = Date.now() + this.config.leaseMs;
    while (Date.now() < deadline) {
      const entry = this.entry(key);
      const now = this.clock();
      if (entry.payload !== undefined && (entry.expiresAt ?? 0) > now) return entry.payload;
      if ((entry.retryAt ?? 0) > now)
        throw new SourceExecutionError(
          entry.errorKind ?? 'upstream_error',
          'public market request failed',
        );
      // 等待者不在本次调用里接管租约，避免超时或 crash 引发一轮请求的重试放大。
      if (entry.owner === undefined || (entry.leaseUntil ?? 0) <= now) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new SourceExecutionError('timeout', 'public market request unavailable');
  }

  private async own<T>(keys: readonly string[], owner: string, run: () => Promise<T>): Promise<T> {
    const timer = setInterval(
      () => {
        try {
          for (const key of keys)
            this.update(key, (entry, now) => {
              if (entry.owner === owner && (entry.leaseUntil ?? 0) > now)
                entry.leaseUntil = now + this.config.leaseMs;
            });
        } catch {
          // 存储故障不能让定时器抛出未捕获异常；过期 owner 无权回写缓存。
          clearInterval(timer);
        }
      },
      Math.max(25, Math.floor(this.config.leaseMs / 3)),
    );
    try {
      return await run();
    } finally {
      clearInterval(timer);
    }
  }

  async execute<C extends MarketCapability>(
    handle: MarketCapabilityHandle<C>,
    input: MarketCapabilityMap[C]['request'],
  ): Promise<MarketCapabilityMap[C]['result']> {
    if (handle.capability === 'batch-quote') {
      return this.quotes(
        handle as MarketCapabilityHandle<'batch-quote'>,
        input as MarketCapabilityMap['batch-quote']['request'],
      ) as Promise<MarketCapabilityMap[C]['result']>;
    }
    const key = this.key(handle.source, handle.capability, input);
    const owner = randomUUID();
    const claim = this.claim(key, owner, handle.capability === 'quote');
    if (claim.kind === 'cached') return decode(claim.payload);
    if (claim.kind === 'waiting') return decode(await this.wait(key));
    return this.own([key], owner, async () => {
      try {
        const result = await handle.execute(input);
        const payload = encode(result);
        this.finish(key, owner, payload);
        return decode(payload);
      } catch (error) {
        this.blockFailure(handle.source, error);
        this.finish(
          key,
          owner,
          undefined,
          sourceErrorKindOf(error),
          false,
          error instanceof SuppressedMarketRequest ? error.retryAt : undefined,
        );
        throw error;
      }
    });
  }

  private async quotes(
    handle: MarketCapabilityHandle<'batch-quote'>,
    input: MarketCapabilityMap['batch-quote']['request'],
  ): Promise<readonly Quote[]> {
    const owner = randomUUID();
    const owned: Array<{ id: string; key: string }> = [];
    const pending: string[] = [];
    const quotes: Quote[] = [];
    let lastError: unknown;
    for (const id of new Set(input.stockIds)) {
      const key = this.key(handle.source, 'quote', { stockId: id });
      try {
        const claim = this.claim(key, owner);
        if (claim.kind === 'cached') quotes.push(decode<Quote>(claim.payload));
        else if (claim.kind === 'owned') owned.push({ id, key });
        else pending.push(key);
      } catch (error) {
        lastError = error;
      }
    }
    if (owned.length > 0)
      await this.own(
        owned.map(({ key }) => key),
        owner,
        async () => {
          try {
            const raw = await handle.execute({ stockIds: owned.map(({ id }) => id) });
            const valid = raw.flatMap((quote) => {
              const result = QuoteSchema.safeParse(quote);
              return result.success ? [result.data] : [];
            });
            for (const { id, key } of owned) {
              const matches = valid.filter((quote) => quoteMatchesStock(quote.stockId, id));
              const quote = matches.length === 1 ? matches[0] : undefined;
              this.finish(
                key,
                owner,
                quote === undefined ? undefined : encode(quote),
                'no_data',
                quote === undefined,
              );
              if (quote !== undefined) quotes.push(quote);
            }
          } catch (error) {
            this.blockFailure(handle.source, error);
            for (const { key } of owned)
              this.finish(
                key,
                owner,
                undefined,
                sourceErrorKindOf(error),
                false,
                error instanceof SuppressedMarketRequest ? error.retryAt : undefined,
              );
            lastError = error;
          }
        },
      );
    await Promise.all(
      pending.map(async (key) => {
        try {
          quotes.push(decode<Quote>(await this.wait(key)));
        } catch (error) {
          lastError = error;
        }
      }),
    );
    if (quotes.length === 0 && lastError !== undefined) throw lastError;
    return quotes;
  }

  private key(
    source: string,
    capability: MarketCapability,
    input: MarketCapabilityMap[MarketCapability]['request'],
  ): string {
    const request =
      'stockId' in input ? { ...input, stockId: input.stockId.trim().toUpperCase() } : input;
    return `request:${source}:${capability}:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;
  }

  private provider<T>(source: string, change: (entry: ProviderEntry, now: number) => T): T {
    const now = this.clock();
    return this.store.update(
      `provider:${source}`,
      now,
      now + Math.max(this.config.windowMs, this.config.cooldownMs, 86_400_000),
      (value) => {
        const entry: ProviderEntry =
          value === null
            ? {
                attempts: [],
                blockedUntil: 0,
                limit: this.config.requestsPerWindow,
                windowMs: this.config.windowMs,
              }
            : JSON.parse(value);
        const lockedAt = this.clock();
        entry.attempts = entry.attempts.filter(
          (at) => at > lockedAt - Math.max(entry.windowMs, this.config.windowMs),
        );
        if (entry.attempts.length === 0 && entry.blockedUntil <= lockedAt) {
          entry.limit = this.config.requestsPerWindow;
          entry.windowMs = this.config.windowMs;
        } else {
          // 活跃窗口配置不一致时取更严格的限制，不能因另一个进程的装配重置配额。
          entry.limit = Math.min(entry.limit, this.config.requestsPerWindow);
          entry.windowMs = Math.max(entry.windowMs, this.config.windowMs);
        }
        const result = change(entry, lockedAt);
        return { value: JSON.stringify(entry), result };
      },
    );
  }

  fetchFor(source: string, fetchImpl: typeof fetch = fetch): typeof fetch {
    return (async (input, init) => {
      const provider = providerOf(input, source);
      const denied = this.provider(provider, (entry, now): SuppressedMarketRequest | undefined => {
        entry.attempts = entry.attempts.filter((at) => at > now - entry.windowMs);
        if (entry.blockedUntil > now)
          return new SuppressedMarketRequest(entry.errorKind ?? 'rate_limited', entry.blockedUntil);
        const first = entry.attempts[0];
        if (entry.attempts.length >= entry.limit && first !== undefined)
          return new SuppressedMarketRequest('rate_limited', first + entry.windowMs);
        entry.attempts.push(now);
        return undefined;
      });
      if (denied !== undefined) throw denied;
      try {
        const response = await fetchImpl(input, init);
        if (!response.ok) {
          const kind = httpStatusErrorKind(response.status);
          let delay = this.config.cooldownMs;
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter !== null) {
            const seconds = Number(retryAfter);
            const retryMs = Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retryAfter) - this.clock();
            if (Number.isFinite(retryMs)) delay = Math.max(delay, Math.min(retryMs, 86_400_000));
          }
          this.block(provider, kind, delay);
          throw new CoordinatedTransportError(kind, `market provider HTTP ${response.status}`);
        }
        return response;
      } catch (error) {
        if (error instanceof CoordinatedTransportError) throw error;
        const kind =
          error instanceof SourceExecutionError
            ? error.kind
            : isAbortError(error)
              ? 'timeout'
              : 'network';
        this.block(provider, kind, this.config.cooldownMs);
        throw new CoordinatedTransportError(kind, 'market provider transport failed', error);
      }
    }) as typeof fetch;
  }

  private block(source: string, kind: SourceErrorKind, delay: number): void {
    this.provider(source, (entry, now) => {
      entry.blockedUntil = Math.max(entry.blockedUntil, now + delay);
      entry.errorKind = kind;
    });
  }

  private blockFailure(source: string, error: unknown): void {
    if (error instanceof SuppressedMarketRequest || error instanceof CoordinatedTransportError)
      return;
    const kind = sourceErrorKindOf(error);
    if (['network', 'timeout', 'rate_limited', 'upstream_error'].includes(kind)) {
      this.block(source, kind, this.config.cooldownMs);
    }
  }
}
