import type { Holiday, Logger, NorthboundFlowQuery, SourceStatus } from '@luoome/core';
import {
  BUILTIN_HOLIDAYS,
  dateInShanghai,
  isHoliday,
  isWeekend,
  NORTHBOUND_NET_UNDISCLOSED_WARNING,
} from '@luoome/core';

import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { NorthboundFlowCapabilityMap, NorthboundFlowResult } from './types.js';

/**
 * NorthboundFlowManager。
 *
 * 对齐 dragon-tiger manager 的错误模型与交易日历语义：
 * - 无缓存：日级序列查询成本低
 * - 源循环替换为 registry handle 循环（docs/ddd/source-pluggability-and-observation-design.md §6.3）：
 *   按绑定顺序 fallback；显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 节假日历直接复用 core/trading-calendar
 * - endDate 缺省：取当天（Asia/Shanghai）；非交易日向前对齐到最近交易日（不做空结果报错，
 *   因为序列查询的语义是"截止到最近一个有数据的交易日"）
 * - 空序列 → 正常返回 + warnings=['empty-list']；净买入未披露 → 附加口径 warning
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<NorthboundFlowCapabilityMap>;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** 测试用：注入节假日历避免实际环境依赖。 */
  readonly holidaysProvider?: () => Promise<ReadonlyMap<number, ReadonlySet<Holiday>>>;
}

/** 直接构造 Manager 时的最小 fallback；生产 factory 会注入 core 的完整三层日历。 */
const defaultHolidaysProvider = async (): Promise<ReadonlyMap<number, ReadonlySet<Holiday>>> =>
  BUILTIN_HOLIDAYS;

/** 向前对齐最多回溯的天数（覆盖国庆 / 春节长假）。 */
const MAX_LOOKBACK_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function errorResult(message: string): NorthboundFlowResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'northbound-flow',
      message,
      recoverable: false,
    },
  };
}

export class NorthboundFlowManager {
  readonly name = 'northbound-flow' as const;
  readonly sources: readonly string[];

  private readonly handles: readonly SourceHandle<NorthboundFlowCapabilityMap, 'northbound-flow'>[];
  private readonly registry: SourceRegistry<NorthboundFlowCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly holidaysProvider: () => Promise<ReadonlyMap<number, ReadonlySet<Holiday>>>;

  private holidays: ReadonlyMap<number, ReadonlySet<Holiday>> | undefined;
  private holidaysLoading: Promise<ReadonlyMap<number, ReadonlySet<Holiday>>> | undefined;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('northbound-flow');
    if (this.handles[0] === undefined) {
      throw new Error('northbound-flow registry 缺少 northbound-flow capability 绑定');
    }
    this.sources = [...new Set(this.handles.map((handle) => handle.source))];
    this.logger = opts.logger;
    this.clock = opts.clock;
    this.holidaysProvider = opts.holidaysProvider ?? defaultHolidaysProvider;
  }

  status(): readonly SourceStatus[] {
    return this.registry.describe();
  }

  private async getHolidays(): Promise<ReadonlyMap<number, ReadonlySet<Holiday>>> {
    if (this.holidays !== undefined) return this.holidays;
    if (this.holidaysLoading === undefined) {
      this.holidaysLoading = this.holidaysProvider();
    }
    this.holidays = await this.holidaysLoading;
    return this.holidays;
  }

  private isTradingDay(date: string): boolean {
    const d = new Date(`${date}T00:00:00Z`);
    if (isWeekend(d)) return false;
    if (this.holidays !== undefined && isHoliday(d, this.holidays)) return false;
    return true;
  }

  /** 把 date（或当天）向前对齐到最近交易日；极端情况下回退到起点本身。 */
  private alignToTradingDay(from: Date): string {
    let d = new Date(`${dateInShanghai(from)}T00:00:00Z`);
    for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
      const ds = dateInShanghai(d);
      if (this.isTradingDay(ds)) return ds;
      d = new Date(d.getTime() - DAY_MS);
    }
    return dateInShanghai(from);
  }

  async fetchSeries(query: NorthboundFlowQuery): Promise<NorthboundFlowResult> {
    const now = this.clock();

    // 显式 source 路由约束：只尝试该源；未启用返回既有 adapter_error 协议（§4.6）
    const handles =
      query.source === undefined
        ? this.handles
        : this.handles.filter((handle) => handle.source === query.source);
    if (handles.length === 0) {
      return errorResult(`source ${String(query.source)} 未启用`);
    }

    // 确保节假日历加载完毕再判定交易日
    if (this.holidays === undefined) {
      await this.getHolidays();
    }

    const endDate = this.alignToTradingDay(
      query.endDate === undefined ? now : new Date(`${query.endDate}T00:00:00Z`),
    );

    let lastError: unknown;
    for (const handle of handles) {
      try {
        const rawResult = await handle.execute({ endDate, days: query.days });

        const series = rawResult.entries.map((e) => ({
          date: e.date,
          netAmount: e.net_amount,
          buyAmount: e.buy_amount,
          sellAmount: e.sell_amount,
          dealAmount: e.deal_amount,
        }));

        const warnings: string[] = [];
        if (series.length === 0) warnings.push('empty-list');
        if (series.some((e) => e.netAmount === null)) {
          warnings.push(NORTHBOUND_NET_UNDISCLOSED_WARNING);
        }

        return {
          ok: true,
          data: {
            endDate,
            days: series.length,
            source: handle.source,
            series,
            warnings,
            asOf: now,
          },
        };
      } catch (err) {
        this.logger.warn('northbound-flow source failed', {
          source: handle.source,
          error: err instanceof Error ? err.message : String(err),
        });
        lastError = err;
      }
    }

    return errorResult(
      `all sources failed (${handles.map((handle) => handle.source).join(' → ')}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
