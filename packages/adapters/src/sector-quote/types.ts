import type { SectorQuoteList } from '@luoome/core';

/**
 * SectorQuoteManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/sector-quote/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整列表快照（与 core SectorQuoteList 相同）。 */
export type SectorQuoteManagerResult = SectorQuoteList;

/** manager.fetchList 错误（recoverable 用于决定调用方是否重试）。 */
export interface SectorQuoteError {
  readonly kind: 'adapter_error';
  readonly adapter: 'sector-quote';
  readonly message: string;
  readonly recoverable: boolean;
}

export type SectorQuoteResult =
  | { readonly ok: true; readonly data: SectorQuoteManagerResult }
  | { readonly ok: false; readonly error: SectorQuoteError };

/** 单个数据源适配器（当前仅 eastmoney 实现；name 用于错误 / 日志标识）。 */
export interface SectorQuoteAdapterLike {
  readonly name: string;
  /**
   * 拉取行业板块一页（pageSize 条，按 fid 字段降序）；无数据时返回空 items，不抛错。
   * fid 为上游排序字段码（f3 涨跌幅 / f6 成交额）。
   */
  fetchList(pageSize: number, fid: 'f3' | 'f6'): Promise<{ readonly items: SectorQuoteRawItem[] }>;
}

/** 数据源 adapter 返回的原始条目（snake_case，协议层；涨跌幅已归一为小数）。 */
export interface SectorQuoteRawItem {
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly change_pct: number;
  readonly change: number;
  readonly amount: number;
  readonly up_count?: number | undefined;
  readonly down_count?: number | undefined;
  readonly leading_stock_name?: string | undefined;
  readonly leading_stock_code?: string | undefined;
  readonly leading_stock_change_pct?: number | undefined;
}
