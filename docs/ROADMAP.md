# Roadmap

> luoome v0.1 → v0.10 演进路线。每版本都有**可见产物 + 验收标准**。
> 设计主线：**罗（采集） → 织（分析） → 建议 → 复盘**。
>
> 本文件 v0.8 以前章节是历史快照。当前目标模型与入口以
> [Strategy 与统一 Watchlist 详细设计](./ddd/strategy-watchlist-unification-detailed-design.md)
> 和 [CONTEXT.md](../CONTEXT.md) 为准；当前执行顺序以
> [开发计划](./development-plan.md) 和
> [Strategy 可靠性开发计划](./strategy-reliability-development-plan.md) 为准。

## v0.1 — Foundation ✅（已完成）

**目标**：骨架 + 第一个垂直切片端到端跑通（advice 模型可用，mock 数据）。

**产物**：
- Bun workspace monorepo（`packages/core db tools adapters workflows mcp cli tui`）
- core 包：领域类型（Account / Holding / Trade / Stock / **Advice**）+ 不变量 + Money/Quantity/Percentage branded types
- db 包：Drizzle schema + SQLite + in-memory repo（双实现）+ Advice 存储
- tools 包：Tool registry + Zod → TS/MCP/OpenAI 自动推导 + 8 个最小工具：
  - read: `list_accounts`, `get_account`, `list_holdings`, `get_holding`, `get_advice`, `get_advice_stats`
  - advice: `analyze_stock`（mock LLM，输出结构化 Advice + disclaimers + validUntil）
- mcp 包：stdio server，暴露 read + advice 类
- cli 包：`luoome` 命令入口，至少 `tools list`, `tools call`, `advice list`, `advice stats`, `mcp serve`
- tui 包：opentui 应用，`luoome tui` 显示持仓列表 + 今日建议（mock 数据）
- 测试：vitest + 核心工具的单元测试 + advice 不变量测试 + mcp server smoke test

**验收**：
- ✅ `bun run tui` 在终端显示 mock 持仓表格 + mock 建议列表
- ✅ `bun run mcp` 起 stdio server，client 能 list tools + call `analyze_stock` 拿 mock advice
- ✅ `bun test` 全绿
- ✅ README + ARCHITECTURE + AGENTS + ROADMAP + SECURITY 齐备且反映 advisor 定位
- ✅ Advice 实体的 6 个不变量都被 assert 覆盖

## v0.2 — 真实行情 + 真实 Advice ✅（已完成）

**目标**：接入真实数据源 + 真实 LLM，advice 端到端可用。

**实际产物（W2.A → W2.H，commit 见 git log）**：
- core 增量：`Market` 枚举 + `IndicatorSet`（`KNOWN_INDICATOR_KEYS` 13 项）
- db 增量：`quote_snapshot` + `daily_bars` 表 + QuoteRepository / DailyBarRepository（Drizzle + in-memory 双实现）
- adapters 增量：
  - market：EastmoneyAdapter（A 股 + 港股）+ TencentAdapter（备用）+ QuoteCache / DailyBarCache（LRU）+ MarketDataManager（cache + rate-limit + fallback + 抑制窗口）
  - llm：OpenAICompatibleAdapter（覆盖 OpenAI / DeepSeek / Kimi / Moonshot / Zhipu）+ AnthropicAdapter + LLMManager（mock fallback + 重试 + 规则兜底）
- tools 增量：fetch_quote / batch_quote / sync_quotes / search_stocks / compute_indicators
- workflows 增量：syncQuotesWorkflow（CLI 子命令 `luoome workflow run sync-quotes`）
- tui / web：5 秒自动刷新
- 测试：343 pass（v0.1 173 → v0.2 +170）

**实际验收**：
- ✅ 真实行情写入 SQLite（`quote_snapshot` / `daily_bars` 双 repo）
- ✅ Eastmoney 失败自动切 Tencent；都失败走 mock + 30 分钟抑制窗口
- ✅ LLMManager：mock / openai-compatible / anthropic 三 provider 路由；
  缺 key 自动降级 mock；schema parse 失败重试 + 规则 fallback
- ✅ TUI / Web 5 秒自动刷新（不卡顿，setInterval + onDestroy clear）
- ✅ 缓存命中率日志可见（`QuoteCache.stats()` + `DailyBarCache.stats()`）
- ✅ 13 个 tool 全部加载 + 2 个 workflow（sync-quotes / daily-advice）端到端跑通

详细验证脚本与日志见各 commit message。

## v0.3 — Tactic + Workflow + 复盘 ✅（已完成）

**目标**：战法引擎 + 完整工作流 + advice 复盘闭环。

**实际产物（W3.A → W3.H，commit 见 git log）**：
- core 增量：`Tactic` / `TacticSignal` / `Notification` 实体 + 不变量；
  `Advice.outcome` 可选字段（advice 持久化时 join outcome）。
- db 增量：`tactic` / `tactic_signal` / `notification` 表 + 三类 repo
  （drizzle + in-memory 双实现），advice repo 在 findById / query 时合并 outcome。
- core 增量：战法 DSL 引擎（`packages/core/src/tactic/`）—— `${...}` 取值 +
  布尔 / 比较 / `Math.*` 表达式 + evidence template 渲染。
- 内置战法 5 个：放量突破 / 均线多头 / 涨停回踩 / 量价背离 / 板块共振。
- adapters 增量：飞书 Webhook adapter（`send_text` / `send_card`）+
  NotificationManager（dry-run 默认 + 失败重试 + 渠道 fallback）。
- tools 增量 9 个：`list_tactics`, `get_tactic`, `run_tactic`, `score_signals`,
  `tactic_signals_by_stock`, `tactic_signals_by_tactic`, `market_outlook`,
  `record_advice_outcome`, `send_notification`。
- workflows 增量：`tacticScanWorkflow` / `riskReportWorkflow` / `dailyReviewWorkflow`。
- cli 增量：`advice outcome <id> --followed true|false --pnl N --notes "..."`
  + workflow 子命令（sync-quotes / daily-advice / tactic-scan / risk-report / daily-review）。
- tui 增量：[t] 战法扫描弹层（list_tactics → run_tactic × N → score_signals 精排 top 10）+
  [o] outcome 复盘弹层（近 20 条 advice + outcome 状态 + 回填指引）。
- web 增量：hash 路由 `#dashboard` / `#tactics` / `#review` + 新 API
  `/api/tactics` / `/api/tactics/scan?topN=N` / `/api/review` /
  `/api/review/:id/outcome`（write opt-in via `LUOOME_EXPOSE_WRITE=true`）。
- 测试：418 pass（v0.2 +0 / v0.3 contract-tests +19 + web / tui 增量维护现有用例）。

**实际验收**：
- ✅ 5 个内置战法 + DSL 表达式求值单测覆盖。
- ✅ `bash bin/luoome workflow run tactic-scan` 在 mock 数据上确定性产出 ≥ 1 个 signal（v0.2 验收时记录；该 workflow 已在 strategy-watchlist 迁移中被 `run-strategies` 取代）。
- ✅ `bash bin/luoome workflow run risk-report` 输出 HHI / top1 / top3 / VaR + 大盘背景。
- ✅ `bash bin/luoome workflow run daily-review` 产出当日 advice 汇总 + 7 日 stats。
- ✅ `bash bin/luoome advice outcome <id> --pnl 500` 落库；后续 `advice stats` 命中率随之更新。
- ✅ 飞书 webhook adapter：env `LUOOME_FEISHU_WEBHOOK_URL` 缺失时降级 logger.info 不抛。
- ✅ TUI smoke：首屏 + [d] 详情 + [esc] + [s] 统计 + [t] 战法 + [o] 复盘 6 项全过。
- ✅ Web 三个新 API 在 `:5174` 端到端返回 ToolResult 形状。
- ✅ `get_advice_stats` 按 decision 拆分（buy / sell / hold / watch / avoid）已 assert。
- ✅ LUOOME_EXPOSE_TRADE=true 启动硬卡（v0.1 已卡，v0.3 加 web 测试守住）。
- ✅ typecheck / test / lint 全绿（lint 0 error，2 info 级别 import 排序建议）。

## v0.4 — Web ✅（已完成）

**目标**：浏览器入口。

**技术栈定调**：保留 vanilla JS + Hono + Bun（无构建步骤），通过 ES modules 拆模块。引入 Solid/Tailwind 会显著增加构建复杂度，与现有架构风格不符；选择 CSS 设计 tokens + 组件类 + 响应式断点达成同等目标。

**实际产物（W4.A → W4.F，commit 见 git log）**：
- 设计系统（apps/web/public/style.css，934 行）：
  - 设计 tokens：颜色（基础 / 文字 / 边框 / 品牌 / 涨跌 / 决策 / 语义）+ 间距（4 倍数）+ 字号 + 字重 + 行高 + 圆角 + 阴影 + 动效。
  - 组件库：`.btn`（4 variant + 3 size）、`.card`、`.table`、`.badge`（5 决策色 + 涨跌）、`.confidence-bar`（3 level）、`.stat-grid`、`.advice-card`（含 expand toggle）、`.field`。
  - 布局：sidebar + content 网格 + 响应式断点（≤900px 侧栏收窄、≤600px 顶部 nav）。
- 模块化前端（apps/web/public/js/）：
  - `api.js`：fetch 包装 + localStorage token 管理。
  - `ui.js`：DOM 助手（$/el/mount）+ 共享组件（decisionBadge / confidenceBar / adviceCard / statBlock）+ 格式化。
  - `pages.js`：7 个页面的渲染函数。
  - `app.js`：入口 + hash 路由 + 时钟 + 仪表盘 5s 自动刷新。
- 路由 7 个：`#dashboard` / `#holdings` / `#quotes` / `#tactics` / `#advice` / `#review` / `#settings`。
- 后端 API 增量：
  - `/api/tactics` / `/api/tactics/scan?topN=N` / `/api/review` 已存在（v0.3）。
  - 新增 `/api/review/trend?days=N`：按天聚合命中率（confidence≥70 且 followed 且 pnl>0）。
  - write 副作用：`/api/review/:id/outcome`（opt-in via `LUOOME_EXPOSE_WRITE=true`）。
- Web mutation：同源 Origin 校验，写操作通过 `LUOOME_EXPOSE_WRITE=true` 显式开启。
- advice 可视化：决策卡（点击展开）+ 信心度条（low/mid/high 三色）+ 支持证据 / 反证 / 风险提示 / 免责声明分层渲染。
- 复盘趋势图：原生 SVG 折线（自动宽，x 轴日期标签 + y 轴百分比），样本不足时 fallback 到 byDecision 柱状概念。

**实际验收**：
- ✅ 7 个路由 (`/` `/holdings` `/quotes` `/tactics` `/advice` `/review` `/settings`) 全部 HTTP 200。
- ✅ 4 个 JS module (`/js/{app,api,ui,pages}.js`) 全部 HTTP 200，ES module import 链路完整。
- ✅ 浏览器访问 `localhost:5174` 看到持仓仪表盘 + 今日建议 + 7 个侧栏 nav + 免责声明横幅。
- ✅ 实时刷新：仪表盘 5s 自动 refresh；其他路由按需刷新。
- ✅ 点击建议卡片：展开 toggle 显示 evidence / counterEvidence / risks / disclaimers。
- ✅ 复盘页面：stat-grid + SVG 折线趋势图（W4.E 完成）+ outcome 回填表单（write opt-in）。
- ✅ 响应式：≤900px 侧栏窄化（仅图标），≤600px 顶部 nav 横排 + 内容区单列。
- ✅ Web mutation：服务端 `LUOOME_EXPOSE_WRITE=true` 才挂载 write endpoint，并执行同源 Origin 校验。
- ✅ typecheck / test / lint 全绿（418 tests / 0 lint error）。

## v0.5 — Multi-Market & Polish（部分完成）

**目标**：A 股真实数据 + 真实 LLM + 录入闭环 + 体验打磨。

**实际产物（截至 HEAD `1e9ea63`，commit 见 git log）**：

- ✅ **真实行情接线（历史快照）**（commit `097f3a0`）：四个 surface（CLI / MCP / TUI / Web）统一经 `createMarketAdapterFromEnv` 装配；当时的 `LUOOME_MARKET_PROVIDER=real` 口径为 Eastmoney 主 → Tencent 备 → Mock 兜底。当前生产路径不提供 mock fallback，真实源失败按可审计错误返回；测试 fixture 与生产数据隔离。实测 `fetch_quote(source=eastmoney)` + `compute_indicators` 触发 Tencent fallback 81 根真实日线。
- ✅ **真实 LLM 接线**：四端统一走 AI SDK Provider Registry 和模型 profile；缺目录、未知 provider 或缺密钥启动期报错；schema parse 失败重试 + 规则 fallback 由 Manager 承担。
- ✅ **持仓 / 交易录入**（commit `cbdfee7`）：Tool 数 22→26，write 1→5。
  - `add_trade`：录 Trade（source=manual） + 联动 Holding（新开 / 加仓加权均价 / 减仓 / 卖光自动 closedAt / 清仓重开复用旧 id）。
  - `add_holding`：无成交明细直录；同 (accountId, stockId) 防重 → invalid_input。
  - `update_holding`：quantity / availableQuantity / avgCost 纠错（至少一项，合并校验）。
  - `close_holding`：软平仓；重复平仓 → invalid_input。
  - stock 行缺失自动补 stub（analyze_position 依赖 stock 存在）。
- ✅ **成交量量纲统一**（commit `d089401`）：K 线 volume 一律 ×100 成股，与 `Quote.volume` 一致（`volMa5` / `volRatio5_20` 跨源可比）；`quote.ts` 注释钉死单位。
- ✅ **buildMockContext 时间炸弹修复**（`097f3a0`）：业务时钟 `max(锚点, 真实时间)` / 行情时钟钉住锚点；`analyze_*` 新鲜 advice 不再被 repo `Date.now()` 过期过滤立刻隐藏。
- ✅ **多账户切换 UI（侧栏账户选择器）**（commit `eb3675c`，v0.5.W3）：3 个 mock 账户（默认 / 长期持仓 / 短线交易）；5 个 seed site 切到 MOCK_ACCOUNTS；TUI [a] 弹层（j/k + Enter）+ accountBar 顶栏；Web 顶栏 `<select>` + POST `/api/account/select`（mutate ctxRef）+ localStorage 持久化。Tool 数 26 不变。
- ✅ **advice confidence 自校准**（commit `1e9ea63`，v0.5.W4）：新 tool `get_confidence_calibration`（10 桶 0-9 / 10-19 / ... / 90-100 聚合 hitRate / avgPnl / avgConfidence）；TUI [c] 弹层 + Web /review 页加校准表；Tool 数 26 → 27。
- ✅ **用户手册 + Homebrew formula**（commit 待落地，v0.5.W5）：新增 docs/USER_GUIDE.md（12 节：安装 / 首次启动 / CLI / TUI / Web / MCP / 多账户 / 复盘与校准 / 数据位置 / 环境变量 / FAQ / 更多阅读）和 homebrew/luoome.rb（HEAD-only formula：依赖 Bun，运行 bin/luoome shim 转 luoome mcp/tui/web/cli 入口；test 块校验 --version + tools list 含 27 tool）；README 顶部加 v0.5.0 状态节 + 文档表更新。

**实际验收**：
- ✅ `LUOOME_MARKET_PROVIDER=real` 端到端：`fetch_quote 002594.SZ` → eastmoney 93.92 元；`batch_quote` 三股并发 OK；`compute_indicators` Eastmoney 日线失败自动切 Tencent（41 根日线）+ 13 个技术指标全产出。
- ✅ `LUOOME_EXPOSE_WRITE=true` 端到端：4 个 write tool 实测闭环（加仓加权 / 超卖保护 / close / 重开复用 id / 重复 close 拒绝）。
- ✅ 默认 mock 模式零回归：所有现有测试 + TUI smoke 仍全过。
- ⏳ A 股 + 港股 + 美股统一数据模型：仅 A 股真实数据；港股走 Eastmoney（已覆盖，但 stock_id 后缀 `HK`）；美股尚未接入（Yahoo / Alpha Vantage 留 v0.5.W2）。
- ✅ confidence 校准接口本身提供「按桶聚合 → 系统 confidence 校准趋势」的可视化（替代原有抽象的相关性 > 0.3 验收口径）。
- ✅ 用户手册 + Homebrew formula：docs/USER_GUIDE.md + homebrew/luoome.rb —— 贡献者与用户入门文档补齐
- ✅ W3 + W4 + W5 落地后 TUI smoke 7/7、vitest 460/460、test:all 107/107 全绿。

**8 个 commit 增量（含 W5）**

| sha | 类型 | 主题 | 测试 +N |
|---|---|---|---|
| `097f3a0` | feat(market) | A 股真实行情接线 + Eastmoney/Tencent 实测修复 | — |
| `d5f5917` | feat(llm) | 真实 LLM 接线（四端 LLMManager，默认 mock 零回归） | vitest +38 |
| `cbdfee7` | feat(tools) | 持仓/交易录入 4 个 write tool | 22 个新测试 |
| `d089401` | fix(market) | K 线成交量量纲统一为股（×100） | 测试断言同步 |
| `8dbb03f` | docs | 同步 LLM 接线 + 持仓交易录入 + 量纲统一 | — |
| `8f38246` | docs(roadmap) | v0.5 部分完成状态对齐 | — |
| `eb3675c` | **feat(v0.5 W3)** | 多账户切换 — 3 mock 账户 + TUI 弹层 + Web 顶栏下拉 | 测试更新 1 |
| `1e9ea63` | **feat(v0.5 W4)** | confidence 自校准 — get_confidence_calibration tool + TUI/Web 可视化 | vitest +4 |
| `<W5>` | **docs(v0.5 W5)** | 用户手册 docs/USER_GUIDE.md + homebrew/luoome.rb + README 状态节 | — |

## v0.6 — 盘中盯盘 ✅（已完成）

**目标**：交易时段自动盯盘——持仓买卖点 + 候选池买点提醒，纯规则零 LLM。

**历史实际产物**（现已由 [Strategy 与统一 Watchlist 详细设计](./ddd/strategy-watchlist-unification-detailed-design.md) 替代；squash 合入 main，PR #1）：
- core 增量：`StockPool` / `WatchTrigger` 实体（PoolSource：holdings / manual / tactic；WatchRule：price-change / cost-threshold / tactic）
- db 增量：`stock_pools` / `watch_triggers` 双表 + repo（drizzle + memory 双实现 + 合约测试）
- tools 增量 5 个（27 → 32）：`list_stock_pools`（read）+ `create_stock_pool` / `update_stock_pool` / `delete_stock_pool` / `save_watch_trigger`（write）
- workflows 增量：`intraday-watch` 9 步编排（load pools → seed tactics → resolve members → batch_quote → loadPrevCloses → evaluate → cooldown + persist → notify + summary）
- cli 增量：`luoome watch`（`--once` / `--interval` / `--pool` / `--no-notify`；A 股时段 9:30–11:30 / 13:00–15:00，SIGINT 优雅退出）

**v0.6.1 — 真实昨收**：price-change 规则 `prevClose` 从 `quote.open` 占位切到 `dailyBar.latestBefore(stockId, now, 1)` 拉到的真实昨收；缺失 / close ≤ 0 / repo throw 自动 fallback 回 `quote.open`。

**v0.6.2 — 行情容错深覆盖**：`MarketDataManager` 单测 +7（batchQuote 部分失败仅 fallback 失败部分 / fetchDailyBars 三层 fallback / 自定义 `finalFallbackSuppressMs` 窗口）。无新功能。

## v0.7 — 节假日历 ✅（已完成）

**实际产物**：
- 内置 2026 全年 A 股休市日（29 天）+ 2027 best-effort placeholder（22 天，按近 5 年规律推断，每年 12 月国办通知发布后手工同步）
- 三层优先级 union 合并：`LUOOME_A_SHARE_HOLIDAYS` env > `$LUOOME_HOME/holidays.json` 文件（路径可用 `LUOOME_HOLIDAYS_FILE` 覆盖）> 内置；文件损坏静默 fallback 到内置，不监听 mtime
- ✅ 连板天梯生产装配复用同一份 core 节假日历；休市日直接返回空事实，不访问真实上游
- `packages/cli/src/paths.ts` 抽出 `luoomeHome()` 共享小工具

**验收**：
- ✅ `luoome watch` 节假日 / 周末 / 盘外不空转（nextRunDelay 60s 重试，交易时段内按 interval 轮询）
- ✅ 测试 605 pass（vitest 478 + bun test db 127）；typecheck / lint 全绿


## v0.8 ✅（已完成）

- ✅ 设置页支持 JSON 数据包导出/导入；可全选或按账户持仓、策略、关注分组、建议报告、行情、研究、对话分类导出，导入按主键原子合并，不包含 API Key / Webhook。
- ✅ 新增 `add_watchlist_members` write tool：最多 100 个成员整批校验、原子写入，并支持用规范 stockId 或唯一股票代码解析。
- ✅ AI 对话添加一个或多个成员统一生成一张批量草案，只确认一次；失败会显示具体 tool 错误且不会部分写入。
- ✅ SQLite 文件连接启用 WAL、`busy_timeout=5000` 与 `synchronous=NORMAL`，消除聊天、确认面板和调度器短事务并发时的即时 `database is locked`。
- ✅ 正式 Strategy 运行先持久化 `status=running`，执行记录立即可见；完成或异常时原子更新为 `complete` / `failed` 并提交结果事实。

## v0.9 — Strategy 生产可靠性与历史评估 🚧（进行中）

**目标**：把“Strategy 功能可运行”提升为“每天可持续运行、结果可验收、失败可恢复、历史评估不污染生产视图”。

**已落地基础**：

- StrategyRun Summary V4、acceptance、`operational/evaluation` scope 与
  `published/withheld/non-publishing` publication；
- current/Diff/AlertPlan/推荐/生产洞察只消费 published operational run；
- StrategyRun 与 StrategySchedule 的 heartbeat、fencing token 和所有权提交；
- `strategy-daily-cycle`：数据准备 → run → 观察补全 → insight → 可选推荐/通知；
- crossing 语义、AST 三值短路、RuleEvaluation V2、edge/cooldown 与 exit/risk signal；
- StockUniverse PIT snapshot、DailyBar revision、StrategyDataCheckpoint；
- evaluation session/day、range replay、断点续跑与 production/evaluation 查询隔离；
- benchmark/excess return、MFE/MAE、分位数和行业/score/edge 分组描述统计。
- 观察统计已统一按 `stock-day-horizon` 去重：同一股票、交易日、观察周期只保留一个可追溯代表样本，
  Tool/Web/AI facts 同步展示完整样本、唯一股票、缺失率、分位数、超额、MFE/MAE、benchmark 与观察截止日。
- Strategy → Watchlist 首个竖向切片已完成：用户显式创建持久订阅后，只有 published operational run
  才能投影；complete/partial/failed、可信空结果、来源隔离和同一 producerRun 幂等语义已接入
  SQLite/in-memory、Tool、workflow、Web/API/UI 与测试。

**当前交付切片**（2026-08-14）：

1. **S0 当前改动收口 ✅**：publication/`dataAsOf` 安全修复、策略模板升级、replay 汇总与
   Web 历史评估入口已完成；
2. **S1 可靠性测试与可观测 🚧**：daily cycle 已写入阶段耗时、运行摘要、lease 续期、checkpoint、
   观察补全和 provider 状态，独立故障矩阵及可靠性汇总 Tool/API 已落地；生产日周期会先同步并
   持久化真实 StockUniverse PIT snapshot，目录同步失败时不使用旧快照继续发布；5,207 只真实全市场
   数据准备已重复验证并写入成员 latency P50/P95/max，首个 schedule 已写入 phase timing；
   已补上 workflow 进程中断后的 stale running 审计收敛、生产日循环显式同步并审计
   `000300.SH:qfq:daily:v1` benchmark，以及 50 张表的 Drizzle/SQLite
   schema drift 契约（逐表列与显式索引）；剩余跨交易日 P50/P95/max 样本；
   非只读 Tool 的 JSONL audit log 已接入 CLI/MCP/TUI/Web 四个生产入口，文件权限、元数据审计和 Advice
   prompt-injection 清理均有测试；Tool 的 input issues、InvariantError、handler 和 output schema
   错误出口统一脱敏；release checklist 已完成逐项复核，但不改变 S3 生产观测要求。
3. **S2 历史评估作业化 ✅（真实区间边界已验收）**：Web 使用后台 evaluation session，提供日期级
   进度、失败重试、续跑、取消和已完成日期保留；真实 500 只股票 × 3 个交易日浏览器任务完成
   2/3 天，缺 PIT 日期诚实显示 `not_found`，不回退当前快照或 mock；同一真实 SQLite 的 5,207 只全市场
   回放已完成 2026-08-13～14 两日（累计 evaluated=10,414、selected=10,410、failed=0）；两日全市场
   回放的 vintage 均为 `unavailable`（`available` 仅出现在既有 1 只/500 只子集证据），均未被误报成收益回测；
4. **R7 统计切片 ✅**：benchmark/excess return、分组统计和 `stock-day-horizon` 去重已完成，代表性
   `SignalObservation` id 可追溯；生产日循环与补观察 workflow 显式同步并审计
   `000300.SH:qfq:daily:v1`；缺失 benchmark 不回填为 0，Web 与 facts-only 均保留样本口径和限制。
   Strategy DSL 已增加 `meta.limitUpLevel` / `meta.limitUpToday`，scan/scheduled 读取真实天梯 manager
   并写入按交易日的 PIT 快照；replay 优先读取历史快照，无快照时保留 unknown，不读取当前快照。
   同一真实 SQLite 已完成 scan→replay 验证：Eastmoney 快照覆盖 5,207 个候选，真实 4 板股票在
   replay 中返回 `historical:limit-up-ladder`、`succeeded=1`、规则命中且 selected=1。
5. **S3 生产观测 ⏳**：按真实开市日持续记录 schedule、lease、checkpoint、publication、观察补全、
   AI 降级和通知事实；不设固定交易日数量的完成门禁。

**未关闭项分类（2026-08-14）**：

- **真实运行观测**：S3 当前已有 2 个正式真实交易日，后续继续积累真实运行样本；样本数量不再作为固定完成门禁。
- **真实数据门禁**：v0.10 更长历史、持续快照审计和缺失日期重放必须等待对应 PIT universe 在真实交易日沉淀。
- **独立产品/数据决策**：天梯 Strategy DSL 的当前/正式日与 PIT replay 已冻结并实现；跨交易日快照仍需
  持续积累，炸板/断板历史仍需可审计数据源；两项都不允许用当前快照、情绪接口或 mock 推断。
- **安全立项**：Web 账户级鉴权尚未定义，当前 `X-Luoome-Account-Id` 只解决 request-scoped 串账户，不能作为认证。

**下一步开发顺序（2026-08-14 决策）**：

1. **P0 真实数据验收（基础 smoke 已完成）**：真实 Tencent 指数 `day` 口径已接入；31 个交易日
   benchmark、账户现金流与交易事实的 SQLite 文件库，以及双账户/拆股语义 smoke 已通过。随后用
   真实陈旧/停牌证券 `600984.SH` 验收：2026-08-11～13 的估值日为 `partial`，明确记录缺失股票，
   `holdingsValue`、`totalValue` 和当日收益字段保持 unavailable，不以 0 代替；保存 provider、
   `dataAsOf`、输入指纹和失败原因。
2. **P0 性能证据（重复运行已完成，跨日门禁进行中）**：新增无鉴权 Sina 目录与 qfq 日线能力，并在独立文件
   SQLite 上完成真实沪深 A 股 5,207 只目录同步和 5,207/5,207 日线同步；数据准备请求
   5,207 只，5,205 可用、2 只因真实陈旧/停牌语义保留缺口（失败 0、无 mock/fallback），
   总耗时约 8 分 41 秒；同一 checkpoint 的纯策略求值 5,205 只约 2.27 秒。首轮覆盖率与
   provider 分布已留存；第二次准备成员延迟 P50=1,880.23ms、P95=2,222.19ms、max=4,842.13ms，
   首个显式 schedule 的 data-prep/run 为 521.089s/1.695s；第二个真实交易日周期 data-prep/run
   为 521.103s/3.059s，两个正式周期均 leaseRenewals=2、leaseLost=0、coverage=99.94%；daily cycle
   启动前会收敛超过租约窗口的 stale WorkflowRun；daily cycle 在正式数据准备前阻止同一
   schedule/交易日的重复正式 cycle，skipped claim 只保留审计、不计入正式周期统计。
   仍需跨更多交易日采集正式 P50/P95/max 阶段样本后关闭性能门禁。
3. **P1 S3 生产观测**：首个显式 schedule 已完成真实运行审计（checkpoint 覆盖 99.94%、lease 续期
   2 次、publication=published、观察无 pending）；AI 未配置时外层调度保持 `partial`，不误报
   `failed`；当前真实汇总包含 2026-08-13/14 两个正式周期（均 partial、failed=0、leaseLost=0），以及
   一次 2026-08-11 因缺少 PIT universe 的显式历史尝试（`historicalRunCount=1`，保留真实审计但不算
   生产成功周期，也不污染 `cycle-failed` 门禁）。
   按真实开市日继续记录；每周调用 `get_strategy_reliability_summary` 复核运行质量与性能趋势，期间不
   扩大自动推荐或通知默认范围。
4. **P1 v0.10 产品验收**：基础 31 个交易日浏览器绩效页 smoke、真实 2 日 × 500 只后台历史评估
   job、真实 3 日 × 500 只部分完成任务、周报浏览器回归、周报账户区间估值/TWR/回撤和收盘分组
   变化真实工具链已完成；另已完成 5,207 只全市场两日真实回放预算验收；仍需更长历史任务与快照审计、
   多账户隔离的持续证据后，才将 v0.10 标记完成。

真实历史区间边界已验证：对 2026-07-01～2026-08-11 的 30 个交易日、真实 SQLite 中 500 只股票
执行 replay 时，因缺少对应日期的 PIT universe，30 天均诚实返回 `not_found`；系统没有用当前快照
或 mock 数据掩盖缺口。下一步在真实日运行期间逐日沉淀 PIT snapshot，再重跑该区间。
已有真实 PIT 的区间已扩大验收：2026-08-13～14、500 只真实股票 2/2 天完成，累计 evaluated=1,000、
failed=0，且 vintage 状态按日期保留；该证据不替代持续的真实数据与 PIT 观测。
全市场预算也已完成两日真实验收：2026-08-13～14 共 10,414 只日期-股票求值，selected=10,410、
failed=0；8/13 的 PIT snapshot 为盘中固化版本且 vintage=unavailable。此前 8/13 失败的回放审计仍保留，
但修复后的 session 已完整结束；不使用当前快照或 mock。更长历史和持续真实运行观测仍在继续。

本轮真实 provider Web smoke 也已复核：独立临时 SQLite 启动后，静态入口、空库账户查询和可靠性
汇总 API 均返回 200，空库没有注入账户、运行或 mock 数据；浏览器账户选择通过
`X-Luoome-Account-Id` 形成 request-scoped context，并发 tab 不再共享可变账户上下文。该机制
只解决上下文串扰，不替代账户级鉴权，后者仍需独立产品决策。

**执行决策（2026-08-14）**：当前冻结横向功能扩张，开发顺序固定为“真实运行证据 → v0.10 验收收口
→ 新需求立项”。S3 作为持续观测项推进，允许在观察期间修复可靠性缺陷、补测试/观测/文档和重跑
已有真实 PIT 数据；缺数据必须保留 `not_found` / `partial` / `failed`，不得使用 mock 或当前快照补齐。
R5 早期突破 v2、完整迁移生成、Web 账户级鉴权分别等待用户确认或产品决策，不与当前门禁并行扩大。

本轮底座收口：全市场行情新增 `MarketSnapshot` 完整性信封（source、coverage、fetchedAt、分页
expected/received/missing/duplicate），A 股情绪宽度只消费完整真实信封；Eastmoney 当前不可达时
优先走真实 Tencent 批量快照 fallback，全部真实源不可用时才保持 unavailable，不使用静态或 mock 数据。

账户绩效补充审计入口：`list_account_performance_snapshots` 与 Web 快照摘要端点已落地，查询已持久化
输入指纹、`dataAsOf`、完整度和 benchmark 状态，不触发重新抓行情；独立真实 Sina 3 日空库 smoke
已返回 1 条 `complete`/`available` 快照；区间审计 Tool/Web 端点对同一真实 2026-08-11～13
装配返回 `expectedTradingDays=3`、`observedTradingDays=3`、`completeDayCount=3`、
`missingDates=[]`、`gaps=[]`。该能力按交易日列出缺失日期和 partial 原因，但连续真实生产快照
仍按 v0.10 观察期验收。

补充真实 provider 证据：2026-08-13 Eastmoney 涨停池接口真实返回 59 条原始记录，默认过滤后
`limit_up_ladder` 返回 57 条、最高 5 板，manager 链路成功；全市场 clist 是独立端点，当前仍因
`ECONNRESET` 不可用，已由 Tencent 批量实时接口接管：Sina 当前目录 5,207 只分 11 批请求，
真实返回 5,207/5,207、missing=0、envelope=`complete`；不能用涨停池结果替代宽度快照，但宽度已有
可审计的真实 fallback。通过 `get_ashare_sentiment` 复核时 breadth=`complete`，
advancing/declining/unchanged=1,083/4,041/83，total=5,207，warnings 为空。
同一事实已从用户入口复现：空临时 `LUOOME_HOME` 下运行 CLI `market limit-up --date 2026-08-13 --json`
返回 `source=eastmoney`、`total=57`、`maxLevel=5`、`levels=5`；未配置 AI 只输出 warning，未写入样例账户或 mock 行情。

**验收**：

- 每个到期 schedule 每周期至多一个正式运行；三小时运行持续续租且只能提交一次；
- 可靠性汇总对同一 schedule/交易日重复正式运行返回 `schedule-day-duplicate` 阻塞；
- 可靠性汇总返回逐 schedule 的 `scheduleTradingDayKeys`，多 schedule 不拼接交易日；任一 schedule
  未达目标时返回 `schedule-days-below-target` 阻塞；
- 正式周期缺 publication、checkpoint 或观察审计事实时，可靠性汇总必须阻塞，不能以缺省值误报 ready；
- 可靠性汇总按真实 WorkflowRun 阶段审计输出 `phaseDurations`（P50/P95/max），用于性能预算验收；
- 低覆盖 manual/scheduled run 均 withheld，evaluation 永不改变 current、AlertPlan、Advice 或生产通知；
- T+1 到期观察最迟在下一次成功日周期中补齐；AI 结构或引用无效时返回 facts-only；
- R7 聚合按 `stock-day-horizon` 去重，代表 `SignalObservation` id 可回溯，Tool/Web/AI facts 的样本数、
  完整率、缺失率、分位数、超额、MFE/MAE、benchmark 状态和观察截止日口径一致；缺失 benchmark 不回填 0；
- 重复真实 5,207 股票证据已满足单次数据准备 < 30 分钟、纯求值 < 15 分钟，并保存覆盖、
  provider 失败分布和成员 latency P50/P95/max；仍需跨交易日形成 WorkflowRun 阶段 P50/P95/max
  样本后，才能关闭 5,207 股票性能门禁；
- 2026-07-01～2026-08-11 可按 PIT universe 重放、断点续跑和幂等审计；
- Web、CLI、MCP 继续复用 Tool/Workflow 契约，全量测试、typecheck、lint、build 和浏览器验收通过。

v0.9 的历史区间能力固定称为“历史评估/历史回放”。它不包含组合净值、费用、滑点、停牌/涨跌停
可交易性或收益承诺，不是严格收益回测。

## v0.10 — 账户绩效与组合归因 🚧（持续快照代码链已完成，生产证据积累中）

**目标**：补齐 Advice、Trade、Holding 和 Outcome 之后的账户级真实复盘，回答“账户实际表现如何、
收益来自哪里、哪些结论因数据缺失不可用”。

**计划范围**：

- 冻结入金、出金、分红、拆股、费用、转入转出和公司行动口径；
- 建立按账户隔离的每日估值事实与 completeness，缺失价格不得填 0；
- 计算 TWR、最大回撤、benchmark、已实现/未实现 PnL 和持仓贡献归因；
- 接入账户复盘页、周报和 Agent 只读事实；
- 用入金、出金、分红、停牌、缺价和多账户 fixture 验证确定性与隔离性。

**已实现切片（截至 2026-08-20）**：

- core 已冻结现金流、公司行动、估值日、完整度、贡献归因和 benchmark 输出 schema；
- Drizzle / in-memory 双仓储与合约测试已接入，现金流和公司行动均按账户隔离；
- `create_portfolio_cash_flow`、`create_portfolio_corporate_action` 和
  `get_account_performance` 已注册为统一 Tool；估值使用真实交易、直接录入持仓和日线，不以 0
  填补缺价；
- Web `/api/account/performance`、`/api/accounts/:id/performance` 和复盘页估值表已接入；报告的
  账户区块与 Agent 查询白名单复用同一 Tool 口径；
- TWR 排除外部现金流，支持拆股/送转、分红、费用、已实现/未实现 PnL、最大回撤、benchmark
  与超额收益，并对缺价保持 `partial/unavailable`。
- `portfolio_performance_snapshots` 按账户、区间和输入事实指纹幂等保存结果、`dataAsOf` 与计算时间；生产默认 benchmark 为沪深300（`000300.SH`），可用环境变量覆盖。
- `snapshot-account-performance` workflow 通过 `ctx.tools.*` 为全部或显式账户生成滚动历史快照；账户级
  完成即持久化，中断重跑复用同指纹结果，输入事实变化产生新版本且旧版本可追溯。WorkflowRun 保存
  新建/复用、完整/部分/失败、价格序列、日线量和耗时预算，不记录私人账本明细。
- 账户价格序列以最多 8 路并发读取；默认 365 日，可显式扩大到 3,660 日，单次最多 1,000 账户。
  Web 长期进程在 A 股交易日 16:00 后触发盘后快照；同进程防重，重启重复触发由指纹幂等收敛。
- 区间审计按最新快照修订选择逐日事实并返回 `revisionCount`，不会用旧 complete 遮蔽新 partial；Web
  复盘页展示快照版本、输入指纹、`dataAsOf`、预算事实和逐交易日缺口。当前账户与显式账户均有只读端点。
- 收盘复盘的 `group-changes` 已通过 `list_watchlists` + `list_watchlist_changes` 生成当日 entered/
  exited/unchanged 汇总；无同步记录或上游失败时标记缺失，不把空数据伪造成完整变化。
**依赖与边界**：

- Strategy v0.9 进入连续生产验证后可先冻结 PRD/DDD；生产实现需通过 v0.9 可靠性门禁；
- 不复制 Account/Holding/Trade 事实，不把估值结果自动翻译为调仓 Advice；
- 不在本版本引入自动交易、云账户或机构级组合优化。

**剩余交付**：

- ✅ 真实 SQLite + 行情源已验收公司行动导入、缺价与多账户隔离基础语义；✅ 真实
  `600984.SH` 缺价日生产 smoke 明确不填 0；
- ✅ 31 个交易日真实 SQLite 绩效页浏览器 smoke，快照审计信息与 `dataAsOf` 可见；✅ 快照审计按账户+区间
  重叠查询，不被最新非重叠快照遮蔽；✅ 真实 Sina
  3 日区间审计返回 3/3 complete、无 missing/gaps；✅ 真实 2 日 ×
  500 只完整及 3 日 × 500 只部分完成后台历史评估浏览器 smoke（逐日进度、完成结果、取消与
  `not_found` 语义）；✅ 周报账户区块已接入区间估值、TWR 与最大回撤并完成真实浏览器回归；✅ 收盘
  复盘分组变化接入真实 Watchlist 变化工具；✅ 持续快照 workflow/scheduler、断点幂等、修订追溯和 Web
  审计入口已完成；✅ 独立真实 Sina + SQLite 的 2025-08-21～2026-08-20 长区间首跑约 3.46 秒，
  242 条持仓 bars 与 242 条 benchmark bars 形成 partial 快照，同事实重跑复用旧快照；真实 Chrome
  可见 2 个版本、251 个日历预期交易日和 9 个未填 0 的 partial 缺口；⏳ 内置交易日历与真实休市日的
  权威校准、大账户生产规模及跨交易日连续调度证据继续积累；
- 持续验证默认 benchmark 数据覆盖，不把缺失 benchmark 显示为可用；
- 将绩效事实纳入周报展示和浏览器回归，完成产品验收后再标记 v0.10 完成。
**验收**：

- 外部现金流不会被错误计算为投资收益；同一账本可确定性重算；
- benchmark 或价格缺失保持 unavailable/partial，不回填 0 或伪造完整曲线；
- 多账户数据严格隔离，Web/Report/Agent 使用同一 Tool 口径；
- 每个指标可追溯到估值日、行情来源、现金流和交易事实。

## v0.11+ 候选方向（未立项）

- Agent 协作体验 Phase 0～2：统一场景、公开计划、工具轨迹、部分失败和闭环复盘草案；
- 基本面、资金流和 A 股短线事件 Evidence Adapter；
- 连板天梯历史数据源与体验增强。

以上方向必须先冻结 PRD/DDD、Tool/API schema、迁移和测试矩阵，不与 v0.9/v0.10 并行扩张生产能力。

## 不在路线图

下列明确**不做**：

- ❌ 真实券商自动下单（合规 + 资金风险）
- ❌ 云同步账户数据（local-first 默认）
- ❌ 多用户 / 团队功能（个人工具）
- ❌ 跨用户跟单、公开策略市场或平台级策略订阅（个人 advisor，不是平台）
- ❌ 移动原生 App（Web PWA 优先）
- ❌ 在费用、滑点、可交易性、公司行动和版本门禁缺失时输出严格回测收益、胜率或 Sharpe

## 评估指标

每个版本完成后自评：

- **完成度**：产物清单是否 100% 落地
- **验收**：所有验收项是否通过
- **测试覆盖率**：core / tools ≥ 80%
- **文档同步**：ARCHITECTURE / AGENTS 是否反映最新设计
- **agent 可用性**：通过 Claude Desktop 跑通至少 3 个真实场景
- **advice 质量**（v0.3 起）：自测 50 条 advice，人工评估与实际 5 日走势一致率 ≥ 60%
- **Strategy 可靠性**（v0.9 起）：重复正式运行、越权提交、低覆盖误发布和 evaluation 污染均为 0
- **复盘完整度**（v0.10 起）：估值完整率、现金流分类完整率、benchmark 可用率和可追溯率

## 设计主线回顾

```txt
v0.1  骨架 + mock advice 模型              [罗: 假数据 / 织: 假建议]
v0.2  真实行情 + 真实 LLM advice           [罗: 真行情 / 织: 真建议]
v0.3  战法 + workflow + advice 复盘闭环    [罗: 多源 / 织: 可复盘]
v0.4  Web 入口                             [面: 三端]
v0.5  多市场 + 体验打磨                    [用: 日常]
v0.6  盘中盯盘（股票池 + watch 长驻）      [用: 盘中]
v0.7  节假日历                             [用: 盘中]
v0.8  数据迁移 + 批量确认 + 运行可见性      [稳: 日常闭环]
v0.9  Strategy 可靠性 + 历史评估作业化     [信: 可持续、可恢复]
v0.10 账户绩效 + 组合归因                   [复: 真实账户复盘]
```
