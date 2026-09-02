import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  MarketSnapshot,
  MarketSnapshotItem,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import {
  brokenPoolSupports,
  parseSentimentPool,
  sentimentPoolUrl,
} from '../ashare-sentiment/eastmoney.js';
import type {
  AShareSentimentCoverage,
  AShareSentimentPoolSource,
  AShareSentimentRawPool,
} from '../ashare-sentiment/types.js';
import {
  attachDragonTigerSeats,
  dragonTigerListUrl,
  dragonTigerSeatUrl,
  parseDragonTigerReport,
  parseDragonTigerSeatReport,
} from '../dragon-tiger/eastmoney.js';
import type { DragonTigerAdapterLike, DragonTigerFetchResult } from '../dragon-tiger/types.js';
import { limitUpLadderPoolUrl, parseLimitUpLadderPool } from '../limit-up-ladder/eastmoney.js';
import type {
  LimitUpLadderAdapterLike,
  LimitUpLadderFetchResult,
} from '../limit-up-ladder/types.js';
import {
  batchEastmoneyQuotes,
  type EastmoneyMarketRequest,
  fetchEastmoneyBatchQuotes,
  fetchEastmoneyDailyBars,
  fetchEastmoneyIndexQuotes,
  fetchEastmoneyIntradayMinutes,
  fetchEastmoneyMarketSnapshot,
  fetchEastmoneyMarketSnapshotEnvelope,
  fetchEastmoneyQuote,
  searchEastmoneyStocks,
} from '../market/eastmoney.js';
import { newsListUrl, parseNewsList } from '../news/eastmoney.js';
import type { NewsAdapterLike, NewsFetchResult } from '../news/types.js';
import {
  mergeNorthboundChannels,
  NORTHBOUND_CHANNELS,
  northboundChannelUrl,
  parseNorthboundChannel,
} from '../northbound-flow/eastmoney.js';
import type {
  NorthboundFlowAdapterLike,
  NorthboundFlowFetchResult,
} from '../northbound-flow/types.js';
import { sourceErrorKindOf } from '../source-error.js';
import { getJson } from './client.js';

/**
 * EastmoneySource：Eastmoney 在本仓库全部能力的单一归属
 * （docs/ddd/source-pluggability-and-observation-design.md §4.2）。
 *
 * - HTTP 管道收敛到 eastmoney/client.ts；URL 模板与字段映射保留在各域目录的纯函数，
 *   本类只做方法委托与观测所需的观测时刻 / 错误归一；
 * - 结构性满足 market 的 MarketDataAdapter 与五个非行情域的 *AdapterLike / PoolSource；
 * - 方法间不共享领域状态；未来第二源出现时本类不需要拆分。
 */

/** 行情系（push2）沿用原 5s 默认；非行情域沿用原 10s 默认。 */
const MARKET_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * push2 主域在部分网络环境被按端点定向阻断（socket reset / curl 000，2026-08 实测），
 * push2delay 是东财官方延迟行情镜像，同路径同字段（延迟约 15 分钟）。
 * 仅在传输层失败（network/timeout）时降级重试一次；HTTP 状态与解析错误不重试。
 */
const PUSH2_HOST = 'push2.eastmoney.com';
const PUSH2_DELAY_HOST = 'push2delay.eastmoney.com';

/** 历史日为该交易日收盘时刻（15:00 +08:00），当日为 min(fetchedAt, closeAt)（§6.2）。 */
const tradingDayObservedAt = (date: string, fetchedAt: Date): Date => {
  const closeAt = new Date(`${date}T15:00:00+08:00`);
  return closeAt.getTime() <= fetchedAt.getTime() ? closeAt : fetchedAt;
};

/**
 * 传输错误 → 情绪池存量 errorKind 词表（结果契约不变，映射只发生在池边界）：
 * network/timeout → network_error；invalid_payload → invalid_response；其余 → http_error。
 */
const sentimentPoolErrorKindOf = (
  error: unknown,
): 'network_error' | 'http_error' | 'invalid_response' => {
  const kind = sourceErrorKindOf(error);
  if (kind === 'network' || kind === 'timeout') return 'network_error';
  if (kind === 'invalid_payload') return 'invalid_response';
  return 'http_error';
};

export interface EastmoneySourceOptions {
  /** 测试用：替换 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 覆盖全部端点超时；缺省时行情 5s、非行情 10s。 */
  readonly timeoutMs?: number;
  /** 业务时钟（observedAt / fetchedAt / 30 天窗口判定）。 */
  readonly clock?: () => Date;
  /** 毫秒时钟（news req_trace 参数）。 */
  readonly now?: () => number;
}

export class EastmoneySource
  implements
    LimitUpLadderAdapterLike,
    DragonTigerAdapterLike,
    AShareSentimentPoolSource,
    NorthboundFlowAdapterLike,
    NewsAdapterLike
{
  readonly name = 'eastmoney';
  readonly indexQuoteMode = 'realtime' as const;

  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly clock: () => Date;
  private readonly now: () => number;
  private readonly marketHttp: EastmoneyMarketRequest;

  constructor(options: EastmoneySourceOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock ?? (() => new Date());
    this.now = options.now ?? Date.now;
    this.marketHttp = {
      getJson: (url) => this.marketJson(url),
      clock: this.clock,
    };
  }

  private marketJson(url: string): Promise<unknown> {
    return this.marketFetch(url).catch((error: unknown) => {
      const kind = sourceErrorKindOf(error);
      if ((kind !== 'network' && kind !== 'timeout') || !url.includes(PUSH2_HOST)) {
        throw error;
      }
      return this.marketFetch(url.replace(PUSH2_HOST, PUSH2_DELAY_HOST));
    });
  }

  private marketFetch(url: string): Promise<unknown> {
    return getJson(url, {
      timeoutMs: this.timeoutMs ?? MARKET_TIMEOUT_MS,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
  }

  private json(url: string): Promise<unknown> {
    return getJson(url, {
      timeoutMs: this.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
  }

  // ---------- market（push2 行情系） ----------

  fetchQuote(stockCode: string): Promise<Quote> {
    return fetchEastmoneyQuote(this.marketHttp, stockCode);
  }

  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    return batchEastmoneyQuotes(this.marketHttp, stockCodes);
  }

  /** batch-quote capability 入口：ulist.np/get 原生批量（单次请求多 secid）。 */
  fetchBatchQuotes(stockIds: readonly string[]): Promise<Quote[]> {
    return fetchEastmoneyBatchQuotes(this.marketHttp, stockIds);
  }

  fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    return fetchEastmoneyIndexQuotes(this.marketHttp);
  }

  fetchIntradayMinutes(stockCode: string): Promise<readonly IntradayMinute[]> {
    return fetchEastmoneyIntradayMinutes(this.marketHttp, stockCode);
  }

  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    return fetchEastmoneyDailyBars(this.marketHttp, stockCode, range);
  }

  searchStocks(query: string): Promise<StockSearchCandidate[]> {
    return searchEastmoneyStocks(this.marketHttp, query);
  }

  fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return fetchEastmoneyMarketSnapshot(this.marketHttp);
  }

  fetchMarketSnapshotEnvelope(): Promise<MarketSnapshot> {
    return fetchEastmoneyMarketSnapshotEnvelope(this.marketHttp);
  }

  // ---------- limit-up-ladder（push2ex 池系） ----------

  /** days 忽略：连板数由 pool 的 lbc 直接给出，不需要样本窗口。 */
  async fetchLadder(
    date: string,
    _opts?: { readonly days?: number },
  ): Promise<LimitUpLadderFetchResult> {
    const raw = await this.json(limitUpLadderPoolUrl(date));
    const fetchedAt = this.clock();
    return {
      date,
      observedAt: tradingDayObservedAt(date, fetchedAt),
      entries: parseLimitUpLadderPool(raw, date),
    };
  }

  // ---------- dragon-tiger（datacenter-web 报表系） ----------

  async fetchList(date: string): Promise<DragonTigerFetchResult> {
    const raw = await this.json(dragonTigerListUrl(date));
    const [buyResult, sellResult] = await Promise.allSettled([
      this.json(dragonTigerSeatUrl(date, 'buy')),
      this.json(dragonTigerSeatUrl(date, 'sell')),
    ]);
    const fetchedAt = this.clock();
    const entries = parseDragonTigerReport(raw);
    const buySeats =
      buyResult.status === 'fulfilled' ? parseDragonTigerSeatReport(buyResult.value, 'buy') : [];
    const sellSeats =
      sellResult.status === 'fulfilled' ? parseDragonTigerSeatReport(sellResult.value, 'sell') : [];
    return {
      date,
      observedAt: tradingDayObservedAt(date, fetchedAt),
      entries: attachDragonTigerSeats(entries, buySeats, sellSeats),
    };
  }

  // ---------- ashare-sentiment（封板 / 炸板双池） ----------

  fetchSealedPool(input: {
    readonly date: string;
    readonly coverage: AShareSentimentCoverage;
  }): Promise<AShareSentimentRawPool> {
    return this.fetchPool('sealed', input.date);
  }

  fetchBrokenPool(input: {
    readonly date: string;
    readonly coverage: AShareSentimentCoverage;
  }): Promise<AShareSentimentRawPool> {
    return this.fetchPool('broken', input.date);
  }

  /** 池级失败返回 ok:false 池（存量结果契约），不抛错；观测分类由 binding 的 observationOf 承担。 */
  private async fetchPool(
    kind: 'sealed' | 'broken',
    date: string,
  ): Promise<AShareSentimentRawPool> {
    if (kind === 'broken' && !brokenPoolSupports(date, this.clock())) {
      return {
        ok: false,
        fetchedAt: this.clock(),
        errorKind: 'unsupported_date',
        errorMessage: 'eastmoney broken pool only supports the most recent 30 days',
      };
    }
    try {
      const raw = await this.json(sentimentPoolUrl(kind, date));
      const fetchedAt = this.clock();
      return {
        ok: true,
        observedAt: tradingDayObservedAt(date, fetchedAt),
        fetchedAt,
        entries: parseSentimentPool(raw, kind),
      };
    } catch (error) {
      return {
        ok: false,
        fetchedAt: this.clock(),
        errorKind: sentimentPoolErrorKindOf(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---------- northbound-flow（datacenter-web 报表系） ----------

  /** 沪 / 深两个通道各拉 days 行（每交易日一行），按日期合并。 */
  async fetchFlow(endDate: string, days: number): Promise<NorthboundFlowFetchResult> {
    const rows = (
      await Promise.all(
        NORTHBOUND_CHANNELS.map(async (channel) =>
          parseNorthboundChannel(await this.json(northboundChannelUrl(channel, endDate, days))),
        ),
      )
    ).flat();
    return { endDate, entries: mergeNorthboundChannels(rows, days) };
  }

  // ---------- news（要闻滚动栏目） ----------

  async fetchNews(page: number, pageSize: number): Promise<NewsFetchResult> {
    const raw = await this.json(newsListUrl(page, pageSize, this.now()));
    return { items: parseNewsList(raw) };
  }
}
