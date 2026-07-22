# luoome v0.2 + v0.3 实施计划

> 依据 ROADMAP.md / ARCHITECTURE.md / AGENTS.md / SECURITY.md / plan.md（v0.1 已完工，全绿：20 个测试文件 / 173 测试 / typecheck 0 错 / lint 0 错 / 8 个 tool 已暴露）。
> v0.1 + v0.2 + v0.3 全部完成时，luoome 进入「真实行情 + 真实 LLM + 战法引擎 + 复盘闭环」可用状态。

## 0. 地基现状（v0.1 已落地，复用即可）

- `@luoome/core`：branded types / 6 个实体（含 Advice、AdviceOutcome、TacticSignal）/ 5 类 ToolError / `SideEffect` 五级 / 不变量断言 / 6 个 repo 接口 / `ToolContext`。
- `@luoome/db`：Drizzle schema + SQLite + in-memory 双 repo + seed。
- `@luoome/adapters`：`MockMarketAdapter` + `MockLLMAdapter` + fixtures（20 股票 / 1 账户 / 6 持仓 / 9 交易）。
- `@luoome/tools`：`defineTool` + `toolRegistry` + Zod → TS/MCP/OpenAI 自动推导 + 8 个 tool（6 read + 2 advice）。
- `@luoome/mcp`：stdio server，env 控制暴露面（`LUOOME_EXPOSE_TRADE=true` 启动硬卡）。
- `@luoome/cli`：`luoome` 入口 + 子命令 `tools list/inspect/call`、`advice list/stats`、`mcp serve`、`tui`、`web serve`、`sync-quotes`、`daily-advice`（占位）。
- `@luoome/workflows`：`dailyAdviceWorkflow` 骨架（list_holdings → 并发 analyze_stock）。
- `@luoome/tui`：opentui 仪表盘（持仓 | 建议 + 顶部免责声明）。
- `apps/web`：Hono + 原生 HTML/JS 仪表盘（localhost:5173）。

## 1. 设计主线

```text
v0.1  [罗: 假数据 / 织: 假建议]   ← 完成
v0.2  [罗: 真行情 / 织: 真建议]   ← 本计划上半
v0.3  [罗: 多源 / 织: 可复盘]    ← 本计划下半
```

## 2. 关键设计决策（动手前钉死）

### 2.1 数据源 / 适配策略

- **行情**：Eastmoney（主力，无 auth，A 股 / 港股覆盖）+ Tencent（备用，A 股覆盖） + Manager（轮询 + 缓存 + 限速 + 故障降级）。v0.2 不接美股（v0.5）。
- **行情缓存**：`QuoteCache`（内存 LRU，TTL 60s），写 `PriceSnapshot` 落库时 `source` 字段标 `eastmoney` / `tencent` / `mock`。
- **降级**：源失败 → 切备用 → 仍失败 → 30 分钟内回退 MockMarketAdapter + 写 `logger.error`，不阻塞 advice。

### 2.2 LLM 适配策略

- **优先级**：OpenAI 兼容协议 1 个适配器覆盖 DeepSeek / Kimi / Moonshot / Zhipu / OpenAI 五家 + Anthropic 1 个适配器原生 Messages API。`LLMProvider` 配置走 env：
  - `LUOOME_LLM_PROVIDER=openai-compatible|anthropic|mock`
  - `LUOOME_LLM_BASE_URL` / `LUOOME_LLM_API_KEY` / `LUOOME_LLM_MODEL`
- **缺 key 优雅降级**：key 缺失或 provider=`mock` → `MockLLMAdapter`，CLI 默认 mock 不污染输出。
- **schema-constrained decoding**：把 `AdviceLLMSchema` 通过 tool/function calling 传给 LLM（OpenAI 用 `response_format: { type: 'json_schema' }`；Anthropic 用 `tool_use` + schema），parse 失败走 §2.3 fallback。

### 2.3 LLM fallback 协议（hard）

LLM 返回值若不符合 `AdviceLLMSchema`：
1. 第一次失败：自动重试一次（同一 prompt + 提示「上一轮未符合 schema，请重试」）。
2. 仍失败 → 走 `fallbackAdvice(data)`（基于指标的硬规则：MA5 > MA20 → `decision: 'watch'`，confidence 30；其他 → `'hold'`，confidence 20），并在 `advice.reasoning.evidence` 加一条「LLM 推理失败，使用规则 fallback」。
3. 永远不让 tool 抛异常（始终包成 `ToolResult`）。

### 2.4 战法 DSL（v0.3）

```yaml
# ~/.luoome/tactics/breakout.yml
id: breakout_volume
name: 放量突破
tag: momentum
description: 5 日均量 > 20 日均量 × 1.5 且收盘突破近 20 日最高。
trigger:
  when: ${indicators.volRatio5_20 >= 1.5 && indicators.close >= indicators.high20}
signal:
  score: ${Math.min(100, indicators.volRatio5_20 * 30)}
  direction: bullish
  evidence:
    - "量比 volRatio5_20=${indicators.volRatio5_20}"
    - "收盘 ${indicators.close} ≥ 20 日最高 ${indicators.high20}"
```

DSL 引擎：用 `${...}` 取值 + 简单 `&&` / `||` / `>=` / `<=` 表达式求值（自实现 mini-eval，避免引第三方表达式库；只支持数字 / 布尔 / `Math.min/max/...`）。

### 2.5 通知适配（v0.3）

飞书 Webhook adapter（`FeishuWebhookAdapter`，`send_text` / `send_card`）。其他渠道（企微 / Slack）v0.4+。`send_notification` 工具走 webhook，env 配 `LUOOME_FEISHU_WEBHOOK_URL`，缺失时降级为只 logger.info。

### 2.6 副作用边界（保持 v0.1）

- v0.2 新增 `external` 工具：`fetch_quote` / `batch_quote` / `sync_quotes` / `search_stocks` / `compute_indicators`。
- v0.3 新增 `external`：`send_notification`；新增 `read`：`list_tactics` / `get_tactic` / `run_tactic` / `score_signals` / `record_advice_outcome` / `market_outlook`（advice）。
- `trade` 永不暴露（已在 mcp 层硬卡，v0.2 / v0.3 不动这条规则）。

## 3. 跨包契约（v0.2 + v0.3 增量）

### 3.1 core 增量

- `entity/market.ts`（新）：`Market = 'cn-a' | 'cn-hk' | 'us'`，`Stock` 加 `market: Market`。
- `entity/indicator-set.ts`（新）：`IndicatorSet` schema（v0.1 `TechnicalIndicators` 升级为强类型 key 集合，保留 catchall）。
- `entity/tactic.ts`（新）：`Tactic`、`TacticTrigger`、`TacticSignal`（已有 TacticSignal 扩展 `tacticName` / `tacticTag`）。
- `entity/notification.ts`（新）：`NotificationChannel = 'feishu' | 'log'`，`NotificationPayload`。
- `repository` 接口新增：`IndicatorRepository`（v0.3 起缓存日线指标快照）、`TacticRepository`（v0.3 起存战法定义 + 信号历史）、`NotificationRepository`（v0.3 起存推送历史）。
- 新不变量：`assertTacticInvariants` / `assertTacticSignalInvariants` / `assertNotificationInvariants`。
- `LLMProvider` 配置类型（移 core）：`{ provider, baseUrl?, apiKey?, model }`。

### 3.2 adapters 增量

- `market/eastmoney.ts`（新）：HTTP 客户端（A 股 + 港股），`name: 'eastmoney'`，3 个方法实现。
- `market/tencent.ts`（新）：备用源，`name: 'tencent'`。
- `market/manager.ts`（新）：`MarketDataManager implements MarketDataAdapter`，内含轮询 / 缓存 / 限速 / 降级。
- `market/cache.ts`（新）：`QuoteCache`（LRU 60s TTL）+ `DailyBarCache`（LRU 1h TTL）。
- `market/types.ts`：保留并加 `MarketManagerOptions`。
- `llm/openai-compatible.ts`（新）：覆盖 OpenAI / DeepSeek / Kimi / Moonshot / Zhipu；用 `response_format: json_schema`。
- `llm/anthropic.ts`（新）：Anthropic Messages API + tool_use 模拟 schema-constrained。
- `llm/manager.ts`（新）：`LLMManager implements LLMAdapter`，env 路由 + fallback 协议（§2.3）。
- `mocks/`：保留 + 加 `mockDailyBarsFor(stockCode, range)` 给 offline test 用。

### 3.3 db 增量

- 新表：`quote_snapshot`（v0.1 暂无独立表，v0.2 起 Quote 也落库便于回放）、`daily_bar`（缓存日线）、`indicator_snapshot`（v0.3 战法精排的指标快照）、`tactic`（v0.3 战法定义）、`tactic_signal`（v0.3 信号历史）、`notification`（v0.3 推送历史）。
- 新 migration：`0002_v0_2.sql` / `0003_v0_3.sql`，每包只追加不破坏 schema。
- 6 个 repo 接口全实现（Drizzle + in-memory 双轨），新 repo 同。
- seed 增量：`v0.2` 加 5 个内置战法定义；`v0.3` 加 1 条飞书推送样例（环境无 webhook 时跳过）。

### 3.4 tools 增量（v0.2 + v0.3 共 15 个新 tool）

**v0.2（5 个）**：
- `fetch_quote`（external）：拉单股 quote 写库。
- `batch_quote`（external）：批量拉行情写库。
- `sync_quotes`（external）：账户下所有持仓全量同步。
- `search_stocks`（read）：按代码 / 名称 / 拼音模糊搜。
- `compute_indicators`（read）：给定 stockId + range 算指标快照（不落库）。

**v0.3（10 个）**：
- `list_tactics`（read）/ `get_tactic`（read）：战法定义查询。
- `run_tactic`（read）：跑单个战法生成 `TacticSignal[]`。
- `score_signals`（read）：LLM 精排信号（高 token 成本，可选 `topK`）。
- `record_advice_outcome`（write）：回填 advice outcome + pnl。
- `send_notification`（external）：推送飞书等。
- `market_outlook`（advice）：大盘 + 板块观点。
- `risk_report`（走 workflow，非 tool）：通过 workflow 暴露。
- `tactic_scan`（走 workflow，非 tool）：通过 workflow 暴露。

`toolRegistry` v0.3 末态 = 23 个 tool（6 + 2 + 5 + 10；`risk_report` / `tactic_scan` 不入注册表，只走 workflow）。

### 3.5 workflows 增量

- `sync-quotes`（v0.2）：拉账户下所有持仓 → `fetch_quote` 并发 → 回报条数。
- `daily-advice`（v0.2 升级）：首步换 `sync_quotes`；advice tool 切真实 LLM（manager 路由）；末步加 `send_notification` 推高信心度建议（v0.3 接）。
- `tactic-scan`（v0.3）：`list_tactics` → 对每个战法 `run_tactic` → `score_signals` 精排 → 写库。
- `risk-report`（v0.3）：账户下所有持仓 → 算集中度 / VaR / Sharpe / 最大回撤 → 写 markdown 报告。
- `daily-review`（v0.3）：当日 advice 汇总 + outcome 回填率 + 命中率 → markdown 报告。

### 3.6 mcp 增量

- v0.2：env 加 `LUOOME_EXPOSE_EXTERNAL`（已在 v0.1 留口）；暴露面校验逻辑不动。
- v0.3：env 加 `LUOOME_EXPOSE_WRITE`（回填 outcome 需要 write）；`LUOOME_EXPOSE_TRADE=true` 启动失败（v0.1 已卡）。
- 新增 `get_advice_stats` 已有，按 `byDecision` / `byTacticTag` 拆分（v0.3 起）。

### 3.7 cli 增量

- 新子命令：`advice outcome --adviceId ... --outcome followed --pnl 123.45`（v0.3）、`tactic list/run`、`workflow run tactic-scan` / `daily-review` / `risk-report`、`sync-quotes`、`notify test`（v0.3）。
- `luoome advice stats` 加 `--by tacticTag` / `--by decision`（v0.3）。

### 3.8 tui 增量

- v0.2：右侧「今日建议」面板加 1s 自动刷新（拉 `get_advice`）；左侧「持仓」加实时价 + 日内涨跌色。
- v0.3：顶部加 tab：`持仓 / 战法 / 复盘`；新增「战法」面板（运行中信号 + LLM 精排 top 5）、「复盘」面板（outcome 回填 + 命中率）。

### 3.9 apps/web 增量

- v0.2：仪表盘加「实时价」列 + 1s 轮询；建议卡片加来源标识（eastmoney / tencent / mock）。
- v0.3：加 `/tactics` 路由（战法列表 + 运行 + 精排结果）、`/review` 路由（复盘 + outcome 回填表单）。

## 4. 波次划分（agent 派工）

> 沿用 plan.md 的波次 + 写权限隔离规则：并行 agent 不写同一文件；除 W2.H / W3.H 外禁止 git commit；每 phase 跑 `bun test` + `bun run typecheck` + `bun run lint` 全绿才进下一波。

### v0.2 波次

| 波次 | 主题 | 唯一写权限 | 依赖 | 估时 |
|---|---|---|---|---|
| W2.A | core 增量（Market / IndicatorSet / LLMProvider） | `packages/core/src/**` | 无 | 0.5d |
| W2.B | db 增量（quote_snapshot / daily_bar / migration） | `packages/db/src/**` | core（Market） | 0.5d |
| W2.C | adapters/market 真实源（Eastmoney + Tencent + Cache + Manager） | `packages/adapters/src/market/**`（mocks/ 不动） | core | 1.5d |
| W2.D | adapters/llm 真实源（OpenAI-Compatible + Anthropic + Manager + fallback） | `packages/adapters/src/llm/**`（mocks/ 不动） | core | 1.5d |
| W2.E | tools 新 5 个 + `analyze_stock` / `analyze_position` 切真实 LLM | `packages/tools/src/**` | C + D | 1d |
| W2.F | workflow `sync-quotes` + `daily-advice` 升级 + 新 CLI 子命令 | `packages/workflows/src/**` + `packages/cli/src/**` | E | 1d |
| W2.G | TUI / Web 实时刷新 | `packages/tui/src/**` + `apps/web/src/**` | E | 1d |
| W2.H | v0.2 验收 + 文档（ROADMAP / AGENTS 同步） + commit | 全部 | 全部 | 0.5d |

### v0.3 波次

| 波次 | 主题 | 唯一写权限 | 依赖 | 估时 |
|---|---|---|---|---|
| W3.A | core 增量（Tactic / Notification / IndicatorSnapshot / 不变量） | `packages/core/src/**` | 无 | 0.5d |
| W3.B | db 增量（tactic / tactic_signal / indicator_snapshot / notification） | `packages/db/src/**` | core | 0.5d |
| W3.C | 战法 DSL 引擎 + 5 个内置战法（breakout / ma-bull / pullback / vol-divergence / sector-resonance） | `packages/core/src/tactic/**` + `packages/adapters/src/mocks/tactics.ts` | A | 1.5d |
| W3.D | 飞书 Webhook adapter + NotificationManager + `send_notification` tool | `packages/adapters/src/notification/**` + `packages/tools/src/tools/send-notification.ts` | A | 1d |
| W3.E | tools 新 9 个（tactics / signals / outcome / outlook） + `analyze_stock` 织入 tacticSignals | `packages/tools/src/**` | C + D | 1.5d |
| W3.F | workflow `tactic-scan` / `risk-report` / `daily-review` + CLI 子命令 + `advice outcome` | `packages/workflows/src/**` + `packages/cli/src/**` | E | 1.5d |
| W3.G | TUI / Web 战法 + 复盘页 | `packages/tui/src/**` + `apps/web/src/**` | E | 1.5d |
| W3.H | v0.3 验收 + 文档（ARCHITECTURE / AGENTS 同步 advice 复盘口径） + commit | 全部 | 全部 | 0.5d |

总计约 14 人天（串行口径；并行可压到 ~7d，但依赖收敛后才有并行空间）。

## 5. 验收口径

### v0.2 验收（W2.H 执行）

- `bun run typecheck` / `bun test` / `bun run lint` 全绿。
- 关闭 mock：设 `LUOOME_LLM_PROVIDER=openai-compatible LUOOME_LLM_BASE_URL=... LUOOME_LLM_API_KEY=... LUOOME_LLM_MODEL=...`，`./bin/luoome tools call analyze_stock --input '{"stockId":"002594.SZ"}'` 返回的 advice `disclaimers` 含 3 条 STANDARD_DISCLAIMERS + `basedOn.llmReasoning` 含真实 LLM 原始推理。
- 模拟 Eastmoney 5xx：mock adapter 测，`Manager` 自动切 Tencent；都失败 → logger.error + fallback MockMarketAdapter + advice 仍产出。
- `cache hit ratio` 日志可见：`LUOOME_LOG=debug ./bin/luoome mcp serve` 跑 10 次同 stock `fetch_quote` → 至少 9 次命中。
- `analyze_position` 输出持仓上下文化的 advice（reasoning.evidence 引用 `position.avgCost` 与现价差）。
- TUI 1s 刷新不卡（手动按 `r` 触发 + 自动轮询）。
- Web 仪表盘实时价轮询正常。

### v0.3 验收（W3.H 执行）

- `bun run typecheck` / `bun test` / `bun run lint` 全绿。
- `./bin/luoome tactic list` 列出 5 个内置战法。
- `./bin/luoome workflow run tactic-scan --tactic breakout_volume` 产出 ≥ 1 个 signal（mock 数据上确定性产出）；`score_signals` 调真实 LLM 精排。
- `./bin/luoome advice outcome --adviceId ... --outcome followed --pnl 100` 落库；`./bin/luoome advice stats --by decision` 输出按决策拆分；`hit rate` 与 confidence 相关性可计算（v0.3 仅做基础统计，不做相关性检验）。
- 飞书 webhook：设 `LUOOME_FEISHU_WEBHOOK_URL=...`，`./bin/luoome notify test` 收到飞书消息。
- `daily-review` workflow 产出 markdown 报告（CLI 输出文件路径 + 摘要）。
- TUI 新增「战法」「复盘」tab 可用。
- Web 新增 `/tactics` `/review` 路由可用。
- 50 条 advice 自评（v0.3 起新增指标）：人工抽 10 条复盘，与 5 日后实际走势一致率 ≥ 50%（v0.3 验收门槛，v0.5 提到 60%）。

## 6. 硬约束（v0.2 + v0.3 全程不变）

1. 依赖方向：`cli / tui / mcp / web ──► tools ──► core`，`tools ──► {db, adapters} ──► core`，`workflows ──► tools ──► core`。**禁止反向依赖**。
2. 副作用 5 级 + `LUOOME_EXPOSE_TRADE=true` 启动硬卡（v0.1 已卡，v0.2 / v0.3 加 e2e 测试守住）。
3. advice 必含 3 条 STANDARD_DISCLAIMERS（不变量，v0.1 已 assert）。
4. advice tool handler 永不触发 trade tool（类型层 + 注释 + 单测兜底）。
5. TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开。
6. Money / Quantity / Percentage / StockCode branded types 禁止裸 number / string。
7. Tool 永不抛异常，永远返回 `ToolResult`；advice output parse 失败走 §2.3 fallback。
8. 每个 tool ≥ 1 个 vitest 单测；core 不变量测试覆盖率 ≥ 80%。
9. Biome lint / format；commit 用 conventional commits（W2.H / W3.H 统一补）。
10. 真实 LLM 调用的 timeout 5s、单 prompt token 上限 4000、超限自动截断 + warn。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Eastmoney 限流 / 改版 | Manager 限速（默认 10 req/s）+ Tencent 备用 + 30min 内回退 mock；断点续传靠 quote_snapshot 表 |
| 真实 LLM 抖动 / 超时 | §2.3 fallback 协议 + 单 tool timeout 5s + 整体 daily-advice 容忍单票失败 |
| 战法 DSL 写错导致跑飞 | DSL schema 严格校验 + 加载期单测 + `run_tactic` 失败不阻塞后续战术 |
| 飞书 webhook 配错误推 | `send_notification` 走 dry-run 默认 + `notify test` 命令先验 |
| 指标公式分歧（用户认为的 MA5 vs 我们算的 MA5） | v0.2 起在 advice.basedOn.indicators 字段显式标 `definitionVersion: 'v1'`；分歧时换字段不改语义 |
| 网络分区 / 离线 | 默认 mock 适配器永远在；adapter manager 选 mock 时 warn |

## 8. 路线图状态机

```text
[W2.A] ──► [W2.B] ──┬──► [W2.C] ──┐
                     └──► [W2.D] ──┤
                                   ▼
                              [W2.E]（关键路径）
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
            [W2.F]             [W2.G]           [W2.H: v0.2 验收]
                │                  │
                └────────┬─────────┘
                         ▼
                    [W3.A] ──► [W3.B] ──┬──► [W3.C] ──┐
                                       └──► [W3.D] ──┤
                                                     ▼
                                                [W3.E]（关键路径）
                                                     │
                                ┌────────────────────┼────────────────────┐
                                ▼                    ▼                    ▼
                            [W3.F]               [W3.G]           [W3.H: v0.3 验收]
```

W2.E 是 v0.2 关键路径，W3.E 是 v0.3 关键路径。两点都完成才能并行下游。
