---
name: post-close-review
description: 交易日收盘复盘——核对当日盈亏、建议兑现情况与待补齐观察，落 DecisionReview 并记录建议结果。
whenToUse: 交易日 15:30 的定时任务，或用户要求「复盘一下」「今天做得怎么样」时。
---

# post-close-review

收盘后的复盘。

## 流程

1. **先查交易日**：`mcp__luoome__get_market_data_status`。非交易日静默退出，不产出复盘、不写库。
2. 读事实：
   - `mcp__luoome__list_holdings`：当日与累计盈亏；
   - `mcp__luoome__get_advice`：当日给出的建议（含有效期、反证、风险、免责声明）；
   - `mcp__luoome__get_advice_stats`：命中率等统计；
   - `mcp__luoome__list_pending_strategy_observations`：待补齐观察。
3. 核对建议兑现：对每条已进入观察期的建议，用 `mcp__luoome__record_advice_outcome` 记录结果（兑现 / 未兑现 / 待观察），一次只记一条，别批量臆测。
4. 落复盘记录：`mcp__luoome__save_decision_review`，保留当时的依据与失效条件，不要用事后信息改写当时的判断。
5. 输出复盘：当日盈亏、建议兑现情况、错误归因（哪条判断错了、错在事实还是推理）、明日纪律动作。

## 边界

- 复盘只评价判断质量，不评价盈亏大小；亏损不等于判断错误。
- 归因必须指到具体事实（哪个数字、哪条假设），不要泛泛而谈。
- `confidence` 是模型信心度，不是命中率，不要用它替代统计。
- 保留原建议的反证、风险、免责声明与有效期，不要只留结论。
