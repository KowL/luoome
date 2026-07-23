# Handoff — luoome v0.8

> 这份文档给**接手的工程师 / agent**：把项目当前状态、关键决策、不变量、已知坑讲清楚，让你能**在一两天内上手改东西**。
>
> 它不是 ARCHITECTURE.md 的替代——架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)；这不是 README——怎么接入看 [AGENTS.md](../AGENTS.md)；这不是路线图——下一步计划看 [ROADMAP.md](./ROADMAP.md)。

---

## 1. 现状快照（v0.8）

| 维度 | 状态 |
|---|---|
| 已发布版本 | v0.5.0（v0.6 系列未单独发 tag / release；squash 合入 main，PR [#1](https://github.com/KowL/luoome/pull/1)） |
| 最新 commit | `0777352`（intrady watch v0.6 + holiday calendar v0.7 + dailyBars v0.6.1 + manager resilience v0.6.2，squash merge） |
| 测试 | 660 Vitest + 155 DB + 27 Web，全部通过（2026-07-23） |
| Tool 数 | 44；新增 `create_account` 支持空库初始化 |
| Workflow 数 | 6（sync-quotes / daily-advice / tactic-scan / risk-report / daily-review / **intraday-watch**） |
| 战法数 | 5 builtin（放量突破 / 均线多头 / 涨停回踩 / 量价背离 / 板块共振）—— v0.3 起 |
| 数据源 | 行情必须为 `real`：Eastmoney 主 → Tencent 备，全源失败报错；LLM 必须为 OpenAI-Compatible / Anthropic 且配置 key；测试 fake 仅从 `testing` 子路径导入 |
| Surfaces | CLI / TUI / Web（6 路由） / MCP stdio |
| 节假日历 | 内置 2026（29 天）+ 2027 best-effort placeholder；`~/.luoome/holidays.json` 文件加载 + `LUOOME_A_SHARE_HOLIDAYS` env 追加 |
| CI | GitHub Actions · ubuntu + bun 1.3.11 · typecheck + test:all + lint 三关 |
| License | MIT |

**v0.6 长驻盘中盯盘 + 节假日文件加载 + dailyBars 真实昨收 + manager 容错深覆盖都已 squash 合入 main**。下一阶段 v0.7+ 见 §9 backlog。

## 2. 5 分钟读懂项目

### 它是什么

**本地优先的个人投资管理 advisor agent**。把多源行情、财报、战法信号罗进来，织成结构化、可追溯、带理由的投资建议。**不替你下单**——advice 永远需要人确认。

### 设计主线

```txt
罗（采集） ──► 织（分析） ──► 建议 ──► 复盘
  行情         指标          decision    outcome
  财报         战法          信心度      命中率
  战法         LLM 推理      周期        hit rate
```

### 三条铁律（绝对不能破）

1. **Tool 永不抛异常** —— 永远返回 `ToolResult<T> = { ok: true, data } | { ok: false, error }`。
2. **advice ≠ trade** —— advice 类 tool 永不直接触发 trade。LLM 推完 buy/sell 后，agent 拿到建议后必须**重新询问用户**，不能自动 follow。
3. **`LUOOME_EXPOSE_TRADE=true` 启动硬卡** —— MCP server 在 env 检测到时直接 throw 退出，不可绕过。

### 包依赖（硬约束）

```txt
cli / tui / mcp / web ──► tools ──► core
                          │
                          └─► { db, adapters } ──► core
workflows ──► tools ──► core
```

`core` 零 IO；任何反向 import 都会被 review 打回。

### 核心实体（`packages/core/src/entity/`）

| 实体 | 关键字段 | 备注 |
|---|---|---|
| `Account` | id, name, currency, initialCapital | 多账户支持（v0.5 UI） |
| `Holding` | accountId, stockId, quantity, availableQuantity, avgCost, openedAt, closedAt? | 同 (accountId, stockId) 不可重复 |
| `Trade` | accountId, stockId, side, quantity, price, fee, executedAt | side: buy / sell |
| `Stock` | id (e.g. '002594.SZ'), code, name, market | market: cn-a / cn-hk（v0.5 加 us） |
| `Advice` | subjectKind, subjectId, decision, confidence, horizon, reasoning, risks, disclaimers, basedOn, validUntil, outcome? | **核心**——每次分析 / 扫描 / 战法的产物 |
| `Tactic` | id, name, tag, triggerWhen (DSL), scoreExpression (DSL), evidenceTemplate | DSL 是 `${...}` 表达式 |
| `TacticSignal` | tacticId, stockId, score, direction, evidence, triggerSnapshot | 战法命中产出 |
| `Notification` | channel, kind, target, payload, result | 飞书 / 日志 等 |

### 数据流（典型场景："给比亚迪出个建议"）

```txt
User  ─►  MCP / CLI / TUI / Web
            │
            ▼
       analyze_stock tool          ← read + advice
            │
            ├─► ctx.tools.compute_indicators  (拉日线 → 算 13 项技术指标)
            ├─► ctx.adapters.market.fetchQuote (Eastmoney / Tencent)
            ├─► ctx.adapters.llm.analyze      (OpenAI-Compatible / Anthropic)
            └─► ctx.repos.advice.save         (写 SQLite)
            │
            ▼
       Advice { decision, confidence, reasoning, ... }
            │
            ▼
       渲染（disclaimers + counter-evidence + risks 一并显示）
```

## 3. 关键文件 / 在哪里找

| 我想看 / 改 | 路径 |
|---|---|
| 实体类型 + 不变量 | `packages/core/src/entity/`（v0.6 起含 `stock-pool.ts`：StockPool / PoolSource / WatchRule / WatchTrigger） |
| branded types | `packages/core/src/types/branded.ts` |
| Tool 注册表 | `packages/tools/src/registry.ts` |
| 加新 tool 的样板 | `packages/tools/src/tools/search-stocks.ts` |
| Tool schema → TS / MCP / OpenAI 推导 | `packages/tools/src/define-tool.ts` |
| 战法 DSL 引擎 | `packages/core/src/tactic/` |
| 内置战法 | `packages/core/src/tactic/builtins.ts` |
| 行情适配（含真实链路容错测试） | `packages/adapters/src/market/{factory,manager,eastmoney,tencent,cache}.ts` + `manager-resilience.test.ts` |
| LLM 适配 + fallback | `packages/adapters/src/llm/` |
| 飞书 webhook | `packages/adapters/src/notification/` |
| Workflow 引擎 | `packages/workflows/src/define-workflow.ts` |
| 内置 workflow | `packages/workflows/src/{sync-quotes,daily-advice,tactic-scan,risk-report,daily-review,intraday-watch}.ts`（v0.6 起含 `intraday-watch` 9 步编排：load→seed→members→batch_quote→loadPrevCloses→evaluate→cooldown+persist→notify+summary） |
| 盘中盯盘 CLI | `packages/cli/src/watch.ts`（纯逻辑：isTradingHours + clampInterval + nextRunDelayMs + formatTriggersForLog）；接入点 `packages/cli/src/index.ts` `cmdWatch` |
| 节假日历 | `packages/cli/src/holidays.ts`（2026/2027 + 文件加载 + 三层优先级 union + parseHolidayObject 容错 + loadHolidaysFromFile 静默）；路径 `packages/cli/src/paths.ts`（`luoomeHome()` 共享小工具） |
| 测试 fixtures / fake adapters | `packages/adapters/src/testing/` 与 `packages/tools/src/testing/`（生产入口不导出） |
| MCP server 暴露面 | `packages/mcp/src/server.ts` |
| CLI argv 解析 | `packages/cli/src/index.ts` |
| TUI 布局 | `packages/tui/src/app.ts` |
| Web 路由 + API | `apps/web/src/server.ts` |
| Web 前端模块 | `apps/web/public/js/{api,ui,pages,app}.js` |
| Web 设计 tokens + 组件 | `apps/web/public/style.css` |
| DB schema (Drizzle) | `packages/db/src/schema/`（v0.6 起含 `stockPools` / `watchTriggers` 双表） |
| Repo 合约测试 | `packages/db/src/repository/contract-tests.ts` |
| 盘中盯盘设计 doc | `docs/intraday-watch-design.md` |

## 4. 日常开发流

```bash
# 拉代码
git clone git@github.com:KowL/luoome.git
cd luoome
bun install --frozen-lockfile

# 跑测试（CI 三关）
bun run typecheck
bun run test:all
bun run lint

# TUI smoke
bun packages/tui/src/smoke.ts

# 起一个 surface
bash bin/luoome tui                          # 终端
bash bin/luoome web serve --port 5173        # Web
LUOOME_EXPOSE_WRITE=true bash bin/luoome web serve  # Web + outcome 回填

# 接 MCP（Claude Desktop 配置 ~/.config/claude_desktop_config.json）
{
  "mcpServers": {
    "luoome": {
      "command": "luoome",
      "args": ["mcp", "serve"],
      "env": { "LUOOME_HOME": "/Users/you/.luoome" }
    }
  }
}
```

## 5. 关键决策与原因（避免重新讨论）

| 决策 | 原因 |
|---|---|
| Bun workspace monorepo（非 pnpm / turborepo） | bun 原生支持 workspace，无 node_modules 嵌套；bun run 直接跑 TS 无构建 |
| Drizzle ORM + 双实现（drizzle + in-memory） | 双实现让合约测试一遍跑两套，行为一致；in-memory 让单测 10x 快 |
| Schema-driven tool（Zod） | TS 类型 + MCP tool 定义 + OpenAI function calling schema 一份 zod 同时出 |
| Vanilla JS + Hono（Web） | 引入 Solid/Tailwind 会显著增加构建复杂度，与现有"零构建"风格不符 |
| OpenAI-Compatible 一个适配器覆盖 5 家 | DeepSeek / Kimi / Moonshot / Zhipu / OpenAI 都是 OpenAI 协议，分开写冗余 |
| 飞书 Webhook（v0.3）+ 企微 / Slack（v0.4+） | 飞书最常见；其他渠道等用户反馈再加 |
| `place_order` 永不暴露 | 合规 + 资金风险；agent 永远只能 advice，永远不能 trade |
| 5s 仪表盘自动刷新 + 手动按 r | 用户盯盘体验；setInterval 由 renderer.destroy 清掉 |
| advice 有 6 条不变量 | 强制 disclaimers + validUntil 让 AI 建议始终是"建议"而非"指令" |
| 战法 DSL 自实现 mini-eval | 引第三方表达式库（jsep / expr-eval）增加包大小；只支持 13 个变量 + 简单 bool / 比较 / Math.* 完全够用 |
| outcome 回填走 write tool | 复盘是用户主动行为；写权限 opt-in 防止 agent 误调 |
| AGENTS.md / ARCHITECTURE.md 分两份 | ARCHITECTURE 给工程师；AGENTS 给外部 agent harness。两份不能合并（受众不同） |

## 6. 已知坑 / 看起来怪但故意的

### 6.1 数据库路径

```bash
LUOOME_HOME    # 数据目录，默认 ~/.luoome
                #   ~/.luoome/luoome.db  ← SQLite 主库
                #   ~/.luoome/tactics/   ← 用户自定义战法（v0.3 留口，尚未实现 loader）
```

**当前约束**：所有 surface 只建表，不自动写入业务数据。空库先调用 `create_account` 或在 Web「设置」页创建真实账户。

### 6.2 Advice 的 `basedOn.dataAsOf`

生产 surface 统一使用真实系统时钟；测试时钟只存在于 `packages/adapters/src/testing/`，不会由生产入口导出。

### 6.3 Workflow 引擎的 unwrap 语义

```ts
// 引擎伪代码：
let current = parsedInput;
for (const step of steps) {
  const value = await step(current, ctx);
  // 如果返回 ToolResult，自动解包 data
  current = isToolOkResult(value) ? value.data : value;
}
```

**坑**：第一个 step 返回 ToolResult 后，下一个 step 拿到的 prev 是 `data`，**不是** `ToolResult`。`risk-report` workflow v0.3 早期就栽在这——`stepCompute` 把 data 当 ToolResult 处理。**记住**：除了引擎入口 / 错误短路，step 之间传的是 unwrap 后的数据。

### 6.4 CLI `--pnl` 等带值 flag

CLI argv 解析器（`packages/cli/src/index.ts`）有 `VALUE_FLAGS` 白名单；不在白名单里的 `--foo bar` 会把 `bar` 当位置参数。**新加带值 flag 必须加进白名单**：

```ts
const VALUE_FLAGS = new Set([
  'input', 'since', 'until', 'port', 'limit',
  'pnl', 'holding-hours', 'notes',
  'tactic', 'by', 'tactic-id', 'scope',
  // 新加的在这里
]);
```

### 6.5 LLM fallback

LLM 调用失败的处理（plan-v0.2-v0.3 §2.3）：

1. schema parse 失败 → 自动重试一次
2. 仍失败 → `fallbackAdvice()` 规则兜底（MA5 > MA20 → watch / confidence 30，其他 → hold / confidence 20）
3. 永远不让 tool 抛异常

测试 fallback 时通过 `realFactory` 注入会抛错的 fake adapter；验证 advice 仍有低信心输出，且 evidence 包含“LLM 推理失败，使用规则 fallback”。

### 6.6 战法 DSL 的 `${meta.*}`

DSL 引擎支持 `${indicators.X}` 和 `${meta.X}`。`meta` 是动态注入的元数据（如 `daysSinceLimitUp`、`recentLimitUp`），**不是所有战法都能用所有 meta key**。改战法前先看 `packages/tools/src/tools/run-tactic.ts` 注入哪些 meta。

### 6.7 CI 不跑 TUI smoke

TUI smoke 需要 `@opentui/core/testing` + Bun 完整环境，CI 上跑会有兼容问题。**本地 `bun packages/tui/src/smoke.ts` 必须 6 项全过再 push**。

## 7. 紧急操作手册

### 7.1 初始化空数据库

```bash
luoome tools call create_account --input '{"name":"主账户","currency":"CNY","initialCapital":100000}'
```

### 7.2 加新 env 变量

1. 在 `packages/core/src/context.ts`（或对应配置模块）的 env 解析里加
2. 在 `README.md` 环境变量表里登记
3. 在 `ARCHITECTURE §12` 配置章节登记
4. 测试时记得加 fallback（env 缺失时降级）

### 7.3 advice 输出错了

```bash
# 1) 看具体 advice
bash bin/luoome advice list --since 7d

# 2) 看 stats
bash bin/luoome advice stats --since 30d

# 3) 看底层 raw output
bash bin/luoome tools call analyze_stock --input '{"stockId":"002594.SZ"}'

# 4) 回填 outcome
bash bin/luoome advice outcome <adviceId> --followed true --pnl 500
```

### 7.4 战法跑不出信号

```bash
# 1) 列战法
bash bin/luoome tools call list_tactics --input '{}'

# 2) 单跑一个战法
bash bin/luoome tools call run_tactic --input '{"tacticId":"breakout-volume","scope":"holdings"}'

# 3) 看 raw signals
bash bin/luoome tools call tactic_signals_by_tactic --input '{"tacticId":"breakout-volume","since":"-7d"}'
```

如果 `evaluatedStocks > 0` 但 `signals = []`，是 DSL 表达式太严；如果 `evaluatedStocks = 0`，是 scope / stockIds 配置问题。

### 7.5 MCP server 起不来

```bash
LUOOME_LOG=debug bash bin/luoome mcp serve 2>&1 | head -50
```

常见原因：

- `LUOOME_EXPOSE_TRADE=true`（启动硬卡）
- `LUOOME_HOME` 路径无权限
- port / pipe 被占（MCP stdio 用 stdin/stdout）

### 7.6 录入持仓 / 交易

```bash
# 买入（自动落 Trade + 新开/加仓 Holding，avgCost 数量加权不含 fee；stock 缺行自动补 stub）
bash bin/luoome tools call add_trade --input '{"stockId":"601398.SH","side":"buy","quantity":500,"price":7.25,"fee":3.5}'

# 卖出（超卖 / 无持仓 → invalid_input；卖光自动 closedAt）
bash bin/luoome tools call add_trade --input '{"stockId":"601398.SH","side":"sell","quantity":100,"price":7.8}'

# 无成交明细的历史持仓直录（同账户同股票不可重复）
bash bin/luoome tools call add_holding --input '{"stockId":"601398.SH","quantity":500,"avgCost":7.25}'

# 纠错 / 平仓
bash bin/luoome tools call update_holding --input '{"holdingId":"<id>","avgCost":7.1}'
bash bin/luoome tools call close_holding --input '{"holdingId":"<id>"}'
```

4 个均为 write 副作用：MCP 需 `LUOOME_EXPOSE_WRITE=true` 才暴露；Web 端 v0.8 起默认放行 write（持仓页新增 / 加仓 / 减仓 / 纠错 / 平仓直接可用，external 仅白名单 `fetch_quote`，详见 `apps/web/src/server.ts` 闸口）。

## 8. 下一步（v0.5 候选）

按优先级：

1. **真实数据链**：四个 surface 统一走 Eastmoney 主 → Tencent 备和真实 LLM；全源失败明确报错。
2. **多账户切换 UI**：账户由用户显式创建，TUI/Web 支持切换。
3. ~~**confidence 自校准**~~ → **已完成（v0.5 W4）**：`get_confidence_calibration` tool + TUI `[c]` 弹层 + Web 复盘页校准表
4. **Web push 通知**（高信心建议推送到浏览器）
5. **CI 加 TUI smoke**（GitHub Actions 上跑）
6. **ESLint-style import 检查**（防反向依赖）
7. **用户自定义战法 loader**（`~/.luoome/tactics/*.yml`）
8. **企微 / Slack 通知**

具体计划开 issue 讨论，不要直接开 PR（涉及大块架构调整）。

## 9. v0.6.3+ 后续 backlog

> 这一节列出 v0.6.2 之后还没动的功能点，按优先级与依赖排序。
> 每条都写明 **痛点 / 范围 / 取舍**，新接手的 agent 可以从 P0 开始按序消化。

### 9.1 [P0] CLI 端真实 Eastmoney 网络 e2e

- **痛点**：v0.6.2 覆盖了 `MarketDataManager` unit-level（fetchImpl 注入 mock），但
  没从 `luoome watch --once` 入口走完 `createCliContext → batch_quote tool →
  adapter → 真实 https://push2.eastmoney.com`。PR reviewer 会担心生产路径断。
- **范围**：`packages/cli/` 加 `tests/watch-real.e2e.test.ts`（用 bun 自带 runner，
  因 CLI 需 `bun:sqlite`），跳过条件 `process.env.LUOOME_REAL_E2E !== '1'`。测试
  拉 1-2 个真实 SH/SZ 代码，验证拿到的 `quote` 字段合规、source 字段 = 'eastmoney'。
- **取舍**：CI 默认不跑（避免外部依赖抖动），开发者本地 `LUOOME_REAL_E2E=1 bun
  test packages/cli --watch-real` 主动验证。

### 9.2 [P0] `cost-threshold` 规则仅 holdings 池生效的 invariant 强制

- **痛点**：design doc §7 提到"cost-threshold 仅 holdings 池有效"，但 entity
  invariant 没强制。manual 池成员的 `avgCost=undefined`，evaluate 静默跳过；
  当前测试覆盖这条但代码层无保护，重构时被悄悄打破。
- **范围**：在 `packages/core/src/entity/stock-pool.ts` 的 `assertStockPoolInvariants`
  加 \`rule.kind === 'cost-threshold' → source.kind === 'holdings'\`；新增
  `stock-pool-invariants.test.ts` case 2 个（误用 manual + cost-threshold → invariant
  violation；用 holdings + cost-threshold 合法）。
- **取舍**：会拒绝"成本阈值在 manual 池"的合法用法；这是设计意图，但需要在 commit
  message 里明确，否则使用者会撞墙。

### 9.3 [P1] `run_tactic` 的 cost-threshold `else if` 优先级文档化

- **痛点**：`evaluateSyncRule` 的 cost-threshold 分支用 `else if`——双向规则
  （take-profit + stop-loss 同时配）时只能命中其一。代码注释没写明这个语义，
  看代码的人会以为是 bug。
- **范围**：纯 docs，`design doc §6 step 5` 加一行"`else if` 优先级：双向
  则优先 take-profit（止盈），stop-loss 不会同帧触发"。现有 cost-threshold
  test 已覆盖此行为，文档补全即可。
- **取舍**：无代码改动，零回归风险。

### 9.4 [P1] 2028+ 节假日补全（按国办通知）

- **痛点**：`CN_A_SHARE_HOLIDAYS_2027` 是 best-effort placeholder，到 2027 末
  2028 国办通知发布后，维护者需在 v0.8+ 手工同步 `CN_A_SHARE_HOLIDAYS_2028`。
- **范围**：`packages/cli/src/holidays.ts` 新增 `CN_A_SHARE_HOLIDAYS_2028` +
  `BUILTIN_HOLIDAYS.set(2028, ...)`，并在常量顶部 disclaimer 写明发布时间窗口。
- **时机**：每年 12 月触发（自动 reminder 暂无；CI 跑 testing 时若 2028/01/01 已
  过且 BUILTIN_HOLIDAYS 没有 2028 entry，可加个启动期 warn）。

### 9.5 [P2] price-change `prevClose` 来源标记

- **痛点**：`evidence: [\`prevClose=${prevClose}\`]` 没区分 dailyBar 来源 /
  quote.open fallback 来源；客户端看 trigger 详情时不知道是哪条路径。
- **范围**：`evaluateSyncRule` 在 price-change 分支判断
  `prevCloses.has(m.stockId)` 设 `(bar)` / `(open-fallback)` 前缀写进 evidence。
 现有 fallback 行为不变，只额外写明来源。
- **取舍**：traceability 提升，代价一个 branch + 几个测试断言。

### 9.6 [P2] dailyBars 1h 缓存层

- **痛点**：`intraday-watch` 高频轮询时每次 batch_quote 后都做
  `dailyBar.latestBefore(stockId, now, 1)`，watch 跑 1 小时就是几十次同样的查询。
  设计 doc §6 提到"dailyBar 1h 缓存"，实现没补。`quote cache` 已有
  （`packages/adapters/src/market/cache.ts`），复用其模式即可。
- **范围**：在 `manager.ts` 的 `stepLoadPrevCloses` 附近加内存 `Map<stockId,
  { close: Money; ts: Date }>`，TTL 1h；走查前先查缓存，过期重取。测试加 case
  覆盖"60s 内同 stockId 第二次 fetch 不应再调 repo"。
- **取舍**：内存量级可控（每 stock ~50 bytes），hot path 提速显著；代价是
  watch 进程内 state，跨重启需要重建（v0.6 dailyBar repo 仍然持 disk）。

### 9.7 [P3] ~~统一 v0.6.x → README + ROADMAP 时间线~~ ✅ 已完成

> 2026-07-22 落地：README 状态节更新到 v0.7、ROADMAP 补 v0.6/v0.6.1/v0.6.2/v0.7 小节、全部文档迁入 `docs/`。以下原始条目存档：

- **痛点**：README.md 的版本状态、ROADMAP.md 的版本完成度还没同步 v0.6 +
  v0.7 + v0.6.1 + v0.6.2。接手的人看 ROADMAP 会以为这些没做。
- **范围**：`README.md` 的"Currently shipping" + `ROADMAP.md` 的
  v0.6 标记为 done（**已完成 v0.6 / v0.7 / v0.6.1 / v0.6.2**）。PR #1 已合并。
- **取舍**：纯 doc；建议合并后立刻做（不然文档滞后代码会在 issue 里引起
  confusion）。

---

## 10. 致接手的人

luoome 不是一个"平台"，是**个人真能用的 advisor agent**。

如果你的改动让它**更贴近这个目标**——更可信的建议、更清楚的复盘、更友好的体验——那就是好的方向。

如果你的改动让它**更像一个跟单 / 交易 / 社交平台**——大概率是走偏了。先开 issue 讨论。

愿你在织网的过程中，享受把噪音织成信号的乐趣。

— lijun, 2026-07-21（v0.6.2 squash 合 main + §9 backlog）
