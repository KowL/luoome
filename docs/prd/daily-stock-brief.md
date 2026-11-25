# 每日个股观察（StockBrief）PRD

> 状态：P0–P3 已实现；盘中 `provisional`（P3-2）不做
> 日期：2026-11-24
> 范围：每交易日的个股观察批次、`stock_briefs`、Web / AI 对话 / CLI / MCP 读入口、调度、预算与降级
> 关联文档：[详细设计](../ddd/daily-stock-brief-detailed-design.md)、[架构说明](../ARCHITECTURE.md)、[领域语言](../../CONTEXT.md)

## 1. 一句话

把个股结论从「按需触发的一次 LLM 调用」升级为「每交易日一批、有事实包、有预算、可降级、可追溯的观察板」：
同一份 `stock_briefs` 同时服务 Web 的 6 个入口、AI 对话、CLI 与 MCP 只读工具，
但**生成只有一个入口**。

## 2. 目标

- **覆盖可见**：当日持仓、关注池成员和入选策略信号都有观察行；没有 AI 结论时也要留下
  `rule-only` / `unavailable` 行与缺失原因，不能静默漏掉。
- **单一生成入口**：交易日 17:30 只跑 `daily-stock-briefs`；`daily-advice` 从当日 brief
  派生「今日无新信号 / 今日有 N 个信号」，不再自己逐只调用 `analyze_stock`。手动 / CLI 运行
  `daily-advice` 走同一组合（先 briefs、再派生）；当日没有 brief 时返回可操作错误，
  不隐式调用 LLM。
- **可追溯**：每条观察带事实指纹、数据时间、来源、质量等级、缺失维度、有效期和 `adviceId`
  链接（仅 AI 结论有）。数值、方向与指标可用性由代码校验，不「看起来正常」就放行。
- **预算硬限**：每日默认 ≤8 票进入 AI、≤16 次 HTTP、≤90k token（约 ≤$0.04），
  并发 2；超限降级为规则观察并显式标 `budget` 缺失。
- **文案合规**：面向用户只使用信号 / 观察词表，规则观察不表述成 AI 研究结论。

## 3. 非目标

- 不做自动交易，也不产生交易动作或修改账户。
- 不做盘中 `provisional` 观察（P3-2 明确不做）；盘中仍由既有 AlertPlan / 交易计划监控负责。
- 不做全市场扫描或自动扩容股票池；候选来自持仓、关注池与当日策略信号，有明确上限。
- 不把规则兜底（`isRuleFallbackAdvice`）计入每日命中率或结算覆盖率分母。
- `generate_stock_briefs` 不进入 MCP 暴露面；MCP 只提供 `get_stock_brief` /
  `list_stock_briefs` 只读查询。
- 不修改历史 advice 列表的既有文案；新入口使用新词表，历史文案保持原文并注明语义。

## 4. 核心对象与 Advice 的关系

`StockBrief` 是**某交易日、某账户、某标的的观察日视图**，唯一键是
`(accountId, tradingDate, stockId, phase)`。它保存结论、置信度、质量、事实指纹、缺失原因与
当日 LLM 计量，证据正文仍由 `advices` / `based_on` 提供。

- **Signal ≠ Advice**：StrategySignal 是策略事实；Advice 是带推理、反证、风险、免责声明和
  有效期的研究结论。观察展示的信号词表只是对 `decision` 的展示映射，不改变领域枚举。
- **Brief ≠ 新的生命周期实体**：它不引入自己的审批、跟踪或行动状态，也不替代 Advice；
  `adviceId` 只是从观察指向当日 AI 结论的可选引用。规则观察没有 `adviceId`，也没有 AI 结论。
- **AI vs 规则观察**：`quality='ai'` 必须有 `adviceId`；`rule-only` 只能是
  `hold/watch/avoid` 且不带 `adviceId`。预算耗尽、模型失败、插件缺失或数据不足都必须
  落到 `quality` + `missing` 上，不能隐藏。

## 5. 入口

| 入口 | 展示 | 是否触发生成 |
|---|---|---|
| 个股详情 `#market?stockId=…` | 今日观察卡（信号词、confidence 区间、horizon、有效期、premise、证据表、反证、风险、缺失、免责声明） | 仅「刷新今日观察」走唯一写入口，受预算限制 |
| 关注列表 `#watchlists` | 成员行信号 chip、confidence、缺失 chip、更新时间 | 仅整列表刷新，不逐票生成 |
| 首页 `#dashboard` | Top 5（按 confidence）+ 覆盖计数与未覆盖原因 | 否 |
| 建议列表 `#advice` | 既有列表 + 质量标记（AI / 规则观察 / 部分数据）与结算状态 | 否 |
| 报告 `#reports` | 周报 section「个股观察成绩」：应结算 / 已结算 / 覆盖率 / 规则观察单列 | 沿用周报手动运行 |
| 作战室 `#market-room` | 板块详情与核心股行的信号徽标、数据时间，点击跳个股详情 | 否 |
| AI 对话 `#chat` | 先读当日 brief（秒级）；没有观察时询问是否现在分析，确认后走 `analyze_stock` 草案 | 仅经草案确认 |
| CLI | `luoome brief list/show/run`、`luoome workflow run daily-stock-briefs` | `brief run` 是显式人工触发 |
| CLI 当日判断 | `luoome workflow run daily-advice`：只派生当日结论；当日无 brief 返回可操作错误 | 否 |
| MCP | `get_stock_brief` / `list_stock_briefs` 只读 | 否 |

生成工具与只读查询都返回同一套 `StockBrief` 投影；Web、CLI 不各自重写文案映射。

## 6. 文案与合规

- `decision` → 展示词：`buy` 偏多信号、`sell` 偏空信号、`hold` 中性观察、
  `watch` 待确认观察、`avoid` 回避观察。
- 展示层与 tool / MCP / CLI 描述禁止出现「买入 / 卖出 / 建仓 / 加仓 / 减仓 / 清仓 / 满仓」。
- 面向用户固定声明「仅技术研究，不构成投资建议」；confidence 是区间参考，不是确定性或收益概率。
- 规则观察必须标注「AI 分析不可用，仅展示确定性规则结果」，不能写成 AI 结论。

## 7. 预算与调度

| 时点 | 做什么 | LLM | 写 advices |
|---|---|---|---|
| 交易日 08:45 | `daily-stock-briefs`（`phase='premarket'`）：事实包 + 规则预筛的研究名单，含隔夜新闻 | 0 次 | 否 |
| 交易日 16:00 后 | 既有 `post-market-data`：股票目录、全市场 dump 日线与复权因子 | — | — |
| 交易日 17:30 | `daily-stock-briefs`（`phase='post-market'`）→ `daily-advice(briefsOnly)` 派生当日判断 | 预算内 | 是（仅 AI 结论） |
| 手动 / CLI | `luoome workflow run daily-advice`：同一组合的后半段；当日无 brief 时直接报错，提示先跑 daily-stock-briefs | 0 次 | 否 |

每日默认预算：8 票进入 AI、16 次 HTTP、90 000 token、并发 2、单票最多 2 次尝试；
同一天同事实指纹重复触发不再调用 LLM。预算触达后本票及后续票降级为规则观察，
运行记录 `partial` 并保留已完成结果。

## 8. 结算与成绩单口径

- **应结算（eligible）**：`subjectKind='stock'`、`decision ∈ {buy,sell}`、非规则兜底的
  Advice，且已到结算窗口。
- **已结算 / 覆盖率**：应结算中已有对应 T+1/T+3/T+5 结算行的条数；没有应结算样本时覆盖率为
  `null`，不伪造成 0% 或 100%。缺日线、缺入场价继续跳过，并计入未覆盖原因。
- **规则观察单列**：规则兜底 advice 单独报总数与已结算数，不进命中率和覆盖率分母（Q6）。
- 周报「个股观察成绩」展示应结算、已结算、覆盖率与规则观察条数；没有样本时维持
  `unavailable` 并给出原因。

## 9. 验收

验收指标与自动化证据见
[每日个股观察验收记录](../archive/daily-stock-brief-acceptance-20261124.md)；当前契约以本 PRD 与
[详细设计](../ddd/daily-stock-brief-detailed-design.md) 为准。
