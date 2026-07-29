import type {
  AShareSentimentRawEntry,
  AShareSentimentRawPool,
  AShareSentimentSource,
} from './types.js';

const SEALED_POOL_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const BROKEN_POOL_URL = 'https://push2ex.eastmoney.com/getTopicZBPool';
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DEFAULT_TIMEOUT_MS = 10_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const exchangeFor = (code: string): 'SH' | 'SZ' | undefined => {
  if (/^(?:6|68)\d{5}$/.test(code)) return 'SH';
  if (/^(?:0|3)\d{5}$/.test(code)) return 'SZ';
  return undefined;
};

const nonnegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const nonnegativeInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

const ladderLevelFrom = (value: Record<string, unknown>): number => {
  const direct = positiveInt(value.lbc);
  if (direct !== undefined) return direct;
  const stat = value.zttj;
  if (typeof stat === 'object' && stat !== null) {
    const record = stat as Record<string, unknown>;
    return positiveInt(record.ct) ?? positiveInt(record.days) ?? 1;
  }
  if (typeof stat === 'string') {
    const match = stat.match(/(\d+)\s*板/);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return 1;
};

const parseEntry = (
  value: unknown,
  kind: 'sealed' | 'broken',
): AShareSentimentRawEntry | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.c !== 'string') return undefined;
  const exchange = exchangeFor(record.c);
  if (exchange === undefined) return undefined;
  const name =
    typeof record.n === 'string' && record.n.trim().length > 0 ? record.n.trim() : record.c;
  const industry =
    typeof record.hybk === 'string' && record.hybk.trim().length > 0
      ? record.hybk.trim()
      : undefined;
  return {
    stockId: `${record.c}.${exchange}`,
    name,
    ladderLevel: ladderLevelFrom(record),
    sealAmount: kind === 'sealed' ? nonnegativeNumber(record.fund) : null,
    openCount: nonnegativeInt(record.zbc),
    ...(industry === undefined ? {} : { industry }),
    concepts: [],
  };
};

const observedAtFor = (date: string, fetchedAt: Date): Date => {
  const closeAt = new Date(`${date}T15:00:00+08:00`);
  return closeAt.getTime() <= fetchedAt.getTime() ? closeAt : fetchedAt;
};

const brokenPoolSupports = (date: string, now: Date): boolean => {
  const cutoff = new Date(now.getTime() + SHANGHAI_OFFSET_MS - THIRTY_DAYS_MS)
    .toISOString()
    .slice(0, 10);
  return date >= cutoff;
};

export class EastmoneyAShareSentimentAdapter implements AShareSentimentSource {
  readonly name = 'eastmoney' as const;
  readonly capabilities = ['limit-up', 'broken-board', 'themes'] as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async fetch(input: { readonly date: string; readonly coverage: 'CN_A_SHARES_SH_SZ' }) {
    const ymd = input.date.replaceAll('-', '');
    const query = `ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=5000&sort=fbt:asc&date=${ymd}`;
    const requestedAt = this.clock();
    const brokenPromise = brokenPoolSupports(input.date, requestedAt)
      ? this.fetchPool(`${BROKEN_POOL_URL}?${query}`, input.date, 'broken')
      : Promise.resolve({
          ok: false as const,
          fetchedAt: requestedAt,
          errorKind: 'unsupported_date' as const,
          errorMessage: 'eastmoney broken pool only supports the most recent 30 days',
        });
    const [sealed, broken] = await Promise.all([
      this.fetchPool(`${SEALED_POOL_URL}?${query}`, input.date, 'sealed'),
      brokenPromise,
    ]);
    return {
      date: input.date,
      coverage: input.coverage,
      source: this.name,
      sealed,
      broken,
    };
  }

  private async fetchPool(
    url: string,
    date: string,
    kind: 'sealed' | 'broken',
  ): Promise<AShareSentimentRawPool> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      const fetchedAt = this.clock();
      return {
        ok: false,
        fetchedAt,
        errorKind: 'network_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
    const fetchedAt = this.clock();
    if (!response.ok) {
      return {
        ok: false,
        fetchedAt,
        errorKind: 'http_error',
        errorMessage: `eastmoney ${kind} pool HTTP ${response.status}`,
      };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      return {
        ok: false,
        fetchedAt,
        errorKind: 'invalid_response',
        errorMessage: `eastmoney ${kind} pool invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const data =
      typeof raw === 'object' && raw !== null
        ? ((raw as Record<string, unknown>).data as Record<string, unknown> | null | undefined)
        : undefined;
    const pool = Array.isArray(data?.pool) ? data.pool : [];
    const entries = pool
      .map((item) => parseEntry(item, kind))
      .filter((entry): entry is AShareSentimentRawEntry => entry !== undefined);
    return {
      ok: true,
      observedAt: observedAtFor(date, fetchedAt),
      fetchedAt,
      entries,
    };
  }
}
