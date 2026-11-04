import type {
  AShareSentimentManagerLike,
  DataArchiveWriter,
  DataImportStagingAdapter,
  DragonTigerManagerLike,
  FinancialSnapshotManagerLike,
  FundamentalDataAdapterLike,
  LimitUpLadderManagerLike,
  LocalExecutionIdentity,
  Logger,
  MarketDataAdapterLike,
  MarketDumpManagerLike,
  NewsManagerLike,
  NorthboundFlowManagerLike,
  NotificationManagerLike,
  ReportArtifactWriter,
  RepositoryRegistry,
  ResearchEmbeddingAdapterLike,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
  ResearchVaultGitSyncAdapterLike,
  SectorMembershipManagerLike,
  SectorQuoteManagerLike,
  StockProfileManagerLike,
  StockUniverseManagerLike,
  ToolContext,
} from '@luoome/core';
import { ExecutionIdentitySchema } from '@luoome/core';

export interface BuildContextDependencies {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly stockUniverse?: StockUniverseManagerLike;
  };
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly auditLog?: ToolContext['auditLog'];
  readonly auditCaller?: string;
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  /** Phase 1：连板天梯 manager（docs/ddd/limit-up-ladder-detailed-design.md §5）。 */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  /** 龙虎榜 manager（只读；东方财富数据中心公开报表）。 */
  readonly dragonTiger?: DragonTigerManagerLike;
  /** 个股档案 manager（只读；东方财富数据中心公开报表）。 */
  readonly stockProfile?: StockProfileManagerLike;
  /** 北向资金历史流 manager（只读；东方财富数据中心公开报表）。 */
  readonly northboundFlow?: NorthboundFlowManagerLike;
  /** 财经要闻 manager（只读；东方财富公开新闻 API）。 */
  readonly news?: NewsManagerLike;
  /** 行业板块行情 manager（只读；东方财富 push2 板块列表公开 API）。 */
  readonly sectorQuote?: SectorQuoteManagerLike;
  /** 个股板块关系 manager（只读；Fuyao 个股反查 + 板块目录；默认不装配）。 */
  readonly sectorMembership?: SectorMembershipManagerLike;
  /** 财务当前快照 manager（只读；Fuyao 财务数据 API）。 */
  readonly financialSnapshot?: FinancialSnapshotManagerLike;
  /** 全市场 dump 同步 manager（显式触发；LUOOME_MARKET_DUMP_SOURCES 默认不装配）。 */
  readonly marketDump?: MarketDumpManagerLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
  readonly researchVault?: ResearchVaultAdapterLike;
  readonly researchRemote?: ResearchRemoteImportAdapterLike;
  readonly researchEmbedding?: ResearchEmbeddingAdapterLike;
  readonly researchVaultGitSync?: ResearchVaultGitSyncAdapterLike;
  readonly notification?: NotificationManagerLike;
  readonly portfolioBenchmark?: ToolContext['portfolioBenchmark'];
  /** Phase 3 P3-1：只从显式基本面 adapter 读取，未注入时 sync 保持 unavailable。 */
  readonly fundamentalData?: FundamentalDataAdapterLike;
  /** T48：host 侧专用有界上传的暂存读取器；未注入时导入 tool 返回 unavailable。 */
  readonly dataImport?: DataImportStagingAdapter;
  /** REQ-M3-08：报告交付物写盘载体；未注入时 write_report_artifact 返回 adapter_error。 */
  readonly reportArtifacts?: ReportArtifactWriter;
  /** task-35：事实库导出物写盘载体；未注入时 export_business_data 返回 adapter_error。 */
  readonly dataArchives?: DataArchiveWriter;
  /** REQ-M5-01：长任务执行器（宿主注入；缺省时 `enqueue_analysis_job` 只排期）。 */
  readonly jobRunner?: ToolContext['jobRunner'];
  readonly goalRoundRunner?: ToolContext['goalRoundRunner'];
  readonly triangleRoleRunner?: ToolContext['triangleRoleRunner'];
  /** REQ-M5-01：分析执行器（宿主注入；缺省时执行体如实报 `analyzer-unavailable`）。 */
  readonly analysisRunner?: ToolContext['analysisRunner'];
  /** REQ-M4-06：档位读写口；未注入时 set_automation_tier 返回 adapter_error。 */
  readonly automationTierStore?: ToolContext['automationTierStore'];
}

export type BuildContextInput = BuildContextDependencies & {
  readonly mode?: 'local';
  readonly identity?: Readonly<LocalExecutionIdentity>;
};

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const identity = Object.freeze(
    ExecutionIdentitySchema.parse(
      input.identity ?? { mode: 'local' as const, userId: input.user?.id ?? 'local-user' },
    ),
  );
  const user = input.user ?? { id: identity.userId, defaultAccountId: '' };
  if (user.id !== identity.userId) {
    throw new Error('Tool context user does not match execution identity');
  }
  const ctx: ToolContext = {
    identity,
    repos: input.repos,
    adapters: input.adapters,
    user,
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
    ...(input.auditCaller === undefined ? {} : { auditCaller: input.auditCaller }),
    ...(input.ashareSentiment === undefined ? {} : { ashareSentiment: input.ashareSentiment }),
    ...(input.researchVault === undefined ? {} : { researchVault: input.researchVault }),
    ...(input.researchRemote === undefined ? {} : { researchRemote: input.researchRemote }),
    ...(input.researchEmbedding === undefined
      ? {}
      : { researchEmbedding: input.researchEmbedding }),
    ...(input.researchVaultGitSync === undefined
      ? {}
      : { researchVaultGitSync: input.researchVaultGitSync }),
    ...(input.notification === undefined ? {} : { notification: input.notification }),
    ...(input.portfolioBenchmark === undefined
      ? {}
      : { portfolioBenchmark: input.portfolioBenchmark }),
    ...(input.fundamentalData === undefined ? {} : { fundamentalData: input.fundamentalData }),
    ...(input.dataImport === undefined ? {} : { dataImport: input.dataImport }),
    ...(input.reportArtifacts === undefined ? {} : { reportArtifacts: input.reportArtifacts }),
    ...(input.automationTierStore === undefined
      ? {}
      : { automationTierStore: input.automationTierStore }),
    ...(input.goalRoundRunner === undefined ? {} : { goalRoundRunner: input.goalRoundRunner }),
    ...(input.jobRunner === undefined ? {} : { jobRunner: input.jobRunner }),
    ...(input.triangleRoleRunner === undefined
      ? {}
      : { triangleRoleRunner: input.triangleRoleRunner }),
    ...(input.analysisRunner === undefined ? {} : { analysisRunner: input.analysisRunner }),
    ...(input.dataArchives === undefined ? {} : { dataArchives: input.dataArchives }),
    ...(input.dragonTiger === undefined ? {} : { dragonTiger: input.dragonTiger }),
    ...(input.stockProfile === undefined ? {} : { stockProfile: input.stockProfile }),
    ...(input.northboundFlow === undefined ? {} : { northboundFlow: input.northboundFlow }),
    ...(input.news === undefined ? {} : { news: input.news }),
    ...(input.sectorQuote === undefined ? {} : { sectorQuote: input.sectorQuote }),
    ...(input.sectorMembership === undefined ? {} : { sectorMembership: input.sectorMembership }),
    ...(input.financialSnapshot === undefined
      ? {}
      : { financialSnapshot: input.financialSnapshot }),
    ...(input.marketDump === undefined ? {} : { marketDump: input.marketDump }),
  };
  if (input.limitUpLadder !== undefined) {
    return { ...ctx, limitUpLadder: input.limitUpLadder };
  }
  return ctx;
};
