# 策略预警详细设计（Phase 1）

> 状态：Phase 1 已实现（2026-07-25）
> 日期：2026-07-24
> 输入：[策略预警产品文档（PRD）](../prd/strategy-alert-product.md)
> 范围：PRD Phase 1。volume-ratio、drawdown-from-high、涨停/炸板/断板等 Phase 2 规则只定义 schema 位置，不实现求值逻辑。

## 1. 设计目标与约束

- 在现有 `intraday-watch` 主链上演进，不新建平行系统（PRD §9.1）。
- schema 变更与迁移先行，模板 / 自然语言入口后置（PRD §10 实施顺序）。
- 所有新字段向后兼容：旧库读出后不 crash，新字段有默认值。
- 触发是事实、通知是送达结果：任何路径下触发记录不丢失（PRD §4.3）。
- 所有时间判断统一 Asia/Shanghai（PRD §11）。

## 2. PRD 决策到实现的映射

| PRD 条目 | 实现落点 |
|---|---|
| 不新增 Strategy 实体（§5.1） | 扩展 `StockPool` / `WatchRule` / `WatchTrigger` |
| `ANY` / `ALL` 一层组合（§5.3，D2） | `StockPool.logic`；ALL 用虚拟组合规则 `composite` |
| 触发模式（§5.4） | `StockPool.triggerMode` + 新表 `WatchRuleState` |
| 穿越型规则（§5.4） | `price-level` 复用同一边沿状态机，忽略 repeat/daily-first |
| 规则级优先级（§5.5） | `rules[].priority?` → 方案 `priority` → 规则种类推导 |
| 送达状态（§8.3） | `WatchTrigger.deliveryStatus`，`notified` 兼容保留 |
| cooldown key 修正（§9.2） | `(poolId, stockId, ruleId)` + 历史回填 |
| 反馈（§6.4，D4） | `WatchTrigger.feedback` 四态 + 新 tool |
| 全局每日上限（§8.1） | 配置项，默认 50 |

## 3. 领域模型与 Schema 变更

所有 zod schema 在 `packages/core/src/entity/stock-pool.ts`；drizzle 表在 `packages/db/src/schema/index.ts`；建表 / 补列在 `packages/db/src/client.ts`（沿用现有「启动时幂等建表 + `PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`」模式）。

### 3.1 枚举

```ts
// 规则类型：Phase 1 新增 price-level；volume-ratio / drawdown-from-high 留 Phase 2
export const WatchRuleKindSchema = z.enum([
  'tactic', 'cost-threshold', 'price-change', 'price-level',
]);

export const PlanLogicSchema = z.enum(['ANY', 'ALL']);           // 默认 ANY
export const TriggerModeSchema = z.enum(['on-enter', 'repeat', 'daily-first']); // 默认 on-enter
export const AlertPrioritySchema = z.enum(['urgent', 'important', 'normal']);
export const TriggerTypeSchema = z.enum(['triggered', 'recovered']);

export const DeliveryStatusSchema = z.enum([
  'not-requested',           // 试跑 / 普通优先级默认只记录
  'suppressed-cooldown',     // 冷却抑制
  'suppressed-daily-limit',  // 方案或全局每日上限抑制
  'pending',                 // 待发送
  'sent',                    // 发送成功
  'failed',                  // 发送失败
  'fallback-log',            // 未配置外部通道，降级日志
]);

export const TriggerFeedbackSchema = z.enum(['handled', 'useful', 'useless', 'ignored']);
```

「外部发送被尝试」的状态集合定义为 `ATTEMPTED = ['sent', 'failed', 'fallback-log']`，cooldown 与每日上限都按它计数（failed 计入，避免失败重试风暴）。

### 3.2 WatchRule

每个规则变体新增两个字段：

```ts
{
  id: z.string().min(1),                    // 稳定 ruleId，pool 内唯一
  priority: AlertPrioritySchema.optional(), // 缺省走方案默认 / 种类推导
}
```

- `id` 由 tool 层在创建时生成：`r_${crypto.randomUUID().slice(0, 8)}`。
- 编辑规则参数时 `id` 不变；删除后重建生成新 id，**不复用**（否则 cooldown 与历史归因错乱）。
- 不变量追加：`pool.rules` 内 `id` 不重复（`assertStockPoolInvariants`）。

规则变更：

```ts
// price-change 增加方向，缺省 any，兼容旧配置
export const PriceChangeRuleSchema = z.object({
  kind: z.literal('price-change'),
  pct: z.number().positive().max(1),
  direction: z.enum(['up', 'down', 'any']).default('any'),
});

// 新增：穿越型。above = 上穿（prev < level 且 close ≥ level），below = 下穿
export const PriceLevelRuleSchema = z.object({
  kind: z.literal('price-level'),
  level: MoneySchema,
  side: z.enum(['above', 'below']),
});

export const WatchRuleSchema = z.discriminatedUnion('kind', [
  TacticRuleSchema, CostThresholdRuleSchema, PriceChangeRuleSchema, PriceLevelRuleSchema,
]);
```

### 3.3 StockPool

```ts
export const StockPoolSchema = z.object({
  // ... 现有字段不变（id / name / description / groupId / rules / cooldownMinutes / enabled / createdAt / updatedAt）
  logic: PlanLogicSchema.default('ANY'),
  triggerMode: TriggerModeSchema.default('on-enter'),
  priority: AlertPrioritySchema.optional(),       // 方案级默认优先级
  dailyNotificationLimit: z.number().int().min(1).max(500).default(20),
  notifyOnRecovery: z.boolean().default(false),
});
```

规则优先级生效顺序：`rule.priority ?? pool.priority ?? 种类推导`：

| 规则 | 推导优先级 |
|---|---|
| cost-threshold 止损侧 | urgent |
| cost-threshold 止盈侧 | important |
| price-level | important |
| tactic（minScore ≥ 70） | important |
| price-change / tactic（minScore < 70） / recovered | normal |

### 3.4 WatchTrigger

```ts
export const WatchTriggerSchema = z.object({
  // ... 现有字段（id / poolId / stockId / ruleKind / direction / reason / evidence / quote / notified / createdAt）
  ruleId: z.string().min(1),              // 规则实例 id；ALL 组合触发固定为 'composite'
  triggerType: TriggerTypeSchema.default('triggered'),
  priority: AlertPrioritySchema,          // 落库时为生效值，不再反推
  deliveryStatus: DeliveryStatusSchema,
  notificationId: z.string().optional(),  // 关联 Notification 记录
  /** 求值快照：输入值、阈值、窗口、数据时间；JSON。 */
  evalSnapshot: z.record(z.unknown()),
  feedback: TriggerFeedbackSchema.optional(),
  feedbackAt: z.coerce.date().optional(),
});
```

兼容约定：

- `notified` 保留写入，派生规则：`deliveryStatus ∈ ATTEMPTED` → `true`，否则 `false`。Web 与新接口只读 `deliveryStatus`，不再解释 `notified`。
- `ruleKind` 保留（展示与旧查询）；ALL 组合触发的 `ruleKind` 取组合中优先级最高的规则的 kind，`ruleId = 'composite'`。
- `evalSnapshot` 至少包含：`ruleId`、`kind`、`quoteClose`、`quoteTs`、`threshold`（或规则参数）、`evaluatedValue`；price-change 另含 `prevClose` 与 `prevCloseSource: 'bar' | 'open-fallback'`；cost-threshold 另含 `avgCost`、`pnlPct`。

### 3.5 新表 WatchRuleState

```ts
export const watchRuleStates = sqliteTable('watch_rule_states', {
  poolId: text('pool_id').notNull(),
  stockId: text('stock_id').notNull(),
  ruleId: text('rule_id').notNull(),      // 含虚拟 'composite'
  active: integer('active', { mode: 'boolean' }).notNull(),
  firstTriggeredAt: integer('first_triggered_at', { mode: 'timestamp_ms' }),
  lastEvaluatedAt: integer('last_evaluated_at', { mode: 'timestamp_ms' }).notNull(),
  lastValue: real('last_value'),          // 最近求值量（如 changePct），仅展示用
  lastRecoveredAt: integer('last_recovered_at', { mode: 'timestamp_ms' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.poolId, t.stockId, t.ruleId] }),
  poolIdx: index('watch_rule_states_pool_idx').on(t.poolId),
}));
```

只服务边沿判断，不替代 `WatchTrigger` 历史（PRD §9.2）。

### 3.6 watch_runs 追加列

`suppressedByDailyLimit INTEGER NOT NULL DEFAULT 0`、`notifyFailed INTEGER NOT NULL DEFAULT 0`，支撑 §12 指标与仪表盘「发送失败」提示。

### 3.7 迁移与回填

启动时幂等执行（顺序固定）：

1. `stock_pools` 补列：`logic`、`trigger_mode`、`priority`、`daily_notification_limit`（默认 20）、`notify_on_recovery`（默认 0）。
2. `watch_triggers` 补列：`rule_id`、`trigger_type`（默认 `'triggered'`）、`priority`、`delivery_status`、`notification_id`、`eval_snapshot`、`feedback`、`feedback_at`；新建索引 `(pool_id, stock_id, rule_id, created_at)`。
3. 建 `watch_rule_states` 表。
4. 回填 `rules[].id`：扫描所有 pool，rules 缺 id 的逐条生成并写回（参照 v0.6 分组迁移的幂等做法；重复启动无副作用）。
5. 回填历史 `watch_triggers`：
   - `delivery_status`：`notified = 1 → 'sent'`，`notified = 0 → 'suppressed-cooldown'`；
   - `rule_id`：pool 内该 `ruleKind` 只有一条规则 → 唯一映射回填；多条同类 → 置空，接受这部分 pool 升级后冷却重置一轮（PRD §9.2）；
   - `eval_snapshot`：由现有字段合成（`quoteClose` / `quoteTs` / `kind`）。
6. 回填失败单行记日志跳过，不阻断启动。

## 4. Watch Runner 判定管线

在 `packages/workflows/src/intraday-watch.ts` 现有步骤上演进，**粗体为新增/变更**：

```text
0. daily 分组刷新检查（不变）
1. 加载 enabled 池（不变）
2. tactic seed（不变）
3. 逐池解析成员（变更：stale 动态分组 → 跳过该池，WatchRun 记录 skipped 原因；
   手动 / holdings 分组不受影响）
4. batch_quote（不变；单票行情失败 → 该票全部规则 unknown）
5. 拉 prevCloses（不变）
6. 逐池逐成员逐规则求值 → bool | unknown + evaluatedValue + evidence
   6a. 批量加载该池 WatchRuleState
   6b. 状态机边沿判定（§5）→ 候选触发（含 recovered）
   6c. logic=ALL：合成 composite 虚拟规则，走同一边沿判定（§6）
7. cooldown 过滤：lastForKey(poolId, stockId, ruleId, now − cooldownMinutes)
   命中 → deliveryStatus = suppressed-cooldown（仍落库）
8. 每日上限过滤：当日 ATTEMPTED 数 ≥ pool.dailyNotificationLimit，
   或全池合计 ≥ 全局上限（默认 50）→ suppressed-daily-limit（仍落库）
9. 优先级映射：normal 且非 recovered 通知 → not-requested；
   其余 → pending（全部落库，§8 状态机）
10. notify=true：pending 按池切片 send_notification → sent / failed / fallback-log，
    回写 deliveryStatus + notificationId；notify=false（试跑）→ not-requested，
    不占 cooldown（lastForKey 只数 ATTEMPTED）
```

关键顺序约束：

- cooldown 先于每日上限判定：被冷却抑制的行不消耗每日配额。
- 状态机（6b）先于 cooldown：边沿判定只依赖 `WatchRuleState`，与被抑制与否无关——**被抑制的 triggered 也会把状态推进为 active**，保证「恢复后再次进入才重新触发」的语义不被冷却破坏。
- 行情缺失 / 求值抛错 → 该规则本轮 unknown：状态不变、不产生任何触发、不写 trigger 行，但 `lastEvaluatedAt` 不更新（保留上次有效评估时间）。

## 5. 触发模式与状态机

每个 `(poolId, stockId, ruleId)` 一个状态，仅 `active: boolean` 参与判定：

```text
求值结果   当前状态     动作
──────────────────────────────────────────────────────────
true       无状态       写入 active=true（初始化，不产生触发）—— bootstrap
false      无状态       写入 active=false（初始化）
true       active=false 产生 triggered；active=true；firstTriggeredAt=now（首次）
true       active=true  按 triggerMode：on-enter 不动作；repeat 产生候选；daily-first 当日未触发过则产生候选
false      active=true  active=false；lastRecoveredAt=now；
                        notifyOnRecovery=true 时产生 recovered 候选
unknown    任意         不动作（状态保持）
```

补充语义：

- **穿越型规则**（price-level）：求值结果就是布尔（above → `close ≥ level`），复用同一状态机；方案为 repeat / daily-first 时也只走 on-enter 边沿（PRD §5.4）。
- **bootstrap**：新建方案、新增规则、股票新进入分组的首轮评估只初始化状态。用户保存前通过试跑可见当前命中（PRD §5.4 / §11 验收）。
- **成员变动**：股票退出分组期间不评估、状态保留；重新进入后从保留状态继续边沿判断。首期不做状态清理。
- **recovered 候选**：走与 triggered 相同的 cooldown / 每日上限过滤，优先级固定 normal；`notifyOnRecovery=false`（默认）直接落 `not-requested`。
- **daily-first 的「当日」口径**：Asia/Shanghai 自然日，用当日首个 ATTEMPTED / triggered 行判断。

## 6. 组合逻辑 ANY / ALL

- `ANY`：每条规则独立走状态机，每条边沿产生一条独立触发（现状行为的扩展）。
- `ALL`：每条规则仍独立求值、独立维护状态、独立保存求值结果；另维护虚拟规则 `composite`：
  - `composite` 求值 = 本轮全部规则均为 `active`（含本轮刚翻成 active 的）；
  - `composite` 走 on-enter 状态机（无论方案 triggerMode），边沿产生一条组合触发，`ruleId = 'composite'`；
  - 组合触发的 `reason` / `evidence` 汇总各规则，`evalSnapshot` 含每规则独立结果；
  - 任一规则 unknown → composite unknown，状态不变（PRD §13「行情缺失不错误恢复」）。
- 「哪些条件尚未满足」不进组合触发，只在试跑 / 评估详情输出（PRD §5.3）。
- cooldown key 对组合触发为 `(poolId, stockId, 'composite')`，与单规则互不干扰。

## 7. 规则求值语义

| 规则 | 输入 | 判定 | 证据要点 |
|---|---|---|---|
| tactic | run_tactic(scope=watchlist) 分数（现状） | score ≥ minScore | 战法名、方向、score、minScore |
| cost-threshold | quote.close、holdings avgCost | pnlPct ≤ −stopLossPct（止损，sell）/ ≥ takeProfitPct（止盈，buy 观察） | avgCost、pnlPct、阈值；止损/止盈拆独立命中原因 |
| price-change | quote.close、prevClose（bar 优先，open 兜底，现状） | direction=up：`changePct ≥ pct`；down：`≤ −pct`；any：`|changePct| ≥ pct` | prevClose 及来源、changePct、阈值 |
| price-level | quote.close、`WatchRuleState` 边沿 | above：`close ≥ level`；below：`close ≤ level`；经状态机取穿越边沿 | level、side、close、穿越方向 |

- 数据缺失（无 quote、holdings 池无 avgCost、prevClose 双源皆缺）→ unknown，见 §4。
- volume-ratio / drawdown-from-high 的求值器接口预留（`evaluators: Record<WatchRuleKind, Evaluator>`），Phase 2 填充；口径以 PRD §5.2 为准（量比 = 当日累计量 /（20 日日均量 × 已交易时间占比）；高点 = 近 20 日 daily bar 最高与当日盘中最高的较大者）。

## 8. 送达状态机与通知策略

单条触发的送达判定（§4 步骤 7–10 的判定矩阵）：

| 条件 | deliveryStatus |
|---|---|
| 试跑（notify=false） | not-requested |
| recovered 且 notifyOnRecovery=false | not-requested |
| priority=normal（默认策略，Phase 1 不做 15 分钟聚合） | not-requested |
| cooldown 命中 | suppressed-cooldown |
| 方案 / 全局每日上限命中 | suppressed-daily-limit |
| 其余（urgent / important） | pending → sent / failed / fallback-log |

- 状态流转单向：`pending` 只在发送后改写为 `sent` / `failed` / `fallback-log`；抑制类状态不进入发送。
- 发送按池聚合（沿用现状按池切片 `send_notification`），聚合文案保留每只股票的方向与核心原因（PRD §8.2）；一条 Notification 可关联多条 trigger，回写各自 `notificationId`。
- 行情全源失败：本轮 WatchRun 记 failed，发一次系统健康提醒，不产生业务触发（现状行为保留，PRD §8.1）。
- 15 分钟窗口聚合、通知摘要为 Phase 2+，Phase 1 普通优先级只记录。

## 9. Tool / API 契约

### 9.1 变更

| Tool | 变更 |
|---|---|
| `create_stock_pool` | 输入新增 `logic` / `triggerMode` / `priority` / `dailyNotificationLimit` / `notifyOnRecovery`；rules 元素接受可选 `id`（缺省服务端生成）与 `priority`；price-change 接受 `direction`；新增 price-level 变体；校验 pool 内 rule id 唯一 |
| `update_stock_pool` | 同上；rules 整体替换：带 id 的保留身份，无 id 的视为新规则生成新 id |
| `list_watch_plans` | 输出带新字段 + 每条规则的 id 与生效优先级 |
| `list_watch_triggers` | 输出新增 `ruleId` / `triggerType` / `priority` / `deliveryStatus` / `evalSnapshot` / `feedback`；过滤参数新增 `deliveryStatus` / `priority` / `feedback` / `triggerType` |
| `save_watch_trigger`（内部） | schema 同步扩展；`deliveryStatus` 必填 |
| `list_stock_pools` | 输出补新字段（只读） |

### 9.2 新增

```ts
// write 类，默认 opt-in（与 update_holding 同级）
set_watch_trigger_feedback({
  triggerId: string,
  feedback: 'handled' | 'useful' | 'useless' | 'ignored',
}) → { ok: true, triggerId, feedback, feedbackAt }
```

- 幂等：重复设置同一值直接成功；改值覆盖并更新 `feedbackAt`。
- 校验：`triggerId` 不存在 → `not_found`。

### 9.3 Repository 变更

- `watchTrigger.lastForKey`：签名改为 `(poolId, stockId, ruleId)`，且只匹配 `deliveryStatus ∈ ATTEMPTED` 的行（旧行为靠 `notified = true`，迁移后等价）。
- 新增 `watchTrigger.countAttemptedSince(poolId | null, since)`：每日上限计数（`poolId=null` 为全局）。
- 新增 `watchTrigger.setDeliveryStatus(ids, status, notificationId?)`：发送后回写。
- 新增 `watchTrigger.setFeedback(triggerId, feedback, at)`。
- 新增 `watchRuleState` repo：`listByPool(poolId)`、`upsert(state)`。
- memory 与 drizzle 双实现，走 `contract-tests.ts`。

### 9.4 MCP 暴露

均为 read/write 类现有分级，无新增 exposure 组；`set_watch_trigger_feedback` 归 write（opt-in）。

## 10. Web 交互要点

- **模板创建**：模板为前端静态配置（6 个模板，PRD §6.1），选择后映射为 `create_stock_pool` 的普通入参，无模板运行时。「若现在运行」复用现有单轮试跑入口（`notify=false`）。
- **自然语言草案**：LLM 输出受 `create_stock_pool` 输入 schema 约束（strict JSON schema），tool 层校验 groupId / tacticId 存在性；前端回显自然语言复述 + 系统补的默认值 + 不支持项提示；用户确认后才调 `create_stock_pool`（PRD §6.2 / §11 安全）。
- **预警卡片**：数据全部来自 `WatchTrigger` 单条记录（reason / evalSnapshot / priority / deliveryStatus）；「生成 AI 建议」按钮调 `analyze_position` / `analyze_stock`，展示反证、风险、免责声明、有效期（PRD D5）。
- **反馈**：卡片四操作 → `set_watch_trigger_feedback`；「规则太频繁」跳方案编辑页，不落库（PRD §6.4）。
- **仪表盘**：今日按优先级计数、发送失败（`notifyFailed` / `failed`）、stale 跳过提示、噪声提示（样本 ≥ 30 条反馈才展示，PRD §7.1 / §12）。

## 11. 指标与日志

| PRD 指标（§12） | 数据来源 |
|---|---|
| 扫描成功率 | watch_runs.status |
| 预警延迟 | trigger.createdAt − quoteTs（P95） |
| 送达成功率 | sent / ATTEMPTED（排除 fallback-log 未配置通道） |
| 可解释率 | evalSnapshot 必填字段完整占比（落库前校验，目标 100%） |
| 处理率 / 有用率 / 噪声率 | feedback 分布 |
| 冷却 / 上限抑制量 | deliveryStatus 计数，watch_runs 汇总列 |

每轮运行日志追加：skip 原因（stale 分组）、unknown 计数、各 deliveryStatus 计数。

## 12. 测试计划

- **实体**：新规则 schema（含默认值兼容旧 JSON）、rules[].id 唯一不变量、优先级推导矩阵。
- **状态机**：bootstrap 不触发、on-enter 单边沿、repeat/daily-first、recovered、unknown 保持、穿越型忽略 repeat、成员退出再进入状态续接。
- **workflow 集成**：ANY/ALL（含 composite 冷却独立）、同类双规则互不错误抑制、cooldown 只数 ATTEMPTED、每日上限（方案级 + 全局）、stale 分组跳过、试跑不占冷却、发送失败回写 failed 且触发不丢。
- **迁移**：旧库（无新列、rules 无 id）启动后幂等补齐；ruleKind 唯一映射回填 / 多条置空；重复启动无副作用。
- **repo 契约**：`contract-tests.ts` 双实现覆盖新接口。
- **tool**：create/update 的 ruleId 生成与保留、feedback tool 幂等与 not_found。

## 13. 实施任务拆分

| 组 | 内容 | 依赖 |
|---|---|---|
| A 领域模型 | §3 全部 schema + 不变量 + 迁移回填 | — |
| B workflow | §4 管线、§5 状态机、§6 ALL、§7 price-level / direction、§8 送达 | A |
| C tool/API | §9 全部 | A（B 完成后联调） |
| D Web | §10 模板 / 草案 / 卡片 / 反馈 / 仪表盘 | C |
| E 迁移验证 | 旧库升级演练、回填正确性、冷却连续性 | A |
| F 测试 | §12 各层 | 随各组 |

顺序：A → B ∥ C → E → D；模板与自然语言入口最后，与 PRD §10 实施顺序一致。

## 14. 开放问题

1. 全局每日上限的配置位置：`update_config` 还是环境变量？倾向 `update_config`，默认 50。
2. `WatchRuleState` 是否需要运营态清理（如 pool 删除后级联删状态）？倾向：pool 删除时级联删除其状态行，规则删除同理；股票退出分组不删（§5）。
3. recovered 是否计入「重复噪声率」分母？倾向计入，复盘时更能暴露阈值过紧的规则。
4. 15 分钟聚合窗口（PRD §8.1 备选）Phase 2 立项时需重新评估与 priority=normal 只记录的关系。
