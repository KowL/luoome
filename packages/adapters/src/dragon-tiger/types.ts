import type { DragonTigerList } from '@luoome/core';

/**
 * DragonTigerManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/dragon-tiger/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整快照（与 core DragonTigerList 相同）。 */
export type DragonTigerManagerResult = DragonTigerList;

/** manager.fetchList 错误（recoverable 用于决定调用方是否重试）。 */
export interface DragonTigerError {
  readonly kind: 'adapter_error';
  readonly adapter: 'dragon-tiger';
  readonly message: string;
  readonly recoverable: boolean;
}

export type DragonTigerResult =
  | { readonly ok: true; readonly data: DragonTigerManagerResult }
  | { readonly ok: false; readonly error: DragonTigerError };

/** adapter / source 一次榜单拉取的完整结果；observedAt 供 registry 观测（§6.2）。 */
export interface DragonTigerFetchResult {
  readonly date: string;
  /** 源实际观测时刻：历史日为收盘时刻，当日为 min(fetchedAt, 收盘)。 */
  readonly observedAt: Date;
  readonly entries: DragonTigerRawEntry[];
}

/** 单个数据源适配器（当前仅 EastmoneySource 实现；name 用于错误 / 日志标识）。 */
export interface DragonTigerAdapterLike {
  readonly name: string;
  fetchList(date: string): Promise<DragonTigerFetchResult>;
}

/** 龙虎榜域的 capability map（SourceRegistry 实例化，§6.2）。 */
export type DragonTigerCapabilityMap = {
  readonly 'dragon-tiger-list': {
    readonly request: { readonly date: string };
    readonly result: DragonTigerFetchResult;
  };
};

/** 数据源 adapter 返回的原始条目（snake_case，协议层）。 */
export interface DragonTigerRawEntry {
  readonly code: string;
  readonly name?: string | undefined;
  readonly close: number;
  readonly change_pct?: number | undefined;
  readonly turnover_rate?: number | undefined;
  readonly reason?: string | undefined;
  readonly net_amount?: number | undefined;
  readonly buy_amount?: number | undefined;
  readonly sell_amount?: number | undefined;
  readonly amount?: number | undefined;
  readonly trade_date?: string | undefined;
}
