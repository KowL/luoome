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

## v0.3 — Tactic + Workflow + 复盘

**目标**：战法引擎 + 完整工作流 + advice 复盘闭环。

**产物**：
- 战法 DSL：YAML schema 定义战法（rule + signal template）
- 内置战法 5 个：放量突破 / 均线多头 / 涨停回踩 / 量价背离 / 板块共振
- tactic-scoring service：LLM 精排信号
- 新 tool：`run_tactic`, `score_signals`, `list_tactics`, `get_tactic`, `record_advice_outcome`
- 新 advice tool：`market_outlook`（大盘 + 板块观点）
- workflow：`tactic-scan`, `risk-report`, `daily-review`
- 通知：飞书 Webhook adapter + `send_notification` tool
- advice 复盘：自动检测 advice 对应持仓已平仓，提示用户回填 outcome

**验收**：
- ✅ 跑战法能产出结构化信号 → 转 Advice
- ✅ daily-review workflow 端到端产出 Markdown 报告
- ✅ 高分建议推送飞书卡片
- ✅ advice outcome 累计后可统计 hit rate
- ✅ get_advice_stats 输出含 byDecision 拆分

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
