# ruo 能力迁移详细设计（Phase 1）

> 状态：Phase 1 已实现（2026-07-25）
> 日期：2026-07-24
> 输入：[ruo 能力迁移产品设计文档（PRD）](../prd/ruo-feature-migration-product-design.md)
> 关联：[Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)
> 范围：Phase 1A（研究档案）、1B（公司事件）、1C（可信度与运行状态）。Phase 2/3 只定义接口预留。

## 1. 设计目标与约束

- 新增实体（`ResearchNote` / `StockEvent` / `WorkflowRun`）走现有模式：core zod entity + drizzle/memory 双 repo + contract-tests + 启动幂等建表。
- `event-date` 复用 `StockPool` / `WatchTrigger` / 送达状态机，不新建提醒链路；与策略预警 DDD 的 `watch_triggers` 变更合并为同一次迁移窗口。
- 调度不内置：全部自动任务 = workflow + 外部 cron（PRD 决策 11）。
- 事实 / 观点 / 建议分层落到 schema：`ResearchNote`（观点）、`StockEvent`（事实）、`Advice`（建议）互不嵌入。

## 2. PRD 决策到实现的映射

| PRD 条目 | 实现落点 |
|---|---|
| 研究档案是聚合读模型（§4.1） | Web 研究页签组合现有 read tool，无新实体 TrackingCard |
| ResearchNote active/版本（§6.1） | `active` + `supersedesId`，thesis 编辑 = 插入新版本行 |
| 公司事件幂等（§6.2） | `(provider, externalId)` 唯一约束 + upsert |
| event-date 低频规则（§6.2） | `WatchRuleKind` 加 `'event-date'`，每日 workflow 求值，intraday-watch 跳过 |
| 提醒窗口（§6.2） | 规则级 `daysBefore` 默认 + 事件级 `remindBeforeDays` 覆盖；去重键含 `eventId` |
| DataProvenance 值对象（§6.3，决策 13） | 公共 schema；Phase 1 只嵌入 `StockEvent` + 行情状态读模型 |
| 运行审计（§6.4） | 新表 `WorkflowRun`；`WatchRun` 保留，查询层适配统一读模型 |
| 调度（决策 11） | cron + `luoome workflow run`，workflow 幂等 |

## 3. 领域模型与 Schema

新 entity 文件：`packages/core/src/entity/research-note.ts`、`stock-event.ts`、`provenance.ts`、`workflow-run.ts`。表定义进 `packages/db/src/schema/index.ts`，建表 / 补列进 `client.ts`。

### 3.1 ResearchNote

```ts
export const ResearchNoteKindSchema = z.enum(['thesis', 'note', 'source-summary']);
export const ResearchStanceSchema = z.enum(['bullish', 'bearish', 'neutral']);

export const CitationSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  quote: z.string().max(500).optional(),
});

export const ResearchNoteSchema = z.object({
  id: z.string().min(1),                       // note_${uuid8}
  stockId: z.string().min(1),
  kind: ResearchNoteKindSchema,
  title: z.string().max(120).optional(),
  content: z.string().min(1).max(10000),
  stance: ResearchStanceSchema.optional(),
  /** thesis 专用：当前生效假设；非 thesis 恒 false。 */
  active: z.boolean().default(false),
  /** thesis 专用：本版本取代的上一条 id。 */
  supersedesId: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  sourceTitle: z.string().max(300).optional(),
  sourceStatus: z.enum(['verified', 'unverified']).optional(),
  fetchedAt: z.coerce.date().optional(),
  citations: z.array(CitationSchema).max(16).optional(),
  relatedHoldingId: z.string().optional(),
  relatedAdviceId: z.string().optional(),
  relatedWatchTriggerId: z.string().optional(),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
```

不变量（`assertResearchNoteInvariants`）：

- `kind = 'thesis'` 且 `active = true` → 同 `stockId` 其它 thesis 必须 `active = false`（repo 层事务保证，tool 层先做应用检查给出可读错误）；
- `kind = 'source-summary'` → `sourceUrl`、`fetchedAt` 必填；无法验证来源 → `sourceStatus = 'unverified'`；
- `kind ≠ 'thesis'` → `active = false`、`supersedesId` 为空；
- `supersedesId` 链不成环、必须指向同 `stockId` 的 thesis。

表：`research_notes`，索引 `(stock_id, created_at)`、`(stock_id, kind, active)`。

### 3.2 StockEvent

```ts
export const StockEventKindSchema = z.enum([
  'earnings', 'unlock', 'dividend', 'shareholder-meeting', 'announcement', 'manual',
]);
export const EventImportanceSchema = z.enum(['urgent', 'important', 'normal']);
export const StockEventStatusSchema = z.enum(['scheduled', 'occurred', 'cancelled']);

export const StockEventSchema = z.object({
  id: z.string().min(1),                       // evt_${uuid8}
  stockId: z.string().min(1),
  kind: StockEventKindSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  occursAt: z.coerce.date(),
  allDay: z.boolean().default(true),
  importance: EventImportanceSchema,
  status: StockEventStatusSchema.default('scheduled'),
  source: z.enum(['manual', 'external']),
  provider: z.string().optional(),
  externalId: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  observedAt: z.coerce.date().optional(),      // 事件实际对应时间（≠ 抓取时间）
  fetchedAt: z.coerce.date().optional(),
  stale: z.boolean().default(false),           // provider 失败后保留旧数据时置 true
  /** 事件级提醒窗口（天）；空数组 = 用规则默认。 */
  remindBeforeDays: z.array(z.number().int().min(0).max(90)).max(8).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
```

表约束：

- `source = 'external'` → `provider`、`externalId` 必填；`(provider, external_id)` 建唯一索引（manual 行两列为 NULL，SQLite 唯一索引天然放行多 NULL）。
- 索引：`(stock_id, occurs_at)`（档案时间线）、`(occurs_at, status)`（提醒窗口扫描）、`(stock_id, kind, occurs_at)`（手工事件疑似重复检测）。
- `allDay = true` 的 `occursAt` 统一存 Asia/Shanghai 当日 00:00，比较只按日期部分。

### 3.3 DataProvenance（值对象）

```ts
export const DataProvenanceSchema = z.object({
  provider: z.string().min(1),
  observedAt: z.coerce.date(),                 // 数据实际对应时间
  fetchedAt: z.coerce.date(),                  // 抓取时间
  freshness: z.enum(['fresh', 'stale', 'unknown', 'unavailable']),
  fallbackFrom: z.string().optional(),         // 主源失败时的原 provider
  errorKind: z.string().optional(),
  errorMessage: z.string().max(300).optional(),
});
```

Phase 1 嵌入点：`StockEvent`（展开为列：provider / observedAt / fetchedAt / stale，见 §3.2）；行情状态读模型（§6）。不进 `Quote` 实体、不回填（PRD 决策 13）。

### 3.4 WorkflowRun

```ts
export const WorkflowRunSchema = z.object({
  id: z.string().min(1),
  workflowName: z.string().min(1),             // 'sync-stock-events' | 'refresh-groups' | ...
  mode: z.enum(['manual', 'scheduled', 'daemon']),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  inputSummary: z.record(z.unknown()).optional(),
  outputSummary: z.record(z.unknown()).optional(),
  providerStatuses: z.array(z.object({
    provider: z.string(),
    ok: z.boolean(),
    errorKind: z.string().optional(),
  })).default([]),
  error: z.string().max(500).optional(),
});
```

表：`workflow_runs`，索引 `(workflow_name, started_at)`、`(started_at)`。

与 `WatchRun` 的统一读模型（查询层适配，不迁表）：

```ts
interface UnifiedRun {
  source: 'watch' | 'workflow';
  name: string;              // watch → 'intraday-watch'
  mode: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: Date;
  finishedAt?: Date;
  summary?: Record<string, unknown>;
  error?: string;
}
```

`list_workflow_runs` 默认返回两者合并视图（`WatchRun` 侧 failed/partial 由现有 status 映射）。

### 3.5 WatchTrigger / WatchRule 扩展（与策略预警 DDD 同窗口）

- `WatchRuleKind` 增加 `'event-date'`；新规则变体：

```ts
export const EventDateRuleSchema = z.object({
  kind: z.literal('event-date'),
  /** 关注的事件类型；缺省 = 全部。 */
  eventKinds: z.array(StockEventKindSchema).optional(),
  /** 最低重要性；缺省 normal（全部）。 */
  minImportance: EventImportanceSchema.default('normal'),
  /** 默认提醒窗口（天）；事件级 remindBeforeDays 非空时被覆盖。 */
  daysBefore: z.array(z.number().int().min(0).max(90)).max(8).default([7, 3, 1]),
  direction 固定 'watch'，priority 由事件 importance 映射（urgent→urgent / important→important / normal→normal）。
});
```

- `watch_triggers` 补列 `event_id TEXT`（可空）+ 索引 `(pool_id, stock_id, rule_id, event_id, created_at)`。非 event-date 触发的 `eventId` 为空。
- `intraday-watch` 遇 `event-date` 规则直接跳过（不计入求值、不影响 ANY/ALL——含 event-date 的 pool 建议单独建，混用时 event-date 不参与盘中组合判定，文档与 UI 均需提示）。
- cooldown/去重键对 event-date 扩展为 `(poolId, stockId, ruleId, eventId, remindDay)`：`remindDay` 存 `evalSnapshot`，每个（事件, 提醒日）最多一条触发。

### 3.6 迁移

启动幂等执行：

1. 建 `research_notes`、`stock_events`（含唯一索引）、`workflow_runs`；
2. `watch_triggers` 补列 `event_id` + 新索引（与策略预警 DDD §3.7 的补列合并执行，一次迁移窗口完成）；
3. 无存量数据回填需求（全部为新增）。

## 4. 事件同步 workflow（sync-stock-events）

### 4.1 Provider 接口

```ts
interface StockEventProvider {
  readonly name: string;                        // 'eastmoney-events' | ...
  fetchEvents(input: {
    stockIds: readonly string[];
    kinds?: readonly StockEventKind[];           // provider 能力子集
    windowDays: number;                          // 未来 N 天
  }): Promise<ExternalEvent[]>;                  // 结构对齐 StockEvent（无 id / stale）
  readonly supportedKinds: readonly StockEventKind[];
}
```

- 首个实现：财报 / 解禁 / 分红三类（具体数据源选型是独立任务，见 §12 开放问题 1）；`shareholder-meeting` / `announcement` 待 provider 能力确认后扩展。
- Provider 接口与 schema 稳定，原始字段差异封装在实现内（PRD §7.3 同源思路）。

### 4.2 关注股票集合

同步范围 = 持仓 ∪ enabled 分组成员快照 ∪ 存在手工事件的股票（去重）。无关注股票时 workflow 记 succeeded、`outputSummary.syncedStocks = 0`。

### 4.3 幂等与失败语义

```text
对每个 (provider, stockId)：
  events = provider.fetchEvents(...)
  成功 → 逐条 upsert by (provider, externalId)：
          已存在 → 更新 title/occursAt/status/importance，stale=false，updatedAt=now
          不存在 → 插入
          occursAt 变更即生效（提醒窗口按新日期重算，见 §5）
  空列表 → 不删除任何旧事件（PRD 关键约束），仅记录
  失败   → 该 provider 全部相关事件 stale=true；WorkflowRun 记 partial + providerStatuses
```

- 单 provider 失败不影响其他 provider；全部失败 → run 记 failed。
- `cancelled` 只由 provider 明确状态驱动；本地不推断取消。
- workflow 幂等：同日重复执行结果一致（upsert 语义保证）。

### 4.4 调度（cron 建议，文档化在 docs/ 与 README）

```cron
# 事件同步：每交易日 08:30
30 8 * * 1-5  luoome workflow run sync-stock-events
# event-date 求值：每交易日 08:50（同步之后）
50 8 * * 1-5  luoome workflow run evaluate-event-rules
```

## 5. event-date 求值 workflow（evaluate-event-rules）

每日一次（盘前），不复用 `intraday-watch`：

```text
1. 加载 enabled pool 中所有 event-date 规则（pool × rule）
2. 解析 pool 分组成员（复用现有 resolver 读路径）
3. 对每个 (pool, rule, stock)：
   events = stockEventRepo.listUpcoming(stockId, now, now + max(daysBefore) 天,
                                        status = 'scheduled', kinds 过滤, importance 过滤)
4. 对每个 event：
   effectiveDays = event.remindBeforeDays 非空 ? event.remindBeforeDays : rule.daysBefore
   d = event.occursAt 日期 − 今日（Asia/Shanghai，自然日差）
   d ∈ effectiveDays 且未发过（eventId, ruleId, poolId, d）→ 生成 WatchTrigger：
     ruleKind='event-date', ruleId=规则 id, eventId=event.id,
     direction='watch', priority=event.importance 映射,
     reason=事件标题 + 距今天数, evidence=[provider, sourceUrl, occursAt],
     evalSnapshot={ eventId, eventKind, remindDay: d, importance, stale }
5. 送达：走策略预警 DDD §8 的判定矩阵（normal → not-requested 仅记录；
   important/urgent → pending → 发送）；cooldown 键含 eventId + remindDay
```

边界语义：

- 事件改期：新日期落窗即触发新提醒（`d` 重算）；旧提醒保留历史。`cancelled` 事件不再触发。
- `stale = true` 的事件仍可触发，但 evidence 标注「数据可能过期」（PRD §10.2：旧快照可用但标记）。
- `today = d 的 0`：支持 `remindBeforeDays: [0]`（当天提醒）。
- 手工事件与外部事件走同一路径，无差别。

## 6. 行情状态读模型（get_market_data_status）

不落新表，现算：

```text
对每个行情 provider（eastmoney / tencent）：
  latestSnapshot = priceSnapshot 最新一条 (provider, ts)
  freshness：盘中且 ts 在 2 个扫描周期内 → fresh；
            超过 → stale；当日无快照 → unknown；provider 连续失败 → unavailable
  fallbackFrom：最近一次 WatchRun / sync-quotes 中记录的降级来源
输出：{ providers: [...], watchHealth: 最近 WatchRun 摘要, watchlistStale: stale Watchlist 列表 }
```

数据源复用现有 `PriceSnapshot`、`WatchRun`、分组 stale 语义（PRD §6.3 新鲜度规则）。

## 7. Tool 契约

### 7.1 ResearchNote

```ts
list_research_notes({ stockId, kind?, activeOnly?, since?, limit? })      // read
  → { notes: ResearchNote[] }                       // activeOnly=true 只返回当前假设

add_research_note({ stockId, kind, title?, content, stance?, tags?,       // write
                    sourceUrl?, citations?, relatedXxxId?... })
  → { note }                                        // kind=thesis 时自动 active=true 并
                                                    // 停用旧 thesis（supersedesId 串联）

update_research_note({ noteId, title?, content?, stance?, tags?,          // write
                       setActive?: boolean })
  → { note, superseded? }
  // thesis 内容/立场变更 → 插入新版本行（返回 superseded = 旧行）；
  // 非内容字段（tags/title）原地更新；setActive=true 恢复历史版本为当前假设；
  // 非 thesis 一律原地更新

delete_research_note({ noteId })                                          // write
  → { ok }                                // 只删笔记，不动关联实体；删 active thesis 后
                                          // 该股票无当前假设（不自动复活旧版本）
```

### 7.2 StockEvent

```ts
list_stock_events({ stockId?, kinds?, status?, from?, to?,                // read
                    importance?, limit? }) → { events }

add_stock_event({ stockId, kind, title, occursAt, allDay?,                // write
                  importance?, remindBeforeDays?, description?, sourceUrl? })
  → { event, duplicateWarning? }          // (stockId, kind, occursAt) 已存在时返回
                                          // duplicateWarning，由调用方决定是否继续

update_stock_event({ eventId, title?, occursAt?, importance?,             // write
                     remindBeforeDays?, status? }) → { event }
  // source=external 的事件禁止编辑 occursAt（以 provider 为准），只能改提醒设置

delete_stock_event({ eventId })                                           // write
  // 仅 manual；external → invalid_input（提示用 cancelled 状态语义）

sync_stock_events({ stockIds?, provider? })                               // external
  → { synced, upserted, staleMarked, providerStatuses }
  // 原子同步 tool；完整 workflow（sync-stock-events）不经 MCP 暴露
```

### 7.3 运行状态

```ts
get_market_data_status({}) → §6 读模型                                     // read

list_workflow_runs({ workflowName?, status?, since?, limit?,              // read
                     includeWatch?: boolean = true }) → { runs: UnifiedRun[] }
```

### 7.4 暴露分级

read 全暴露；note/event CRUD 归 write（opt-in）；`sync_stock_events` 归 external（opt-in）。无新增 exposure 组。

## 8. Web 交互要点

- **研究页签**（Phase 1A 主交付）：顶部摘要 + 时间线 + 侧栏（PRD §6.1 页面结构）。时间线由服务端聚合接口 `GET /stocks/:id/research-timeline` 输出（内部组合 list_research_notes / list_stock_events / list_watch_triggers / get_advice / list_trades，按时间倒序、支持类型筛选），不作为 MCP tool。
- **thesis 编辑**：前端走 `update_research_note`，展示「将保存为新版本，历史版本保留在时间线」。
- **事件组件**：分组详情「近期事件」与档案侧栏「未来 30/90 天」共用 `list_stock_events`。
- **状态组件**：仪表盘数据健康 + 设置页 workflow 运行记录，消费 `get_market_data_status` / `list_workflow_runs`。
- **新鲜度展示**：fallback / stale / unavailable 三态样式按 PRD §6.3 用户展示文案；unavailable 禁止渲染零值。

## 9. 指标与日志

| PRD 指标（§13） | 数据来源 |
|---|---|
| 来源可解释率 | StockEvent provider/fetchedAt 非空占比 |
| 事件重复率 | `(provider, externalId)` 冲突插入尝试计数（应为 0，upsert 兜底） |
| 自动任务可审计率 | 计划内 workflow 有 WorkflowRun 记录占比 |
| 新鲜度可判断率 | get_market_data_status 覆盖的展示位占比 |

日志：同步 workflow 输出每 provider 的 upserted / skipped / stale 计数；evaluate-event-rules 输出每 pool 的触发数与去重命中数。

## 10. 测试计划

- **实体**：ResearchNote 不变量（active 唯一、source-summary 必填、supersedes 同股不成环）；StockEvent 外部事件必填字段、allDay 日期口径。
- **同步 workflow**：upsert 幂等（重复执行无重复行）、空列表不删旧、失败标 stale 保留旧数据、单 provider 失败 partial、改期更新 occursAt。
- **event-date**：窗口命中（含 d=0）、事件级覆盖规则默认、（event, day）去重、改期重触发、cancelled 不触发、normal 仅记录 / important 推送、intraday-watch 跳过 event-date。
- **tool**：thesis 版本链（编辑 → 新行 + 旧行停用）、setActive 恢复、delete 不连锁、external 事件编辑限制、手工事件 duplicateWarning。
- **repo 契约**：contract-tests 双实现覆盖三个新 repo + watch_triggers 新查询。
- **统一读模型**：WatchRun / WorkflowRun 合并视图字段映射。

## 11. 实施任务拆分

| 组 | 内容 | 依赖 |
|---|---|---|
| A 领域模型 | §3 全部 entity + 表 + 迁移 | 与策略预警 DDD 组 A 对齐迁移窗口 |
| B 事件同步 | provider 接口 + 首个实现 + sync workflow + cron 文档 | A |
| C event-date | 规则变体 + evaluate-event-rules + intraday 跳过 + 送达接入 | A + 策略预警 DDD 组 B 的送达状态机 |
| D tool/API | §7 全部 + 研究时间线聚合接口 | A（B/C 完成后联调） |
| E Web | 研究页签、事件组件、状态组件 | D |
| F 测试 | §10 各层 | 随各组 |

顺序：A → B ∥ C ∥ D → E。Phase 1A（ResearchNote）可独立于 B/C 先交付。

## 12. 开放问题

1. 首个事件 provider 的数据源选型（财报 / 解禁 / 分红日历的免费可靠来源）——Phase 1B 最大风险，选型结论需回填本文档。
2. `ResearchNote.tags` 是否需要预定义词表，还是自由文本先行？倾向自由文本 + 后续按使用收敛。
3. 手工事件是否也进入 `sync_stock_events` 的 stale 语义？倾向否（无 provider，stale 无意义）。
4. 统一读模型中 `WatchRun` 的 `partial` 映射：现有 status 枚举是否够用，还是只映射 succeeded/failed？实现时按现有枚举定稿。
