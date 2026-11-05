# AI 投资协作首页详细设计

> 初稿：2026-10-16；入口与领域契约核对：2026-11-05。依据：[PRD](../prd/ai-investment-workspace.md)、[任务与文件归属](../archive/ai-investment-workspace-development-plan.md)（已归档）。真实供应商与真机验收单独记录，不由 fixture 代替。
>
> **当前状态**：默认产品入口是 DSH 插件。本文的旧 Web 首页 API、会话、草案确认、浏览器恢复与通知路由属于阶段设计，不代表当前插件提供相同入口。InvestmentWorkspace 的研究、共识与跟踪领域能力已实现，默认插件只开放 `get_investment_workspace`；`save_investment_consensus`、`set_investment_tracking` 尚未接入默认 Operation policy，`get_investment_candidates` 也未进入默认读面。方向研究写回沿用已有分析入口；完整的共识确认与方向跟踪旅程尚未接通。以下账户事实、逐股计划与方向主体的领域契约仍有效，不因旧 Web 方案退役而删除。
>
> 当前入口核对：[`production-config.ts`](../../packages/dsh-luoome/src/host/production-config.ts)、[`production.ts`](../../packages/dsh-luoome/src/host/production.ts)；领域工具库存：[`registry.ts`](../../packages/tools/src/registry.ts)。

## 首页信息流

首页以助手开场、持仓变化、参与方向、计划进展组织。事实通过现有 tools 获取，分别返回 ToolResult，单区失败不清空其它区域。开场明确标注“事实摘要”，不将确定性计数写成 AI 判断。研究结果独立展示，未研究、失败、数据不足与研究后等待分开；默认零现金账户显示“尚未核实登记”，不推断真实资金。

保留原看盘内容和完整历史入口。持仓只展示合格账户事实中的估值，缺失行情不沿用成本价冒充现价。计划复用 `list_trading_plans(currentOnly=true, includeMonitoring=true)` 的版本和资格投影；`ready` 仅表示资格，后台检查时间来自真实运行，不意味着已监控或已送达。

## 主体引用与服务端可信边界

`POST /api/chat` 增加 `subjects`（最多 4 个）。持仓引用携带 holding id 与服务端生成的内容哈希，计划引用携带确切 version id；Advice、Trigger、Report 使用不可变 id。方向引用 researchId + directionId，共识引用 id + version。客户端仅提供引用和本轮 user 文本，不提供可信标签、事实、助手或执行结果。服务端先读取当前账户拥有的会话，再经 tools 解析引用；跨账户、版本不符、已删除主体拒绝并要求刷新。过期计划/建议可讨论历史，但上下文必须携带当前资格、有效期与禁止沿用行动措辞的限制。

服务端在 user message 的 `data-luoome-subjects` part 保存已核验的引用、标签与核验时间。每轮重新读取主体事实；该标签不冒充历史事实快照，方向/共识及计划的不可变版本负责追溯。未指定主体时沿用会话最近主体；显式空数组回到全局讨论。跨卡比较列出所有主体及各自证据，提示模型逐项区分。每轮独立读取结构化当前共识，不依赖最近 20 条聊天文本。

行情资格、账户指纹、计划截止遵守已有 core 规则，不在 Web 复制阈值。历史事实保留 observedAt / dataAsOf / validUntil；界面刷新时间仅是读取时间。方向研究的数据分类与阈值见[方向研究与共识契约](#方向研究与共识契约)。

## 同一会话、多种视图

首页、卡片内简短追问、完整讨论移动同一个聊天挂载节点，共用服务端 session、feed、草案状态和请求控制器。主体切换与发问分开；每条历史问题保留当时主体标签。关闭/返回仅退出视图，不取消已授权跟踪；“停止回答”仅中断当前流。草案确认沿用服务端存储输入与原子认领，执行中/成功/失败分别展示，未知状态先读取会话核对，不自动重放写入。

浏览器 history 保存展开层级与来源卡片滚动位置；返回先退出完整讨论，再退出就地讨论并恢复来源。流式渲染只在用户已靠近底部时跟随，阅读旧消息时保留滚动锚点，提供“查看新内容”。输入支持多行与输入法，组合输入中的 Enter 不提交；使用动态视口、visualViewport 与安全区域，手机不使用固定 500px 高度。

## 恢复与身份

会话与消息由服务端 tools 持久化。当前 session、主体引用、未发送文本仅保存在当前浏览器 sessionStorage，并按 account 分区；退出、认证失效、账户变化立即清理、终止旧请求、清空挂载内容。读取响应附 view/identity epoch，旧账户迟到响应不可覆盖新界面。刷新后先读会话和真实草案结算；断线不自动重发 mutation。服务端对相同本轮消息 id 做幂等检查，不重复启动同一次模型请求；中断后由用户显式继续。

首页进入讨论和准备草案在每次异步等待后重新核对身份；关闭讨论或打开另一主体使旧打开请求失效。成交/复盘的迟到响应在写入浏览器未决请求状态前再次核对账户 epoch，切走再切回同一账户也不接收旧响应。首页完成实际成交登记后重新读取账户事实和计划进展。

单机形态没有租户与登录态：服务端按当前账户绑定上下文，浏览器侧执行 write/external opt-in 和已有账户 header，并保留同源 Origin 校验。trade 不进入模型/MCP/generic API；记录实际成交复用 DecisionReview 专用入口，数量、价格、时间与尚未入账确认由用户提供。删除聊天不撤销已确认共识或跟踪。

## 方向、共识与通知集成

旧 Web 首页阶段设计读取 `get_investment_workspace` 与 `get_investment_candidates`；正式方向研究、共识修订与跟踪开关通过 `POST /api/workspace/drafts` 保存服务端草案，再由 `settle_chat_draft` 原子确认。该流程只接受这三项明确操作，服务端建立真实 user message 来源，不接受客户端助手或执行结果；共识保存与跟踪启动结果分别显示。这些路由和确认步骤不是当前默认 DSH 插件的入口承诺；当前可用范围以上述状态说明为准。

方向以 `opportunityType` 区分已发布策略选择和市场参与研究。未指定策略且没有合格策略运行时，读取实际市场广度、指数及事件池情绪；市场方向携带快照来源、事实时间和明确覆盖，不填造策略或运行 ID。页面按 `coverage.kind` 分别显示策略覆盖/入选数和市场实际观察范围；证据区同时显示供应商、对应时间和获取时间。

`trackingEligibility` 决定是否提供连接入口，页面展示不能跟踪的具体原因。市场方向尚无真实股票候选映射时仍可保存共识，但不能创建个股跟踪；混合共识只连接真实策略方向并显示未映射原因。市场事实到期时当前共识投影为待复核；历史版本保留。盘中事实有效期为对应时间后 20 分钟与当日收盘的较早值，收盘事实有效至下一交易日开盘，不能以抓取时间延长。

`GET /api/watch/notifications/:triggerId` 调用私有 resolver，仅作为专用鉴权入口，不进入模型/MCP/generic registry。`#alerts?triggerId=…` 保留进入时的目标，打开时同时显示触发快照和最新资格；`#reports?reportId=…` 读取确切报告，无权或删除时不以其它报告替代。复盘复用专用成交登记与显式来源链；未决成交回执在浏览器按 account 分区。

方向研究由 DSH 侧的分析读面与精确写回入口承载，不再有托管计量账本；共识与跟踪仍遵守本文领域契约，尚待接入默认插件入口。通知走本机配置的飞书链路：unknown 不盲重发，accepted 不生成设备回执。当前逐股计划、关注和事件预警都走同一条飞书 watchDelivery，不能据此宣称这些提醒已可在手机到达。盘中计划的批处理由 DSH 定时任务调用批处理工具执行；候选同步未开启 StrategySchedule 时明确 partial。

### 方向研究与共识契约

本节承接领域实现细节；依据为 [`investment-workspace.ts`](../../packages/core/src/entity/investment-workspace.ts)、[工作区工具](../../packages/tools/src/tools/investment-workspace.ts)和[订阅同步工具](../../packages/tools/src/tools/strategy-watchlist-subscription.ts)。它描述已实现能力，不表示完整旅程已暴露到默认插件。

- **事实来源与范围**：参与方向有来源、覆盖范围和事实时间，新用户无需先配置 Strategy。`strategy-selection` 引用真实 published StrategyRun 与规则，保留确切 Strategy、版本和运行身份。无合格预设策略时，`market-participation` 可引用市场广度、A 股指数、封板/炸板情绪和供应商事件池行业分布的不可变快照，不填造 strategyId/runId。最多比较三个方向，不由有限股票样本或事件池外推全市场，不把池内行业计数当完整板块行情或个股主题映射；缺公告/新闻不补造催化。缺合格事实返回 unavailable；模型或引用失败返回 failed，保留问题与实际事实。
- **证据时效**：策略证据在下一交易日上海时间 16:30 到期；市场盘中事实在 observedAt 后 20 分钟或当日 15:00 的较早时点到期，收盘事实至下一交易日 09:30。来源 unknown/stale、未来事实及超出相应有效窗口的事实不作为当前依据，fetchedAt 不刷新事实时间。IndexQuote 可显式提供 observedAt/fetchedAt/timestampSource；旧 Tencent 上游 ts 可核验使用，旧 Eastmoney 抓取时间 ts 不作为市场研究事实时间。真实供应商覆盖与质量另验。
- **共识版本与效力**：InvestmentConsensus 按用户与账户追加不可变版本，保存主次/回避方向、用户理由、系统反对、明确约束、近期意愿、讨论文本快照、复核与有效期。并发确认比较 expectedVersion，版本过期须刷新后再确认；修改时省略字段保留旧值。删除聊天不撤销共识，近期意愿过复核时间不再作为当前授权。方向始终 research-only，用户坚持不使数据或账户硬约束失效。
- **映射资格**：市场方向可以确认并跨日保留共识，尚无真实 Strategy 与股票候选映射时不开启个股跟踪。trackingEligibility 说明映射缺口，混合共识仅连接已映射策略并列出 unmappedDirections。确认方向不自动创建或发布 Strategy，也不生成第二套逐股仓位与退出规则。
- **跟踪与共识分开**：InvestmentTracking 使用 starting / tracking / partial / failed / paused，保存共识成功不等于跟踪成功。跟踪只连接专用 Watchlist、Strategy 订阅与已有发布运行，不开启新的付费研究、自动调度或通知。订阅绑定确切共识和 Strategy 版本；换版、共识/意愿复核到期或暂停新机会时，停止同步新候选。共识修订暂停本功能旧方向候选同步，重新开启需独立确认，不修改已有持仓、TradingPlan 或持仓风险提醒。
- **恢复与运行证据**：失败可用新请求重试并复用专用列表；starting 表示仍在执行或结果待核对，须先核对实际状态。候选已同步但未启用策略调度时仍为 partial；tracking 只表示接线完成，后台执行与投递以既有运行审计为准。个股研究复用策略候选分析能力，默认插件走 get_analysis_context / record_advice；领域内原有 analyze_strategy_candidate 不因此成为默认插件新入口。计划与预算复用 Advice / TradingPlan，同股多方向合并来源，不重复创建仓位规则。

## 账户事实与逐股计划实现契约

本节记录当前账户与 TradingPlan 的存储、算法及执行契约，承接领域词表中的实现细节。它们是已有实现与决定，不是本次新增产品需求。实现落点：[现金账本](../../packages/core/src/portfolio/ledger.ts)、[TradingPlan](../../packages/core/src/entity/trading-plan.ts)、[计划预算](../../packages/core/src/portfolio/trading-plan-budget.ts)、[日波动率工具](../../packages/tools/src/tools/get-daily-volatility.ts)、[计划日循环](../../packages/workflows/src/trading-plan-daily-cycle.ts)和[计划读写工具](../../packages/tools/src/tools/trading-plan.ts)。

### 账户现金、对账与迁移

现金是 Account.cashBalance 上保存的余额：开户即入金等于本金，之后由交易、持仓改动与资金流水在同一事务内增减。账本口径集中在 ledger：买卖按数量 × 成交价，不计交易手续费；登记/加仓扣成本，减仓/平仓回补成本；入金/转入/分红加，出金/转出/费/税减。余额写入后不允许为负，超买或超额出金须先纠错。现金读取、增减与余额校验在同一写事务内完成；持仓写入核对读取时的旧值，冲突时要求刷新重试。

AccountFacts 是仓位计算的唯一账户输入：现金余额 + 当前持仓 × 合格行情。有数量的任一持仓缺少达到决策资格的行情时标 unavailable 并给原因，不给精确仓位与可执行建仓建议。digest 是持仓、现金和本金的指纹；计划据此识别账户前提变化，账本变更后旧计划失效，不继续沿用旧分母。

HoldingCashAdjustment 记录登记、纠错和平仓的现金变动与数量差额，与持仓、现金同事务保存并随账户数据导出。`reconcile_account_cash` 按本金、交易、资金流水和持仓调整重放现金，数量覆盖同时计入调整记录，不用剩余持仓猜已卖出部分成本。现金差额、数量缺口或历史负余额均使账户事实 unavailable，不给精确资产和仓位。分红送转等公司行为不自动改现金，由用户通过资金流水或纠错登记。

旧库首次增加现金列时，按历史交易、资金流水及可恢复的未覆盖持仓成本回填，不直接回填本金。可恢复成本保存为迁移调整记录；建列、调整记录及余额回填原子提交，可重复启动，已有非空现金字段不被覆盖。未记录的已卖出成本或纠错历史不凭当前持仓补造；对账保留差额与缺口，不假定迁移账户已核对完成。

旧 AccountSnapshot 手工核对模型已整体移除：实体、仓储、新库表、save/get/list_account_snapshot 工具、Web 入口和导出分类均下线；analyze_position 不接受 account-snapshot-position 引用。旧库残留 account_snapshots 表没有代码读写，不作为账户事实来源。旧快照计划保留读取，启动迁移将 active/draft 标 expired 并保留旧快照身份，不转换成当前账户指纹。

### 计划身份、存储一致性与历史可读

TradingPlan 回答账户内某只股票的行动条件、目标仓位、持有周期与失效条件。id 由账户和股票稳定派生，版本不可变；plan_json 是唯一完整领域载荷，外层 version_id、status、有效期等列为存储元数据，必须与载荷一致。写路径与导入校验器强制一致性；数据库有意不设 CHECK 约束，以保留旧单值、无结构化失效条件计划的历史可读性。

观察、建仓、加仓、持有、减仓、退出、回避等动作与价格方向分开，入场使用价格区间。旧单值 targetPct 读取时归一化为退化区间 `{t,t}`，不改写 plan_json；旧计划缺少后引入的波动率窗口字段时，读侧不强制补齐。

来源 Advice 为 buy 或给出价位/目标仓位时，买点、止损与目标价必须同时存在；按 money 持久化精度满足 `0 < stopLoss < entryPrice < targetPrice`。入场区间上下限成对给出，买点落在区间内，止损低于下限、上限低于目标价；buy 还必须提供入场区间及目标仓位。交互 `record_advice` 对新买入建议进一步要求非退化目标仓位区间，存量单值建议仍可读取。精确校验见 [Advice schema](../../packages/core/src/entity/advice.ts)及[写回工具](../../packages/tools/src/queue/record.ts)，不据旧模型适配器的重试次数描述当前流程。

### 仓位区间与波动率选点

目标仓位 targetPctRange{min,max} 用百分点表示（0–100，与 currentPct、单票上限同量纲）。计划保存 rangePick（lower-bound / mid / volatility-scaled）、实际 appliedPct 和恒等于区间下限的 fallbackPct；volatility-scaled 必须带可复算参数。区间宽度不得超过「分层上限（max≤10 为 4、max≤20 为 6、其余为 8）」与 `0.30 × max` 的较小值。add/hold 要求 min>0，exit/avoid 只允许 `{0,0}`；observe 未设条件仓位时允许 `{0,0}`。退化区间 min=max 没有可选点，仍记 lower-bound。deltaPct 不持久化，读取时由 min/max−currentPct 派生 deltaPctMin/Max。

波动率取规范 daily_bars 最近 21 根 bar 的收盘价环比，计算 20 个交易日日收益率的总体标准差 σ，单位为百分点，与 volatility-20 同一定义。按 bar 取样，不用最近 21 个自然日替代；只有正好相差一个交易日、两端均有成交的 bar 对才产生收益率。跨断档的收益率是多日收益，不进入日收益样本；零成交 bar 视为占位。volume 仅判断有无真实成交，不参与 σ 数值计算。窗口必须有 20 个有效收益率，不足为 insufficient-volatility。

选点取 `min + (max−min) × bandFractionPct / 100`，按持久化精度复算：

| σ 上限（百分点） | 占区间宽度 |
|---|---|
| 1.5 | 100% |
| 2.5 | 67% |
| 4 | 33% |
| 6 | 0% |

超过 6 无匹配档位时落至下限。低但有效的波动率（如约 1%）取区间上限，appliedPct 可大于 min；这保留“波动小可用满计划仓位”的既有决定。lower-bound 和旧单值路径不变，fallbackPct 仍为 min。

σ 与 rangePick.windowStart/windowEnd/barsCount 随计划保存；maxGapTradingDays 记录相邻 bar 缺失的交易日数，支持仅凭计划核对计算窗口。日波动率回执中的 returnsCount、zeroVolumeBars、maxGapTradingDays 区分跨断档、零成交和 σ 过低；ok 项的 maxGapTradingDays 恒为 0。

样本防护不依赖 provider 必然省略停牌 bar：sync_daily_bars 仅丢弃未收盘的当日 bar，既不丢 volume=0，也不校验 bar 日期为交易日；adapter 仅过滤非正 OHLC。零成交占位 bar 即使收盘微动、最新日期很近，也不因此成为有效日收益率样本。

### 样本资格、阈值与降级

选点前依次核对样本和新鲜度，任一不满足时取 lower-bound，在 constraintReasons 留下原因及实际阈值：

- 日线不足、收盘非正或日期乱序时，波动率不可用，不猜 σ。
- 有效收益率不足 20 个，或 σ 低于默认 0.1 时，按 insufficient-volatility 处理。σ 贴近零表示样本无效，不能解释成最安全并给最大仓位。
- 最新日线距 asOf 超过默认 5 个交易日时按样本过期降级；这与样本本身无效分开表达。

0.1 与 5 都是未标定的经验默认值。get_daily_volatility.minVolatilityPct 可覆盖 σ 下限；trading-plan-daily-cycle 的 volatilityMinPct / volatilityMaxStalenessTradingDays 可覆盖两阈值；环境变量为 LUOOME_TRADING_PLAN_VOLATILITY_MIN_PCT / LUOOME_TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS。日循环优先级为显式入参 > 环境变量 > 默认值；定时路径未传这些入参时通过环境变量标定。降级文案记录当次实际阈值，避免后续调参改变历史解释。

[新鲜度实现](../../packages/tools/src/tools/get-daily-volatility.ts#L125-L145)按最新 bar 日期至 asOf 的 UTC 日界逐日推进，排除 [core 日历](../../packages/core/src/trading-calendar.ts)中的周末和节假日，不精确判断当日是否已收盘。已登记的长假本身不增加 stalenessTradingDays，不应把“放假超过五个自然日”说成“超过五个交易日”；日历缺漏、尚未核准年份、同步延迟与停牌需分别核验。真实数据分布标定仍未完成，本次仅修正文档中的自然日/交易日混淆，不改变算法或阈值。

### 预算口径与账户前提

生效计划占建议预算，撤销、过期或被新版本替代时释放或重算；同股多策略证据不重复占额度。预算仅校验总仓位和单只股票上限，默认 100% / 30%；行业合计上限已按用户决定移除，stocks.industry 不参与判断。100% 阻止多计划建议合计超过账户总资产；30% 仅阻止继续加仓，超限持仓仍可减仓。

预算回执的 maxTotalPct/minTotalPct 表示全部候选（含 blocked）按 max/min 声明的组合暴露包络；proposedStockPct 仅统计 included 的本次增量，两者口径不同，不要求数值对应。hold / 已持仓 observe 仅在区间整体不高于实时仓位、或点区间等于实时仓位时不占新增额度；计划 currentPct 与实时持仓不同则按新增额度计，不因旧计划记录而免除预算。

计划锚定 accountFactsDigest 与 accountFactsAsOf。账本变化后区间和结构化失效条件同时失效，不评估任何规则，须重新生成。生效计划至少有一条结构化失效条件，复用 TradingPlanCondition，phase∈{exit,risk} 或 kind=market-fact；invalidationConditions 文本仅供展示，不单独承担失效判断。

### 期限、草案与复核

观察计划（Advice watch → TradingPlan observe）同样携带建议中的入场区间、目标仓位、止损、目标价和“条件满足前不建仓”的入场条件；未持仓时取建议目标仓位，已持仓时维持当前仓位。计划不等于 Trade 或自动下单；实际持仓、可卖数量与成交由用户维护的账户事实决定。draft 保留缺失前提，不作为当前可执行动作发布。

复核时间与硬有效期分开，复核到期不自动结束跨日计划。新生效计划按研究周期最长持有交易日设置硬期限，来源 Advice 在生成时必须仍有效。草案最多保留首次生成后两个交易日，存量草案同样适用；连续修订继承首次截止，相同失败或未补齐前提的过期草案不靠重生成延期。前提补齐后可发布新生效版本。

账户前提、行动条件、持有周期、反证与风险均未变化且原生效版有效时，保留原版本及硬期限；本次 Advice 引用和复核时间写入复核审计，沿 Advice 追溯证据。修订草案不替代仍有效的生效版，也不释放其预算。

旧规则 fallback 生成路径及 LLM 适配器已退役。存量 Advice 的 reasoning 带“规则 fallback”或“LLM 推理不可用”标记时仍被识别为规则兜底，最多形成 draft，并给出“AI 推理不可用（规则兜底建议）”原因，不提升为研究结论或生效计划。

### 盘中监控与投递

监控以计划为条件契约：入场条件按 ALL 合成一个边沿，任一风险/退出条件命中则阻止入场提醒；人工确认或过期市场事实保持 unknown。风险/退出提醒直接引用原计划，不调用模型、不自动替换计划；复核留在盘后批次或用户主动研究流程。

预警只报告持仓股操作与买入候选。observe 命中仅提示重新评估；未持仓计划的止损、目标价及退出条件属于入场前提，不投递提醒，仅留 not-requested（命中仍阻止入场提醒并推进边沿状态）。冷却适用于全部优先级，每日上限仅约束常规提醒；urgent / important / normal 分别映射 error / warn / info。通知必须披露下一步、触发价格、止损/目标价、反证、风险、有效期与卖出限制。

list_trading_plans(includeMonitoring=true) 返回只读 monitoring 资格与 views 当前版本投影；currentOnly=true 先按计划聚合再应用数量限制，返回最新版本和仍需跟踪的原生效版。过期统一在读取时判断，保留不可变原版本；草案、等待数据、待生效、账户已变分别呈现。ready 仅指计划有资格，后台已执行和通知已送达仍须运行与投递证据；账户变化、有效期、草案、约束和缺少条件分别说明阻塞原因。

notify=false 试跑不写 Trigger、边沿或投递次数；正式执行共享预警租约，并在工具调用前续租。

## 验证边界

自动测试覆盖主体归属、伪造版本、时效、会话隔离、幂等、局部失败、上下文恢复及草案信任。隔离服务只使用 fixture providers 和临时库；实际浏览器验证桌面与 360/390/430px、返回、滚动与刷新。网络中断和账户切换单独验证。iOS Safari / Android Chrome 键盘与后台、真实行情覆盖、模型质量和真实手机通知必须另验。

性能记录区分冷启动与缓存，不在未测量时声称 P95 达标。验收结果按 AC01–AC17 写入 A 交接并同步维护文档。
