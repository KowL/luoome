---
name: strategy-result-review
description: 解释策略选股诊断、版本对照、历史验证和持续观察更新，保留反证与数据缺口，并按需保存研究结论。
whenToUse: 用户问策略为什么入选或未入选、对照和验证有什么变化、T+1/T+3/T+5 观察如何，或要求恢复研究时。
---

# strategy-result-review

回答「这个策略最近发生了什么、为什么」，只读已持久化事实，不重算历史、不承诺收益。

本技能版本：strategy-result-review-v3。

## 流程

1. **锁定身份**：用 `list_strategies` 按用户所选名称查找，核对版本号和事实时间后，在工具参数中绑定确切 strategyId/runId。名称唯一且事实对应时直接继续；存在同名或事实不符时，用名称、版本和时间让用户核对，不展示内部标识。
2. **只读确切事实**：
   - 策略与版本：`get_strategy`、`get_strategy_workspace`（含 `currentRunVersion` 和最多 `selectedLimit` 条有名称的 `matches.rows`；`matches.total` 是完整入选数量）；
   - 运行：`list_strategy_runs`、`get_strategy_run`、`compare_strategy_runs`；
   - 结果、信号与观察：`strategy_signals_by_stock`、`get_strategy_insight_facts`、`list_pending_strategy_observations`、`get_signal_observation_stats`；
   - 可靠性：`get_strategy_reliability_summary`、`get_strategy_decision_cycles`；
   - 持续运行：`get_strategy_schedule`、`list_strategy_watchlist_subscriptions`、`luoome_automation_catalog` 与 `luoome_research_status`。已发布但没有启用 StrategySchedule 时明确说「已发布，尚未启用持续运行」；读取失败说未知，不当成未配置。即使 schedule.enabled 为真，也必须核对 DSH 真实任务、当前任务定义指纹、有效 grant、Operation 业务回执、本策略最新运行与事实截止，才说明实际执行状态。提醒投递不是业务成功，批次受理不是通知送达。
   只把 published operational run 当作当前事实；evaluation、withheld、non-publishing 运行只作历史参考，不用当前行情重算过去运行。
3. **分层解释，不混为一谈**：
   - 执行事实：run 状态、发布资格、coverage、dataAsOf、命中与排除结果、signal；
   - 数据缺口：dataHealth、limitations、pending 或 unavailable 观察、样本数；
   - 事后观察：T+1/T+3/T+5 的 SignalObservation，注明 sampleUnit、样本量、missingRate 与 benchmarkStatus；
   - 推断：模型对「为什么」的解释必须标为推断，不能伪装成事实。
4. **引用与措辞**：结论内部绑定真实 run/version/fact id，对用户使用策略名称、版本号、事实时间和股票名称说明来源，不直接展示内部标识。当前版本与结果版本不同时明确区分。不把观察称为严格回测，不承诺未来收益，不把 confidence 当概率。
5. **只解释就结束**：用户只问「怎么样、为什么」时，在对话里回答即可，不强制落库，不自动生成报告，不触发写入。
6. **要改策略或运行配置**：修改定义转入本插件 strategy-lab 的草案、校验、试跑、逐项审批与发布路径；研究结论不能直接修改定义或直接发布。启用、修改、暂停或恢复持续运行也按 strategy-lab 的两层调度流程执行：StrategySchedule 只决定到期，DSH 定时任务调用 `run_strategy_daily_cycle` 才执行；日程查重与任务授权分开确认。Watchlist 订阅或取消同样独立审批，不直接调用 `run_strategy`。
7. **可选保存 proposal**：用户明确要求留档时，先调用 `get_analysis_context`，kind 取 strategy_version_proposal、subject 为 strategy（以工具 input schema 为准），取得带 factIds 的 context；展示将保存的 proposal 内容与来源引用；再经 DSH 原生确认操作 `luoome_confirmed_operation` 的 `record_analysis_result` policy 保存。保存的 proposal 只是研究产物，不是发布。
8. **context 时效**：遇到 context_expired 或 stale_context 只重取一次，并按新事实包逐项重新核对；仍不可用就说明无法保存，不重放旧结论、不把旧数据当新事实。

## 对照、验证与结论

- 恢复研究先读 `get_strategy_research_state`、`list_strategy_evaluation_sessions`、`get_strategy_experiment_context`；绑定保存的版本与区间，不能自动换成新发布版本。
- `get_strategy_data_preflight` 的字段、PIT 范围和基准缺口与实际验证结果一起展示。用 `get_strategy_evaluation_progress` 读取真实逐日 checkpoint，区分 session running、宿主 worker idle、cancelled、partial 和 complete；恢复需独立审批，不能把 Operation succeeded 等同 evaluation complete。
- 逐股诊断用 `get_strategy_selection_diagnostics` 只读确切 run/version，分别解释 selected、rule-near-miss、ranking-near-miss、excluded、incomplete；规则输入值、门槛和 scoringBreakdown 来自持久事实，不刷新行情。同快照内存诊断使用 trial 返回的 diagnostics。
- `compare_strategy_runs` 表示两次运行变化，可能跨日或跨版本；`trial_strategy_version` 的共享 inputIdentity 才代表同事实对照。`run_strategy_research_comparison` 必须保留所有候选、失败与限制；不依据验证区间最高收益挑选“最优参数”。
- 研究更新包含规则变化、选股进出以及 T+1/T+3/T+5 的样本量、pending/unavailable、benchmark coverage 和观察截止。观察收益不是组合回测。需要严格回测时只读 `list_strict_strategy_backtests`、`get_strict_strategy_backtest` 的真实状态、执行模型和门禁；没有记录就明确未开始，不生成零收益。
- 用户要求结论留档时，读 revision 后经 `luoome_confirmed_operation` 的 `save_strategy_research_state` 保存支持、待定或否定的结论、真实 evidenceReferences、limitations 与 nextStep。先展示待保存内容，保存不代表发布；响应丢失先查询原 Operation，不重复保存。`export_strategy_manifest` 导出定义和证据引用，保留数据无法携带与重放的限制。

## 审批与授权纪律

- 原生调用优先用 inputJson 字符串：按对应 tool 的 input/contentSchema 将业务参数序列化为 JSON，保留 null、数字和数组。与 input 对象二选一；不得把 null 改成占位字符串或省略必填字段。
- 写入 proposal 必须经 DSH 原生审批；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户拒绝、取消、超时或切换账户时视为未执行，不重试写入。
- 审批后响应丢失：用 `luoome_operation_status` 按原 operationId 查询，必要时 reconcile=true 核对已有业务回执；它不会重启任务，也不会重建确认凭据。不重复保存。

## 边界

- 不把有限样本的观察称为严格回测或可复现实验；样本不足时明确写样本不足。
- 建议不等于交易；不承诺收益，不提供自动交易或下单入口。
- 不调用 trade 能力；不未经审批创建 schedule、任务授权或订阅，不自动发布、不自动正式运行。
- 数据缺口、pending 和 unavailable 如实展示，不用模型记忆补齐。
