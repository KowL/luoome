---
name: stock-deep-dive
description: 个股深度研究——基于事实包与研究库输出可证伪的研究报告，必要时落为建议。
whenToUse: 用户点名某个标的问「这只票怎么样」「深度分析一下」时。
---

# stock-deep-dive

针对单个标的做深度研究。

## 流程

1. 先取事实，再下结论：
   - `mcp__luoome-worker__get_analysis_context` 取该标的的事实包（有 analysis context 时）；
   - 无 context 时用只读工具补齐：行情、指标、基本面评分、持仓与成本、该标的的既有建议与研究文档。
2. 研究检索：读研究库与已归档的研究文档，标明来源与时间；没有就明说没有，不要补记忆里的财报数字。
3. 输出结构固定五段：
   - **事实**：数字与 `dataAsOf`，逐位来自工具；
   - **反面证据**：最可能证伪多头逻辑的三条；
   - **结论**：方向性判断 + 适用条件；
   - **观察条件**：可证伪的价位、量能、失效条件；
   - **风险与有效期**：风险点、来源、有效期。
4. 需要落库时：
   - 只给观察计划、不构成建议 → 不写 Advice；
   - 明确形成建议 → 先 `mcp__luoome-worker__get_analysis_context` 取有效 context，再 `mcp__luoome-worker__record_advice`。

## 写回约定

- `record_advice` 返回 `context_expired` 或 `stale_context` 时，必须先用 `mcp__luoome-worker__get_analysis_context` 重取事实包并重试一次；重试仍失败才向用户报告。
- 重取后要按新事实包重新核对数字，不要沿用旧事实包。

## 边界

- 建议不等于成交，不得出现「已买入/已卖出」。
- 不要凭记忆报价格、涨跌幅、财报数字；取不到就直说取不到。
- 先给反面证据，再给结论，最后给可证伪的观察条件。
