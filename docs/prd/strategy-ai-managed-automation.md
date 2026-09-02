# 策略自动化与 AI 管理 PRD

> 状态：已确认立项（2026-09-01）
> 上位约束：[CONTEXT.md](../../CONTEXT.md)、[架构说明](../ARCHITECTURE.md)、[安全说明](../SECURITY.md)
> 关联文档：[策略工作台 PRD](./strategy-v2.md)、[Strategy DSL PRD](./strategy-dsl.md)、
> [AI 投资决策闭环产品总纲](./ai-investment-decision-loop.md)、
> [Strategy 实验、晋级与反馈闭环详细设计](../ddd/strategy-experiment-feedback-detailed-design.md)

## 1. 文档结论

策略功能的迭代方向从"工具集合"转为"AI 管理的自动化闭环 + 报告中心"：

```text
StrategySchedule 自动运行（已存在）
  → daily-cycle 末尾自动候选分析（Top N 信号自动产出 Advice）
  → 收盘报告"策略行动"section（事实层 + AI 解读层）
  → 每周策略复盘（观察统计 → AI 提议）
  → 提议自动进入独立验证（≥20 交易日、≥30 观察，阈值不动）
  → 晋级门通过自动发布 / 不通过进人工队列
  → 暂停与归档按确定性规则自动执行并在报告中通知
```

两个里程碑：M1 报告中心先行，M2 AI 生命周期管理后置；M1 的自动候选分析是 M2 的执行通道前置。

**本文 supersede 的既有契约**（详见 §7）：

- [策略工作台 PRD §7.3](./strategy-v2.md) "Strategy 工作台不会自动生成 Advice"——自动候选分析在
  daily-cycle 中自动产出 Advice；
- [策略工作台 PRD §6.9/§8](./strategy-v2.md) 与开发计划 §9.2 "发布、暂停必须人工确认"——改为
  晋级门/确定性规则通过后的自动执行。

## 2. 背景与问题

现状痛点（来自 2026-09-01 方向讨论，用户即唯一使用者）：

1. 策略能自动跑，但**跑完没后续**：结果需要人工逐个打开分析，自动化在"运行"处断掉；
2. 工作台的实验、AI 洞察、闭环等功能复杂，实际看不懂、用不上；
3. 策略有效性验证依赖 SignalObservation 前向证据，但证据没有被人（或 AI）系统性消费。

数据约束：本方向**只使用行情数据**；不获取公司行动与财务数据。因此严格回测八项门禁与
基本面因子（P3-3～P3-5）从候选方向中移除，不是降级而是删除。

## 3. 目标与非目标

### 3.1 目标

1. 每日收盘后零人工操作即可看到"今日行动清单"：Top N 信号含完整 Advice，其余一行事实；
2. 每周自动产出策略层复盘：基于 SignalObservation 统计给出加关注/暂停建议；
3. AI 可调整现有策略参数，也可基于 DSL catalog 创造新策略；
4. 暂停/归档全自动；发布经晋级门自动放行；全程动作在报告中可审计；
5. Web 首页即最新收盘报告；实验/洞察/闭环等复杂功能收深导航，代码不删。

### 3.2 非目标

- 自动交易（永久红线，Strategy、AlertPlan、WatchTrigger、Advice 均不得自动下单）；
- 严格回测门禁补全、基本面因子接入 DSL（因数据约束移除出候选）；
- AI 管理运行运维（重试、lease、reconcile 保持确定性代码，不引入 LLM）；
- AI 策略组合编排（权重分配、信号冲突仲裁）；
- 盘中 AI 实时决策（盘中提醒继续走现有 AlertPlan/Trigger 确定性链路）；
- 新建独立报告实体或推送通道（复用现有 Report 与 Trigger 送达链）。

## 4. 关键决策

### 4.1 报告为产品主入口

扩展现有 closing/weekly report，不新建报告体系：

- closing-report 增加"策略行动" section；weekly-report 增加"策略复盘" section；
- Web 首页直接渲染最新收盘报告；Strategy Workspace 各复杂 tab 只收深导航，代码与测试不动；
- 报告 block 继续遵守既有不变量：不含 Advice 决策字段（decision/positionSize/stopLoss/
  takeProfit/confidence），行动清单以 `entityKind='advice'` 链接引用 Advice 本体。

### 4.2 行动清单 section 分两层，`required=false`

- **事实层**（确定性，不依赖 AI）：当日 published 信号、统计计数、Advice 链接，永远能产出；
- **AI 解读层**（text block）：AI 失败时只缺本层，进入 `missingDimensions`，报告主体不受影响。

### 4.3 自动候选分析的数量与深度

- daily-cycle 末尾对当日 published 信号，经 RecommendationPolicy V2 确定性预检后取 Top N
  （配置项，默认 10）自动执行 `analyze_strategy_candidate` 产出 Advice；
- Top N 出完整 Advice（证据+反证+风险+有效期）；其余信号只在报告中一行事实带过；
- N 为报告配置项；行动清单的价值在少而准，不设上限等于没有清单。

### 4.4 AI 自主权边界（分级）

| 操作 | 自主权 |
|---|---|
| 暂停 / 归档策略 | 全自动；触发条件为确定性统计规则，AI 只生成解释文本；结果进日报/周报通知 |
| 发布新版本（含 AI 创造的全新策略） | AI 提议 → 独立验证 session（≥20 交易日、≥30 完整观察、benchmark 覆盖 ≥90%，阈值不动）→ `assessStrategyPromotion` eligible → 自动 publish；blocked 进待确认队列人工处理 |
| 修改已发布版本 | 禁止（既有不变量，不变） |

晋级门是确定性代码自动执行，"人工确认"被"门禁自动放行"替代；新策略从提议到生效天然有
验证期，这是护栏而非缺陷。任何自动动作写审计并在报告中可见。

### 4.5 AI 可创造策略，但走同一管线

AI 可基于 DSL catalog 从头组合新策略（不限于调参）。全新策略没有 base version，以 draft 身份
进入验证 session，满足同一晋级门后自动发布；无例外路径。

### 4.6 只用行情数据

策略信号、观察统计、AI 提议的证据全部来自行情面（量价、天梯、情绪等已有行情类字段）。
不引入公司行动、财务数据源；严格回测与基本面因子两项既有收口工作从计划中移除。

## 5. M1：报告中心

### 任务

1. **自动候选分析接线**：`strategy-daily-cycle` 末尾对当日 published 信号按 §4.3 自动分析。
   2026-09-01 复核：该链路已存在（schedule 级 `recommendationPolicy` + RecommendationPolicy V2 预检 +
   `analyze_strategy_candidate`，`maxPerRun` 即 Top N），本里程碑不重复建设，M1 只新增报告呈现；
   分析失败不回滚已发布 run 与观察事实（既有语义不变）。
2. **closing-report "策略行动" section**：按 §4.1/§4.2 实现两层结构。
3. **weekly-report "策略复盘" section**：基于 `get_signal_observation_stats` 的策略级统计
   （样本量、超额收益、benchmark 覆盖）+ AI 文本建议；本阶段建议仅展示，不自动执行。
4. **Web 首页改版**：首页渲染最新收盘报告；实验/AI 洞察/闭环 tab 收深导航（只动路由与导航）。
5. 配置项：Top N 上限。
6. 测试：closing/weekly report 新 section 的 workflow 测试、daily-cycle 接线测试、Web 前端
   测试与真实浏览器验收（按 AGENTS.md 要求）。

### 验收

- 每日收盘后无需人工操作，打开首页即见"今日信号 Top 10 + 完整建议 + 其余事实清单"；
- AI 服务不可用时报告主体照常生成，仅解读层缺失并标注；
- 报告 block 不含 Advice 决策字段，完整建议经链接进入 Advice 本体；
- `bun run test:all`、`typecheck`、`lint` 通过；Web 改动完成真实浏览器验收。

## 6. M2：AI 策略生命周期管理

### 任务

1. **提议管道**：按周报复盘节奏（或观察样本达标触发），AI 基于观察统计与 DSL catalog 生成
   版本提议（调参或新策略 draft），落库并在周报可见；复用 `propose_strategy_version_draft`。
2. **自动验证**：提议自动创建独立验证 session（复用 strategy-evaluation / replay 链）。
3. **门禁自动放行**：`assessStrategyPromotion` 返回 eligible-for-human-review 后自动接 publish；
   blocked 进待确认队列，Web 提供一键确认/否决。
4. **自动暂停/归档**：确定性统计触发规则（如近 N 周期超额收益显著为负且样本达标，阈值在
   实现前冻结进 DDD），AI 生成解释文本；执行结果进日报/周报。
5. **周报 "AI 管理动作" section**：本周提议、验证进度、发布、暂停的完整审计记录。

### 验收

- 从"AI 提议参数调整"到"验证通过自动发布"全程零人工；
- 全新 AI 策略同样经验证期后自动发布；
- 每个自动动作（提议/发布/暂停）在报告中可追溯；
- 门禁 blocked 的提议不静默丢弃，进入人工队列。

## 7. 与既有契约的关系

| 既有契约 | 变化 |
|---|---|
| 策略工作台 PRD §7.3"不自动生成 Advice" | supersede：daily-cycle 自动候选分析产出 Advice，仍保留证据/反证/有效期/免责声明 |
| 策略工作台 PRD §6.9/§8、开发计划 §9.2"发布必须人工确认" | supersede：发布改为晋级门自动放行；晋级门阈值不变 |
| CONTEXT.md "版本必须先校验再发布" | 不变：validate 与晋级门均在发布前执行 |
| publication 运行发布门（core/strategy/publication.ts） | 不变：本 PRD 只改版本发布路径，不改 run 发布门 |
| Signal ≠ Advice ≠ Trade | 不变：自动产出的仍是 Advice，永不触发交易 |
| 严格回测、基本面因子 | 从候选方向移除（数据约束），代码保留但不继续投入 |

## 8. 副作用与权限

| 操作 | 副作用 | 确认要求 |
|---|---|---|
| 自动候选分析、生成 Advice | advice / 受控 LLM | 无需逐条确认；Top N 与启停为配置项 |
| AI 创建版本 draft | write | 自动，落库可审计 |
| 验证 session 创建与执行 | write + external（行情） | 自动 |
| 发布（晋级门通过后） | write | 门禁自动放行；blocked 转人工 |
| 暂停 / 归档 | write | 自动（确定性规则触发）+ 报告通知 |
| 报告生成与送达 | 既有 report/delivery 语义 | 不变 |

trade 永不通过 MCP 暴露的硬卡不变；自动动作全部落入既有 JSONL audit log。

## 9. 风险

| 风险 | 控制措施 |
|---|---|
| AI 提议质量未知 | M2 上线初期人工查看提议内容（校准而非审批）；晋级门兜底 |
| 验证期拉长迭代节奏 | 接受；门禁阈值不动，迭代瓶颈在观察样本而非流程 |
| AI 故障导致报告无解读 | 两层 section + `required=false`；故障进入 missingDimensions 可见 |
| 自动暂停误杀 | 触发规则确定性、阈值进 DDD 冻结；暂停可逆，报告中可追踪恢复 |
| Advice 自动产出放大噪声 | Top N 上限 + RecommendationPolicy V2 预检；Advice 保留反证与有效期 |
