import type { StockProfile } from '@luoome/core';

/**
 * StockProfileManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/stock-profile/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整快照（与 core StockProfile 相同）。 */
export type StockProfileManagerResult = StockProfile;

/** manager.fetchProfile 错误（recoverable 用于决定调用方是否重试）。 */
export interface StockProfileError {
  readonly kind: 'adapter_error';
  readonly adapter: 'stock-profile';
  readonly message: string;
  readonly recoverable: boolean;
}

export type StockProfileResult =
  | { readonly ok: true; readonly data: StockProfileManagerResult }
  | { readonly ok: false; readonly error: StockProfileError };

/** adapter / source 一次档案拉取的完整结果；observedAt 供 registry 观测（§6.2）。 */
export interface StockProfileFetchResult {
  /** 源实际观测时刻。 */
  readonly observedAt: Date;
  readonly holders: readonly StockProfileRawHolder[];
  readonly concepts: readonly StockProfileRawConcept[];
}

/** 单期股东户数（协议层，snake_case 口径已在上游字段名上保留原义）。 */
export interface StockProfileRawHolder {
  /** 统计截止日 YYYY-MM-DD。 */
  readonly endDate: string;
  readonly holderNum: number;
  /** 较上期变动比例（小数，-0.0184 = -1.84%）；上游未披露为 null。 */
  readonly changePct: number | null;
  /** 户均持股（股）。 */
  readonly avgShares: number | null;
  /** 户均市值（元）。 */
  readonly avgMarketValue: number | null;
}

/** 所属板块（协议层）。 */
export interface StockProfileRawConcept {
  readonly code: string;
  readonly name: string;
  /** 上游标注的板块类型（行业 / 板块）；未标注为 null。 */
  readonly boardType: string | null;
  /** 上游标记是否为精确归属（1 精确 / 0 宽泛）。 */
  readonly precise: boolean;
  /** 上游给出的板块内排序；缺失为 null。 */
  readonly rank: number | null;
  /** 入选理由原文；上游未给出为 null。 */
  readonly reason: string | null;
}

/** 个股档案域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type StockProfileCapabilityMap = {
  readonly 'stock-profile': {
    readonly request: { readonly stockId: string };
    readonly result: StockProfileFetchResult;
  };
};
