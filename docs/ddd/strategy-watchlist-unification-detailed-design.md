# Strategy 与统一 Watchlist 详细设计

> 状态：设计草案，待按开发计划实施
> 日期：2026-07-29
> 输入：[AI 投资决策闭环产品总纲](../prd/ai-investment-decision-loop.md)、
> [Strategy DSL PRD](../prd/strategy-dsl.md)、[统一 Watchlist PRD](../prd/watchlist.md)
> 当前事实来源：[ARCHITECTURE.md](../ARCHITECTURE.md)、`packages/core`、`packages/db`、
> `packages/tools`、`packages/workflows`

## 1. 设计结论

本设计完成两项领域收口：

1. 将顶层 `Tactic` 重构为版本化 `Strategy`，当前战法表达式迁入 `StrategyRule`。
2. 将 `StockGroup` 重构为统一 `Watchlist`，以独立来源表达 manual、Strategy、AI 和 Portfolio。

目标主链：

```text
StrategyVersion
  └── StrategyRun
        ├── StrategyResult ──► WatchlistMemberSource(strategy)
        └── StrategySignal ──► Advice evidence / AlertRule / SignalObservation

Watchlist
  └── WatchlistMember
        ├── WatchlistMemberSource
        └── AlertPlan ──► WatchTrigger
```

当前对象的迁移关系：

| 当前对象 | 目标对象 | 迁移结论 |
|---|---|---|
| `Tactic` | `Strategy + StrategyVersion + StrategyRule` | 每个 Tactic 迁成一个 signal-only Strategy |
| `TacticSignal` | `StrategySignal` | 补 strategyVersionId/ruleId 后迁移 |
| `StockGroup` | `Watchlist` | 一组迁一表，id 默认保持 |
| `GroupMemberSnapshot` | `WatchlistSyncRun + MembershipSnapshot` | refreshId 映射 syncRunId |
| group resolver | `WatchlistMemberSource` 的生产方式 | manual/holdings/formula/llm 分别迁移 |
| `StockPool / WatchPlan` | `AlertPlan` | id 保持，引用从 groupId 改 watchlistId |
| `WatchTrigger` | `WatchTrigger` | 领域保留，引用改 alertPlanId |
| `WatchRuleState` | `AlertRuleState` | 语义保留，引用改 alertPlanId |

迁移采用 expand → backfill → verify → switch → contract 的顺序。实现期间旧表可作为回滚来源，
但同一业务对象在切换后只有一个写入事实源。

## 2. 设计目标与非目标

### 2.1 目标

- Strategy 成为选股、评分、信号、版本和运行审计的统一身份。
- Watchlist 成为手工、Strategy、AI、Portfolio 观察关系的统一容器。
- 当前功能在迁移期间不中断：战法扫描、动态分组、盘中盯盘、Advice 和报告继续可用。
- 动态同步失败不制造成员退出，旧来源明确进入 stale。
- Agent、Web、CLI、MCP 使用同一 tool schema。
- 所有 repository 同时提供 drizzle 与 in-memory 实现，并复用 contract tests。
- Drizzle schema、`ensureSchema` DDL 和存量库迁移保持同步、幂等。

### 2.2 非目标

- 本设计不实现真实下单或券商订单模型。
- 首期不实现完整基本面数据平台和严格回测。
- 首期不删除旧表；旧表物理清理需单独版本和备份方案。
- 不将 LLM 放入 StrategyRunner 或盘中规则求值热路径。
- 不引入通用事件总线、Redis、任务队列或多租户权限模型。
- 不在首期把 Portfolio 提升为新的持久化聚合；继续以 Account/Holding/Trade 为事实源。

## 3. 模块边界

依赖方向保持不变：

```text
cli / tui / mcp / web ──► tools ──► core
                          │
                          └─► db / adapters ──► core
workflows ──► tools ──► core
```

落点：

| 包 | 职责 |
|---|---|
| `core` | Strategy、Watchlist、AlertPlan 类型、不变量、纯 StrategyEvaluator |
| `db` | 新表、repository 双实现、幂等迁移、契约测试 |
| `tools` | 原子 CRUD、发布、运行、同步、查询；统一 Zod schema |
| `workflows` | 批量运行 Strategy、同步 Watchlist、盘中提醒编排 |
| `adapters` | 行情、LLM、通知；不感知 Strategy/Watchlist repository |
| `web/cli/tui/mcp` | 消费 tools/workflows，不复制领域判断 |

StrategyEvaluator 位于 core，只接受已经准备好的规范上下文，不拉数据、不持久化、不调用 LLM。
StrategyRunner 的数据准备和结果持久化通过 tools/workflows 完成。

## 4. Core 领域模型

建议新增：

```text
packages/core/src/entity/strategy.ts
packages/core/src/entity/watchlist.ts
packages/core/src/entity/alert-plan.ts
packages/core/src/strategy/expression.ts
packages/core/src/strategy/evaluator.ts
```

现有 `tactic/dsl.ts` 的 parser/evaluator 先迁移或包装到 `strategy/expression.ts`，在兼容期保留旧导出。
`stock-pool.ts` 的提醒规则拆到 `alert-plan.ts`，兼容期从旧文件 re-export。

### 4.1 Strategy

```ts
export const StrategyStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
export const StrategyOwnerSchema = z.enum(['builtin', 'user']);

export const StrategySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  owner: StrategyOwnerSchema,
  status: StrategyStatusSchema,
  currentVersionId: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
```

不变量：

- `updatedAt >= createdAt`。
- `active` 必须有 `currentVersionId`，draft 可以没有。
- builtin Strategy 不可通过普通 update tool 修改，只能复制为 user Strategy。
- archived 不参与定时运行，历史仍可查询。

### 4.2 StrategyVersion

首版 DSL 只实现 metadata、universe、selection、scoring、signals。data/factors/portfolio/risk/schedule/
evaluation 在 schema 中使用显式 optional 段，未支持字段由版本 schema 拒绝，不做无效透传。

```ts
export const StrategyDslV1Schema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({
    style: z.string().max(64).optional(),
    horizon: z.enum(['intraday', 'short', 'medium', 'long']).optional(),
  }),
  universe: z.object({
    coverage: z.literal('CN_A_SHARES_SH_SZ'),
    includeStockIds: z.array(z.string()).optional(),
    excludeStockIds: z.array(z.string()).default([]),
  }),
  selection: z.object({
    logic: z.enum(['all', 'any']).default('all'),
    rules: z.array(StrategyRuleSchema).default([]),
  }),
  scoring: StrategyScoringSchema.optional(),
  signals: z.object({
    entry: z.array(StrategySignalRuleSchema).default([]),
    exit: z.array(StrategySignalRuleSchema).default([]),
    risk: z.array(StrategySignalRuleSchema).default([]),
  }),
});

export const StrategyVersionSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  version: z.number().int().positive(),
  definition: StrategyDslV1Schema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  parentVersionId: z.string().optional(),
  changeSummary: z.string().max(500).optional(),
  validationStatus: z.enum(['pending', 'valid', 'invalid']),
  validationErrors: z.array(z.string()).default([]),
  publishedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});
```

不变量：

- `(strategyId, version)` 唯一。
- `definitionHash` 由 canonical JSON 的 SHA-256 生成，调用方不能直接提供。
- published version 必须 `validationStatus='valid'`。
- published version 不允许更新 definition。
- parentVersionId 必须指向同一 Strategy。
- version 严格递增，不要求连续回填历史空洞。

### 4.3 StrategyRule

首期复用当前表达式能力：

```ts
export const StrategyRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  when: z.string().min(1).max(1000),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(8),
});

export const StrategySignalRuleSchema = StrategyRuleSchema.extend({
  score: z.string().min(1).max(1000),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
});
```

`scoring` 首期支持加权规则分：

```ts
export const StrategyScoringSchema = z.object({
  method: z.literal('weighted-sum'),
  components: z.array(
    z.object({
      ruleId: z.string().min(1),
      score: z.string().min(1).max(1000),
      weight: z.number().positive().max(1),
    }),
  ).min(1),
  top: z.number().int().positive().max(500).optional(),
});
```

权重总和误差在 `1e-9` 内等于 1；component.ruleId 必须引用 selection rule 或显式 score rule。

### 4.4 StrategyRun

```ts
export const StrategyRunSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  mode: z.enum(['scan', 'scheduled', 'replay', 'backtest']),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  dataAsOf: z.coerce.date(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']),
  inputSnapshot: z.record(z.string(), z.unknown()),
  providerStatuses: z.array(ProviderStatusSchema),
  summary: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
```

不变量：

- `finishedAt >= startedAt`。
- running 没有 finishedAt；终态必须有 finishedAt。
- failed 必须有 error，complete 不得有 error。
- `dataAsOf <= finishedAt`（终态）。
- run 永远绑定发布且 valid 的 StrategyVersion，replay 也不例外。
- 新写入只使用 `running/complete/failed`；`partial` 仅用于读取存量记录。
- `complete` 只表达执行结束与事实包提交成功，覆盖质量由 Summary V3 的
  `dataHealth=complete/partial/unavailable` 表达。

### 4.5 StrategyResult

```ts
export const RuleEvaluationSchema = z.object({
  ruleId: z.string().min(1),
  status: z.enum(['matched', 'not-matched', 'unknown', 'error']),
  value: z.unknown().optional(),
  evidence: z.array(z.string()),
  error: z.string().optional(),
});

export const StrategyResultSchema = z.object({
  runId: z.string().min(1),
  stockId: z.string().min(1),
  selected: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  ruleEvaluations: z.array(RuleEvaluationSchema),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date(),
});
```

selected 语义：

- `logic=all`：所有 selection rule matched 才为 true。
- `logic=any`：至少一条 matched；若 unknown/error 会改变结论，则该股票求值不完整，并汇总到
  run 的 `incompleteCount` 与 `dataHealth`。
- 零 selection rule 表示 universe 全部入选，仅允许 builtin/migration Strategy；普通创建接口要求至少一条。
- rank 只给 selected 且存在 scoring 的结果。

### 4.6 StrategySignal

```ts
export const StrategySignalSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  runId: z.string().min(1),
  ruleId: z.string().min(1),
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  score: z.number().min(0).max(100),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  evidence: z.array(z.string()).min(1),
  evaluationSnapshot: z.record(z.string(), z.unknown()),
});
```

唯一性为 `(runId, ruleId, stockId, ts)`；不同运行即使使用同一版本、同一数据时点，也必须各自保存
信号事实；长周期 replay run 内同一规则在不同时点产生的信号也必须保留。
signal 是事实，不等于 Advice。

### 4.7 Watchlist

```ts
export const WatchlistSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  kind: z.enum(['personal', 'strategy', 'portfolio', 'system']),
  membershipPolicy: z.enum(['manual', 'synced', 'mixed']),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
```

kind 只定义默认权限：

- personal：manual/mixed。
- strategy：synced/mixed。
- portfolio：synced，不允许普通工具手工结束 portfolio source。
- system：只允许内部 migration/seed tool 创建。

### 4.8 WatchlistMember

```ts
export const WatchlistMemberSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  stockId: z.string().min(1),
  stage: z.enum(['discovered', 'watching', 'researching', 'confirmed', 'archived']),
  priority: z.enum(['normal', 'important', 'urgent']),
  firstAddedAt: z.coerce.date(),
  lastActivityAt: z.coerce.date(),
  archivedAt: z.coerce.date().optional(),
});
```

不变量：

- `(watchlistId, stockId)` 唯一。
- archived 必须有 archivedAt；其它 stage 不得有。
- `lastActivityAt >= firstAddedAt`。
- Strategy/AI/Portfolio 同步不能覆盖 stage 和 priority。
- archived member 收到新 active source 时默认恢复为 discovered；如历史上由用户明确保留，可恢复为
  watching，具体值由同步输入显式提供并记录审计。

### 4.9 WatchlistMemberSource

```ts
export const WatchlistMemberSourceSchema = z.object({
  id: z.string().min(1),
  memberId: z.string().min(1),
  kind: z.enum(['manual', 'strategy', 'ai', 'portfolio', 'import']),
  sourceKey: z.string().min(1),
  sourceId: z.string().optional(),
  sourceVersionId: z.string().optional(),
  syncRunId: z.string().optional(),
  reason: z.string().min(1).max(1000),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  status: z.enum(['active', 'stale', 'ended']),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date().optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date().optional(),
});
```

sourceKey 规范：

```text
manual:<member-id>
strategy:<strategy-id>
ai:<agent-run-id>
portfolio:<account-id>
import:<batch-id>
```

同一 `(memberId, sourceKey)` 只有一个非 ended 当前来源。历史结束行保留；重新进入创建新行。

### 4.10 WatchlistSyncRun 与 MembershipSnapshot

```ts
export const WatchlistSyncRunSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  sourceKind: z.enum(['strategy', 'ai', 'portfolio', 'import']),
  sourceKey: z.string().min(1),
  producerRunId: z.string().optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']),
  dataAsOf: z.coerce.date().optional(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  enteredCount: z.number().int().nonnegative(),
  exitedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  missingDimensions: z.array(ReportMissingDimensionSchema),
  error: z.string().optional(),
});

export const MembershipSnapshotSchema = z.object({
  id: z.string().min(1),
  syncRunId: z.string().min(1),
  stockId: z.string().min(1),
  selected: z.boolean(),
  change: z.enum(['entered', 'unchanged', 'exited']),
  reason: z.string().min(1),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date().optional(),
});
```

complete sync 才允许结束未入选的旧 source。partial/failed 永远不结束旧 source；受影响来源改 stale。

### 4.11 AlertPlan

`StockPoolSchema` 现有字段迁为：

```ts
export const AlertPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  watchlistId: z.string().min(1),
  rules: z.array(AlertRuleSchema).min(1),
  logic: z.enum(['ANY', 'ALL']),
  triggerMode: z.enum(['on-enter', 'repeat', 'daily-first']),
  priority: AlertPrioritySchema.optional(),
  cooldownMinutes: z.number().int().nonnegative(),
  dailyNotificationLimit: z.number().int().min(1).max(500),
  notifyOnRecovery: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
```

现有 WatchRule 变体改名 AlertRule；字段和状态机语义保持，`tactic` rule 迁为 `strategy-signal`：

```ts
{
  kind: 'strategy-signal';
  strategyId: string;
  ruleId?: string;
  minScore: number;
  direction?: 'bullish' | 'bearish' | 'neutral';
}
```

兼容期允许读取 `kind='tactic'` 并在 decode 时映射，不再写入旧 kind。

## 5. Repository 契约

新增到 `RepositoryRegistry`：

```ts
interface StrategyRepository {
  create(strategy: Strategy): Promise<void>;
  findById(id: string): Promise<Strategy | null>;
  list(filter?: { status?: StrategyStatus; owner?: StrategyOwner }): Promise<readonly Strategy[]>;
  createVersion(version: StrategyVersion): Promise<void>;
  setVersionValidation(
    versionId: string,
    validation: { status: 'valid' | 'invalid'; errors: readonly string[] },
  ): Promise<void>;
  findVersionById(id: string): Promise<StrategyVersion | null>;
  listVersions(strategyId: string): Promise<readonly StrategyVersion[]>;
  activateVersion(strategyId: string, versionId: string, at: Date): Promise<void>;
  publishVersion(strategyId: string, versionId: string, at: Date): Promise<void>;
  pause(strategyId: string, at: Date): Promise<void>;
  resume(strategyId: string, at: Date): Promise<void>;
}

interface StrategyRunRepository {
  findRunById(id: string): Promise<StrategyRun | null>;
  listRuns(filter?: StrategyRunQuery): Promise<readonly StrategyRun[]>;
  listResults(runId: string): Promise<readonly StrategyResult[]>;
  commitRun(bundle: StrategyRunBundle): Promise<void>; // terminal facts，原子且 append-only
  signalsByRun(runId: string): Promise<readonly StrategySignal[]>;
  signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]>;
  signalsByStock(stockId: string, since?: Date): Promise<readonly StrategySignal[]>;
}

interface WatchlistRepository {
  save(watchlist: Watchlist): Promise<void>;
  findById(id: string): Promise<Watchlist | null>;
  list(filter?: { enabledOnly?: boolean; kind?: WatchlistKind }): Promise<readonly Watchlist[]>;
  archive(id: string, at: Date): Promise<void>;
}

interface WatchlistMemberRepository {
  saveMember(member: WatchlistMember): Promise<void>;
  findMember(watchlistId: string, stockId: string): Promise<WatchlistMember | null>;
  listMembers(watchlistId: string, filter?: WatchlistMemberQuery): Promise<readonly WatchlistMember[]>;
  saveSource(source: WatchlistMemberSource): Promise<void>;
  listSources(memberId: string, includeEnded?: boolean): Promise<readonly WatchlistMemberSource[]>;
  currentSource(memberId: string, sourceKey: string): Promise<WatchlistMemberSource | null>;
  saveSyncRun(run: WatchlistSyncRun): Promise<void>;
  saveSnapshots(rows: readonly MembershipSnapshot[]): Promise<void>;
  listSyncRuns(watchlistId: string, limit?: number): Promise<readonly WatchlistSyncRun[]>;
  listSnapshots(syncRunId: string): Promise<readonly MembershipSnapshot[]>;
}

interface AlertPlanRepository {
  save(plan: AlertPlan): Promise<void>;
  findById(id: string): Promise<AlertPlan | null>;
  list(filter?: { enabledOnly?: boolean; watchlistId?: string }): Promise<readonly AlertPlan[]>;
  remove(id: string): Promise<void>;
}
```

原子性要求：

- `activateVersion` 在同一事务中校验 version、更新 currentVersionId/status。
- StrategyRun 终态、results/signals 的提交由 tool 以 repository 事务方法完成，不能出现 complete run
  没有结果。
- Watchlist complete sync 的 snapshots、source enter/update/end、member archive/revive 和统计在同一事务。
- memory 与 drizzle 的行为由同一 contract suite 验证。

为保证事务边界，最终接口可以将上述多个写方法收口为：

```ts
commitStrategyRun(bundle: StrategyRunCommit): Promise<void>;
commitWatchlistSync(bundle: WatchlistSyncCommit): Promise<void>;
```

普通调用方不自行拼事务。

## 6. 数据库设计

### 6.1 新表

| 表 | 关键字段 | 索引/唯一约束 |
|---|---|---|
| `strategies` | id, name, owner, status, current_version_id, timestamps | status；owner |
| `strategy_versions` | id, strategy_id, version, definition_json, hash, validation | unique(strategy_id, version)；hash |
| `strategy_runs` | id, strategy/version, mode, coverage, data_as_of, status | strategy+started；status+started |
| `strategy_results` | run_id, stock_id, selected, score, rank, evaluations_json | unique(run_id, stock_id)；run+rank |
| `strategy_signals` | id, strategy/version/run/rule/stock, ts, score | unique(version,rule,stock,ts)；stock+ts |
| `watchlists` | id, name, kind, policy, enabled, timestamps | enabled；kind |
| `watchlist_members` | id, watchlist_id, stock_id, stage, priority | unique(watchlist_id,stock_id)；stage |
| `watchlist_member_sources` | id, member_id, kind, source_key, status, validity | member+status；source_key+status |
| `watchlist_sync_runs` | id, watchlist/source, producer_run, status, counts | watchlist+started；producer_run |
| `membership_snapshots` | id, sync_run_id, stock_id, selected, change, evidence | unique(sync_run_id,stock_id)；run+change |
| `alert_plans` | StockPool 字段 + watchlist_id | watchlist；enabled |

JSON 字段：

- Strategy definition、run snapshot、provider statuses、rule evaluations、evidence 使用 SQLite text JSON。
- JSON 只保存不可独立查询的值对象；Strategy、Watchlist、Member、Source、Run 均使用独立表。
- 所有时间使用 epoch milliseconds，与现有 schema 一致。

### 6.2 兼容列

迁移期：

- `watch_triggers` 新增 `alert_plan_id TEXT`，从 `pool_id` 回填；写新值时两列保持同值。
- `watch_rule_states` 新增 `alert_plan_id TEXT`，从 `pool_id` 回填。
- `watch_runs` 的 pool 统计 JSON 如包含 poolId，读取时映射为 alertPlanId；不重写历史 JSON。
- `signal_observations.sourceKind` 增加 `strategy-signal`，兼容读取 `tactic-signal`。

新表切换稳定后，旧列只读。物理删除需未来表重建迁移，不在本设计首批执行。

### 6.3 ensureSchema

必须同步修改：

1. `packages/db/src/schema/index.ts` 的 Drizzle tables 和 `schema` 导出。
2. `packages/db/src/client.ts` 的 CREATE TABLE/INDEX。
3. 缺列补齐和数据回填函数。
4. `createDrizzleRepositories`、memory registry 和 seed。
5. drizzle/memory contract tests。

每个 migration 函数：

- 先用 `PRAGMA table_info` 或 sqlite_master 判断。
- 使用显式事务。
- 可重复运行。
- 不依赖网络、LLM、行情或当前系统时间以外的外部状态。
- 不删除旧行。
- 失败时回滚当前阶段并保留旧可用路径。

## 7. 存量数据迁移

### 7.1 迁移版本表

新增：

```text
schema_migrations
- id
- applied_at
- checksum
- details_json
```

现有 ensureSchema 可继续负责建表/补列；跨多表的数据迁移通过有 id 的 migration 记录，避免每次启动
扫描全库。checksum 变化视为装配错误，不自动重跑已应用的不同逻辑。

建议 migration id：

```text
20260729_01_strategy_tables
20260729_02_migrate_tactics
20260729_03_watchlist_tables
20260729_04_migrate_stock_groups
20260729_05_alert_plan_tables
20260729_06_migrate_stock_pools
20260729_07_switch_read_models
```

### 7.2 Tactic → Strategy

对每个 tactics 行：

1. 创建 Strategy，id 默认保持 tactic.id；冲突时使用 `strategy-<tactic.id>` 并记录映射。
2. 创建 version 1：
   - universe.coverage = `CN_A_SHARES_SH_SZ`；
   - selection.rules = []；
   - signals 按 direction/tag 映射到 entry/exit/risk；
   - when = triggerWhen；
   - score = scoreExpression；
   - evidence = evidenceTemplate。
3. builtin → owner=builtin，user → owner=user。
4. validationStatus=valid，publishedAt=definedAt，Strategy=active。
5. definitionHash 使用 canonical JSON 计算。
6. 将 tactic_signals 迁为 strategy_signals：
   - strategy/version 取映射；
   - ruleId 固定为 `legacy-signal`；
   - runId 指向为同一时间桶创建的 migration StrategyRun，或使用专门的
     `legacy-signal-import` run；
   - triggerSnapshot → evaluationSnapshot。

迁移后数量校验：

- Strategy 数 = Tactic 数（无冲突时）。
- 每个 Tactic 有且只有一个迁移 version。
- signal 行数一致；重复行按目标唯一键幂等合并并记录数量。

### 7.3 StockGroup → Watchlist

每个 stock_groups 行：

- id/name/description/enabled 保持。
- resolver 映射：

| resolver | Watchlist kind/policy | source producer |
|---|---|---|
| manual | personal/manual | manual source |
| holdings | portfolio/synced | portfolio:<accountId> |
| formula | strategy/synced | strategy:<mappedStrategyId> |
| llm | personal/mixed | ai:legacy-group:<groupId> |

manual resolver 的 stockIds：

- 为每个 stockId 创建或复用 WatchlistMember(stage=watching)。
- 创建 manual source，reason=`从手工分组迁移`。

holdings：

- 迁移时从当前 active holdings 创建 Member 和 portfolio source。
- 后续由 portfolio sync tool 维护，不以迁移时快照作为永久事实。

formula/llm 历史 group_member_snapshots：

1. 按 refreshId 分组创建 WatchlistSyncRun。
2. 每行创建 MembershipSnapshot(change 初始按相邻批次计算)。
3. 最新成功批次创建 active strategy/ai sources。
4. dataAsOf、score、evidence、tacticId、signalTs 尽量原样迁移。
5. 无快照的动态组保留空 Watchlist，并标记首次 sync required，不伪造成员。

### 7.4 StockPool → AlertPlan

- id/name/description/rules/logic/triggerMode/priority/cooldown/limit/recovery/enabled 原样迁移。
- groupId 通过 group→watchlist 映射变为 watchlistId。
- tactic rule：
  - tacticId → strategyId；
  - kind → strategy-signal；
  - 缺 ruleId 时使用迁移 Strategy 的 `legacy-signal`。
- WatchTrigger/WatchRuleState 的 plan id 保持相同，仅回填 alertPlanId。
- 找不到 Watchlist 或 Strategy 映射时，不启用该 AlertPlan，记录 migration warning。

### 7.5 双读校验与切换

切换前提供只读校验命令（该命令与 migration decoder 已在旧模型收尾中移除，本节保留为切换期设计记录）：

```text
luoome migration verify strategy-watchlist
```

输出：

- tactics/strategies 数量和未映射项；
- tacticSignals/strategySignals 数量与抽样 hash；
- groups/watchlists 数量；
- 每组当前成员集合差异；
- pools/alertPlans 数量和规则差异；
- triggers/rule states 引用完整性；
- warnings 和是否允许切换。

切换条件：

- 无 orphan 引用；
- 当前成员集合完全一致（明确允许的 holdings 时点差异除外）；
- 启用 AlertPlan 数一致；
- 所有迁移 warning 已分类为 accepted 或 blocking；
- contract/test:db 全绿。

## 8. Strategy 运行设计

### 8.1 单次运行

`run_strategy` tool 的逻辑：

```text
load active StrategyVersion
  → resolve StockUniverse
  → prepare market/data context
  → evaluate selection/scoring/signals per stock
  → assign stable ranks
  → commit StrategyRun + Results + Signals
  → （未交付，后续迭代）optional sync target Watchlist
```

输入：

```ts
{
  strategyId: string;
  versionId?: string;       // 缺省 currentVersion
  mode?: 'scan' | 'replay';
  asOf?: Date;              // replay 必填
  stockIds?: string[];      // 试算子集；正式 scheduled 不允许
  targetWatchlistId?: string; // 未交付，后续迭代（schema 已不含该字段）
  persist?: boolean;        // 默认 true；试算 false
}
```

sideEffect：

- 需要外部行情时为 `external`。
- `persist=false` 仍可能外部取数，不能标 read。
- Agent 调用正式 persist/sync 前必须获得明确确认；样本试算可自动调用。

### 8.2 数据上下文

首版复用 `run_tactic` 当前的 quote/indicators/meta context。增加注册表：

```ts
interface StrategyFieldDefinition {
  path: string;
  type: 'number' | 'boolean' | 'string';
  unit?: string;
  requiredLookback?: number;
  dataSource: 'quote' | 'daily-bars' | 'meta';
  availableForCoverage: readonly MarketCoverage[];
}
```

创建/发布时静态解析表达式路径，所有 path 必须在 registry 中。运行时字段缺失产生 unknown，
不得以 0 或 false 替代。

### 8.3 性能

- 正式全市场候选身份来自 StockUniverse，行情快照不能增删候选。
- 复用当前 batch snapshot 和 daily bar manager。
- 只有表达式依赖 K 线字段时才取 daily bars。
- 股票求值使用有上限并发池，初始 8；adapter rate limiter 仍是硬限制。
- 每 100 只汇总进度，不为每只股票写 WorkflowRun。
- results 批量事务提交，单批建议 500 行。
- 单股表达式错误不阻塞其它股票；run 仍可 `complete`，并以
  `summary.dataHealth=partial`、`incompleteCount` 记录覆盖质量。

### 8.4 排名稳定性

- score 降序。
- score 相同按 stockId 升序。
- rank 使用 competition ranking 还是 ordinal ranking 必须固定；首版采用 ordinal，保证 topN 确定。
- score 计算后 clamp 不是默认行为；越界视为 rule error。只有 DSL 明确使用 Math.min/max 才截断。

## 9. Watchlist 同步设计

### 9.1 原子同步输入

```ts
interface WatchlistSourceCandidate {
  stockId: string;
  reason: string;
  score?: number;
  rank?: number;
  evidence: readonly string[];
  dataAsOf?: Date;
}

interface SyncWatchlistSourceInput {
  watchlistId: string;
  sourceKind: 'strategy' | 'ai' | 'portfolio' | 'import';
  sourceKey: string;
  sourceId?: string;
  sourceVersionId?: string;
  producerRunId?: string;
  status: 'complete' | 'partial' | 'failed';
  candidates: readonly WatchlistSourceCandidate[];
  missingDimensions?: readonly ReportMissingDimension[];
}
```

### 9.2 同步算法

在一个 repository 事务中：

1. 加载该 Watchlist + sourceKey 的当前非 ended sources。
2. 校验候选 stockId 属于权威 universe/search 结果并确保 Stock stub。
3. 计算 entered/unchanged/exited。
4. 写 WatchlistSyncRun 和 MembershipSnapshot。
5. complete：
   - entered：创建/恢复 Member，创建 active source。
   - unchanged：更新当前 source 的 score/rank/evidence/dataAsOf。
   - exited：结束 source；若无其它 active/stale source 且用户未保留，归档 Member。
6. partial/failed：
   - 不处理 exited；
   - 现有 source 标 stale；
   - partial 中确定成功的 candidate 可更新，但不得据缺失集合推导退出。
7. 提交统计。

空 complete candidates 只有在 producer 明确证明完整运行成功时才允许结束全部来源。StrategyRunner
必须区分“完整零命中”和“数据失败导致零结果”。

### 9.3 AI source

AI 不直接调用 sync tool 的 complete 模式。流程：

```text
Agent 生成候选草案
  → search/universe 校验
  → 用户确认
  → activate_ai_watchlist_draft
  → sync source
```

draft 自身可存在 chat UI message 或独立短期对象，首期不需要永久 Agent marketplace 实体。

### 9.4 Portfolio source

Portfolio Watchlist 每次持仓写操作后或启动同步：

- 当前 active Holding → candidate。
- sourceKey=`portfolio:<accountId>`。
- reason 包含账户和持仓状态，不包含敏感数量的通知文本。
- complete 只基于本地 repository，不依赖外部行情。
- 平仓结束 portfolio source，不自动归档仍被用户/Strategy 关注的 Member。

## 10. AlertPlan 与盘中链路

`intraday-watch` 改造后的步骤：

```text
load enabled AlertPlans
  → load enabled Watchlist members
  → resolve quotes / previous closes / StrategySignals / events
  → evaluate AlertRules
  → apply edge state + cooldown + daily limit
  → save WatchTrigger
  → notify
  → record WatchRun
```

约束：

- archived Member 不进入扫描。
- Watchlist disabled 时所有关联 AlertPlan 视为 not-ready，不使用旧成员。
- stale strategy/ai source 不等于 Member 不可扫描；页面和触发证据必须显示 stale。
- strategy-signal rule 只读取持久化 StrategySignal，不在盘中临时跑全市场 Strategy。
- cost-threshold 只对存在 Holding 的 Member 求值，否则 unknown。
- AlertPlan 不拥有成员；删除被引用 Watchlist 被拒绝。

## 11. Tools

### 11.1 Strategy tools

| tool | sideEffect | 说明 |
|---|---|---|
| `list_strategies` | read | 列身份、状态、当前版本和最近运行 |
| `get_strategy` | read | Strategy + versions + definition |
| `create_strategy` | write | 创建 draft Strategy |
| `create_strategy_version` | write | 从 definition/parent 创建待校验版本 |
| `validate_strategy_version` | external | 静态校验 + 可选样本取数试算 |
| `publish_strategy_version` | write | 激活 valid version |
| `pause_strategy` | write | 暂停定时运行 |
| `run_strategy` | external | 运行并可持久化结果 |
| `list_strategy_runs` | read | 运行历史 |
| `get_strategy_run` | read | run + results + provider status |
| `strategy_signals_by_stock` | read | 个股信号 |

### 11.2 Watchlist tools

| tool | sideEffect | 说明 |
|---|---|---|
| `list_watchlists` | read | 列 Watchlist、成员数和来源健康 |
| `get_watchlist` | read | Member + current sources + AlertPlans |
| `create_watchlist` | write | 创建 |
| `update_watchlist` | write | 改基础字段/启停 |
| `archive_watchlist` | write | 软归档；有 AlertPlan 引用时拒绝 |
| `add_watchlist_member` | write | 添加 manual source |
| `update_watchlist_member` | write | 修改 stage/priority |
| `archive_watchlist_member` | write | 结束 manual source/归档 |
| `sync_watchlist_source` | write | 内部原子同步；不直接暴露给日常 Agent |
| `list_watchlist_changes` | read | sync runs/snapshots |

### 11.3 Alert tools

| tool | sideEffect | 说明 |
|---|---|---|
| `list_alert_plans` | read | 替代 list_watch_plans/list_stock_pools |
| `create_alert_plan` | write | 引用 Watchlist |
| `update_alert_plan` | write | 保留 ruleId |
| `delete_alert_plan` | write | 删除计划，不删 Trigger 历史 |
| `list_watch_triggers` | read | 兼容保留名称 |

### 11.4 ToolResult 与错误

所有 tool 继续返回 `ToolResult`。常用错误：

| 情况 | ToolError.kind |
|---|---|
| schema/DSL/未知字段 | `invalid_input` |
| Strategy/Watchlist 不存在 | `not_found` |
| 引用、版本、删除不变量 | `invariant_violation` |
| 行情或 provider 失败 | `adapter_error` |
| LLM 生成失败 | `llm_error` |
| repository 未知失败 | `internal`，不泄漏底层异常 |

## 12. Workflows

### 12.1 `run-strategies`

盘后运行 active + scheduled Strategy：

1. `list_strategies(status=active)`。
2. 过滤 schedule=after-market 的 currentVersion。
3. 对每个 Strategy 调 `run_strategy`。
4. （未交付，后续迭代）有 target Watchlist 时调用内部 sync tool。
5. 记录每项执行状态 complete/failed、dataHealth 和 providerStatuses；历史 partial 按完成读取。
6. 不生成 Advice、不发送买卖结论。

### 12.2 `sync-portfolio-watchlists`

读取账户/持仓 tools，按账户同步 portfolio Watchlist。由持仓写操作后、Web 启动或手动执行。

### 12.3 `intraday-watch`

保留现有 workflow 名，内部改用 AlertPlan/Watchlist tools。兼容 CLI `luoome watch`。

### 12.4 workflow 约束

- 只通过 `ctx.tools.*`，不直接访问 repository/adapter。
- 固定定时编排使用 workflow；Agent 不递归调用 workflow tool。
- 每轮写 WorkflowRun，并明确 partial/failed。

## 13. Web、CLI、MCP 与 Agent

### 13.1 Web

新增/调整路由：

```text
#strategies
#strategies/:id
#watchlists
#watchlists/:id
#alerts
```

Web 技术栈保持 Hono + 原生 HTML/CSS/JS。

API：

```text
GET/POST /api/strategies
GET/POST /api/strategies/:id/versions
POST     /api/strategies/:id/validate
POST     /api/strategies/:id/publish
POST     /api/strategies/:id/run
GET/POST /api/watchlists
GET/PATCH /api/watchlists/:id
POST     /api/watchlists/:id/members
PATCH    /api/watchlists/:id/members/:memberId
GET/POST /api/alert-plans
```

所有 mutation 继续受 token、同源 Origin 和 `LUOOME_EXPOSE_WRITE=true` 保护。

### 13.2 CLI

```text
luoome strategy list|get|validate|run
luoome watchlist list|get|sync
luoome alert list
luoome watch                         # 现有常驻 runner 保留
```

### 13.3 MCP

- 新 read tools 默认可暴露。
- write/external 遵循现有 opt-in。
- `sync_watchlist_source`、migration 和内部 commit tools 不暴露。
- 实际执行为一次性硬切：旧 tactic/group/pool tools 已随迁移从 registry 移除，无兼容期 discovery。

### 13.4 Agent

- 只通过新 tools 操作目标模型。
- 创建/发布 Strategy、创建 Watchlist/AlertPlan、确认 AI source 都走 draft-and-confirm。
- run_strategy 的正式全市场 persist/sync 视为 external + write 意图，需确认。
- Agent 不访问 legacy tools，避免生成新的旧模型数据。

## 14. 兼容与弃用

> 实际执行记录：设计原建议两个发布版本的兼容期（见下），落地时改为一次性
> big-bang 硬切——新旧模型同分支切换，legacy tools 直接移除、不做转译层。

原设计（未按此执行，仅供追溯）：

### 版本 N

- 新旧 read tools 同时存在。
- 所有新 UI/Agent 只写新模型。
- legacy write tools 内部转译成新模型写入，不再写旧表；无法无损映射则返回弃用错误。
- 迁移校验命令可用。

### 版本 N+1

- 默认 registry 移除 legacy tools。
- 旧表保持只读回滚来源。
- legacy entity 文件只保留类型 re-export 和 migration decoder。

实际执行（一次性硬切）：

- legacy tools 随迁移同版本从 registry 移除，不保留 discovery，不做 deprecated 过渡。
- 旧数据经一次性 migration decoder 迁移校验；收尾阶段用户确认不再需要数据迁移后，
  migration decoder、verify 命令、旧表 DDL/schema 与 legacy entity 已整体移除，
  存量库的旧物理表不再维护（不 DROP、不读取）。

## 15. 安全与隐私

- Strategy DSL 不包含订单、broker、account token 或真实交易执行段。
- portfolio guidance 只能作为 Advice 输入。
- Strategy/Watchlist/AlertPlan 的 write tool 必须显式 opt-in。
- Agent 生成内容必须先校验、试算、确认。
- Watchlist portfolio source 对外展示遵守当前账户范围，MCP 不返回不必要的私人笔记。
- 日志不记录完整研究笔记、账户隐私、API key 或 LLM 凭证。
- Advice 继续包含反证、风险、免责声明和有效期。

## 16. 测试策略

### 16.1 Core

- 每个 schema 和不变量。
- canonical JSON/hash 稳定性。
- expression 字段静态校验、安全关键字和 unknown/error。
- StrategyEvaluator 的 all/any、score、rank、signal。
- Watchlist stage/source 状态机。
- complete/partial/failed 同步算法。
- legacy decoder 映射。

### 16.2 Repository contract

drizzle + memory 共用：

- Strategy/version 唯一、激活事务、不可变版本。
- Run commit 原子性、result/signal 唯一和排序。
- Watchlist member 唯一。
- 多 source 进入、更新、stale、结束、重新进入。
- complete 空结果、partial/failed 不退出。
- sync commit 原子性。
- AlertPlan 引用和删除保护。

### 16.3 Migration

fixture 数据库覆盖：

- 空库。
- 只有 builtin Tactic。
- user Tactic + signals。
- manual/holdings/formula/llm group。
- 多 refreshId 和空动态组。
- StockPool/WatchTrigger/RuleState 历史。
- id 冲突、缺引用、重复 signal。
- 中途失败后重启。
- migration 重复运行。
- verify 报告一致。

### 16.4 Tools/workflows

- ToolResult 成功和每类错误。
- registry sideEffect 与 schema 派生。
- run-strategies 一项失败不阻塞其它项。
- StrategyRun → Watchlist sync。
- portfolio sync。
- intraday-watch 使用 Watchlist/AlertPlan 后行为与旧链一致。
- Agent whitelist 不含内部 sync/migration/trade。

### 16.5 Web

- API 鉴权/Origin/write opt-in。
- Strategy 草案、校验、发布、运行。
- Watchlist 多来源和 stage 操作。
- AlertPlan CRUD 与试跑。
- 浏览器真实启动验证：页面、确认、错误、stale/partial 展示。

### 16.6 验收命令

开发中先跑目标测试；每个阶段交付前至少：

```text
bun run typecheck
bun run test
bun run test:db
bun run test:web        # 涉及 Web 时
bun run lint
git diff --check
```

最终切换阶段运行 `bun run test:all` 和真实浏览器验收。

## 17. 可观测性

日志和 WorkflowRun 至少包含：

- strategyId/version/runId、候选数、结果数、dataHealth/incomplete/failed 原因、耗时。
- watchlistId/sourceKey/syncRunId、entered/exited/unchanged/stale。
- alertPlanId、评估成员数、unknown 数、触发与送达统计。
- migration id、扫描/写入/跳过/冲突数。

不记录完整 DSL 之外的敏感用户内容；definitionHash 用于关联。

## 18. 已确认决策

1. StrategyVersion 的 `definition_json` 是运行时唯一事实源。YAML 只作为导入/导出格式，解析并
   canonicalize 后才可进入校验和发布流程；原始 YAML 不参与运行。
2. archived Member 收到新的自动来源时恢复为 discovered；用户手工恢复时可明确选择 watching
   或 researching。
3. 首期不新增永久 AgentRun 领域实体。AI source 使用现有 chat message/tool trace id；未来只有
   在 Agent run 形成独立查询、保留和权限生命周期时再立项。
4. legacy tools 的兼容期未执行：实际为一次性 big-bang 硬切，迁移版本直接移除 legacy
   tools（不转译、不保留 discovery）；旧表数据经迁移命令处理，物理清理留给未来专项。
5. Strategy selection 零规则只允许 migration/builtin Strategy；普通用户创建和发布至少需要
   一条 selection rule。
