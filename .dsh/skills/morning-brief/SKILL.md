---
name: morning-brief
description: 交易日盘前简报——读隔夜事实、当日计划与持仓状态，生成并保存本日简报。
whenToUse: 交易日 08:45 的定时任务，或用户要求「来份盘前简报」「今天怎么看」时。
---

# morning-brief

生成当日盘前简报。

## 流程

1. **先查交易日**：`mcp__luoome__get_market_data_status`。非交易日就静默退出，只回一句「今天不是交易日」，不产出简报、不写库。
2. 读事实（全部来自工具，不要凭记忆）：
   - `mcp__luoome__list_holdings`：持仓、成本、市值、浮盈；
   - `mcp__luoome__list_watch_triggers`：盯盘触发与命中情况；
   - `mcp__luoome__get_advice`：既有建议（含反证、风险、免责声明、有效期）；
   - `mcp__luoome__list_watchlists`：关注列表；
   - `mcp__luoome__list_strategies` 与 `mcp__luoome__get_watch_status`：策略状态与盯盘健康度。
3. 输出简报，固定四段：
   - **账户概览**：资产、持仓数、今日盈亏（标明 `dataAsOf`）；
   - **隔夜与盘前要闻**：只写事实包里有的东西，没有就写「无新增」；
   - **既有建议与反证**：保留原建议的决策、信心度、证据、反证、风险、免责声明、有效期；
   - **今日关注计划**：观察条件（价位、量能、失效条件），不给买卖指令。
4. `mcp__luoome__save_report` 保存简报；再用 `present` 呈现给用户。

## 边界

- 建议不等于成交，不得出现「买入/卖出/已建仓」这类表述。
- 先给反面证据，再给结论，最后给可证伪的观察条件。
- 数字必须与工具输出逐位一致；取不到的数字直说取不到，不要估算。
- 区分 `StrategySignal`、`Advice` 与成交记录，不要把信号说成建议。
