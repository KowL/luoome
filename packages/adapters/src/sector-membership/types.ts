import type { SectorMembershipSnapshot, SectorMembershipType } from '@luoome/core';

/**
 * SectorMembershipManager 接口。
 *
 * 不放在 core：因为 core 不能依赖 adapters 包（ARCHITECTURE §3 依赖方向）。
 * Manager 自身实现放在 adapters/sector-membership/manager.ts；core/context.ts 只引用本接口。
 */

/** Manager 返回的完整关系快照（与 core SectorMembershipSnapshot 相同）。 */
export type SectorMembershipManagerResult = SectorMembershipSnapshot;

/** manager.fetchMemberships 错误（recoverable 用于决定调用方是否重试）。 */
export interface SectorMembershipError {
  readonly kind: 'adapter_error';
  readonly adapter: 'sector-membership';
  readonly message: string;
  readonly recoverable: boolean;
}

export type SectorMembershipResult =
  | { readonly ok: true; readonly data: SectorMembershipManagerResult }
  | { readonly ok: false; readonly error: SectorMembershipError };

/** 板块关系域的 capability map（SourceRegistry 实例化，fuyao-data-expansion §10.2）。 */
export type SectorMembershipCapabilityMap = {
  readonly 'sector-membership': {
    readonly request: {
      readonly stockIds: readonly string[];
      readonly type?: SectorMembershipType | undefined;
    };
    readonly result: SectorMembershipFetchResult;
  };
  /** 板块目录（`.TI` → 名称）；用于反查缺名时的 join，不单独暴露 tool。 */
  readonly 'sector-catalog': {
    readonly request: Record<string, never>;
    readonly result: SectorCatalogFetchResult;
  };
};

/** 板块目录一次拉取的完整结果。 */
export interface SectorCatalogFetchResult {
  readonly items: readonly { readonly sectorCode: string; readonly sectorName: string }[];
}

/** adapter / source 一次反查的完整结果。 */
export interface SectorMembershipFetchResult {
  readonly groups: SectorMembershipRawGroup[];
  /** 规范化响应内容的稳定 hash（审计 / 幂等识别；不是上游 revision）。 */
  readonly contentHash: string;
}

/** 数据源 adapter 返回的原始关系组（协议层，身份保留上游 `.TI` 代码）。 */
export interface SectorMembershipRawGroup {
  readonly stockId: string;
  readonly memberships: SectorMembershipRawEntry[];
}

export interface SectorMembershipRawEntry {
  readonly sectorCode: string;
  readonly sectorName?: string | undefined;
  readonly type: SectorMembershipType;
}
