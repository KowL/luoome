import type { NorthboundFlowSeries } from '@luoome/core';

/**
 * NorthboundFlowManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/northbound-flow/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整序列快照（与 core NorthboundFlowSeries 相同）。 */
export type NorthboundFlowManagerResult = NorthboundFlowSeries;

/** manager.fetchSeries 错误（recoverable 用于决定调用方是否重试）。 */
export interface NorthboundFlowError {
  readonly kind: 'adapter_error';
  readonly adapter: 'northbound-flow';
  readonly message: string;
  readonly recoverable: boolean;
}

export type NorthboundFlowResult =
  | { readonly ok: true; readonly data: NorthboundFlowManagerResult }
  | { readonly ok: false; readonly error: NorthboundFlowError };

/** adapter / source 一次序列拉取的完整结果。 */
export interface NorthboundFlowFetchResult {
  readonly endDate: string;
  readonly entries: NorthboundFlowRawEntry[];
}

/** 单个数据源适配器（当前仅 EastmoneySource 实现；name 用于错误 / 日志标识）。 */
export interface NorthboundFlowAdapterLike {
  readonly name: string;
  /**
   * 拉取截止 endDate 的最近 days 个交易日的北向日记录（合并沪/深股通，按 date ASC）。
   * 无数据时返回空 entries，不抛错。
   */
  fetchFlow(endDate: string, days: number): Promise<NorthboundFlowFetchResult>;
}

/** 北向资金域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type NorthboundFlowCapabilityMap = {
  readonly 'northbound-flow': {
    readonly request: { readonly endDate: string; readonly days: number };
    readonly result: NorthboundFlowFetchResult;
  };
};

/** 数据源 adapter 返回的原始日记录（snake_case，协议层；金额已换算为元）。 */
export interface NorthboundFlowRawEntry {
  readonly date: string;
  /** 净买入合计（元）；null = 上游不再披露（2024-08-16 起）。 */
  readonly net_amount: number | null;
  readonly buy_amount: number | null;
  readonly sell_amount: number | null;
  /** 成交总额合计（元）；始终有值。 */
  readonly deal_amount: number;
}
