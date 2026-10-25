---
name: strategy-lab
description: 在 DSH 对话中把策略想法做成可解释、可校验、可试跑的 StrategyVersion 草案，并在用户逐项原生审批后创建、校验和发布。
whenToUse: 用户要求新建策略、修改已有策略规则、解释策略定义，或要求把研究结论落成策略版本时。
---

# strategy-lab

在对话中把「策略想法」做成可审计的 Strategy 与 StrategyVersion：AI 生成草案，确定性规则负责校验和试跑，用户通过原生审批决定是否写入与发布。

本技能版本：strategy-lab-v1。

## 流程

1. **先读事实，再动手写**（只读工具）：
   - 已有策略：`list_strategies`、`get_strategy`；
   - DSL 字段、指标与数据需求：`get_strategy_dsl_catalog`；
   - 当前版本、最近 published operational run 与数据健康：`get_strategy_workspace`；
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
   - 静态校验：tool 取 `validate_strategy_version`，展示 referencedFields、requiredLookback 与 validationErrors；
   - 有限样本试跑：调用 `trial_strategy_version`（同一策略的基线版本与草案版本、显式股票样本）；试跑强制非持久化，不写 current operational run，也不产生正式 StrategyRun；
   - 发布：tool 取 `publish_strategy_version`，必须单独审批。
5. **展示试跑与发布结果**：样本范围、覆盖与缺口、失败原因、是否已发布；发布后说明策略面板可以回读同一 Strategy 与版本。

## 审批与授权纪律

- 原生调用优先用 inputJson 字符串：按对应 tool 的 input/contentSchema 将业务参数序列化为 JSON，保留 null、数字和数组。与 input 对象二选一；不得把 null 改成占位字符串或省略必填字段。
- 写入参数以 `luoome_confirmed_operation` 中对应 tool 的 input schema 为准；不要用空载荷或猜测工具名探测写接口。invalid_input 先按字段路径纠正参数，不能将其解释成缺少用户授权。
- 审批结果只来自 DSH 原生审批卡；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户未批准、拒绝、取消、超时、切换账户或从子 Agent 发起时，一律视为未执行，不重试写入。
- 用户说「先做出来看看」「你看着办」不等于发布授权；创建与校验通过也不隐含发布，发布必须是一次明确的独立批准。
- 审批后响应丢失：查询该操作状态与已有业务回执，核对后再继续；不重复创建版本、不重复发布。

## 边界

- 不自动创建 schedule、不自动正式运行、不自动发布、不自动交易。
- 建议不等于交易；不承诺收益，不把样本试跑结果说成未来表现。
- 数据缺口、校验失败与试跑失败如实展示，不用空成功或模型记忆补齐。
- 不调用 trade 能力。
- 凡使用分析 context 的写回，遇到 context_expired 或 stale_context 只重取一次并重新核对事实，不重放旧结果。
- 不编造模型标识、生成时间或工具回执。
