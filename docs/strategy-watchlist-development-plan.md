# Strategy 与统一 Watchlist 开发计划

> 状态：待执行
> 日期：2026-07-29
> 详细设计：[Strategy 与统一 Watchlist 详细设计](./ddd/strategy-watchlist-unification-detailed-design.md)
> 产品输入：[Strategy DSL PRD](./prd/strategy-dsl.md)、[统一 Watchlist PRD](./prd/watchlist.md)

## 1. 计划目标

在保持当前战法扫描、动态分组和盘中盯盘可用的前提下，将系统迁移到：

```text
Tactic      → Strategy
StockGroup  → Watchlist
StockPool   → AlertPlan
```

最终交付：

- Strategy 身份、版本、运行、结果和信号闭环。
- manual/Strategy/AI/Portfolio 多来源统一 Watchlist。
- AlertPlan 引用 Watchlist，现有 watch runner 行为不退化。
- 存量 SQLite 数据可幂等迁移、校验和回滚。
- Web、CLI、MCP、Agent 统一使用新 tools。
- 旧 tools 完成一个兼容周期后可移除。

## 2. 实施原则

- 每个阶段必须可独立合入和回滚，不维护长期半迁移状态。
- schema/repository/contract tests 先于业务写路径。
- 新旧模型不长期双写；切换后 legacy write 只转译到新模型。
- 每个迁移先只读验证，再允许切换。
- 不把完整回测、基本面因子和 Portfolio 重构塞进本期。
- 不改变 advice ≠ trade 和 MCP trade 永不暴露的硬边界。
- Web 改动必须真实启动并用浏览器验收。

## 3. 工作分解总览

| 阶段 | 主题 | 主要产物 | 依赖 |
|---|---|---|---|
| W0 | 决策冻结与迁移脚手架 | 决策约束落地、migration registry、fixture 基线 | 无 |
| W1 | Strategy 领域与存储 | core schema、5 张表、双 repo、Tactic 迁移 | W0 |
| W2 | Strategy Runner 与 tools | evaluator、field registry、运行/版本 tools、兼容映射 | W1 |
| W3 | 统一 Watchlist 领域与迁移 | 5 张表、同步事务、StockGroup 迁移、多来源 | W1 |
| W4 | AlertPlan 与 watch 切换 | AlertPlan 表、规则迁移、intraday-watch 切换 | W2+W3 |
| W5 | Surface 与 Agent 切换 | Web/CLI/MCP/Agent 新入口、legacy deprecated | W2+W3+W4 |
| W6 | 全量迁移验收与收口 | verify、真实库演练、默认移除 legacy tools | W5 |

建议每个 W 拆成一个或多个小 PR，但不得跨阶段同时修改同一核心 schema。

## 4. W0：决策冻结与迁移脚手架

### 4.1 目标

在写领域代码前核对已确认决策，并建立可重复的数据迁移框架。

### 4.2 任务

- 将详细设计中的五项已确认决策编码为 schema、权限或测试约束。
- 定义统一 ID 规则和 legacy id 冲突映射。
- 新增 `schema_migrations` 表及 repository-free migration runner。
- 支持 migration id、checksum、事务、重复运行和失败回滚。
- 建立旧库 fixture：
  - Tactic + TacticSignal；
  - 四种 StockGroup resolver；
  - 多 refreshId；
  - StockPool + Trigger + RuleState。
- 新增 `migration verify` 只读框架，首期输出旧模型基线统计。
- 记录现有 tool registry、当前成员集合和 watch 行为 golden snapshot。

### 4.3 测试

- 空库 migration runner。
- 同一 migration 重复运行。
- checksum 冲突拒绝。
- 中途抛错事务回滚。
- fixture 可被当前代码正常读取。

### 4.4 验收

- migration runner 不依赖外部网络或 LLM。
- fixture 覆盖所有 resolver 和提醒历史。
- `bun run test:db`、typecheck、lint 通过。
- 已确认决策均有对应的 schema、权限或测试落点。

## 5. W1：Strategy 领域与存储

### 5.1 目标

建立目标 Strategy 模型，并将现有 Tactic/TacticSignal 无损迁入。

### 5.2 Core

- 新增 `Strategy`、`StrategyVersion`、`StrategyRun`、`StrategyResult`、`StrategySignal`。
- 新增 Strategy DSL v1 schema。
- 新增 canonical JSON 和 SHA-256 definitionHash。
- 新增不变量与 legacy Tactic → StrategyVersion mapper。
- `Tactic` 暂时保留，不改现有运行路径。

### 5.3 DB

- 新增 strategies、strategy_versions、strategy_runs、strategy_results、strategy_signals。
- Drizzle 与 ensureSchema DDL 同步。
- 新增 StrategyRepository、StrategyRunRepository 的 drizzle/memory 实现。
- 增加 contract tests。
- 实现 `20260729_02_migrate_tactics`。

### 5.4 迁移校验

- 每个 Tactic 对应一个 active Strategy 和 published version 1。
- 所有 signal 迁移或明确报告唯一键合并。
- definitionHash 可重复计算一致。
- migration 重跑不增加行数。

### 5.5 验收

- 当前 Tactic tools 尚未改变行为。
- 新 repository contract 双实现全绿。
- fixture 迁移后无 orphan。
- Strategy 数据可以通过内部测试读回，但尚不对用户开放写入口。

## 6. W2：Strategy Runner、版本与 tools

### 6.1 目标

让 Strategy 成为真实可运行能力，而不是只迁移数据。

### 6.2 Expression 与 evaluator

- 将当前 mini-eval 抽到 strategy expression 模块。
- 旧 tactic DSL 从新模块 re-export，确保测试不回退。
- 新增 StrategyFieldRegistry 和静态路径检查。
- 实现 selection all/any、scoring、stable rank 和 signals。
- 定义 unknown/error/partial 传播。
- 增加单股纯 evaluator 测试。

### 6.3 数据准备与运行

- 实现 `run_strategy` tool：
  - 解析 current/pinned version；
  - 从 StockUniverse 取候选身份；
  - 按字段依赖加载 quote/daily bars；
  - 有界并发求值；
  - 原子提交 run/results/signals。
- 实现子集 dry-run，用于草案校验。
- 实现 `run-strategies` workflow，但默认不接定时任务。

### 6.4 Strategy tools

- list/get/create Strategy。
- create/validate/publish version。
- pause/run/list runs/get run/signals by stock。
- 写入 sideEffect 和 Agent whitelist 测试。
- builtin Strategy 只能复制，不能原地编辑。

### 6.5 兼容

- `run_tactic` 内部继续走旧 runner，或先通过 adapter 调用 signal-only Strategy；
  本阶段结束前必须选定单一 evaluator，避免两套表达式语义。
- legacy list/get tool 输出增加 replacement 提示，不删除。

### 6.6 验收

- 迁移 Strategy 与原 Tactic 在同一 fixture/context 产生相同 signal。
- 同一 version/input 得到相同 selected/score/rank。
- 全市场 run 的 partial/failed 状态正确。
- workflow 一项失败不阻塞其它 Strategy。
- `bun run test`、`test:db`、typecheck、lint 通过。

## 7. W3：统一 Watchlist 与多来源同步

### 7.1 目标

建立 Watchlist/Member/Source/SyncRun/Snapshot，并迁移 StockGroup。

### 7.2 Core/DB

- 新增五个 core schema 和状态机。
- 新增五张表及索引。
- 新增 WatchlistRepository、WatchlistMemberRepository 双实现。
- 实现 `commitWatchlistSync` 原子事务。
- contract tests 覆盖多来源、stale、ended、re-entry 和 archive/revive。

### 7.3 迁移

- manual → personal/manual source。
- holdings → portfolio/synced source。
- formula → strategy source，引用 W1 映射。
- llm → ai legacy source。
- refreshId → WatchlistSyncRun。
- snapshots 迁移并计算 entered/unchanged/exited。
- 最新批次生成当前 MemberSource。

### 7.4 Tools

- Watchlist list/get/create/update/archive。
- member add/update/archive。
- changes 查询。
- 内部 `sync_watchlist_source`。
- `sync-portfolio-watchlists` workflow。

### 7.5 验收

- 每个旧 StockGroup 有且只有一个目标 Watchlist。
- 当前成员集合一致。
- 同一 Member 可同时有 strategy/manual/portfolio sources。
- 结束一个来源不删除其它来源。
- partial/failed/空异常同步不退出成员。
- 旧 StockGroup tools 尚可读，legacy write 转译策略暂不启用。

## 8. W4：AlertPlan 与盘中链路切换

### 8.1 目标

将 StockPool/WatchPlan 迁为 AlertPlan，并让 intraday-watch 只消费目标模型。

### 8.2 Core/DB

- 新增 AlertPlan/AlertRule schema，现有 stock-pool 文件兼容 re-export。
- 新增 alert_plans 表和 repository 双实现。
- tactic rule 迁为 strategy-signal rule。
- watch_triggers/watch_rule_states 增 alertPlanId 并回填。
- 迁移失败引用的计划 disabled + warning，不静默丢失。

### 8.3 Workflow

- intraday-watch 加载 AlertPlan。
- 从 WatchlistMember 解析扫描对象。
- strategy-signal rule 读取持久化 StrategySignal。
- 保持 cost/price/event 规则、边沿、冷却、每日上限和通知语义。
- WatchRun 输出改用 alertPlan 术语，兼容历史 JSON。

### 8.4 对比测试

对同一 fixture、行情和 clock 同时运行旧/新 evaluator：

- evaluated 成员集合一致；
- triggered/recovered 数一致；
- deliveryStatus/cooldown 一致；
- ruleId、priority、evidence 不丢；
- stale/disabled Watchlist 新语义符合设计。

### 8.5 验收

- `luoome watch --once` 目标路径端到端通过。
- Trigger 历史可查，plan 引用完整。
- AlertPlan 删除不删除 Trigger。
- legacy StockPool 进入只读回滚状态。
- 所有 intraday-watch 相关测试迁到目标模型。

## 9. W5：Web、CLI、MCP 与 Agent

### 9.1 Web

- 策略列表、详情、版本、校验、发布、运行。
- Watchlist 总览、详情、多来源、stage/priority、变化历史。
- AlertPlan 管理与试跑。
- 股票研究档案展示 StrategyResult/Signal 和 Watchlist 来源。
- mutation token、Origin、write opt-in 测试。
- 删除旧“战法/分组/盯盘方案”一级产品语言。

### 9.2 CLI/MCP

- 增加 strategy/watchlist/alert 命令。
- MCP 暴露新 read，write/external 遵循 opt-in。
- 内部 sync/migration tools 不暴露。
- legacy tools description 标 deprecated。

### 9.3 Agent

- 更新 whitelist 和 system prompt。
- Strategy/Watchlist/AlertPlan 使用 draft-and-confirm。
- dry-run 可自动执行，publish/full run/sync 必须确认。
- 禁止 Agent 生成旧 Tactic/StockGroup/StockPool。

### 9.4 浏览器验收

实际启动 Web 验证：

1. 从模板创建 Strategy 草案。
2. dry-run 并查看 rule errors/partial。
3. 发布并运行。
4. 结果同步到 Watchlist。
5. 用户将 discovered 改为 researching。
6. 创建 AlertPlan 并试跑。
7. 查看 Trigger、Strategy evidence 和数据时间。

### 9.5 验收

- 四个 surface 使用同一 tool contract。
- UI 不出现三套平行概念。
- 所有写操作确认和权限边界正确。
- Web 自动测试与真实浏览器验收通过。

## 10. W6：全量迁移、默认切换与收口

### 10.1 迁移演练

- 复制真实本地数据库到临时目录，不在原库首次演练。
- 运行 ensureSchema + migrations。
- 运行 `migration verify strategy-watchlist`。
- 抽样 Strategy、Watchlist、AlertPlan、Trigger 历史。
- 执行 Strategy dry-run、Watchlist sync、watch --once。
- 记录耗时、库体积和 warnings。

### 10.2 默认切换

- 所有新写入口只写目标表。
- legacy write tools 转译到目标模型或返回明确弃用错误。
- registry 默认隐藏 legacy tools；提供短期兼容开关时必须默认关闭。
- 旧表保留只读，不立即删除。
- 更新 CONTEXT、ARCHITECTURE、SECURITY、USER_GUIDE、Skill references 和 ROADMAP。

### 10.3 最终验收

- `bun run test:all`、typecheck、lint、build 全绿。
- migration verify 无 blocking issue。
- 真实浏览器端到端通过。
- MCP discovery 不暴露 trade 或内部 migration/sync。
- 当前代码和文档不再把 Tactic/StockGroup/StockPool 当作目标领域语言。
- 回滚流程经过临时库验证。

## 11. PR/提交建议

建议拆分：

| PR | 范围 |
|---|---|
| PR1 | migration registry + fixtures |
| PR2 | Strategy core/schema/repositories + Tactic backfill |
| PR3 | Strategy evaluator/runner/tools/workflow |
| PR4 | Watchlist core/schema/repositories + StockGroup backfill |
| PR5 | Watchlist tools/sync workflow |
| PR6 | AlertPlan migration + intraday-watch switch |
| PR7 | Web/CLI/MCP/Agent surfaces |
| PR8 | verify、文档、legacy 默认移除 |

每个 PR：

- 只暂存本任务文件。
- 提交前检查 staged diff。
- 不使用 `--no-verify`。
- 未经用户明确要求不 commit、push 或创建 PR。

## 12. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 新旧 evaluator 结果不一致 | 策略信号漂移 | golden fixture + 同上下文差分测试 |
| 动态组历史迁移错误 | Watchlist 成员变化失真 | refreshId 分批、集合 hash、verify |
| complete/partial 判断错误 | 误退出全部成员 | 只有 complete 可结束来源 |
| 多来源唯一约束不严 | 重复/误删成员 | current source contract + 事务 |
| SQLite 迁移中断 | 启动失败 | migration registry、事务、旧表保留 |
| 全市场 Strategy 性能过慢 | 日常不可用 | 字段依赖计划、快照复用、有界并发 |
| legacy 双写漂移 | 数据不一致 | 切换后单写目标，旧工具只转译 |
| Agent 绕过确认 | 意外写入 | whitelist + draft-only + server 权限 |
| 产品一次扩张过大 | 长期半成品 | W 阶段独立验收，回测/基本面延后 |

## 13. 暂不纳入本计划

- 完整 factors 数据平台。
- 严格历史回测和收益曲线。
- 自动组合优化。
- Strategy marketplace。
- 跨用户 Watchlist 分享。
- 自动真实下单。
- 旧表物理删除。

这些需求必须在 W6 稳定后单独立项。
