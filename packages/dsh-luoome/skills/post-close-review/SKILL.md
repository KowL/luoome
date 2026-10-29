---
name: post-close-review
description: 盘后复盘当时的建议依据、用户的记录与行动、后来发生的事实，分别保存复盘笔记和用户反馈，不把推断当作用户行为。
whenToUse: 用户问「当时的判断如何、我实际怎么做了、错在哪里」，或要求记录复盘与建议结果时。
---

# post-close-review

复盘要同时回答三件事：当时依据是什么、用户实际做了什么、后来发生了什么。三者分别读取、分别保存，不得互相推断。

本技能版本：post-close-review-v1。

个人操作的 accountId / requestId 由宿主绑定。业务参数省略 requestId，顶层 id 使用新的 UUID；若显式提供 requestId，必须与顶层 id 完全一致。错误路径为 requestId 时只修正该字段，不通过删改笔记、反馈或盈亏探测原因。

## 流程

1. **确定复盘对象**：账户、时间范围与来源（Advice、计划版本或提醒）；需要时用 `list_decision_reviews` 找已保存的复盘。
2. **分头读取，不混口径**：
   - 当时依据：`get_advice`（查看已过期快照时显式允许过期）、`get_decision_review_context`、`get_decision_review_snapshot`；
   - 用户实际：只认 DecisionReview 修订里显式记录的 tradeIds，再用 `list_trades` 核对成交；
   - 后来事实：`get_signal_observation_stats`、`list_pending_strategy_observations`；
   - 账户层面：`get_decision_loop_review`（描述性聚合，明确未知与数据截止时间）；账户快照工具如已注册可作补充；
   - 统计口径：`get_advice_stats`、`get_confidence_calibration`（样本数与未知盈亏）。
3. **三类信息分写**：
   - 当时依据：来源快照与有效期；
   - 用户实际：用户明确记录的行为与结果，或显式关联的成交；
   - AI 事后判断：只作为分析，不能当作事实写入用户记录。
   不根据同股、同日或后市涨跌推断用户跟随；不伪造盈亏；盈亏未知保持缺失，不写 0。
4. **保存复盘笔记**（用户要求时）：先调用 `get_decision_review_context` 取得 contextHash 与 expectedRevision，向用户展示冻结内容（来源、tradeIds、changeNote）；再经 `luoome_confirmed_operation` 的 `save_decision_review` policy 直接提交并保留回执。响应丢失时只查询操作状态与业务回执核对，不重复保存。
5. **记录用户 outcome（仅在用户明确说明后）**：用户明确说明自己跟随、部分跟随或忽略，并给出实际结果后，才允许经 `luoome_confirmed_operation` 的 `record_advice_outcome` policy 直接提交。outcome 取 followed、partially_followed 或 ignored；tradeIds 只列显式核对过的成交；pnl 未知时缺省，不用 0 伪装。AI 不得替用户选择 outcome，也不得自动填写盈亏。
   `record_advice_outcome.notes` 与 `save_decision_review.content.note` 写入同一个复盘笔记字段，更正原因单独放 changeNote。需要同时回填结果与保存笔记时优先用一次 outcome 操作并提交完整目标 notes；分两步时先 outcome、回读新 revision，再只更新 content.note。不得用更正原因覆盖已有笔记，也不得提交旧 expectedRevision。
   相同复盘内容可能返回既有修订：成功回执不代表新增 revision。不要为更换更正原因措辞反复提交相同内容，也不能伪造内容迫使新增修订；如更正原因未更新，明确说明实际回执与当前修订的差异。
6. **与面板同口径**：展示样本数、未知盈亏、数据缺口与时间范围；面板只投影工具结果，不在对话里另造统计口径。
7. **AI 质量分析与用户 outcome 分开写**：前者是模型对判断过程的事后分析，后者是用户事实，二者不能混在同一字段里。

## 执行与授权纪律

- 原生调用优先用 inputJson 字符串：按对应 tool 的 input/contentSchema 将业务参数序列化为 JSON，保留 null、数字和数组。与 input 对象二选一；不得把 null 改成占位字符串或省略必填字段。content 更新时省略的顶层字段保留 expectedRevision 对应原值，只有显式 null 才清除可空字段；tradeIds 用空数组显式解除关联。新建时省略字段初始为空数组/null；不要为填满契约编造值。显式提供 adviceFeedback 对象时整体替换该字段；清除已填盈亏或解除成交关联仍须更正原因。
- 保存参数以 `luoome_confirmed_operation` 中对应 tool 的 input schema 为准；不要用写调用探测工具名或参数，尤其不能用 `record_advice_outcome` 探测权限。invalid_input 按字段路径纠正，不能将其解释成缺少用户授权。
- 个人版按明确意图直接保存复盘笔记与用户 outcome，没有人工审批；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户取消、执行超时或切换账户时视为未执行，不重试写入。
- 执行后响应丢失：查询操作状态与业务回执核对，不重复保存或重复记录 outcome。

## 边界

- 不推断用户跟随、不代填 outcome、不伪造盈亏，未确认的结果保持未知。
- 建议不等于交易；复盘不产生下单或自动交易动作。
- 不调用 trade 能力。
- 凡使用分析 context 的写回，遇到 context_expired 或 stale_context 只重取一次并重新核对事实，不重放旧结果。
