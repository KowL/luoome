# 每日个股观察（StockBrief）验收记录（2026-11-24）

> 状态：P0–P3 已实现；仓内自动化验收已通过，5180 临时实例的 Web 入口 / CLI / 工具列表留痕已补（见 §5）。真实批次耗时与日累计用量仍待运行观测
> 日期：2026-11-24
> 范围：每日个股观察批次、`stock_briefs`、Web / AI 对话 / CLI / MCP 只读入口、17:30 与 08:45 调度、预算降级、结算与成绩单
> 关联文档：[PRD](../prd/daily-stock-brief.md)、[详细设计](../ddd/daily-stock-brief-detailed-design.md)、[架构说明](../ARCHITECTURE.md)

## 1. 交付范围

已完成：

- P0：`stock_briefs` 实体 / 表 / 仓储、事实包与规则预筛、`generate_stock_briefs` 生成入口。
- P1：只读 `get_stock_brief` / `list_stock_briefs`、Web API、CLI `brief list/show/run`、MCP 只读基线、
  17:30 唯一生成入口与 `daily-advice(briefsOnly)`。
- P2：Web 6 入口展示、AI 对话先读 brief、展示词表与「仅技术研究」文案、预算与降级可见、
  每日个股观察成绩 section、Skill / MCP 暴露面。
- P3-1：盘前 08:45 调度，只出研究名单，0 次 LLM、不写 advices。
- P3-3：8 场景回归 fixture。
- P3-5：结算覆盖率、buy/sell 对账、规则观察单列、周报覆盖率与对账数字。
- P3-6：PRD / DDD / ARCHITECTURE / `docs/README.md` / `CONTEXT.md` 文档归位。

未做 / 待定：

- P3-2 盘中 `provisional`：按任务要求不做。
- Q1 后端 `daily-advice` 枚举改名（`no-action` / `has-signals`）：本期只改展示层，后端改名留待下一版。
- `generate_stock_briefs` 的 tool description 与相关 Skill 文本已改为同时覆盖盘前 / 盘后两种用法（Kow 2026-11-24 决定）。
- 真实批次 P95 / 日累计 HTTP·token·金额 / 17:45 覆盖率：仍待生产或完整运行观测，见 §4。
- 历史 fallback advices：不删不改（P1-9 结论）。
- `workflow_runs.input_summary` 被清空问题：本批未处理。

## 2. 本批（P3-5）自动化证据

| 验收点 | 证据 |
|---|---|
| 应结算建议日线齐全 → 覆盖率 1，每条写满 T+1/T+3/T+5 | `packages/tools/src/tools/advice-tracking.test.ts`「应结算建议日线齐全时覆盖率为 1，每条写满 T+1/T+3/T+5 三档」 |
| 缺日线 / 缺入场价 → 跳过、计数原因、不写假结算 | 同文件「缺少日线时跳过，不写假结算，并计入未覆盖原因」「缺入场价时计入 missingEntry，不写假结算」 |
| 规则观察单列且不进覆盖率分母 | 同文件「规则观察单列：不计入应结算覆盖率，但仍按原行为结算」 |
| 分页扫描不因单页上限漏结算 | 同文件「分页扫描不因单页上限漏掉更早的建议」 |
| 成绩单覆盖率 / buy-sell 对账 / 与 `advice.query` 三边相等 | `packages/tools/src/tools/advice-scorecard.test.ts`「覆盖率与对账：应结算 / 已结算 / 规则观察可与同窗口 advice.query 对上」 |
| 规则观察不进命中率分母 | 同文件「规则观察不进命中率分母，单独列出已结算条数」 |
| 周报覆盖率 / 应结算 / 已结算 / 规则观察单列 | `packages/workflows/src/weekly-report.test.ts`「规则观察不计入分母，单列条数，与成绩单口径一致」 |

本批相关测试：3 个文件、21 个用例全绿。

## 3. 全量命令结果（本批交付时运行）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 19 个 workspace 全部通过 |
| `bun run lint` | 963 个文件通过，无修复项 |
| `bun run test` | 279 个文件 / 2262 个用例通过 |
| `bun run test:db` | 10 个文件 / 264 个用例通过 |
| `bun run test:web` | 70 个文件 / 956 个用例通过 |
| `bun run test:dsh` | 7 个文件 / 50 个用例通过 |
| `bun run mcp:smoke` | 5 个 stdio 场景通过（本地 fixture，无网络/凭证） |
| `git diff --check` | 通过 |
| 文档相对链接检查 | `docs/**/*.md` 与 `CONTEXT.md` 相对链接均可解析 |

全量命令由执行者在合并前再跑一遍。

## 4. 设计 §13.2 验收指标逐项状态

`design.md` 为外部设计基线；下表按当前仓库可核验的状态记录，不把未测项标成通过。

| 指标 | 目标 | 状态 |
|---|---|---|
| 单票 P95 | ≤ 90 s（中位约 40–60 s） | **待执行者补真实运行观测**；自动化只断言单票最多 2 次尝试的上限，不测真实耗时 |
| 批次 P95 | ≤ 6 min，硬上限 8 min | **待执行者补真实运行观测**；`generate-stock-briefs.test.ts`「并发为 2」只断言并发上限，不等待真实批次 |
| 每日 HTTP 调用 | ≤ 16 / 账户 | **已有自动化**：预算硬限、HTTP 超限降级与 `workflow_runs.output_summary.llmHttpCalls` 断言；真实日累计由执行者运行观测 |
| 每日 token | ≤ 90 000；reasoning 单独可见 | **已有自动化**：token 硬限与 usage 分项落库断言；真实日累计待运行观测 |
| 每日金额 | ≤ $0.04 | **计量可见但无独立硬上限**：`llm_cost_usd` 随行保存并按日汇总，预算按 HTTP/token 双轨；金额目标待真实运行观测 |
| 覆盖率（17:45 前） | 持仓 100% 有 brief 行；confirmed/researching ≥95% | **持仓与候选覆盖已有自动化**（`generate_stock_briefs.test.ts`、`daily-stock-briefs.test.ts`、`stock-brief-query.test.ts`）；17:45 实际覆盖率待执行者运行观测 |
| 调用放大 | 每次 `analyze_stock` = 2 次 HTTP | **已有自动化**：「失败后修复重试：2 次真实 HTTP」；stub adapter 计数 |
| factDigest 去重 | 同日重复触发第二次起 0 次 LLM | **已有自动化**：「幂等：同日同 digest 再跑 0 次 LLM，不重复写 advices」 |
| 数值可追溯率 | 100% | **已有自动化**：事实包 / 回归 fixture 对事实外数字与 DSL 的拦截；真实批次逐条审计待运行观测 |
| 幻觉回归 | 低开 / 26 根 / 编造 DSL 三类全绿 | **已有自动化**：`packages/tools/src/tools/brief-regression.fixtures.test.ts` 三类 fixture 全绿 |
| 文案合规 | 展示层与 tool/MCP/CLI 描述 0 处出现禁用操作词 | **已有自动化**：`packages/tools/src/tools/advice-wording.test.ts`、`apps/web/public/js/advice-wording.test.js` |
| 降级可见率 | 100% | **已有自动化**：LLM 失败、行情不可用、插件禁用、预算耗尽、news / sector / account 缺失均断言可见原因 |
| 冷却误伤 | `PluginExecutionDenied` 不写 provider 冷却 | **不适用本批**：该修复在既有插件执行层，本批未改动；沿用既有测试 |
| 结算联通 | buy/sell advice 100% 进入 T+1/T+3/T+5；规则观察单列 | **已有自动化**：见 §2 的 settle / scorecard / weekly report 用例 |

## 5. 浏览器与入口留痕（2026-11-24 16:24–16:26 Asia/Shanghai）

执行者用 5180 临时实例实测。数据目录：`/workspace/luoome-notes/advice-p3-verify/b2/tmp-home`（独立 seed，未复制生产库）。端口 `127.0.0.1:5180`；未开 write/external、未配 LLM、未走真实行情 / Fuyao / Tushare。主树 5173（pid 273404）全程未动；自检后已关闭 5180。截图与 curl / CLI 原始结果在同目录 `screens/` 与 `api-*.json`。

| 入口 | 检查点 | 状态 |
|---|---|---|
| 个股详情 `#market?stockId=002594.SZ` | 今日观察卡（偏多信号、信心度 64、证据表、分时缺失原因、有效期、免责声明）；刷新能力因插件未启用显示「生成能力不可用」 | **已留痕**（`market-390.png` / `market-1280.png`）；`GET /api/stock-briefs?stockId=002594.SZ` 200 |
| 关注列表 `#watchlists` | 6 名成员行内 signal chip、信心度、缺失 chip、数据时间；平安无观察显示「暂无观察」 | **已留痕**（`watchlists-*.png`）；`GET /api/stock-briefs?watchlistId=wl-demo` 200 |
| 首页 `#dashboard` | 「今日个股观察」在工作台主视野：有结论 4、规则观察 1、未覆盖 0，缺失原因与预算可见；标注「只读，不触发生成」 | **已留痕**（`dashboard-*.png`）；`GET /api/stock-briefs/today` 返回 5 条 |
| 建议列表 `#advice` | 规则观察单独标「规则观察」且 premise 为规则兜底；成绩单近 30 天 T+5 覆盖率/命中率可见；未把规则观察写成 AI 结论 | **已留痕**（`advice-*.png`）；`GET /api/advice?includeExpired=true` 5 条，`/api/advice/scorecard` coverage=1 |
| 报告 `#reports?id=report-weekly-p3-7` | 「个股观察成绩」展示应结算 2 / 已结算 2 / 结算覆盖率 100% / 规则观察 1，并含免责声明 | **已留痕**（`reports-*.png`）；该报告为验收 seed，数字与 section 文案一致 |
| 作战室 `#market-room` | 页面可开、只读、免责声明可见；临时库无已发布盘中批次，板块/核心股信号徽标无法在此实例展示 | **页面已打开**（`market-room-*.png`）；徽标待有盘中批次的环境再观测 |

补充留痕：

- CLI：`luoome brief list --json` 返回当日 5 条（含免责声明与规则观察标签）；`luoome brief show --stock 002594.SZ --json` 与 Web 同形。`brief run` 未跑（会走生成入口，本实例未开 write/external）。
- 工具列表：`luoome tools list --json` 共 50 个工具，含 `get_stock_brief` / `list_stock_briefs` / `get_stock_facts`，**不含** `generate_stock_briefs`。
- 生成闸门：`POST /api/stock-briefs/generate` 返回 403（write 未开启）。
- AI 对话 `#chat`：页面已打开且页脚含「仅技术研究，不构成投资建议」；本实例未配置 LLM，**未实测**「先读 brief → 无观察再询问是否分析」的完整对话。
