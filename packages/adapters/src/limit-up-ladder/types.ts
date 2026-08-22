import type { LimitUpLadder } from '@luoome/core';

/**
 * LimitUpLadderManager 接口（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §4.1）。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/limit-up-ladder/manager.ts；core/context.ts 只引用本接口。
 */

/** 修正后的完整快照（与 core LimitUpLadder 相同，Manager 返回类型）。 */
export type LimitUpLadderManagerResult = LimitUpLadder;

/** manager.fetchLadder 错误（recoverable 用于决定 workflow 是否重试）。 */
export interface LimitUpLadderError {
  readonly kind: 'adapter_error';
  readonly adapter: 'limit-up-ladder';
  readonly message: string;
  readonly recoverable: boolean;
}

export type LimitUpLadderResult =
  | { readonly ok: true; readonly data: LimitUpLadderManagerResult }
  | { readonly ok: false; readonly error: LimitUpLadderError };

/** adapter / source 一次天梯拉取的完整结果；observedAt 供 registry 观测（§6.2）。 */
export interface LimitUpLadderFetchResult {
  readonly date: string;
  /** 源实际观测时刻：历史日为收盘时刻，当日为 min(fetchedAt, 收盘)。 */
  readonly observedAt: Date;
  readonly entries: LimitUpLadderRawEntry[];
}

/** 单个数据源适配器（当前仅 EastmoneySource 实现；name 用于错误 / 日志标识）。 */
export interface LimitUpLadderAdapterLike {
  readonly name: string;
  fetchLadder(date: string, opts?: { readonly days?: number }): Promise<LimitUpLadderFetchResult>;
}

/** 连板天梯域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type LimitUpLadderCapabilityMap = {
  readonly 'limit-up-ladder': {
    readonly request: { readonly date: string; readonly days: number };
    readonly result: LimitUpLadderFetchResult;
  };
};

/** 数据源 adapter 返回的原始条目（snake_case，协议层）。 */
export interface LimitUpLadderRawEntry {
  readonly code: string;
  readonly name?: string | undefined;
  readonly industry?: string | undefined;
  readonly level?: number | undefined;
  readonly limit_up_days?: number | undefined;
  readonly first_time?: string | undefined;
  readonly final_time?: string | undefined;
  readonly reason?: string | undefined;
  readonly close: number;
  readonly pre_close?: number | undefined;
  readonly change_pct?: number | undefined;
  readonly limit_up_date?: string | undefined;
  readonly high?: number | undefined;
}
