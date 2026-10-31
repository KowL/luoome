/**
 * schema ↔ 表列集对账守卫。
 *
 * **为什么存在**：已经发生过两次同一个模式的 P0 ——
 * 1. `AnalysisContext.missingFacts` 在 drizzle 表里没有列，`contextRow()` 的 `{...rest}`
 *    展开被 drizzle 静默丢弃 → 带缺口的 context 写回必然 `context_mismatch`；
 * 2. `AdviceOutcome.origin` 在 drizzle 表里没有列，`recordOutcome()` 手工建 row 漏字段、
 *    `toOutcome()` 也不读 → memory 与 SQLite 的回填来源分叉。
 * 两次都是「core 实体加了字段 → 表没加列 → 仓储映射静默丢 → memory 绿、drizzle 假绿」，
 * 都靠人肉审计才发现。这里把它变成红测试。
 *
 * **两条守卫**（缺一不可）：
 * - 正向：`Object.keys(EntitySchema.shape)` ⊆ 表列键 ∪ `entityOnly` 例外。
 *   防「实体加了字段、表没加列」。
 * - 反向：表列键 ⊆ 实体键 ∪ `tableOnly` 例外。
 *   防「表加了列、实体没加、读不回来」——反向同样会让人踩空。
 *
 * **例外必须逐条写理由**，且每条都被自检（例外声明的键必须真的是差异，差异消失即红，
 * 防止例外表腐烂成通配）。`bulkJson` 不是通配：它声明「该实体整体序列化进这一列」，
 * 并且断言该列真实存在。
 *
 * **覆盖范围**：只覆盖「有手写 row↔entity 映射的仓储实体」。未覆盖的 62 张表在
 * `UNCOVERED_TABLES` 里逐张声明原因，并由本文件末尾的用例**机器校验**——新增表若既不
 * 进 `PAIRS` 也不进 `UNCOVERED_TABLES`，这里会红，不会出现静默盲区。
 * 补覆盖只需要往 `PAIRS` 加一对（并把该表从 `UNCOVERED_TABLES` 移走）。
 *
 * **与 `client.test.ts` 的分工**：`client.test.ts` 的「Drizzle schema 与 ensureSchema 的
 * 实际 SQLite 列和索引保持一致」已经用 `PRAGMA table_info` ↔ `getTableConfig` 的**精确列序
 * 相等**覆盖了「drizzle 定义 ↔ 真实 DDL」这条缝（80 张表全覆盖，两个方向）。本文件补的是
 * 它看不到的那条缝：「core 实体 schema ↔ drizzle 表」。
 */
import { describe, expect, it } from 'bun:test';
import {
  AccountSchema,
  AdviceOutcomeSchema,
  AdviceSchema,
  AnalysisContextSchema,
  AnalysisJobSchema,
  DecisionReviewRevisionSchema,
  DecisionReviewSchema,
  ExternalMarketFactSchema,
  HoldingSchema,
  PortfolioCashFlowSchema,
  QuoteSchema,
  ReportSchema,
  SignalObservationSchema,
  StockSchema,
  StrategySchema,
  StrategyVersionSchema,
  StrategyWatchlistSubscriptionSchema,
  TradeSchema,
  TradingPlanSchema,
  WorkflowRunSchema,
} from '@luoome/core';
import { getTableColumns } from 'drizzle-orm';
import * as schemaModule from '../schema/index.js';
import { schema } from '../schema/index.js';

type Table = (typeof schema)[keyof typeof schema];

interface Pair {
  /** 用于失败信息的可读名。 */
  readonly name: string;
  readonly entity: unknown;
  readonly table: Table;
  /** 实体有、表无：键 → 为什么这样是合法的。 */
  readonly entityOnly?: Readonly<Record<string, string>>;
  /** 表有、实体无：列键 → 为什么这样是合法的。 */
  readonly tableOnly?: Readonly<Record<string, string>>;
  /** 实体整体序列化进该 JSON 列（该列必须真实存在）。 */
  readonly bulkJson?: string;
}

const SUBJECT_SPLIT = 'subject 拆成 subject_kind + subject_id，读取侧显式重建 subject 对象';

const PAIRS: readonly Pair[] = [
  {
    name: 'ExternalMarketFact ↔ external_market_facts',
    entity: ExternalMarketFactSchema,
    table: schema.externalMarketFacts,
    entityOnly: {},
    tableOnly: {},
  },
  { name: 'Account ↔ accounts', entity: AccountSchema, table: schema.accounts },
  {
    name: 'Advice ↔ advices',
    entity: AdviceSchema,
    table: schema.advices,
    entityOnly: {
      outcome: 'outcome 在独立表 advice_outcomes；toAdvice(row, outcome) 从该表派生',
      targetPositionPctRange: '区间拍平成 target_position_pct_min / target_position_pct_max 两列',
    },
    tableOnly: {
      generatorKind: 'provenance.generatorKind 的拍平投影列（advice.ts 写入），供查询与统计',
      targetPositionPctMin: 'targetPositionPctRange 的拍平下界',
      targetPositionPctMax: 'targetPositionPctRange 的拍平上界',
    },
  },
  // 本对是两次 P0 之一：origin 曾经没有列，这里必须守住。
  {
    name: 'AdviceOutcome ↔ advice_outcomes',
    entity: AdviceOutcomeSchema,
    table: schema.adviceOutcomes,
  },
  {
    name: 'AnalysisContext ↔ analysis_contexts',
    entity: AnalysisContextSchema,
    table: schema.analysisContexts,
    entityOnly: { subject: SUBJECT_SPLIT },
    tableOnly: {
      subjectKind: 'subject.kind 的拍平列',
      subjectId: 'subject.id 的拍平列',
    },
  },
  {
    name: 'AnalysisJob ↔ analysis_jobs',
    entity: AnalysisJobSchema,
    table: schema.analysisJobs,
    entityOnly: { subject: SUBJECT_SPLIT },
    tableOnly: {
      subjectKind: 'subject.kind 的拍平列',
      subjectId: 'subject.id 的拍平列',
    },
  },
  {
    name: 'DecisionReview ↔ decision_reviews',
    entity: DecisionReviewSchema,
    table: schema.decisionReviews,
    entityOnly: { subject: SUBJECT_SPLIT },
    tableOnly: {
      subjectKind: 'subject.kind 的拍平列',
      subjectId: 'subject.id 的拍平列',
      contextHash: 'context.contextHash 的投影列，用于提交时的 CAS 比较',
    },
  },
  {
    name: 'DecisionReviewRevision ↔ decision_review_revisions',
    entity: DecisionReviewRevisionSchema,
    table: schema.decisionReviewRevisions,
  },
  { name: 'Trade ↔ trades', entity: TradeSchema, table: schema.trades },
  { name: 'Holding ↔ holdings', entity: HoldingSchema, table: schema.holdings },
  {
    name: 'PortfolioCashFlow ↔ portfolio_cash_flows',
    entity: PortfolioCashFlowSchema,
    table: schema.portfolioCashFlows,
  },
  { name: 'Strategy ↔ strategies', entity: StrategySchema, table: schema.strategies },
  {
    name: 'StrategyVersion ↔ strategy_versions',
    entity: StrategyVersionSchema,
    table: schema.strategyVersions,
  },
  {
    name: 'StrategyWatchlistSubscription ↔ strategy_watchlist_subscriptions',
    entity: StrategyWatchlistSubscriptionSchema,
    table: schema.strategyWatchlistSubscriptions,
  },
  {
    name: 'SignalObservation ↔ signal_observations',
    entity: SignalObservationSchema,
    table: schema.signalObservations,
  },
  {
    name: 'Stock ↔ stocks',
    entity: StockSchema,
    table: schema.stocks,
    tableOnly: {
      nameSource: '由 name === code 派生（stock.ts），表级审计列',
      nameUpdatedAt: '表级审计列，Stock 实体不承载',
      updatedAt: '表级审计列，Stock 实体不承载',
    },
  },
  {
    name: 'Report ↔ reports',
    entity: ReportSchema,
    table: schema.reports,
    tableOnly: {
      scopeKey: 'reportScopeKey(report.scope) 的派生列，用于唯一约束与查询',
      deliveryAttemptId:
        '投递租约指针，由 beginDelivery/finishDelivery 单写单读，Report 实体不承载',
    },
  },
  { name: 'WorkflowRun ↔ workflow_runs', entity: WorkflowRunSchema, table: schema.workflowRuns },
  {
    // 实体是 union + transform（ZodPipe，无单一 shape）：整份计划进 plan_json，
    // 表只保留可查询的头部列。这里靠反向守卫防「表加了列、实体没加」。
    name: 'TradingPlan ↔ trading_plans',
    entity: TradingPlanSchema,
    table: schema.tradingPlans,
    bulkJson: 'plan',
    tableOnly: {
      versionId: 'plan_json 的查询头部列（版本主键）',
      planId: 'plan_json 的查询头部列（跨版本聚合）',
      version: 'plan_json 的查询头部列（版本号）',
      accountId: 'plan_json 的查询头部列',
      stockId: 'plan_json 的查询头部列',
      status: 'plan_json 的查询头部列（按状态筛计划）',
      validFrom: 'plan_json 的查询头部列（有效期下界）',
      validUntil: 'plan_json 的查询头部列（有效期上界）',
      createdAt: 'plan_json 的查询头部列（排序）',
    },
  },
  {
    name: 'Quote ↔ price_snapshots',
    entity: QuoteSchema,
    table: schema.priceSnapshots,
    entityOnly: {
      ts: '历史兼容别名：读回时 ts ← observedAt（quote.ts 的 toQuote）',
    },
  },
];

/** 未覆盖表 → 原因。**逐张声明**，由用例机器校验，新增表不声明即红。 */
const UNCOVERED_TABLES: Readonly<Record<string, string>> = {
  // (a) 有 core 实体、但本轮还没加守卫的下一批（加守卫 = 从本表移走并进 PAIRS）。
  alertPlans: 'pending',
  chatMessages: 'pending',
  chatSessions: 'pending',
  dailyBarRevisions: 'pending',
  dailyBars: 'pending',
  financialFactRevisions: 'pending',
  fundamentalScoreResults: 'pending',
  fundamentalScoreRuns: 'pending',
  fundamentalScoreVersions: 'pending',
  holdingCashAdjustments: 'pending',
  limitUpLadderSnapshots: 'pending',
  membershipSnapshots: 'pending',
  minuteBars: 'pending',
  notifications: 'pending',
  portfolioCorporateActions: 'pending',
  portfolioPerformanceSnapshots: 'pending',
  researchDocumentChunks: 'pending',
  researchDocumentIndex: 'pending',
  researchEmbeddingIndexStates: 'pending',
  researchHypothesisVersions: 'pending',
  researchSubjectLinks: 'pending',
  researchTopicDocuments: 'pending',
  researchTopicIndex: 'pending',
  researchVaultSyncRuns: 'pending',
  stockEvents: 'pending',
  stockUniverseSnapshotMembers: 'pending',
  strategyAutonomyActions: 'pending',
  strategyBacktestMarketFacts: 'pending',
  strategyBacktestRuns: 'pending',
  strategyDataCheckpointMembers: 'pending',
  strategyDataCheckpoints: 'pending',
  strategyEvaluationDays: 'pending',
  strategyEvaluationSessions: 'pending',
  strategyResults: 'pending',
  strategyRuns: 'pending',
  strategySchedules: 'pending',
  strategySignals: 'pending',
  strategySignalStates: 'pending',
  watchRuleStates: 'pending',
  watchRuns: 'pending',
  watchTriggers: 'pending',
  watchlistMemberSources: 'pending',
  watchlistMembers: 'pending',
  watchlistSyncRuns: 'pending',
  watchlists: 'pending',
  // (b) 整对象序列化进 JSON 列：逐列守卫无意义，守卫对象是「那一列存在」。
  investmentConsensus: 'json-blob:payload',
  investmentResearch: 'json-blob:payload',
  investmentTracking: 'json-blob:payload',
  pluginAutomationGrants: 'json-blob:record',
  pluginOperations: 'json-blob:record',
  researchChunkEmbeddings: 'json-blob:vector',
  strategyResearchStates: 'json-blob:state',
  // (c) 没有逐行 core 实体：内部记账 / 关联表 / 租约 / 派生投影。
  dataImportReceipts: 'internal: 导入回执，无 core 行实体',
  decisionReviewTradeLinks: 'internal: review↔trade 关联表',
  decisionWriteReceipts: 'internal: 写入幂等回执',
  researchDocumentFts: 'internal: FTS5 派生投影，由 manifest 重建',
  schemaMigrations: 'internal: 迁移记账表',
  stockUniverseMemberships: 'internal: 成员状态表，实体是聚合视图 StockUniverseSnapshot',
  stockUniverseSyncRuns: 'internal: 同步运行记账，实体是聚合视图 StockUniverseSnapshot',
  strategyRunLeases: 'internal: 运行租约（fence/heartbeat）',
  watchExecutionLease: 'internal: 单行执行租约，无 core 行实体（DDL 侧已由 client.test.ts 覆盖）',
};

const drizzleTableMarker = Symbol.for('drizzle:IsDrizzleTable');

/** 取实体 schema 的顶层键；ZodPipe（object + transform）取输入侧的 object。 */
const shapeOf = (entity: unknown): Record<string, unknown> | null => {
  const candidate = entity as {
    shape?: Record<string, unknown>;
    def?: { type?: string; in?: unknown };
  };
  if (candidate.shape !== undefined) return candidate.shape;
  if (candidate.def?.type === 'pipe') return shapeOf(candidate.def.in);
  return null;
};

const tableKeys = (table: Table): string[] => Object.keys(getTableColumns(table));

/**
 * 枚举**模块导出的全部** sqliteTable，而不是只枚举 `schema` barrel。
 * 原因：`strategyWatchlistSubscriptions` 与 `watchExecutionLease` 是导出的表，却没进
 * `schema` barrel —— 于是 `client.test.ts` 那条 DDL 一致性用例（它遍历 `Object.entries(schema)`）
 * 对这两张表是**盲的**。这里按模块导出枚举，至少保证它们被分类、不会静默消失。
 */
const allTables = (): [string, Table][] =>
  Object.entries(schemaModule).filter(
    ([, value]) =>
      value !== null &&
      typeof value === 'object' &&
      (value as Record<PropertyKey, unknown>)[drizzleTableMarker] === true,
  ) as [string, Table][];

describe('实体 schema ↔ 表列集对账守卫', () => {
  it('每个实体的顶层键都能在表里找到列（或有逐条理由的例外）', () => {
    for (const pair of PAIRS) {
      const shape = shapeOf(pair.entity);
      if (shape === null && pair.bulkJson === undefined) {
        throw new Error(`${pair.name}: 实体没有可读的 shape，且未声明 bulkJson`);
      }
      const columns = new Set(tableKeys(pair.table));
      const declared = pair.entityOnly ?? {};
      const missing = Object.keys(shape ?? {}).filter(
        (key) => !columns.has(key) && declared[key] === undefined,
      );
      expect(missing, `${pair.name} 实体有字段但表无列（且未声明例外）`).toEqual([]);
    }
  });

  it('表里每列都能被实体读回（或有逐条理由的例外）', () => {
    for (const pair of PAIRS) {
      const shape = shapeOf(pair.entity);
      const entityKeys = new Set(Object.keys(shape ?? {}));
      const declared = pair.tableOnly ?? {};
      const orphan = tableKeys(pair.table).filter(
        (key) => !entityKeys.has(key) && declared[key] === undefined && pair.bulkJson !== key,
      );
      expect(orphan, `${pair.name} 表有列但实体无字段（且未声明例外）`).toEqual([]);
    }
  });

  it('例外声明不会腐烂：写进例外的键必须真的是差异', () => {
    for (const pair of PAIRS) {
      const shape = shapeOf(pair.entity);
      const entityKeys = new Set(Object.keys(shape ?? {}));
      const columns = new Set(tableKeys(pair.table));
      for (const key of Object.keys(pair.entityOnly ?? {})) {
        expect(entityKeys.has(key), `${pair.name}: entityOnly 声明的 ${key} 已不在实体里`).toBe(
          true,
        );
        expect(
          columns.has(key),
          `${pair.name}: entityOnly 声明的 ${key} 表里已有列，例外可删`,
        ).toBe(false);
      }
      for (const key of Object.keys(pair.tableOnly ?? {})) {
        expect(columns.has(key), `${pair.name}: tableOnly 声明的 ${key} 已不在表里`).toBe(true);
        expect(
          entityKeys.has(key),
          `${pair.name}: tableOnly 声明的 ${key} 实体里已有字段，例外可删`,
        ).toBe(false);
      }
    }
  });

  it('bulkJson 声明的列必须真实存在', () => {
    for (const pair of PAIRS) {
      if (pair.bulkJson === undefined) continue;
      expect(tableKeys(pair.table), `${pair.name}: 缺少 bulkJson 列 ${pair.bulkJson}`).toContain(
        pair.bulkJson,
      );
    }
  });

  it('每张 drizzle 表都被分类：进 PAIRS，或在 UNCOVERED_TABLES 里写明原因', () => {
    const paired = new Set<string>();
    for (const pair of PAIRS) {
      const matched = allTables().find(([, table]) => table === pair.table);
      if (matched === undefined) throw new Error(`${pair.name}: table 不在 schema 导出里`);
      paired.add(matched[0]);
    }
    const unclassified = allTables()
      .map(([exportName]) => exportName)
      .filter((name) => !paired.has(name) && UNCOVERED_TABLES[name] === undefined);
    expect(unclassified, '新表必须进 PAIRS 或 UNCOVERED_TABLES').toEqual([]);

    const stale = Object.keys(UNCOVERED_TABLES).filter(
      (name) => !allTables().some(([exportName]) => exportName === name),
    );
    expect(stale, 'UNCOVERED_TABLES 里有已不存在的表').toEqual([]);

    const overlap = Object.keys(UNCOVERED_TABLES).filter((name) => paired.has(name));
    expect(overlap, '同一张表既在 PAIRS 又在 UNCOVERED_TABLES').toEqual([]);

    for (const [name, reason] of Object.entries(UNCOVERED_TABLES)) {
      expect(reason.length, `${name} 的未覆盖原因太短`).toBeGreaterThan(5);
    }
  });

  it('覆盖了两次 P0 涉及的两个实体，且数量不回退', () => {
    const names = PAIRS.map((pair) => pair.name);
    expect(names).toContain('AdviceOutcome ↔ advice_outcomes');
    expect(names).toContain('AnalysisContext ↔ analysis_contexts');
    expect(PAIRS.length).toBeGreaterThanOrEqual(19);
  });
});
