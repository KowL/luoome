---
name: strategy-result-review
description: 研究指定 Strategy 的正式运行结果、信号与事后观察，区分执行事实、数据缺口和推断，并在需要改版时转入受审批的草案流程。
whenToUse: 用户问某个策略最近跑得怎样、为什么选出这些股票、观察结果如何、接下来该怎么改时。
---

# strategy-result-review

回答「这个策略最近发生了什么、为什么」，只读已持久化事实，不重算历史、不承诺收益。

本技能版本：strategy-result-review-v1。

## 流程

1. **锁定身份**：先确认 strategyId；用户没给时用 `list_strategies` 让用户选择，并用 `list_strategy_runs` 展示最近运行让用户选定 runId。
2. **只读确切事实**：
   - 策略与版本：`get_strategy`、`get_strategy_workspace`；
   - 运行：`list_strategy_runs`、`get_strategy_run`、`compare_strategy_runs`；
   - 结果、信号与观察：`strategy_signals_by_stock`、`get_strategy_insight_facts`、`list_pending_strategy_observations`、`get_signal_observation_stats`；
   - 可靠性：`get_strategy_reliability_summary`、`get_strategy_decision_cycles`。
   只把 published operational run 当作当前事实；evaluation、withheld、non-publishing 运行只作历史参考，不用当前行情重算过去运行。
3. **分层解释，不混为一谈**：
   - 执行事实：run 状态、发布资格、coverage、dataAsOf、命中与排除结果、signal；
   - 数据缺口：dataHealth、limitations、pending 或 unavailable 观察、样本数；
   - 事后观察：T+1/T+3/T+5 的 SignalObservation，注明 sampleUnit、样本量、missingRate 与 benchmarkStatus；
   - 推断：模型对「为什么」的解释必须标为推断，不能伪装成事实。
4. **引用与措辞**：每个结论引用真实 run/version/fact id；不把观察称为严格回测，不承诺未来收益，不把 confidence 当概率。
5. **只解释就结束**：用户只问「怎么样、为什么」时，在对话里回答即可，不强制落库，不自动生成报告，不触发写入。
6. **要改策略**：转入本插件 strategy-lab 的草案、校验、试跑、逐项审批与发布路径。研究结论不能直接修改定义，也不能直接发布。
7. **可选保存 proposal**：用户明确要求留档时，先调用 `get_analysis_context`，kind 取 strategy_version_proposal、subject 为 strategy（以工具 input schema 为准），取得带 factIds 的 context；展示将保存的 proposal 内容与来源引用；再经 DSH 原生确认操作 `luoome_confirmed_operation` 的 `record_analysis_result` policy 保存。保存的 proposal 只是研究产物，不是发布。
8. **context 时效**：遇到 context_expired 或 stale_context 只重取一次，并按新事实包逐项重新核对；仍不可用就说明无法保存，不重放旧结论、不把旧数据当新事实。

## 审批与授权纪律

- 原生调用优先用 inputJson 字符串：按对应 tool 的 input/contentSchema 将业务参数序列化为 JSON，保留 null、数字和数组。与 input 对象二选一；不得把 null 改成占位字符串或省略必填字段。
- 写入 proposal 必须经 DSH 原生审批；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户拒绝、取消、超时或切换账户时视为未执行，不重试写入。
- 审批后响应丢失：查询操作状态与业务回执核对，不重复保存。

## 边界

- 不把有限样本的观察称为严格回测或可复现实验；样本不足时明确写样本不足。
- 建议不等于交易；不承诺收益，不提供自动交易或下单入口。
- 不调用 trade 能力；不自动创建 schedule、不自动发布、不自动正式运行。
- 数据缺口、pending 和 unavailable 如实展示，不用模型记忆补齐。
