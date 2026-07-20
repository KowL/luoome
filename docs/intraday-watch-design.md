# 盘中盯盘设计：股票池 + `luoome watch` 长驻进程

> 状态：设计已确认，待实现。本文档是唯一事实来源；实现时按「实施顺序」执行。

## 目标

盘中自动盯盘，两类核心场景：

1. **持仓买卖点**：持仓触及止盈/止损线、命中 bearish 战法（如量价背离）→ 卖点提醒；命中 bullish 战法 → 加仓点提醒
2. **候选池买点**：候选股票池（短线1进2、异动放量、自定义策略等）命中买点规则 → 提醒

## 已确认决策

- **运行形态**：长驻进程命令 `luoome watch`，盘中交易时段内每 N 秒轮询一轮，Ctrl+C 停止；`--once` 跑单轮（调试 / cron 可用）
- **信号判定**：纯规则，按池配置（战法命中 + 价格阈值），不走 LLM（盘中高频，零成本、确定性）
- **股票池**：持久化到 SQLite，通过 tool 做 CRUD —— 既支持 CLI 手动管理，也支持挂 MCP 后对话创建（write 类 tool，需 `LUOOME_EXPOSE_WRITE=true`）

## 现状（已核实）

- 无 Alert / watchlist 实体与表；DB 现有表：accounts / stocks / holdings / trades / advices / adviceOutcomes / priceSnapshots / dailyBars / tactics / tacticSignals / notifications（`packages/db/src/schema/index.ts`）
- 战法引擎就绪：5 个内置战法 + DSL 触发表达式（`packages/core/src/entity/tactic.ts`），`run_tactic` tool 支持 scope=holdings/watchlist（显式 stockIds），命中信号自动落库 tactic_signals
- `Quote` 有 open/high/low/close/volume，无 prevClose；real 行情 = Eastmoney→Tencent→Mock，quote 缓存 TTL 60s（`packages/adapters/src/market/manager.ts`）
- `send_notification` tool 就绪（feishu/log，缺 webhook 自动降级 log）
- workflow 引擎：`defineWorkflow`，步骤内只能通过 `ctx.tools.*` 调 tool（ARCHITECTURE §4.6）；CLI `workflow run` 按 hyphen→camel + `Workflow` 后缀动态查找（`packages/cli/src/index.ts`）
- `RepositoryRegistry` 在 `packages/core/src/repository/index.ts`；db 有 memory + drizzle 双实现 + contract-tests 复用

## 设计

### 1. core：StockPool 实体（`packages/core/src/entity/stock-pool.ts`，新建）

```ts
// 池成员来源（三种，覆盖"持仓池 / 手动池 / 策略池"）
type PoolSource =
  | { kind: 'holdings' }                                  // 默认账户活跃持仓，动态解析
  | { kind: 'manual'; stockIds: string[] }                // 手动股票列表
  | { kind: 'tactic'; tacticId: string; lookbackDays: number; minScore?: number }
  // tactic：成员 = 该战法近 lookbackDays 天命中信号的 distinct stockId
  //（"短线1进2""异动放量"等策略池 = tactic source + 对应战法；内置战法不够时用自定义战法）

// 盯盘规则（每池多条，规则因池而异）
type WatchRule =
  | { kind: 'tactic'; tacticId: string; minScore?: number }   // 战法命中：bullish→买点 / bearish→卖点
  | { kind: 'cost-threshold'; stopLossPct?: number; takeProfitPct?: number } // 现价 vs avgCost（仅 holdings 池）
  | { kind: 'price-change'; pct: number }                     // 日内涨跌幅 |X|≥pct（相对昨收，异动提醒）

interface StockPool {
  id: string;            // slug，kebab-case
  name: string;
  description?: string;
  source: PoolSource;
  rules: WatchRule[];    // ≥1
  cooldownMinutes: number; // 同股票同规则通知冷却，默认 30
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

- Zod schema（`StockPoolSchema` / `PoolSourceSchema` / `WatchRuleSchema`）+ `assertStockPoolInvariants`：
  id slug 合法；rules ≥ 1；`cost-threshold` 只允许挂 `source.kind='holdings'` 的池；tactic 规则/source 的 `minScore` ∈ [0,100]；pct 字段 > 0
- 触发结果类型 `WatchTrigger { poolId, stockId, ruleKind, direction: 'buy'|'sell'|'watch', reason, evidence[], quote }` 也定义在这里（workflow 输出复用）

### 2. core：Repository 接口（`packages/core/src/repository/index.ts`，改）

- 新增 `StockPoolRepository { save, findById, list(enabledOnly?), remove }`
- `RepositoryRegistry` 加 `readonly stockPool: StockPoolRepository`

### 3. db：表 + 双实现（改 `packages/db`）

- `schema/index.ts` 新增 `stockPools` 表：id 主键，name/description，source / rules 存 JSON text，cooldownMinutes / enabled / createdAt / updatedAt
- `repository/drizzle/` 新增 `stock-pool.ts`（DrizzleStockPoolRepository）
- `repository/memory/` 新增对应 memory 实现
- `repository/contract-tests.ts` 补 stockPool 契约用例（两套实现复用）
- `createDrizzleRepos` / memory 工厂挂上 stockPool

### 4. tools：池管理 4 个 tool（`packages/tools/src/tools/`，新建）

| tool | sideEffect | 说明 |
|---|---|---|
| `list_stock_pools` | read | 列全部池（可 filter enabled） |
| `create_stock_pool` | write | 输入 name/source/rules/cooldown → 校验 + 不变量 → 落库；tactic 引用先查 repos.tactic.findById 存在性 |
| `update_stock_pool` | write | 按 id 改 rules / source / enabled / cooldown / name |
| `delete_stock_pool` | write | 按 id 删 |

- 注册进 toolRegistry，并在 `packages/workflows/src/define-workflow.ts` 的 `WorkflowToolMap` 补 4 行类型映射
- MCP 侧 write 类默认 opt-in，无需改 mcp 包（对话建池时用户开 `LUOOME_EXPOSE_WRITE=true`）

### 5. tools：`run_tactic` 加 `persistSignals` 选项（`packages/tools/src/tools/run-tactic.ts`，小改）

- input 加 `persistSignals: z.boolean().default(true)`；为 false 时跳过 `saveSignal`
- 原因：watch 每分钟轮询若走默认落库会把 tactic_signals 表打爆；watch 传 false，信号历史仍由手动 run_tactic / tactic-scan 积累

### 6. workflows：`intraday-watch`（`packages/workflows/src/intraday-watch.ts`，新建）

单轮盯盘评估（无状态，可被 watch 进程 / cron / 手动复用）：

- input：`{ poolIds?: string[]; notify?: boolean = true }`
- steps：
  1. 加载 enabled 池（repo.stockPool.list）
  2. 逐池解析成员：holdings → `ctx.tools.list_holdings`；manual → stockIds；tactic → `tactic_signals_by_tactic` tool 拿近 N 天信号再聚合 distinct stockId（workflow 不直连 repo）
  3. `batch_quote` 拉全部成员行情
  4. 逐池逐规则评估：
     - `tactic` 规则 → `run_tactic`（scope=watchlist，stockIds=成员，persistSignals=false），score ≥ minScore 触发；direction 映射：bullish→buy、bearish→sell、neutral→watch
     - `cost-threshold` → quote.close 对比 holding.avgCost 纯计算
     - `price-change` → (close − 昨收)/昨收 ≥ pct；昨收取 `fetchDailyBars` 最近一根（dailyBar 有 1h 缓存，盘中只算一次）
  5. 汇总 `WatchTrigger[]`；notify=true 且有触发 → `send_notification` 聚合推送一条（标题"盘中提醒 N 条"，内容列：池 / 股票 / 买卖方向 / 理由 / 现价）
- output：`{ triggers, evaluatedPools, evaluatedStocks, notified }`

### 7. cli：`luoome watch` 命令（`packages/cli/src/index.ts` + 新建 `packages/cli/src/watch.ts`）

- 用法：`luoome watch [--interval 60] [--pool <id>] [--once] [--no-notify]`
- `watch.ts` 放可测纯逻辑：
  - `isTradingHours(date)`：A股 9:30–11:30 / 13:00–15:00，周一至周五（不做节假日历，v1 注释说明）
  - `CooldownMap`：key = poolId+ruleKind+stockId，池级 cooldownMinutes 内抑制重复通知；命中冷却的 trigger 仍打印到终端但不推送
- index.ts 加 `watch` 分支：createCliContext → 循环（`--once` 跑一轮退出；否则交易时段内每 interval 秒调 `intradayWatchWorkflow.run`，非时段 sleep 60s 重查）→ SIGINT 优雅 close
- interval 下限 clamp 到 30s（quote 缓存 TTL 60s，help 文案注明建议 ≥60s）

### 8. 种子数据（`packages/cli/src/context.ts`，小改）

- 首次运行 stock_pools 为空时种一个示例池：`id='holdings-watch'`，source=holdings，rules=[cost-threshold ±5%，tactic 量价背离]，开箱即可 `luoome watch`

### 9. 文档同步

- `AGENTS.md`：工具清单加 4 个 pool tool（write 类）；调试区加 `luoome watch` 用法
- `ARCHITECTURE.md` §8.1 内置 workflow 列表加 `intraday-watch`

## 实施顺序（实现时）

1. core 实体 + 不变量 + 测试（stock-pool.ts）
2. core repo 接口 → db schema + drizzle + memory + contract tests
3. tools 4 个 CRUD + registry + WorkflowToolMap + 测试；run_tactic persistSignals 选项
4. intraday-watch workflow + 测试
5. cli watch.ts + index.ts 接线 + 测试 + context.ts 种子
6. 文档（AGENTS.md / ARCHITECTURE.md）
7. 全量验证：`bun test`、`bunx tsc --noEmit`、`bunx biome check .`；再 `luoome watch --once`（mock 行情）实跑一轮确认输出

## 明确不做（v1）

- 不做 LLM 精排（盘中频率高、有成本；后续可加"高分信号触发一次 score_signals"）
- 不做节假日历、不做涨跌停特殊处理
- 不做通知通道扩展（复用现有 feishu/log）
- 不做 AGENTS.md 里的通用 Alert 实体（set_alert/list_alerts）；StockPool + WatchRule 覆盖了本次需求，通用预警另立任务
