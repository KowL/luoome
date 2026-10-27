---
name: strategy-lab
description: 在 DSH 中围绕明确假设研究策略，检查数据资格、比较不可变版本、验证并保存结论；写入与发布分别由用户原生审批。
whenToUse: 用户想选股、验证或比较策略、恢复未完成研究、修改规则，或把研究结论保存为候选版本时。
---

# strategy-lab

在对话中把「策略想法」做成可审计的 Strategy 与 StrategyVersion：AI 生成草案，确定性规则负责校验和试跑，用户通过原生审批决定是否写入与发布。

本技能版本：strategy-lab-v3。

## 研究闭环与初始化

先确认一条可被反证的研究假设，例如“只调整成交量门槛，是否减少数据完整样本中的规则误选”。绑定当前账户、Strategy、基线/候选的不可变版本、股票范围、区间和基准。一次优先改一组有界参数，不在验证区间反复挑选最高观察收益。

- **恢复**：先读 `get_strategy_research_state` 和 `list_strategy_evaluation_sessions`，再按保存的版本读取 `get_strategy_experiment_context`。发布版本变化不替换已保存基线；版本丢失或归属不符时停止相关执行并说明缺口。Operation 正在 executing 或 unknown 时用 `luoome_operation_status` 查询原 operationId；必要时 reconcile=true 只核对既有回执，不启动任务，不能新建 operation 盲跑。
- **初次研究**：读 `get_account`、`list_strategies`、`get_stock_universe_status` 和 `get_market_data_status`。没有策略时可展示 catalog 与 starterTemplate，用户选择后才经原生审批创建草案；不凭空创建示例账户、持仓或投资资产，不更改部署 owner，也不自动开启日程或通知。
- **数据资格**：候选冻结后用 `get_strategy_data_preflight` 检查确切 versionId、from/to、stockIds 和 benchmarkStockId。报告字段、窗口、PIT 修订和严格回测门禁缺口。预检只证明本地可核对事实；实时源可用性还须实际试跑，partial/unavailable 不视为通过。
- **同快照对照**：`trial_strategy_version` 对照基线与一个候选，或用 `run_strategy_research_comparison` 比较最多八个明确候选。必须展示返回的 inputIdentity、实际股票集合、事实时间、失败和 limitations；不能把同一 stockIds 的两次独立运行叫作同快照。同快照 diagnostic 与 scoringBreakdown 解释入选、临界、未入选和缺失；缺失不补零。
- **验证**：历史评估通过原生审批的 `start_strategy_evaluation_session` 开始后台执行，用 `get_strategy_evaluation_progress` 查看 checkpoint。取消和恢复分别经 `cancel_strategy_evaluation_session`、`resume_strategy_evaluation_session` 独立审批；刷新后 worker idle 但 session running 需明确恢复，不能宣称仍在执行。使用原 session 身份保留完成日期；不向用户暴露逐日 record/finish 的任意写入。
- **证据分层**：trial 为内存试算，evaluation 为历史逐日选股重放，strict backtest 才使用组合执行模型，T+1/T+3/T+5 为真实信号观察。训练/验证分别固定 session、区间与样本；`assess_adaptive_personality` 只报告可信门禁，不生成最优收益结论。严格回测缺可交易性、公司行动或基准事实时保留阻塞，不降级冒充严格回测。
- **结论留档**：用户要求保存时，经 `luoome_confirmed_operation` 的 `save_strategy_research_state` 独立原生审批，保存 question、基线/候选、范围/区间/基准、证据引用、反证、limitations 和 nextStep。outcome 区分 supported、inconclusive、rejected；失败或证据不足也可保存，不能写成验证通过。先读当前 revision，按 expectedRevision 防止覆盖别处更新；requestId 与账户由宿主绑定。导出用 `export_strategy_manifest`，说明定义和证据引用可携带，供应商历史数据并不随 manifest 打包，不能保证异机完整重放。

## 流程

1. **先读事实，再动手写**（只读工具）：
   - 已有策略：`list_strategies`、`get_strategy`；
   - DSL 字段、指标与数据需求：`get_strategy_dsl_catalog`；
   - 当前定义、最近 published operational run、结果实际版本、入选明细与数据健康：`get_strategy_workspace`（入选明细默认最多 50 条，可用 `selectedLimit` 调整到 200 条；完整数量见 `matches.total`）；
   - 数据健康与必要证据：`get_market_data_status`、`get_strategy_experiment_context`、`get_strategy_insight_facts`。
   取不到就明说取不到，不凭记忆补 DSL 字段、行情或历史运行。
2. **生成草案，不落库、不发布**：
   - 用 `get_strategy_dsl_catalog` 对齐 DSL 版本与字段路径；
   - 把 AI 生成的 definition 交给 `propose_strategy_version_draft` 做确定性 schema 校验，取得 diff、事实引用与未持久化草案；该工具不可用时，在对话中给出完整 definition，并用 `compare_strategy_definitions` 与现有版本对比；
   - 草案只是候选版本，不是已发布策略，也不是正式运行结果。
3. **展示冻结内容**（写入前必须完成）：
   - definition diff 与规则解释：每条规则在什么条件下选股、排除或评分；
   - 样本范围：股票池、时间窗、所需数据；
   - 数据缺口与 limitations；
   - 变更摘要与 factReferences；
   - 下一步将执行的写入动作和会产生的实体。
4. **逐项写入，每次独立原生审批**：
   - 所有写入都经 DSH 原生确认操作 `luoome_confirmed_operation`（id、tool 加 inputJson 或 input）；DSH 冻结解析后的参数并弹出审批卡，只有用户实际点「允许一次」才执行；
   - 新建策略：tool 取 `create_strategy`，必要时用 copyFromStrategyId 复制内置策略作基线；
   - 新版本：tool 取 `create_strategy_version`，把未持久化草案变成 draft 版本，validationStatus 为 pending；
   - 静态校验：tool 取 `validate_strategy_version`，展示 referencedFields、requiredLookback 与 validationErrors；试跑使用的基线和草案都必须 valid，尚为 pending 的基线也需独立审批校验；
   - 有限样本试跑：调用 `trial_strategy_version`（同一策略的基线版本与草案版本、显式股票样本）；试跑强制非持久化，不写 current operational run，也不产生正式 StrategyRun；
   - 发布：tool 取 `publish_strategy_version`，必须单独审批。
5. **展示试跑与发布结果**：样本范围、覆盖与缺口、失败原因、是否已发布；发布后说明策略面板可以回读同一 Strategy 与版本。已发布只代表定义生效，不代表持续运行已经启用；已有 StrategySchedule 会在下一次日循环使用新的 currentVersion，必须明确提示。
6. **发布后由用户选择下一步**：
   - 仅保存研究方法：到此结束，不创建调度或订阅。
   - 启用持续运行：先读 `get_strategy_schedule`，展示 cron、timezone、enabled 和 acceptancePolicy，经独立原生审批调用 `set_strategy_schedule`；不要传 recommendationPolicy。再读 `luoome_automation_catalog` 核对 DSH 现有日程、任务定义指纹和精确 `run_strategy_daily_cycle` 调用模板；缺失时先用宿主 `schedule_list` 查重，只有用户明确要求创建自动任务才用宿主 `schedule_create`。最后经独立原生审批调用 `configure_plugin_automation` 授权该任务。StrategySchedule 只决定策略何时到期，DSH 定时任务执行 daily cycle 才会真正运行；两层都成功只是配置就绪，用 `luoome_research_status` 核对有效 grant、真实投递、Operation 业务回执、本策略运行、同次日循环审计与事实截止；提醒已投递不代表业务已完成或通知已送达。
   - 跟踪匹配标的：读取 `list_watchlists` 与 `list_strategy_watchlist_subscriptions`，经独立原生审批调用 `subscribe_strategy_to_watchlist`。只有 published operational run 才同步，订阅本身不产生 Advice 或交易；取消时使用 `unsubscribe_strategy_from_watchlist` 并独立审批。
   - 暂停或恢复：分别使用 `pause_strategy`、`resume_strategy`，各自独立审批；暂停不伪称取消进行中的运行。
7. **执行边界**：不直接调用 `run_strategy`，不把单次求值当成完整上线链路，不做任意单策略立即运行。到期执行只复用 `run_strategy_daily_cycle`，其数据准备、正式运行、Watchlist 同步、观察补全和审计由既有 workflow 负责。

## 审批与授权纪律

- 原生调用优先用 inputJson 字符串：按对应 tool 的 input/contentSchema 将业务参数序列化为 JSON，保留 null、数字和数组。与 input 对象二选一；不得把 null 改成占位字符串或省略必填字段。
- 写入参数以 `luoome_confirmed_operation` 中对应 tool 的 input schema 为准；不要用空载荷或猜测工具名探测写接口。invalid_input 先按字段路径纠正参数，不能将其解释成缺少用户授权。
- 审批结果只来自 DSH 原生审批卡；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户未批准、拒绝、取消、超时、切换账户或从子 Agent 发起时，一律视为未执行，不重试写入。
- 用户说「先做出来看看」「你看着办」不等于发布授权；创建与校验通过也不隐含发布，发布必须是一次明确的独立批准。
- 审批后响应丢失：查询该操作状态与已有业务回执，核对后再继续；不重复创建版本、不重复发布。

## 边界

- 不未经审批创建 StrategySchedule、DSH 日程、任务授权或 Watchlist 订阅，不自动发布、不自动交易。
- 建议不等于交易；不承诺收益，不把样本试跑结果说成未来表现。
- 数据缺口、校验失败与试跑失败如实展示，不用空成功或模型记忆补齐。
- 不调用 trade 能力。
- 凡使用分析 context 的写回，遇到 context_expired 或 stale_context 只重取一次并重新核对事实，不重放旧结果。
- 不编造模型标识、生成时间或工具回执。
