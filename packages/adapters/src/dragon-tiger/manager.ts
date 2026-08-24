import type {
  DragonTigerEntry,
  DragonTigerListQuery,
  Holiday,
  Logger,
  SourceStatus,
} from '@luoome/core';
import { BUILTIN_HOLIDAYS, dateInShanghai, isHoliday, isWeekend } from '@luoome/core';

import type { SourceHandle, SourceRegistry } from '../source-registry.js';
import type { DragonTigerCapabilityMap, DragonTigerRawEntry, DragonTigerResult } from './types.js';

/**
 * DragonTigerManager。
 *
 * 对齐 limit-up-ladder manager 的错误模型与交易日历语义，但刻意简化：
 * - 无 LRU 缓存：龙虎榜收盘后一次性发布，日级粒度重复拉取成本可接受
 * - 源循环替换为 registry handle 循环（docs/ddd/source-pluggability-and-observation-design.md §6.3）：
 *   按绑定顺序 fallback；显式 query.source 只尝试该源，未启用返回既有 adapter_error 协议
 * - 节假日历直接复用 core/trading-calendar（limit-up-ladder 内联实现已随日历下沉 core 而失去必要）
 * - 非交易日：不调远端、不写观测，直接返回空榜单 + warnings=['non-trading-day']，
 *   结果 source 用显式约束或配置首项（§4.6）
 * - date 缺省：取当天（Asia/Shanghai）；当天非交易日回退到最近交易日
 */

interface ManagerOptions {
  readonly registry: SourceRegistry<DragonTigerCapabilityMap>;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** 测试用：注入节假日历避免实际环境依赖。 */
  readonly holidaysProvider?: () => Promise<ReadonlyMap<number, ReadonlySet<Holiday>>>;
}

/** 直接构造 Manager 时的最小 fallback；生产 factory 会注入 core 的完整三层日历。 */
const defaultHolidaysProvider = async (): Promise<ReadonlyMap<number, ReadonlySet<Holiday>>> =>
  BUILTIN_HOLIDAYS;

/** 缺省日期最多向前回溯的天数（覆盖国庆 / 春节长假）。 */
const MAX_LOOKBACK_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function mapEntry(raw: DragonTigerRawEntry, date: string): DragonTigerEntry {
  return {
    code: raw.code,
    name: raw.name?.trim() ?? raw.code,
    close: raw.close,
    changePct: raw.change_pct ?? 0,
    turnoverRate: raw.turnover_rate ?? 0,
    reason: raw.reason?.trim() ?? '--',
    netAmount: raw.net_amount ?? 0,
    buyAmount: raw.buy_amount ?? 0,
    sellAmount: raw.sell_amount ?? 0,
    amount: raw.amount ?? 0,
    tradeDate: raw.trade_date ?? date,
    ...(raw.buy_seats === undefined
      ? {}
      : { buySeats: raw.buy_seats.map((seat) => ({ name: seat.name, amount: seat.amount })) }),
    ...(raw.sell_seats === undefined
      ? {}
      : { sellSeats: raw.sell_seats.map((seat) => ({ name: seat.name, amount: seat.amount })) }),
  };
}

function errorResult(message: string): DragonTigerResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'dragon-tiger',
      message,
      recoverable: false,
    },
  };
}

export class DragonTigerManager {
  readonly name = 'dragon-tiger' as const;
  readonly sources: readonly string[];

  private readonly handles: readonly SourceHandle<DragonTigerCapabilityMap, 'dragon-tiger-list'>[];
  private readonly registry: SourceRegistry<DragonTigerCapabilityMap>;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly holidaysProvider: () => Promise<ReadonlyMap<number, ReadonlySet<Holiday>>>;

  private holidays: ReadonlyMap<number, ReadonlySet<Holiday>> | undefined;
  private holidaysLoading: Promise<ReadonlyMap<number, ReadonlySet<Holiday>>> | undefined;

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.handles = opts.registry.sources('dragon-tiger-list');
    if (this.handles[0] === undefined) {
      throw new Error('dragon-tiger registry 缺少 dragon-tiger-list capability 绑定');
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

  /** 从 `from`（Asia/Shanghai 当日）向前找最近交易日；极端情况下回退到 from 本身。 */
  private latestTradingDay(from: Date): string {
    let d = new Date(`${dateInShanghai(from)}T00:00:00Z`);
    for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
      const ds = dateInShanghai(d);
      if (this.isTradingDay(ds)) return ds;
      d = new Date(d.getTime() - DAY_MS);
    }
    return dateInShanghai(from);
  }

  async fetchList(query: DragonTigerListQuery): Promise<DragonTigerResult> {
    const now = this.clock();

    // 显式 source 路由约束：只尝试该源；未启用返回既有 adapter_error 协议（§4.6）
    const handles =
      query.source === undefined
        ? this.handles
        : this.handles.filter((handle) => handle.source === query.source);
    const firstHandle = handles[0] ?? this.handles[0];
    if (handles.length === 0 || firstHandle === undefined) {
      return errorResult(`source ${String(query.source)} 未启用`);
    }

    // 确保节假日历加载完毕再判定交易日
    if (this.holidays === undefined) {
      await this.getHolidays();
    }

    const date = query.date ?? this.latestTradingDay(now);

    // 非交易日：直接返回空榜单（不调远端、不写观测；source 取显式约束或配置首项，§4.6）
    if (!this.isTradingDay(date)) {
      return {
        ok: true,
        data: {
          date,
          total: 0,
          source: query.source ?? firstHandle.source,
          entries: [],
          warnings: ['non-trading-day'],
          asOf: now,
        },
      };
    }

    let lastError: unknown;
    for (const handle of handles) {
      try {
        const rawResult = await handle.execute({ date });
        const entries = rawResult.entries.map((e) => mapEntry(e, date));
        const warnings: string[] = [];
        if (entries.length === 0) warnings.push('empty-list');

        return {
          ok: true,
          data: {
            date,
            total: entries.length,
            source: handle.source,
            entries,
            warnings,
            asOf: now,
          },
        };
      } catch (err) {
        this.logger.warn('dragon-tiger source failed', {
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
