import type { CorporateActionEventRevision } from '@luoome/core';

/**
 * corporate-action 域类型（设计 §6.1）。
 *
 * Manager 接口不放在 core：core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * 在线单股端点只承载现金/送转事实：allotmentRatio/allotmentPrice 恒 null，
 * dumpId/artifactSha256 恒 null（无内容寻址）；配股证据只能来自
 * adjustment-factors dump，本域不得据在线响应声明配股覆盖完整。
 */

/** 在线补取查询：from/to 按除权日（上海日历日）过滤，省略即全历史。 */
export interface CorporateActionQuery {
  readonly stockId: string;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/** adapter 一次在线补取的完整结果。 */
export interface CorporateActionFetchResult {
  readonly stockId: string;
  /** 按 exDate 升序；零分红零送股行原样保留（可能是配股除权日）。 */
  readonly events: CorporateActionEventRevision[];
}

export interface CorporateActionError {
  readonly kind: 'adapter_error';
  readonly adapter: 'corporate-action';
  readonly message: string;
  readonly recoverable: boolean;
}

export type CorporateActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CorporateActionError };

/** corporate-action 域 capability map（SourceRegistry 实例化，§6.2）。 */
export type CorporateActionCapabilityMap = {
  readonly 'corporate-action': {
    readonly request: CorporateActionQuery;
    readonly result: CorporateActionFetchResult;
  };
};
