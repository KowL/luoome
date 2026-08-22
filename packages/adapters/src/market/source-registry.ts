import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  MarketCoverage,
  MarketSnapshot,
  MarketSnapshotItem,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  SourceStatus,
  StockSearchCandidate,
} from '@luoome/core';

import {
  type AnyBinding,
  type SourceBinding,
  type SourceHandle,
  SourceRegistry,
} from '../source-registry.js';

/**
 * 行情域的 SourceRegistry 实例化（薄壳）：capability map 注入 10 种行情能力的
 * request/result 类型；MarketCoverage 的 coverage 过滤规则保留在本层——
 * 通用 registry 只保存 coverage 元数据，不理解 MarketCoverage 的包含关系。
 * 观测状态机、绑定校验与路由顺序全部由泛型核心承担。
 */

export type MarketCapability =
  | 'quote'
  | 'batch-quote'
  | 'daily-bars'
  | 'search'
  | 'market-snapshot'
  | 'market-snapshot-envelope'
  | 'realtime-index'
  | 'delayed-index'
  | 'intraday-minutes'
  | 'minute-bars';

export type MarketCapabilityMap = {
  readonly quote: { readonly request: { readonly stockId: string }; readonly result: Quote };
  /**
   * 原生批量快照（C2）：request 是一组 stockId，result 是不占位的 Quote 数组
   * （缺漏标的不出现在结果中）。只有 HTTP API 真实支持多代码单请求的源才绑定。
   */
  readonly 'batch-quote': {
    readonly request: { readonly stockIds: readonly string[] };
    readonly result: readonly Quote[];
  };
  readonly 'daily-bars': {
    readonly request: { readonly stockId: string; readonly range: DateRange };
    readonly result: readonly DailyBar[];
  };
  readonly search: {
    readonly request: { readonly query: string };
    readonly result: readonly StockSearchCandidate[];
  };
  readonly 'market-snapshot': {
    readonly request: { readonly coverage: MarketCoverage };
    readonly result: readonly MarketSnapshotItem[];
  };
  readonly 'market-snapshot-envelope': {
    readonly request: { readonly coverage: MarketCoverage };
    readonly result: MarketSnapshot;
  };
  readonly 'realtime-index': {
    readonly request: { readonly coverage: MarketCoverage };
    readonly result: readonly IndexQuote[];
  };
  readonly 'delayed-index': {
    readonly request: { readonly coverage: MarketCoverage; readonly asOf: Date };
    readonly result: readonly IndexQuote[];
  };
  readonly 'intraday-minutes': {
    readonly request: { readonly stockId: string };
    readonly result: readonly IntradayMinute[];
  };
  readonly 'minute-bars': {
    readonly request: { readonly stockId: string; readonly interval: MinuteBarInterval };
    readonly result: readonly MinuteBar[];
  };
};

export type MarketCapabilityBinding<C extends MarketCapability = MarketCapability> = SourceBinding<
  MarketCapabilityMap,
  C
>;

export type AnyMarketCapabilityBinding = AnyBinding<MarketCapabilityMap>;

export type MarketCapabilityHandle<C extends MarketCapability> = SourceHandle<
  MarketCapabilityMap,
  C
>;

/** 行情域的 SourceStatus 收窄：dataset 为 MarketCapability、coverage 为 MarketCoverage。 */
export type MarketSourceStatus = Omit<SourceStatus, 'dataset' | 'coverage'> & {
  readonly dataset: MarketCapability;
  readonly coverage: readonly MarketCoverage[];
};

export class MarketSourceRegistry {
  private readonly registry: SourceRegistry<MarketCapabilityMap>;

  constructor(bindings: readonly AnyMarketCapabilityBinding[], clock: () => Date) {
    this.registry = new SourceRegistry(bindings, clock);
  }

  sources<C extends MarketCapability>(
    capability: C,
    constraint?: { readonly coverage?: MarketCoverage },
  ): readonly MarketCapabilityHandle<C>[] {
    const handles = this.registry.sources(capability);
    if (constraint?.coverage === undefined) return handles;
    const coverage = constraint.coverage;
    return handles.filter((handle) => handle.coverage.includes(coverage));
  }

  describe(): readonly MarketSourceStatus[] {
    return this.registry.describe().map((status) => status as MarketSourceStatus);
  }
}
