# Roadmap

> luoome v0.1 → v0.5 演进路线。每版本都有**可见产物 + 验收标准**。
> 设计主线：**罗（采集） → 织（分析） → 建议 → 复盘**。

## v0.1 — Foundation（当前）

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
- core 增量：`Market` 枚举 + `IndicatorSet`（`KNOWN_INDICATOR_KEYS` 13 项）+ `LLMProviderConfig` + env 解析
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
- ✅ `bash bin/luoome workflow run tactic-scan` 在 mock 数据上确定性产出 ≥ 1 个 signal。
- ✅ `bash bin/luoome workflow run risk-report` 输出 HHI / top1 / top3 / VaR + 大盘背景。
- ✅ `bash bin/luoome workflow run daily-review` 产出当日 advice 汇总 + 7 日 stats。
- ✅ `bash bin/luoome advice outcome <id> --pnl 500` 落库；后续 `advice stats` 命中率随之更新。
- ✅ 飞书 webhook adapter：env `LUOOME_FEISHU_WEBHOOK_URL` 缺失时降级 logger.info 不抛。
- ✅ TUI smoke：首屏 + [d] 详情 + [esc] + [s] 统计 + [t] 战法 + [o] 复盘 6 项全过。
- ✅ Web 三个新 API 在 `:5174` 端到端返回 ToolResult 形状。
- ✅ `get_advice_stats` 按 decision 拆分（buy / sell / hold / watch / avoid）已 assert。
- ✅ LUOOME_EXPOSE_TRADE=true 启动硬卡（v0.1 已卡，v0.3 加 web 测试守住）。
- ✅ typecheck / test / lint 全绿（lint 0 error，2 info 级别 import 排序建议）。

## v0.4 — Web

**目标**：浏览器入口。

**产物**：
- apps/web：Hono + Solid + Tailwind（或 v0.4 前定）
- 路由：仪表盘 / 持仓 / 行情 / 战法 / 建议 / 复盘 / 设置
- 后端：Hono HTTP API 暴露 tool registry
- 前端：组件库 + 设计 tokens
- 响应式：手机 + 平板 + 桌面
- Web 鉴权：本地 token / session
- 建议可视化：决策卡片 + 信心度条 + 证据 / 反证 toggle + 风险列表

**验收**：
- ✅ 浏览器访问 `localhost:5173` 看到持仓仪表盘 + 今日建议
- ✅ 实时行情刷新
- ✅ 点击建议卡片可查看 reasoning + evidence 详情
- ✅ 复盘页面显示 hit rate 趋势图

## v0.5 — Multi-Market & Polish

**目标**：多市场接入 + 体验打磨。

**产物**：
- adapters/market：港股 / 美股 数据源
- 多市场统一抽象：`Stock` 加 `market` 字段
- 多账户：账户切换 UI
- 性能：批量查询 + 索引优化
- 文档：用户手册 + 视频脚本
- 发布：Homebrew formula + 一键安装脚本
- advice 模型优化：基于历史 outcome 自动校准 confidence

**验收**：
- ✅ A 股 + 港股 + 美股统一数据模型
- ✅ 真实用户每日使用零障碍
- ✅ advice 历史准确率与 confidence 相关性 > 0.3（说明置信度有意义）

## 不在路线图

下列明确**不做**：

- ❌ 真实券商自动下单（合规 + 资金风险）
- ❌ 云同步账户数据（local-first 默认）
- ❌ 多用户 / 团队功能（个人工具）
- ❌ 跟单 / 策略订阅（个人 advisor，不是平台）
- ❌ 移动原生 App（Web PWA 优先）

## 评估指标

每个版本完成后自评：

- **完成度**：产物清单是否 100% 落地
- **验收**：所有验收项是否通过
- **测试覆盖率**：core / tools ≥ 80%
- **文档同步**：ARCHITECTURE / AGENTS 是否反映最新设计
- **agent 可用性**：通过 Claude Desktop 跑通至少 3 个真实场景
- **advice 质量**（v0.3 起）：自测 50 条 advice，人工评估与实际 5 日走势一致率 ≥ 60%

## 设计主线回顾

```txt
v0.1  骨架 + mock advice 模型              [罗: 假数据 / 织: 假建议]
v0.2  真实行情 + 真实 LLM advice           [罗: 真行情 / 织: 真建议]
v0.3  战法 + workflow + advice 复盘闭环    [罗: 多源 / 织: 可复盘]
v0.4  Web 入口                             [面: 三端]
v0.5  多市场 + 体验打磨                    [用: 日常]
```
