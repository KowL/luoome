# Strategy AI 生命周期管理详细设计（M2）

> 状态：已实施（2026-09-02，M2-S0～S4 全部交付；实施偏差见 §8）
> 上位 PRD：[策略自动化与 AI 管理 PRD](../prd/strategy-ai-managed-automation.md) §6
> 关联：[Strategy 实验、晋级与反馈闭环详细设计](./strategy-experiment-feedback-detailed-design.md)、
> [Strategy 日运行与历史评估可靠性详细设计](./strategy-daily-cycle-and-replay-detailed-design.md)

## 1. 范围

M2 让 AI 接管策略生命周期：提议版本（调参或创造新策略）→ 自动独立验证 → 晋级门自动放行发布；
以及按确定性规则自动暂停策略。全部动作持久化、可审计、进周报。

显式不做：

- 自动归档：归档是生命周期退出语义，误操作成本高且暂停已覆盖"停止信号"的实际效果；
  PRD §4.4 中"归档全自动"收敛为 M2 只自动暂停，归档保留人工（PRD 偏差，已确认可接受时再回补）。
- 自动 resume：自动暂停的策略只能人工恢复，防止暂停/恢复震荡。
- 盘中触发、组合权重编排、运维自愈（均为 PRD 非目标）。

## 2. 领域实体：StrategyAutonomyAction

新增持久化实体，记录每一次自主管理动作（提议、发布、暂停）的身份、依据与终态：

```text
StrategyAutonomyAction
  id                  稳定 id
  kind                propose-version | publish-version | pause
  status              见 §2.2 状态机
  strategyId
  strategyVersionId?  提议/发布的候选版本
  evaluationSessionId? 提议关联的验证 session
  trigger             weekly-review（首期唯一触发源）
  ruleSnapshot        触发时的确定性规则与指标快照（纯事实，JSON）
  aiNarrative?        AI 生成的解释文本（可有可败，失败不阻塞动作）
  factReferences      事实引用
  createdAt / updatedAt / completedAt?
```

### 2.1 不变量

- kind=propose-version 必须最终关联一个 strategyVersionId（AI 提议失败则 status=failed，不留孤儿）；
- kind=publish-version 的 strategyVersionId 在动作创建后不可变；
- kind=pause 的 ruleSnapshot 必须包含触发时的完整指标与阈值，禁止只记结论；
- aiNarrative 不参与任何状态转移判定；状态只由确定性事实推进。

### 2.2 状态机

```text
propose-version:  drafted → validating → eligible → published
                              │             └→ blocked（进人工队列 → confirmed→published / rejected）
                              └→ failed
publish-version:  由 propose-version 的 eligible→published 转移记录，不独立创建
pause:            executed（创建即终态，动作已完成）
```

人工队列语义：blocked 只是状态，Web 提供确认（→ 走 publish）与否决（→ rejected）入口；
不新增通知渠道，周报汇总可见。

## 3. 编排：strategy-autonomy-weekly workflow

新 workflow，每周运行一次（挂在 Web 调度器现有周节奏上，与 weekly-report 同触发点、先 autonomy 后 report，
使周报能包含本周动作）。只通过 `ctx.tools.*` 编排，分四步，任一步失败不影响其它策略与其它步骤：

### 3.1 自动暂停（先于提议，先止损再优化）

对每个 status=active 的 owner=user 策略，读取 T+5 观察统计，命中以下**全部**条件则暂停：

| 条件 | 阈值（冻结） |
|---|---|
| 完整观察样本数 | ≥ 20 |
| benchmark 覆盖率 | ≥ 0.9 |
| 平均超额收益 | < 0 |
| 超额收益中位数 | < 0（防单次极值） |
| 自动暂停冷却 | 同一策略 30 个自然日内最多 1 次（查 StrategyAutonomyAction 历史） |

执行：`pause_strategy` + 落库 kind=pause 的 action（ruleSnapshot 含上表全部实测值）+
AI 解释文本（失败则缺省）。builtin 策略永不自动暂停（publish/pause tool 已拒绝 builtin，双保险）。

### 3.2 AI 提议

对每个 active 用户策略（含刚被自动暂停的除外），收集实验上下文
（`get_strategy_experiment_context` 既有事实装配），由 AI 生成版本提议：

- 调参：以当前 currentVersion 为 parent 生成 draft（复用 `propose_strategy_version_draft` +
  `create_strategy_version` 链）；
- 创造：AI 也可基于 DSL catalog 提议全新策略——首期收敛为**只提议现有策略的新版本**，
  全新策略创建在 UI/审计成熟后开放（实现约束：`create_strategy` 后的空策略没有 base version，
  晋级门的 base/candidate 关系需要另行定义；列为 M2 后续切片）。

AI 输出必须先过 `validate_strategy_version`（validationStatus=valid 才落库 action 并进入验证）；
invalid 则 action=failed 并记录校验错误。每个策略每周最多 1 个提议；提议与现有 draft 定义相同
（definitionHash 相等）时不重复创建。

### 3.3 自动验证

propose 动作落库后，为候选版本创建独立验证 session（复用 `start_strategy_evaluation_session`
链），action 进入 validating。session 的逐日推进复用既有 evaluation 作业化机制，不在本
workflow 内同步等待。

### 3.4 门禁复核与自动发布

每次 weekly cycle 对所有 status=validating 的 propose action 复核：

1. 验证 session complete 且该版本观察统计满足晋级门输入；
2. 复用 `get_strategy_experiment_context` 的装配逻辑（或抽其公共部分）调用
   `assessStrategyPromotion`（阈值不动：≥20 验证交易日、vintage 覆盖 1.0、≥30 完整观察、
   benchmark 覆盖 ≥0.9）；
3. eligible → `publish_strategy_version`（既有语义：原子切换 currentVersion 并置回 active），
   action → published；
4. blocked → action → blocked，进人工队列，附 reasons 明细。

发布失败（tool 错误）保留 eligible 状态下次重试，记录 attempts。

## 4. 存储与接口

- 新 repository `strategyAutonomyAction`：Drizzle + memory 双实现 + 共享 contract tests；
  Drizzle schema 与 `ensureSchema` DDL 同步，迁移幂等（按 AGENTS.md）。
- 新 tools（全部经 Zod schema，返回 ToolResult）：
  - `list_strategy_autonomy_actions`（read：按 strategy/status/kind/时间过滤）；
  - `confirm_strategy_autonomy_action`（write：blocked → confirmed → 执行 publish）；
  - `reject_strategy_autonomy_action`（write：blocked → rejected）；
  - workflow-only 内部 tool：action 的创建与状态转移（不暴露给 MCP/Agent 的自治写入面）。
- MCP 暴露：list 可读；confirm/reject 属 write，按既有 write opt-in 闸口；自治执行只发生在
  workflow 内，不新增 MCP 写入口。
- 周报新增「AI 管理动作」section（key=`strategy-autonomy-actions`，required=false）：
  本周 action 的 list block（entityKind='strategy' + entityId，detail 含 kind/status/指标摘要）。

## 5. Web

- 策略工作台「设置」tab 内增加该策略的自治动作时间线（复用 read tool）；
- blocked 动作在动作时间线上提供 确认/否决 按钮（write 闸口 + Origin 校验，与既有 mutation 一致）；
- 不新增一级导航。

## 6. 安全与红线

- 不新增自动交易路径；publish/pause 只改变策略生命周期，不产生 Advice 或 Trade；
- 自动动作全部落入既有 JSONL audit log；aiNarrative 落库前过既有 prompt-injection 清理；
- 晋级门阈值、暂停阈值、冷却窗口只允许通过改代码变更，不做成运行期配置（防止静默放宽）；
- AI 故障时：提议步骤跳过（action=failed 或当周无提议），暂停步骤的确定性判定照常执行
  （暂停不依赖 AI，AI 只生成解释）。

## 7. 实施切片

| 切片 | 内容 | 验收 |
|---|---|---|
| M2-S0 | StrategyAutonomyAction 实体、双仓储、DDL、contract tests、registry 接线 | contract tests 通过；迁移幂等 |
| M2-S1 | 自动暂停（§3.1）+ weekly workflow 骨架 + 周报 section | 命中阈值的策略被暂停且 action/周报可见；不命中不动 |
| M2-S2 | AI 提议 + 自动验证 session（§3.2/§3.3） | draft→valid→session 链路；重复提议去重；AI 失败降级 |
| M2-S3 | 门禁复核自动发布 + blocked 人工队列（§3.4 + tools + Web 入口） | eligible 自动发布；blocked 可确认/否决 |
| M2-S4 | 全链路真实运行验收 + 文档同步（PRD 状态、ARCHITECTURE、本 DDD 状态） | 真实周期证据；typecheck/lint/test:all 全绿 |

每片独立可合入（契约与存储 → Tool/Workflow → Web/报告），遵循 development-plan §8 节奏。

## 8. 实施记录（2026-09-02）

M2-S0～S4 全部交付，相对上文设计的实际偏差：

- **evaluation-scope 不变量放宽**：`run_strategy`（persist=true）与双仓储 `isRunnableVersion`
  原要求版本已发布；已放宽为 evaluation scope（`publication=non-publishing`）允许绑定未发布
  valid 版本，operational 拒绝语义不变，并有 contract test 钉住。这是自治验证（以及 Web 实验页
  既有「独立验证」）能对未发布候选版本运行的前置。同步记录于
  [日运行与历史评估可靠性设计](./strategy-daily-cycle-and-replay-detailed-design.md)。
- **调度挂接**：weekly-report 并无既有周调度可挂；实际为独立 scheduler（30 分钟 tick，
  Asia/Shanghai 周日到期），幂等靠确定性 id 的 WorkflowRun 持久事实
  （`strategy-autonomy-weekly:<上海周一日期>`）判重，failed 允许同周重试。
- **session 推进**：workflow 内嵌套调用 `replay-strategy-range`（与 Web startEvaluationJob
  同一 workflow 同一推进序列），partial/failed session 先 resume 再 replay。
- **eligible 滞留重试**：发布失败的 eligible 动作在后续 weekly cycle 直接重试 publish
  （attempts 累加），是 §3.4「保留 eligible 下次重试」的落地。
- **blocked 状态路径**：状态机无 validating→blocked 直达边，实际走 validating→eligible→blocked。
- **自动归档未实施**：按 §1 只做自动暂停；**AI 创造全新策略未开放**（§3.2 已收敛为只提议现有
  策略的新版本），两者均为待用户确认的后续切片。
- 验收：vitest 1789 / test:db 365 / test:web 401 全绿，typecheck、lint 通过；Web 时间线与
  blocked 确认/否决经真实浏览器验收。
