# Vibe-Trading 对 luoome 的参考价值研究

日期：2026-11-25。本文是一次性源码研究快照，建议不等于已批准的产品需求或实施设计。

- 外部基线：HKUDS/Vibe-Trading `2134f408b1cd715c74fa8c5021f4402d50b00ea8`，提交时间 2026-11-25 15:59:37 +08:00。
- 本地基线：luoome `main`、HEAD `7975159aef1f228ff8d974c266dd0aba7e27d35f` 加研究时已有工作树改动。代码事实优先于旧设计和过期库存数字。
- 方法：并行阅读源码、测试、官方说明及技术报告；没有安装或运行 Vibe 的依赖，没有调用真实账户、行情或模型。对 luoome 运行了一次不联网的数值审计函数实验。

## 1. 判断

最值得借鉴的是：**保留结论的证据身份、用独立计算核对评价口径、把研究任务的产出和交付分别验收**。luoome 应继续围绕个人账户的观察、建议、条件计划、提醒与复盘发展；当前优先级是兑现已有能力的可信度，而不是复制完整量化终端。

Vibe 已经是覆盖研究、策略生成、回测、组合、模拟账户、多 Agent 和可选实盘的大型工作台，不适合再按早期聊天选股 demo 评价。[当前产品定位](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/README.md#L163-L179)。luoome 的领域边界则是 advisor-first、单主用户多账户、建议与交易分离，见 [CONTEXT](../../CONTEXT.md) 与 [架构](../ARCHITECTURE.md)。两个项目的优化目标不同，功能广度不能直接作为优劣评分。

luoome 已经研究并迁移过 Vibe。现有 [迁移设计](../ddd/vibe-ashare-report-and-strategy-research-detailed-design.md) 的顶部明确记录了 11-12、11-20 的裁撤；A 股情绪事实仍有价值，旧简报、local_selector、策略研究平台等不能自动变成待补需求。下文仅讨论当前代码上的增量价值。

## 2. Vibe 的真实机制与边界

| 机制 | 本次确认的实现 | 对 luoome 的意义 |
| --- | --- | --- |
| 自然语言研究与策略 | Agent 配合技能生成策略代码，由共享引擎计算交易和指标；输出时序有有限 AST 检查 | 学习“想法→可检验规则→结果”的连续旅程，继续使用现有受限 DSL |
| 可复用研究结果 | ResearchArtifactRevision 保存主体、范围、data_as_of、run_id、证据、内容和来源 hash、前序修订；默认 unverified | 保存当时依据，明确“保存了”与“验证了”的差别 |
| 研究输入冻结 | Research Lab 校验策略和输入 manifest；费用/滑点实验复用冻结数据 | 学习比较实验必须固定数据、价格口径、基准和费用 |
| 真正训练与测试分离 | 有训练集择参、择参结果封存、OOS 与独立 holdout；结果有折级审计导出 | 将来若重新立项历史验证，应采用该方法；当前无需恢复整个平台 |
| 任务回放 | 原 prompt、产物、工具限制、计量与时间分别检查；缺失不伪装成通过 | 可直接借鉴到现有 Agent/StockBrief 的质量验收 |
| 可选实盘 | 有真实代码级授权门控、限额、到期和停止开关；部分通路有 pending 与对账恢复 | 学习执行边界和歧义处理，保持 luoome 不自动下单 |
| 多 Agent | 有工作流依赖和产物交接；有共享行情事实预取 | 先验证一个独立反证角色的价值，避免复制整套组织结构 |

Vibe 的 run card 还把指标绑定到具体 artifact、列、行和文件 hash；只有指标值与已保存 metrics 单元格相等时才产生引用。这个做法比让模型重述一份摘要更适合作为关键数字的展示基础。hash 只能证明指定内容未变，不能证明行情本身真实或结论正确。[指标引用实现](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/backtest/run_card.py#L474-L523)。

出处：[策略时序检查](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/backtest/signal_timing.py)、[研究记录模型](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/research_artifacts/models.py#L9-L42)、[Research Lab 方法和限制](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/guides/research-lab.md)、[任务回放契约](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/evals/harness/README.md)、[共享行情预取](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/swarm/grounding.py#L1-L44)。

必须保留以下限制：

1. **论文中的数值发布门禁不等于当前线上路径。** 技术报告讨论带来源作用域的数值核验、修复与发布；但当前 harness 文档明确数值诊断已移至 `evals.grounding`，不进入 runtime，不做纠错、遮挡或 fallback。主 loop 和 worker 的当前测试允许直接完成研究回答。可借鉴离线审计方法，不能把它说成现成的线上防幻觉保证。[现行边界](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/evals/harness/README.md#L58-L79)、[交付回归](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/tests/test_research_delivery.py#L30-L80)。
2. **旧 window consistency 不是择参后的样本外验证。** 官方指南已把旧 `walk_forward` 输出标为 Window consistency，并明确区分新的训练择参/OOS。新研究方法仍不认证任意用户策略代码在窗口内部没有未来函数。[方法边界](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/guides/research-lab.md#L35-L73)。
3. **AST 检查和受限执行不能当安全沙箱证明。** 官方安全说明要求把生成代码视为可执行软件。luoome 现有 schema/字段白名单 DSL 更符合当前需求，没有理由引入任意 Python 执行。[安全说明](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/SECURITY.md#L23-L27)。
4. **论文没有证明持续盈利。** 报告的真实模型实验为两个合成任务模板各运行两次，另有固定 claim 和边界测试；它证明的是这些任务中的计算、证据与边界行为，不能外推为 A 股 alpha、真实盈利率或多 Agent 的净收益。[技术报告 §4](https://arxiv.org/html/2611.24845v1#S4)。
5. **不能把单一券商恢复方案外推为全部券商 exactly-once。** 先持久化 pending、按 client_order_id 查回的精确恢复存在通路限制，尤其要区分 Alpaca SDK 与其他 connector；逐单批准也不是所有实盘路径的默认行为。[SDK 门控](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/live/sdk_order_gate.py)。

## 3. luoome 已有的基础

下列能力已经存在，后续应复用，不能重复建设：

- 自然语言策略场景已有读 DSL、保存草案、校验和发布流程；策略提议已有 schema、真实 fact id 和 definitionHash 校验；已有基线/草案同样本试跑。[场景](../../packages/tools/src/agent/scenarios.ts)、[策略提议](../../packages/plugins/strategy/src/tools/strategy-proposal.ts)、[策略版本与试跑](../../packages/plugins/strategy/src/tools/strategy-definition.ts)。
- StockFactPack 已按行情、日线、指标、新闻、板块、分时、信号、账户等维度记录来源、dataAsOf 和 unavailable 原因。[事实包](../../packages/toolkit/src/internal/stock-facts.ts)。
- StockBrief 已有事实指纹、并发限制、HTTP/token 预算、规则降级与持久化；不应增加重复的每日报告链路。[批次实现](../../packages/plugins/analysis/src/tools/generate-stock-briefs.ts)。
- Advice、TradingPlan 与盘中确定性监控已有账户指纹、有效期、仓位预算和人工边界；用户明确取消的行业仓位限制不应重新引入。[计划预算](../../packages/core/src/portfolio/trading-plan-budget.ts)、[领域语言](../../CONTEXT.md)。
- 每周成绩单已有 T+1/T+3/T+5 结算、基准、样本、覆盖和 confidence 桶；用户自报盈亏是另一种统计。[结算](../../packages/toolkit/src/tools/settle-advices.ts)、[成绩单](../../packages/toolkit/src/tools/advice-scorecard.ts)、[明确反馈统计](../../packages/toolkit/src/tools/get-advice-stats.ts)。
- DSH 已有子 Agent opt-in、父子权限交集与共享预算；下一步应验证质量收益，而非另建 Agent 框架。[桥接插件](../../packages/dsh-bridge/src/plugin.ts)、[模型预算](../../apps/web/src/dsh/model-budget.ts)、[Tool Gateway](../../apps/web/src/dsh/tool-gateway.ts)。

## 4. P0：让事实引用保留字段身份与当时依据

### 4.1 已确认：数字合法池会漏检错引指标

`numeric-audit.ts` 递归收集整个事实包的数字，再加入字段名周期、部分输出数字以及两数的差/比；普通文本数字只需与其中一个值在容差内匹配。高低开、涨跌幅等有额外语义检查，但这不是通用的主体、指标、时点和单位绑定。[实现](../../packages/toolkit/src/internal/numeric-audit.ts)。

本次运行以下无网络函数实验：

```ts
numericAuditViolations({
  output: { reasoning: { evidence: ['MA20 为 15'] } },
  facts: {
    quote: { close: 15, prevClose: 14 },
    indicators: { ma20: 12 },
  },
  availableFields: ['ma20'],
});
// 实际返回 []，即本项审计未报告违规。
```

这证明该辅助函数可以接受“数字真实存在，但指标引用错误”。这不是一次完整模型生成或 Advice 入库实验，也不意味着其他不变量都能绕过。

建议把**已观察事实**引用为带身份的结构化数据，例如 `{factId, subjectId, field, dataAsOf, unit}`；由确定性代码取值并渲染关键证据，允许的派生运算明确依赖哪些字段。未来目标价、止损与情景假设应另外标记为推断，并保存依据；不能要求预测价已经存在于历史事实中，也不能让预测价反过来证明历史事实。

先在现有 Advice/StockBrief 路径内完成，不新建通用证据平台。验收用正确值错字段、错股票、错日期、百分比/百分点错配四类反例，以及合法引用对照。仅对明确支持的结构化字段承诺校验覆盖，不声称任意自然语言解释已经被机器证明。

### 4.2 已确认：factDigest 不能复原模型当时的完整输入

`analyze-stock.ts` 的模型 payload 包含新闻、板块、分时、信号、市场和账户事实；保存 `Advice.basedOn` 时只存 quote、indicators 和 `dataAsOf: now`。StockBrief 的 digest、来源和缺失元数据不能逆推出原始新闻与板块输入。[生成与保存路径](../../packages/plugins/analysis/src/tools/analyze-stock.ts)、[Advice schema](../../packages/core/src/entity/advice.ts)、[StockBrief schema](../../packages/core/src/entity/stock-brief.ts)。

建议在已有持久对象中保存**实际使用且有大小上限的事实投影**，以及各段来源/数据时间、生成时间、相关模型与提示版本。可以复用现有不可变对象的可解析引用；只有 hash 而无可读取内容不够。无需保存全部供应商响应，无需恢复 Research Vault 或 RAG。

最小验收：生成后改变上游新闻/板块数据，重开数据库，仍能准确读出旧建议当时使用的事实；“查看原判断”与“用新数据重新分析”具有清楚区别。历史结论继续描述历史状态，不能静默拿新行情替换旧依据。

## 5. P0：先核对成绩单，再讨论增加回测

Vibe 的参考价值在于统一引擎、冻结输入、明确成本与独立对账，而不是提供更多胜率数字。luoome 当前结算路径有三项值得优先核对的具体问题：

1. `hitOf` 将 buy 定义为 `returnPct > 0`，sell 与 hold 都为 `excessPct > 0`。如果 sell 表示看空或规避后续损失，这个命中定义需要重定；例如个股上涨 5%、指数上涨 2% 仍会把 sell 判为命中。应先确认产品定义，不能只根据函数名称断言最终语义。[结算 hitOf](../../packages/toolkit/src/tools/settle-advices.ts)。
2. 股票和指数分别取第 h 根日线，没有在此处显式按同一交易日期对齐；停牌或缺 bar 时可能比较不同日期。基准收益从其首根 bar 开始算，第一档基准收益为零，需连同实际查询边界核对起止时间。[结算序列](../../packages/toolkit/src/tools/settle-advices.ts)。
3. 入场价可取建议单价、区间中点或引用收盘价；当前此计算未验证条件是否触达，也未建模费用、滑点和涨跌停可成交性。它不能直接解释为真实可实现收益；用户填报成交价又是另一种来源。[assumedEntryOf 与结算](../../packages/toolkit/src/tools/settle-advices.ts)。

建议先明确三种口径：建议方向的事后观察、条件可成交的纸面结果、用户实际交易结果。当前优先把第一种算对、标清；第二种只有真实需求出现时再立项，第三种继续基于明确反馈和成交引用。

验收采用可手算的买入、卖出、停牌/缺日线、节假日、条件未触达案例，让独立预期值核对同日个股与基准收益。结算成熟度按交易日定义。保留样本数、缺失覆盖和规则观察分列；confidence 桶与“50 条/60%”门槛只是内部观察标准，不是统计显著性或未来盈利证明。[成绩单实现](../../packages/toolkit/src/tools/advice-scorecard.ts)、[反馈口径](../../CONTEXT.md)。

若以后重新建设历史策略验证，再单独定义训练/验证/最终留出、时间可用性、复权、退市样本、费用和多次试验偏差。应复用确定性 DSL 和引擎；现阶段不用恢复已裁撤的完整严格回测体系。

## 6. P0：建立小规模任务回放与连续真实验收

借鉴 Vibe 的任务回放方式，将计算正确、记录完整、最终交付、权限边界、时效与成本分别评分。缺失测量显示未评估，不能因为其他断言通过就标全绿。[回放契约](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/evals/harness/README.md#L34-L79)。

luoome 已有 StockBrief 回归 fixtures，本次建议是扩展现有测试和审计：

| 用例 | 独立验收内容 |
| --- | --- |
| 相同数值出现在不同字段/主体/日期 | 错引被识别，正确引用通过 |
| 缺行情、新闻或足量指标 | 缺失保留，不编造、不伪装为完整 AI 结论 |
| 账户变化或旧计划过期 | 原计划阻断，不能继续作为当前动作 |
| 结算遇停牌、缺 bar、节假日 | 同日比较；未成熟或不足保持未覆盖 |
| 模型预算耗尽或失败 | 正确降级；规则观察不混入 AI 成绩 |
| 生成成功但通知失败 | 记录生成与送达的不同结果；重试保持受限 |
| 上游内容更新后查看旧结论 | 显示旧证据，重新分析产生新观察 |

最新 [StockBrief 验收快照](./daily-stock-brief-acceptance-20261124.md) 已明确：真实批次 P95、实际日费用与 17:45 覆盖率仍待运行观测。应沿现有 WorkflowRun/StockBrief 审计补连续真实交易日证据，先看持仓覆盖率、AI/规则/不可用占比、引用错误、准时率、HTTP/token/金额和重试。不需要先新增历史观测数据库或监控平台；使用脱敏汇总，不输出私人账户数据。

## 7. P1：打磨已有旅程，受控验证反证角色

### 策略创作

把现有能力组织成用户能检查的连续结果：自然语言想法 → 白名单规则解释 → 参数与所需数据 → 基线差异 → 同样本试跑 → 明确确认发布。缺口是旅程和解释，不是缺少版本化策略或缺少 AI。

例如用户说“找放量突破的票”，需要看到实际采用的量比/均线/突破窗口、排除条件、未知数据，以及哪些股票因什么规则进入；不能让模型自由补出目录外指标。版本变更继续生成草案，经既有 schema/validate/publish 契约处理。[场景与草案](../../packages/tools/src/agent/scenarios.ts)、[规则版本](../../packages/plugins/strategy/src/tools/strategy-definition.ts)。

### 独立反证检查

先试“一次主要研究 + 一个独立反证角色”，只对用户显式请求的深研开放。两个角色读取同一份冻结事实、分别提交证据引用与反证，不通过多票共识提高 confidence。复用已有 DSH 权限交集、账户隔离、截止时间和共享预算；额度不足时按既有策略降级，不扩大默认每日研究费用。

以固定任务对照单 Agent 与增加反证角色：新增有效反证数量、错引/数字错误、风险遗漏、耗时和费用。只有出现可重复的净收益才扩大使用。Vibe 的多 Agent 产品能力与论文的计算任务实验不能证明该方案会改善 luoome 的投资结果。[Vibe 依赖编排](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/swarm/runtime.py)、[luoome 子 Agent 机制](../../packages/dsh-bridge/src/plugin.ts)。

### 解释今天为何变化

在保存足够旧事实之后，先比较少数影响决策的变化：价格结构、策略信号、原反证是否出现、账户是否改变。旧结论与当前状态并排可读，比新增通用研究记忆更贴近个人用户。复用 Advice、StockBrief 和 TradingPlan，避免新增另一套研究生命周期。

## 8. 执行安全可借什么

Vibe 的 live/runtime 与 sdk_order_gate 值得借鉴的是：授权在真实执行边界重查；写操作不因网络超时盲重试；外部结果未知时先以稳定身份查回，歧义保持阻塞。这些原则适用于 luoome 的通知、外部服务调用及受控写入，但具体能否精确去重取决于外部服务是否提供回执或幂等键，不能凭本地状态宣称 exactly-once。[实盘运行时](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/live/runtime/runner.py)、[SDK 执行门控](https://github.com/HKUDS/Vibe-Trading/blob/2134f408b1cd715c74fa8c5021f4402d50b00ea8/agent/src/live/sdk_order_gate.py)。

luoome 已有盘中执行租约、投递前保存尝试次数、受限退避与权限开关，应先验证现有机制，不另建订单式授权系统。继续保持 trade 不经 MCP、Advice 不触发交易、write/external 显式授权。[安全契约](../SECURITY.md)、[提醒语义](../../CONTEXT.md)。

## 9. 建议顺序与投入范围

以下范围是技术判断，不是工期承诺，也没有启动实施。

| 顺序 | 建议 | 范围判断 | 完成标准 |
| --- | --- | --- | --- |
| P0-1 | 修订结算定义并用独立小案例核对 | 小到中；先澄清 sell/日期/成交假设 | 每种口径可手算，缺失和未成熟不伪造 |
| P0-2 | 关键事实字段绑定 + 保存实际用到的事实投影 | 中；涉及 core/schema/保存/展示契约 | 错字段/错主体/错时点用例失败，旧证据可重读 |
| P0-3 | 扩展现有回归并补连续真实运行观测 | 小到中；复用当前测试与审计 | 质量、覆盖、交付、时间、费用各有真实分母 |
| P1-1 | 顺畅的策略草案、差异、试跑、确认旅程 | 中；复用已有工具与 Web | 用户能说明规则含义和发布影响 |
| P1-2 | 可选反证角色对照实验 | 中；基于现有 DSH | 同输入下证明质量收益和增量成本 |
| 后置 | 费用敏感性、OOS/holdout 等研究平台 | 大；需重新立项和可靠历史数据 | 有明确个人需求后再设计 |

当前不建议复制：自动下单、多券商执行、任意生成代码执行、完整因子市场、整套 Research Vault、自动策略晋级、更多日报、React 技术栈迁移或为了对标而扩张角色数量。这些要么违背当前边界，要么是已主动裁撤的复杂度。

## 10. 本次验证与限制

- 已核对外部固定提交的文档、核心实现和相邻测试；未运行 Vibe 测试，不把阅读测试视为本次执行通过。
- 已运行上文数值审计最小实验，实际返回 `[]`；只证明该函数在该输入下的行为。
- 结算部分是代码级风险识别与口径待确认项，未读取真实数据库，也未计算真实账户成绩。
- 本文与导航属于文档变更，交付时检查本地 Markdown 链接和 `git diff --check`；未进行代码修改，不重跑全量业务测试。
