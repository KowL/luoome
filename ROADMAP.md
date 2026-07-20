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
- 鉴权：本地 token 生成 / 清除（设置页 + localStorage），请求自动附 `Authorization: Bearer <token>` header（服务端校验留口）。
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
- ✅ 鉴权：设置页可生成 / 清除 token，token 附 Authorization header；服务端 `LUOOME_EXPOSE_WRITE=true` 才挂载 write endpoint。
- ✅ typecheck / test / lint 全绿（418 tests / 0 lint error）。

## v0.5 — Multi-Market & Polish

**目标**：多市场接入 + 体验打磨。

> 范围修正（2026-07-20）：多市场数据源（港/美）确认不做，A 股优先。
> 已完成：真实行情接线——四个 surface 统一经 `createMarketAdapterFromEnv` 装配，
> `LUOOME_MARKET_PROVIDER=real` 启用 Eastmoney 主 → Tencent 备 → Mock 兜底（默认 mock 零回归）。
> 已完成：真实 LLM 接线——四端 LLM 统一走 LLMManager（`LUOOME_LLM_PROVIDER` 路由，默认 mock）。
> 已完成：持仓/交易录入——`add_trade` / `add_holding` / `update_holding` / `close_holding` 4 个 write tool。
> 已完成：成交量量纲统一——K 线 volume 一律 ×100 成股（与 Quote.volume 一致）。

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
