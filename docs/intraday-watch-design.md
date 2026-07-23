# 盘中盯盘设计：股票池 + `luoome watch` 长驻进程

> 状态：**已实现**——v0.6 落地主体（股票池 + `luoome watch` + intraday-watch workflow），v0.6.1 切真实昨收（dailyBar），v0.7 补节假日历。本文档是设计唯一事实来源；实现与本文有出入处以代码为准，并在本文追记。
>
> **后续演进**：分组与盯盘解耦（StockGroup + 成员快照 + 动态 resolver）见 [stock-group-design.md](./stock-group-design.md)（已实现）；web 对话助手见 [web-chat-design.md](./web-chat-design.md)（已实现）。

## 目标

盘中自动盯盘，两类核心场景：

1. **持仓买卖点**：持仓触及止盈/止损线、命中 bearish 战法（如量价背离）→ 卖点提醒；命中 bullish 战法 → 加仓点提醒
2. **候选池买点**：候选股票池（短线1进2、异动放量、自定义策略等）命中买点规则 → 提醒

## 已确认决策

- **运行形态**：长驻进程命令 `luoome watch`，盘中交易时段内每 N 秒轮询一轮，Ctrl+C 停止；`--once` 跑单轮（调试 / cron 可用）
- **信号判定**：纯规则，按池配置（战法命中 + 价格阈值），不走 LLM（盘中高频，零成本、确定性）
- **股票池**：持久化到 SQLite，通过 tool 做 CRUD —— 既支持 CLI 手动管理，也支持挂 MCP 后对话创建（write 类 tool，需 `LUOOME_EXPOSE_WRITE=true`）
- **触发持久化**：每次 trigger 落库 `watch_triggers` 表（审计 + 复盘 + cooldown 查询），重启进程后冷却可接续
- **tactic source 启动 seed**：`source.kind='tactic'` 的池在 `luoome watch` 启动时（仅一次）对每个被引用战法跑一次 `run_tactic(scope='all-stocks', persistSignals=true)`，避免「池成员永远为空」的鸡生蛋
- **A 股交易时段**：北京时间 `9:30–11:30 / 13:00–15:00`，周一至周五（不做节假日历，v1 注释说明）

## 现状（已核实）

- 无 Alert / watchlist 实体与表；DB 现有表：accounts / stocks / holdings / trades / advices / adviceOutcomes / priceSnapshots / dailyBars / tactics / tacticSignals / notifications（`packages/db/src/schema/index.ts`）
- 战法引擎就绪：5 个内置战法 + DSL 触发表达式（`packages/core/src/entity/tactic.ts`），`run_tactic` tool 支持 scope=holdings/watchlist/all-stocks（显式 stockIds），命中信号默认落库 tactic_signals
- `Quote` 有 open/high/low/close/volume，无 prevClose；真实行情 = Eastmoney→Tencent，quote 缓存 TTL 60s（`packages/adapters/src/market/manager.ts`）
- `send_notification` tool 就绪（feishu/log，缺 webhook 自动降级 log）；payload 上限 title 200 / content 5000（v1 触发聚合按池切片，N 大不爆）
- workflow 引擎：`defineWorkflow`，步骤内只能通过 `ctx.tools.*` 调 tool（ARCHITECTURE §4.6）；CLI `workflow run` 按 hyphen→camel + `Workflow` 后缀动态查找（`packages/cli/src/index.ts`）
- `RepositoryRegistry` 在 `packages/core/src/repository/index.ts`；db 有 memory + drizzle 双实现 + contract-tests 复用
- 编程式建表走 `ensureSchema`（`packages/db/src/client.ts`），v0.1 不引 drizzle-kit；新增表 = 手工同步 schema/index.ts + ensureSchema 的 CREATE TABLE DDL + index 命名约定（这是迁移脚本的 v1 形态）

## 设计

### 1. core：StockPool + WatchTrigger 实体（`packages/core/src/entity/stock-pool.ts`，新建）

```ts
// 池成员来源（三种，覆盖"持仓池 / 手动池 / 策略池"）
type PoolSource =
  | { kind: 'holdings'; accountId: string }               // 显式绑定账户，无 "默认账户"歧义
  | { kind: 'manual'; stockIds: readonly string[] }
  | { kind: 'tactic'; tacticId: string; lookbackDays: number; minScore?: number }
  // tactic：成员 = 该战法近 lookbackDays 天命中信号的 distinct stockId。
  // 注意：依赖 tactic_signals 表数据 → watch 启动时跑 seed 落库（见 §6.1）。
  // 内置战法不够时用自定义战法。

// 盯盘规则（每池多条，规则因池而异；any-rule semantics：任意一条 fire 即触发）
type WatchRule =
  | { kind: 'tactic'; tacticId: string; minScore?: number }            // 默认 minScore=60，避免裸配置噪声
  | { kind: 'cost-threshold'; stopLossPct?: number; takeProfitPct?: number } // 现价 vs avgCost（仅 holdings 池）；不复权（v1）
  | { kind: 'price-change'; pct: number }                              // 日内涨跌幅 |X|≥pct；昨收 = 上一交易日 close

interface StockPool {
  id: string;            // slug，kebab-case
  name: string;
  description?: string;
  source: PoolSource;
  rules: readonly WatchRule[];    // ≥1
  cooldownMinutes: number;       // 同股票同规则通知冷却，默认 30
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 触发事件（watch 一轮评估后输出；落库 watch_triggers 表）。
 * direction: 'buy' / 'sell' / 'watch'；ruleKind 标识命中哪条规则；reason + evidence 给终端输出 + 通知文案。
 * quote 是触发时的实时行情快照，方便事后回放。
 */
interface WatchTrigger {
  id: string;
  poolId: string;
  stockId: string;
  ruleKind: WatchRule['kind'];
  direction: 'buy' | 'sell' | 'watch';
  reason: string;
  evidence: readonly string[];
  quote: { close: number; ts: Date };
  notified: boolean;            // 本次是否真的推送（被 cooldown 抑制则为 false）
  createdAt: Date;
}
```

- Zod schema（`StockPoolSchema` / `PoolSourceSchema` / `WatchRuleSchema` / `WatchTriggerSchema`）+ `assertStockPoolInvariants`：
  - id slug 合法（`^[a-z0-9][a-z0-9-]{1,63}$`，与战法对齐）
  - `name` 1-64
  - `rules.length ≥ 1`
  - `source.kind='holdings'` → 该池的 `rules` 不允许出现 `cost-threshold` 之外的规则（`cost-threshold` 需 avgCost，仅 holdings 池有意义）
    - **修订**：成本阈值规则仅在 source.kind='holdings' 时合法；其他池建池时报 invalid_input
  - tactic 规则/source 的 `minScore` ∈ [0,100]；缺省值 60（避免误配触发噪声）
  - `cost-threshold` 的 pct ∈ (0, 1]（5% → 0.05）；stopLossPct + takeProfitPct 至少一个非空
  - `price-change` 的 `pct` ∈ (0, 1]
  - `cooldownMinutes` ∈ [1, 1440]（1 分钟 ≤ 上限 24 小时）
- `assertWatchTriggerInvariants`：id / poolId / stockId 非空；evidence ≥ 1；quote.close > 0；direction ∈ union

### 2. core：Repository 接口（`packages/core/src/repository/index.ts`，改）

- 新增 `StockPoolRepository { save, findById, list(enabledOnly?), remove }`
- 新增 `WatchTriggerRepository { save, listByPoolSince, lastForKey, listRecent }`
  - `listByPoolSince(poolId, since)`：审计 + 复盘用，按 createdAt 倒序
  - `lastForKey({ poolId, stockId, ruleKind, since })`：cooldown 查询专用，找池+股票+规则维度最近一条触发，since = now − cooldownMinutes
  - `listRecent({ limit?, poolId? })`：给 CLI / TUI / MCP 看最近触发
- `RepositoryRegistry` 加 `readonly stockPool: StockPoolRepository` + `readonly watchTrigger: WatchTriggerRepository`

### 3. db：表 + 双实现（改 `packages/db`）

- `schema/index.ts` 新增 `stockPools` 表：
  - id（text 主键，slug）；name；description（可空）；source（text JSON）；rules（text JSON）；cooldownMinutes（integer）；enabled（integer 0/1）；createdAt / updatedAt（integer timestamp_ms）
  - 索引：`stock_pools_enabled_idx on (enabled)`
- `schema/index.ts` 新增 `watchTriggers` 表：
  - id（text 主键，uuid）；poolId / stockId / ruleKind / direction / reason / quoteClose / quoteTs / notified / evidence（text JSON）；createdAt
  - 索引：`watch_triggers_pool_ts_idx on (poolId, createdAt)`、`watch_triggers_pool_stock_rule_idx on (poolId, stockId, ruleKind, createdAt)`（cooldown 查询走这条）
- `repository/drizzle/` 新增 `stock-pool.ts` + `watch-trigger.ts`（DrizzleXxxRepository）
- `repository/memory/` 新增对应 memory 实现
- `repository/contract-tests.ts` 补 stockPool + watchTrigger 契约用例（两套实现复用）
- `createDrizzleRepos` / memory 工厂挂上 stockPool + watchTrigger
- `client.ts ensureSchema` 补两段 `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`（与现有 11 段一致；DDL 即迁移脚本的 v1 形态）

### 4. tools：池管理 4 个 tool + 触发落库 1 个 tool（`packages/tools/src/tools/`，新建）

| tool | sideEffect | 说明 |
|---|---|---|
| `list_stock_pools` | read | 列全部池（可 filter enabled） |
| `create_stock_pool` | write | 输入 name/source/rules/cooldown → 校验 + 不变量 → 落库；tactic 引用先查 `repos.tactic.findById` 存在性；holdings source 的 accountId 先查 `repos.account.findById` |
| `update_stock_pool` | write | 按 id 改 rules / source / enabled / cooldown / name |
| `delete_stock_pool` | write | 按 id 删 |
| `save_watch_trigger` | write | 输入完整 WatchTrigger（含 id + createdAt）→ 落库；workflow / cli 调用，单纯持久化 |

- 注册进 toolRegistry，并在 `packages/workflows/src/define-workflow.ts` 的 `WorkflowToolMap` 补 5 行类型映射
- MCP 侧 write 类默认 opt-in，无需改 mcp 包（对话建池时用户开 `LUOOME_EXPOSE_WRITE=true`）
- `save_watch_trigger` 不是"暴露给 agent 用"的 tool，而是 workflow 的内部持久化通道——但走 tool 层保持 ARCHITECTURE §4.6 "workflow 不直连 repo" 约束

### 5. tools：`run_tactic` 加 `persistSignals` 选项（`packages/tools/src/tools/run-tactic.ts`，小改）

- input 加 `persistSignals: z.boolean().default(true)`；为 false 时跳过 `saveSignal`
- 原因：watch 每分钟轮询若走默认落库会把 tactic_signals 表打爆；watch 传 false，信号历史仍由手动 run_tactic / tactic-scan / watch 启动 seed（见 §6.1）积累

### 6. workflows：`intraday-watch`（`packages/workflows/src/intraday-watch.ts`，新建）

单轮盯盘评估（无状态，可被 watch 进程 / cron / 手动复用）：

- input：`{ poolIds?: readonly string[]; notify?: boolean = true; seedTacticSources?: boolean = true }`
- steps：
  1. 加载 enabled 池（`repos.stockPool.list(true)`）；若 `poolIds` 指定则取交集
  2. **seed 阶段（仅 step 1 之后执行一次）**：收集所有 `source.kind='tactic'` 池涉及的 tacticId 去重，对每个 tacticId 调一次 `run_tactic(scope='all-stocks', persistSignals=true, lookbackDays=<池最大 lookbackDays>)`，把近期信号灌进 tactic_signals 表
  3. 逐池解析成员：
     - `holdings` → `ctx.tools.list_holdings({ accountId, status: 'active' })` 拿 stockIds
     - `manual` → 原样
     - `tactic` → `tactic_signals_by_tactic({ tacticId, since: now - lookbackDays })` 拿 distinct stockId
  4. 跨池聚合所有 stockIds（去重），`batch_quote` 一次拉全
  5. 逐池逐规则评估：
     - `tactic` 规则 → `run_tactic(scope='watchlist', stockIds=成员, persistSignals=false)`，score ≥ minScore 触发；direction 映射：bullish→buy、bearish→sell、neutral→watch
     - `cost-threshold` → `quote.close` 对 `holding.avgCost` 纯计算；stopLoss 触发 direction=sell、takeProfit 触发 direction=sell（止盈本身是卖）
     - `price-change` → `(close − prevClose) / prevClose` 的绝对值 ≥ pct；`prevClose` **v0.6.1+** 取 `dailyBars` 中 `date < today` 的最近一根 close（上一交易日，不用当日 dailyBar 避免盘中自刷新；dailyBar 1h 缓存即可，盘中只算一次）。dailyBars 缺失 / close <= 0 → fallback 到 `quote.open`（v0.6 占位行为仍兼容）
  6. **cooldown 过滤**：对每个候选 trigger，构造 key=`{poolId, stockId, ruleKind}`，查 `repos.watchTrigger.lastForKey(key, since=now − cooldownMinutes)`，存在则标 `notified=false`，从推送集剔除，但仍计入返回
  7. 触发落库：对最终 fire 的每个 trigger（不论是否被 cooldown 抑制）调 `save_watch_trigger` 写入 `watchTriggers` 表
  8. notify=true 且有 `notified=true` 的 trigger → `send_notification` 聚合推送：
     - 按 poolId 切片成多条飞书 / log 消息（避免单条 content > 5000）；标题"盘中提醒 池-<name> N 条"
     - 内容列：股票 / 买卖方向 / 理由 / 现价 / 触发时间
- output：`{ triggers, evaluatedPools, evaluatedStocks, notified, suppressedByCooldown }`

### 7. cli：`luoome watch` 命令（`packages/cli/src/index.ts` + 新建 `packages/cli/src/watch.ts`）

- 用法：`luoome watch [--interval 60] [--pool <id>] [--once] [--no-notify]`
- `watch.ts` 放可测纯逻辑：
  - `isTradingHours(date)`：北京时间 9:30–11:30 / 13:00–15:00，周一至周五（不做节假日历，v1 注释说明；硬约束：所有判断基于 Asia/Shanghai 时区，避免容器时区漂移）
  - `nextTradingBoundary(date)`：算下一个轮询时刻（盘内 = interval 秒后；盘外 = 下一交易日 9:30 减 60s 缓冲；收盘后 = 次日 9:30 减 60s 缓冲）
  - `formatTriggersForLog(...)`：终端表格输出（命中冷却的 trigger 仍打印到终端但不推送）
- index.ts 加 `watch` 分支：createCliContext → 循环（`--once` 跑一轮退出；否则按 nextTradingBoundary 等）→ SIGINT 优雅 close
- interval 下限 clamp 到 60s（quote 缓存 TTL 60s；help 文案注明"建议 ≥60s；<60s 拿到的会是缓存数据"）

### 8. 种子数据（`packages/cli/src/context.ts`，小改）

- 首次运行 stock_pools 为空时种一个示例池：`id='holdings-watch'`，source=`{ kind: 'holdings', accountId: <默认账户 id> }`，rules=[cost-threshold stopLossPct=0.05 takeProfitPct=0.05、tactic 量价背离]，开箱即可 `luoome watch`

### 9. 文档同步

- `AGENTS.md`：工具清单加 5 个 pool/trigger tool（write 类）；调试区加 `luoome watch` 用法
- `ARCHITECTURE.md` §8.1 内置 workflow 列表加 `intraday-watch`；§5.1 加 StockPool / WatchTrigger 实体说明

## 实施顺序（实现时）

1. core 实体 + 不变量 + 测试（stock-pool.ts：StockPool + PoolSource + WatchRule + WatchTrigger + 4 个 Schema + 2 个 assert + 测试）
2. core repo 接口 → db schema + drizzle + memory + contract tests
   - **同步更新 `client.ts ensureSchema` 的 CREATE TABLE DDL**（v1 形态的迁移脚本）
   - **同步更新 `schema/index.ts` 的桶导出 schema**（registry 装配层）
3. tools 5 个 CRUD/落库 + registry + WorkflowToolMap + 测试；run_tactic persistSignals 选项
4. intraday-watch workflow + 测试（含 seed、cooldown 查 DB、prev close 用上一交易日）
5. cli watch.ts + index.ts 接线 + context.ts 种子 + 测试
6. 文档（AGENTS.md / ARCHITECTURE.md）
7. 全量验证：`bun test`（vitest，含 db contract tests）、`bun test packages/db`（bun 自带 runner）、`bunx tsc --noEmit`、`bunx biome check .`；再用真实行情执行 `luoome watch --once --no-notify`

## 明确不做（v1）

- v0.6 长驻盘中盯盘（基础）→ 见 §6、§7
- v0.6.1 price-change 接入 dailyBars 真实昨收 → 见 §6 step 5
- v0.6.2 真实行情链路容错加深：`MarketDataManager` 的 `batchQuote` 部分失败 + `fetchDailyBars` 三层 fallback + suppress 窗口验证（无新功能，纯测试覆盖；详见 [`packages/adapters/src/market/manager-resilience.test.ts`](../../packages/adapters/src/market/manager-resilience.test.ts)）

## 已知边界

- 不做 LLM 精排（盘中频率高、有成本；后续可加"高分信号触发一次 score_signals"）
- ~~不做节假日历~~ **v0.6 起内置 2026 全年 A 股休市日**（29 天）。**v0.7 起扩展**：
  - 内置增加 `CN_A_SHARE_HOLIDAYS_2027`（22 天，best-effort placeholder，按近 5 年规律推断；每年 12 月国办通知发布后维护者手工更新常量）
  - 文件加载：`$LUOOME_HOME/holidays.json`（或 `LUOOME_HOLIDAYS_FILE` 指向的文件），格式 `{ "YYYY": ["YYYY-MM-DD", ...] }`
  - 加载优先级（三层 union）：`内置 < 文件 < LUOOME_A_SHARE_HOLIDAYS env`
  - 损坏 / 不存在文件：静默 fallback 到内置，不抛（hot path 上避免让 watch daemon crash）
  - 不监听文件 mtime：修改后需重启 `luoome watch` 进程（测试可通过 `_resetHolidayCache` 强制重载）
  - 不识别「调休补班」日期——A 股惯例是把假期调成连续工作日，倒过来不需要补班

- 不识别「调休补班」日期——A 股惯例是把假期调成连续工作日，倒过来不需要补班
- 不做涨跌停特殊处理（cost-threshold / price-change 都按 raw close 计算）
- 不做通知通道扩展（复用现有 feishu/log；聚合按池切片而非按条数拆批，避免 N 大时消息爆炸）
- 不做 AGENTS.md 里的通用 Alert 实体（set_alert/list_alerts）；StockPool + WatchRule 覆盖了本次需求，通用预警另立任务
- 不做除权除息复权（cost-threshold 基于当前 avgCost，未做除权除息调整；tool description 注明）
- 不做"按 advisor 出 advisor"——watch 触发通知，不挂建议（advice ≠ trade，与 daily-advice 解耦）
