---
name: morning-brief
description: 交易日盘前简报——读隔夜事实、既有建议与观察条件，生成并落盘本日简报，再交付给用户。
whenToUse: 交易日 08:45 的定时任务，或用户要求「来份盘前简报」「今天怎么看」时。
---

# morning-brief

生成当日盘前简报，落盘成文件后交付给用户。

本技能版本：morning-brief-v1。

## 流程

1. **先查交易日**：`get_market_data_status`。非交易日就静默退出，只回一句「今天不是交易日」，不产出简报、不写库。
2. 读事实（全部来自工具，不要凭记忆）：
   - `list_holdings`：持仓、成本、市值、浮盈；
   - `list_watch_triggers`：盯盘触发与命中情况；
   - `list_advices`：既有建议（含反证、风险、免责声明、有效期）；
   - `list_watchlists`：关注列表；
   - `list_strategies` 与 `get_watch_status`：策略状态与盯盘健康度。
3. 生成简报，固定四段（顺序不变）：
   - **账户概览**：资产、持仓数、今日盈亏（标明 `dataAsOf` 与不可用项）；
   - **隔夜事实**：只写事实包里有的东西，每条带来源与观察时间；
   - **既有建议与反证**：保留原建议的决策、信心度、反证、风险、免责声明、有效期；
   - **今日观察条件**：触发价、条件、失效条件；缺哪项就写进可用性披露，不要凭空补。
4. **先落盘**：调 `write_report_artifact`（按 `reportId`，或 `kind` + `scope` + `periodEnd`），
   拿到返回的 `deliverablePath` 与 `presentArgs`。不要自己拼 Markdown，也不要自己写文件。
5. **再交付**：把上一步返回的 `presentArgs` **原样**传给 `present`，**恰好一次**。
   `presentArgs.files.length === 1`（`present` 只接受 1 到 4 个文件），不要自己编参数，
   也不要重复调用。
6. 把 `present` 返回的文件卡片连同简报摘要一起回复用户；落盘失败时如实说明失败原因
   （适配器未装配 / 不变量拒绝），不要伪造一份「已交付」。

## 写回路径

- 简报落盘只走 `write_report_artifact`：它把 `Report` 渲染成 Markdown + 内嵌 JSON，写入 `$LUOOME_HOME/reports/`。
- 交付动作只有一次 `present`。`present` 是 DSH 宿主工具，luoome 侧不代理、不重试、不重复调用。
- 简报本身是研究材料，不写 luoome 事实库；用户要长期留档时先确认他要的是「笔记」还是「决策」，
  要笔记就用 `save_decision_review` 的 `content.note` 显式记录并说明这是用户笔记。

## 边界

- 建议不等于成交：正文只写立场与观察条件，不写任何交易动作。
- 先给反面证据，再给结论，最后给可证伪的观察条件。
- 任何数据缺失都如实披露为不可用，不按零处理。
