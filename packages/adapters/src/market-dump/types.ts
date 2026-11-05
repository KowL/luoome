import type {
  CorporateActionEventRepository,
  Logger,
  MarketDumpKind,
  MarketDumpRun,
  MarketDumpRunRepository,
  RawDailyBarRepository,
} from '@luoome/core';

/**
 * market-dump 域类型（设计 §5）。
 *
 * Manager 接口不放在 core：core 不能依赖 adapters 包（ARCHITECTURE §3）。
 * 预签名 URL 属于敏感瞬态材料：只存在于 DownloadTicket 生命周期内，
 * 不进入日志、错误消息、run 记录或 ToolResult。
 */

/** download-url 响应解析后的下载票据（敏感；不得持久化）。 */
export interface DumpDownloadTicket {
  readonly kind: MarketDumpKind;
  /** 从 URL 路径段解析的 dump 身份。 */
  readonly dumpId: string;
  /** 预签名下载地址（敏感）。 */
  readonly presignedUrl: string;
  readonly expiresAt: Date;
}

/** 安全下载器产物：内容寻址的本地 artifact 引用。 */
export interface DumpArtifactRef {
  readonly dumpId: string;
  readonly sha256: string;
  readonly bytes: number;
  /** 本地只读副本路径（调用方只读，不得外传）。 */
  readonly localPath: string;
}

export interface MarketDumpError {
  readonly kind: 'adapter_error';
  readonly adapter: 'market-dump';
  readonly message: string;
  readonly recoverable: boolean;
}

export type MarketDumpResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: MarketDumpError };

/** dump 域 capability map（SourceRegistry 实例化，§6.2）。 */
export type MarketDumpCapabilityMap = {
  readonly 'market-dump-download-url': {
    readonly request: { readonly kind: MarketDumpKind };
    readonly result: DumpDownloadTicket;
  };
};

/** sync 入参（设计 §5.1）；resumeRunId 显式指定要恢复的 running run。 */
export interface MarketDumpSyncInput {
  readonly kind: MarketDumpKind;
  readonly resumeRunId?: string | undefined;
}

/**
 * sync 结果投影（进入 ToolResult，绝不携带 presignedUrl / localPath 等敏感字段）。
 * status='complete' 表示本次 run 导入完成；'failed' 表示终态失败（错误已脱敏落 run 记录）。
 */
export interface MarketDumpSyncResult {
  readonly runId: string;
  readonly kind: MarketDumpKind;
  readonly dumpId: string;
  readonly artifactSha256: string;
  readonly status: 'complete' | 'failed';
  /** true 表示本次调用复用了已有 running run 的 checkpoint（断点续传）。 */
  readonly resumed: boolean;
  readonly processedRows: number;
  readonly nextRowOffset: number;
  readonly minDate: Date | null;
  readonly maxDate: Date | null;
  readonly recordedAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

/**
 * dump 事实链仓储组（设计 §5.4 / §6.1）。
 * 由装配侧（db 包 Drizzle 或 in-memory）注入；adapters 不反向依赖 db 包。
 */
export interface MarketDumpStores {
  readonly runs: MarketDumpRunRepository;
  readonly rawDailyBars: RawDailyBarRepository;
  readonly corporateActionEvents: CorporateActionEventRepository;
}

/**
 * MarketDumpManager 端口（设计 §5.1 的 MarketDumpManagerLike）。
 * 不加入 MarketDataAdapterLike；作为 ToolContext 顶层可选端口由装配侧注入。
 */
export interface MarketDumpManagerLike {
  readonly name: 'market-dump';
  sync(input: MarketDumpSyncInput): Promise<MarketDumpSyncResult>;
  status(): Promise<readonly MarketDumpRun[]>;
}

/** Manager 组装参数（factory 与测试共用）。 */
export interface MarketDumpManagerOptions {
  readonly stores: MarketDumpStores;
  /** 本地 artifact 根目录（$LUOOME_HOME/market-dumps）。 */
  readonly artifactDir: string;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** 测试用：替换 fetch（download-url 与 S3 下载共用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 测试用：runId 生成器（默认 crypto.randomUUID）。 */
  readonly runIdGen?: () => string;
  /** 单批导入行数（设计 §5.4 建议 1,000）。 */
  readonly batchSize?: number;
}
