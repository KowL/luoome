# Strategy 实验、晋级与反馈闭环开发计划

> 状态：Wave A～Wave E 已完成
> 基线日期：2026-08-31
> 对应需求：[策略工作台 PRD](./prd/strategy-v2.md)、[AI 投资决策闭环产品总纲](./prd/ai-investment-decision-loop.md)
> 详细设计：[Strategy 实验、晋级与反馈闭环详细设计](./ddd/strategy-experiment-feedback-detailed-design.md)
> 上位约束：[领域语言](../CONTEXT.md)、[架构说明](./ARCHITECTURE.md)、[安全说明](./SECURITY.md)

## 1. 执行结论

本轮不新增平行的 Strategy、Experiment、CandidatePool 或 Recommendation 聚合。目标是把已经落地的
StrategyVersion、definition diff、样本试算、历史评估、SignalObservation 和适应性门禁组合成一条
可审计的产品路径：

```text
已发布基线
  → 人工或 AI 草案
  → definition diff
  → 同样本 trial
  → 独立历史评估与真实观察
  → 晋级证据汇总
  → 人工校验、发布
  → T+1/T+3/T+5 持续反馈
```

当前可靠性底座继续作为前置条件；本计划不以新增模板数量、短期收益或固定交易日数量作为完成标准。

## 2. 当前实现基线

### 2.1 已可复用能力

- StrategyVersion 不可变，已有 `parentVersionId`、`changeSummary`、`factReferences` 与 agent trace；
- `compare_strategy_definitions` 已提供确定性定义 Diff；
- `propose_strategy_version_draft` 只生成未持久化草案，不会自动发布；
- `trial_strategy_version` 已能在相同股票样本上执行 `persist=false` 基线/候选试算；
- evaluation session/day 已支持后台进度、重试、断点续跑和取消；
- SignalObservation 已有 `stock-day-horizon` 去重、benchmark、超额收益、MFE/MAE 和缺失率统计；
- `run_local_selector_research` 与 `assess_adaptive_personality` 已提供 PIT 横截面研究和训练/验证门禁；
- Web 已有 Strategy Workspace、版本创建/校验/发布、运行 Diff、历史评估和严格回测入口；
- Tool 支持 `requiredCapabilities`，Web/MCP 会对所有声明能力执行交集门控。

### 2.2 尚未形成闭环的差距

| 差距 | 当前表现 | 本轮目标 |
|---|---|---|
| 持久化运行能力声明 | `run_strategy`、`prepare_strategy_data` 会写入事实，但只声明 `external` | 所有外部访问并写库的入口同时要求 `external + write` |
| 评分解释 | StrategyResult 只有总分和排名 | 保存每个 scoring component 的原始分、权重、贡献与输入事实 |
| 实验入口 | 草案、trial、回放和观察分散 | 在同一实验视图中组织，仍复用原 Tool 和实体 |
| 策略编辑 | Web 主要编辑原始 JSON | Field Registry 驱动的规则构建器，JSON 作为高级模式 |
| 晋级判断 | 有适应性门禁，但无通用候选版本证据摘要 | 确定性 `eligible-for-human-review / blocked` 评估 |
| 推荐适配 | RecommendationPolicy 主要按分数、排名和冷却筛选 | 在 LLM 前增加账户级确定性预检，保持 Advice 与 Trade 隔离 |

## 3. 范围与非目标

### 3.1 本轮包含

1. Strategy 持久化外部 Tool 的组合能力门禁审计；
2. StrategyResult scoring breakdown V1；
3. Strategy DSL 字段目录和实验上下文只读 Tool；
4. Strategy Workspace 的“实验”页签与 Field Registry 驱动的规则构建器；
5. 基线/候选同样本试算、独立验证、观察统计与人工晋级证据；
6. RecommendationPolicy V2 的账户级确定性预检；
7. 自动测试、真实浏览器验收和维护文档同步。

### 3.2 本轮不包含

- 自动生成并直接持久化、校验、发布或激活 StrategyVersion；
- 根据短期样本自动调参、自动替换 currentVersionId；
- 把 score、rank、观察收益或晋级状态表述为收益概率；
- 默认扩大 Advice、通知或 Watchlist 投影范围；
- 自动交易、自动调仓或 MCP trade 暴露；
- 在真实 PIT 基本面数据门禁未通过前接入 StrategyDslV2；
- 在可交易性、公司行动和 benchmark 历史事实未齐全前放宽严格回测门禁；
- 新前端框架、第二套策略 DSL 或新的持久化 Experiment 表。

## 4. 依赖与执行波次

```text
Wave A（可并行）
  X0 组合能力门禁 ───────────────┐
  X1 scoring breakdown ──────────┼──► Wave B：X3 Web 实验室与规则构建器
  X2 实验上下文与 DSL catalog ───┘                    │
                                                       ▼
                                  Wave C：X4 人工晋级与反馈闭环
                                                       │
                                                       ▼
                                  Wave D：X5 RecommendationPolicy V2
                                                       │
                                                       ▼
                                  Wave E：X6 V2 设置与预检可观测
```

Wave A 的三个切片可以在独立 worktree 中并行开发。X3 必须在 X1/X2 合入后的共同基线上开始，避免前端
猜测 schema；X4 必须在实验上下文稳定后接入；X5 只在前述事实和真实观察口径可用后推进。

截至 2026-08-30，Wave A 已合并到共同工作树并完成组合验证：定向 Core/Tools/MCP 99 项、DB 343 项、
Web 141 项均通过，typecheck、lint 和 build 通过。全量 Vitest 为 1680 项通过、2 项既有 Eastmoney
相对日期 fixture 失败；失败路径不涉及本计划改动。Wave B 随后完成并合入，主工作树 Web 全量 357 项、
typecheck、lint、build 和 diff check 均通过；真实浏览器已覆盖 1320/1020/640 三档及关键错误恢复。
Wave C 已完成并合入：主工作树 Web 360 项、DB 343 项全部通过，typecheck、lint、build、diff check
均通过；四层证据、三周期 observation、发布后真实反馈、严格回测门禁和发布前事实快照均已在隔离数据下
完成三档浏览器验收。观察周期现固定为 T+1/T+3/T+5，不再等待 T+20。

## 5. 里程碑

### X0：组合能力门禁收口

**优先级：P0；预计：1～2 个有效开发日。**

**实施状态：已完成（2026-08-30）。** 新增独立 external-only `trial_strategy`；持久化运行和数据准备
统一要求 `external + write`，Web/MCP/registry 回归测试已覆盖。

任务：

1. 逐个审计 Strategy 路径中同时访问外部数据并写库的公共 Tool；
2. `run_strategy` 与 `prepare_strategy_data` 声明 `requiredCapabilities: ['external', 'write']`；
3. 复核 `propose_strategy_version_draft`、`trial_strategy_version` 的 `persist=false` 路径只要求 external；
4. Web 专用 route、通用 `/api/tools/:name/call` 与 MCP 使用同一组合能力判断；
5. 增加 registry、Web exposure 与 MCP exposure 回归测试；
6. 不通过运行时 input 动态降低静态 Tool 能力，dry-run 如需 external-only 必须使用现有独立 trial 入口。

验收：

- 只开启 external 时，持久化正式运行和数据准备被拒绝；
- 同时开启 external/write 后原有路径成功；
- trial/propose 保持 external-only，且不产生持久化事实；
- `trade` 暴露规则没有变化。

### X1：StrategyResult 评分分解

**优先级：P1；预计：2～3 个有效开发日。**

**实施状态：已完成（2026-08-30）。** breakdown 使用可判别状态保存且保持 optional；Drizzle 在既有
JSON 列中兼容读取旧数组形态，不新增 DDL；旧 StrategyVersion 的重复 component 仍可读取但不可发布。

任务：

1. 在 core 增加 `StrategyScoreComponentEvaluation` schema；
2. evaluator 对每个 scoring component 保存表达式、实际读取输入、状态、原始分、权重和贡献；
3. `StrategyResult.scoringBreakdown` 保持 optional，旧运行继续可读；
4. 总分只能由所有 available component contribution 求和产生；missing/error 时保持现有 partial 语义；
5. JSON repository round-trip、Tool output、Diff 和结果视图透传新字段；
6. 增加权重、精度、稳定排序、missing/error 和 legacy 兼容测试。

验收：

- `score` 与 available contributions 之和的误差不超过 `1e-9`；
- 每个 component 可追溯到 ruleId、score expression 和实际读取字段；
- 输入缺失时不填 0，不产生虚假贡献；
- 老数据库无需 DDL 迁移即可读取。

### X2：实验上下文与 DSL Catalog

**优先级：P1；预计：3～4 个有效开发日。**

**实施状态：已完成（2026-08-30）。** catalog、experiment context、promotion 纯函数及 Web read route
已落地；晋级仍只返回 `blocked` 或 `eligible-for-human-review`，且观察证据校验 signal/stock 归属。

任务：

1. 增加 `get_strategy_dsl_catalog` 只读 Tool，输出注册字段、类型、单位、lookback、数据源、可用运算符；
2. 增加 `get_strategy_experiment_context` 只读 Tool，聚合基线/候选版本、definition diff、evaluation session、
   observation stats 和晋级证据；
3. 在 core 增加纯函数 `assessStrategyPromotion`，只返回 `blocked` 或 `eligible-for-human-review`；
4. 通用门禁覆盖版本关系、校验状态、定义变化、独立验证、PIT vintage、观察数量和 benchmark 覆盖；
5. adaptive personality 继续是参数自适应的附加门禁，不被新通用门禁复制或替代；
6. Tool 不保存 experiment，不自动执行 trial、evaluation、发布或 Advice。

验收：

- 无候选、候选无效、验证未完成和观察不足均返回稳定 reason code；
- 证据充分时只进入人工评审，不自动发布；
- observation ids、session ids、definition hashes 可追溯；
- Web/API 不直接访问 repository 或重新实现门禁。

### X3：Web 实验室与规则构建器

**优先级：P1；预计：4～6 个有效开发日；依赖：X1、X2。**

**实施状态：已完成（2026-08-30）。** 实验页签、六段流程、catalog 驱动规则构建器、JSON 高级模式、
独立 mutation 确认、trial/validation/promotion 展示和响应式布局已落地；结构化编辑器保证规则 ID 与
scoring 引用一致，高级表达式不会在结构化模式中被静默改写。

任务：

1. Strategy Workspace 增加“实验”页签；
2. 页面按“基线 → 草案 → Diff → Trial → 独立验证 → 晋级评审”展示步骤和状态；
3. 调用现有 propose/create/validate/trial/publish route，每个 mutation 独立确认；
4. 使用 DSL catalog 生成 selection、scoring、entry/exit/risk 的结构化编辑器；
5. 展示字段单位、lookback、数据源和缺失风险；
6. JSON 高级模式与结构化模式使用同一个本地 definition 状态并执行 Zod/服务端校验；
7. 展示 scoring contribution、trial 差异、数据覆盖和限制，不使用胜率式文案；
8. 浏览器验证桌面、窄屏、键盘、取消和错误恢复。

验收：

- 普通用户无需手写完整 JSON 即可创建合法草案；
- 未注册字段无法从结构化编辑器产生，手工 JSON 会被现有校验拒绝；
- 页面刷新前的 trial 只存在于内存，不冒充持久化运行；
- 发布动作仍有独立确认且只接受 valid 持久化版本。

### X4：人工晋级与真实反馈

**优先级：P1；预计：3～5 个有效开发日，不含真实观察等待。依赖：X2、X3。**

**实施状态：已完成（2026-08-30）。** 实验上下文和 Web 工作台已按四层证据分区，三个 horizon 的
complete/missing/pending/unavailable/真实 0 语义可区分，observation 可追溯到 signal/run/version；
production feedback 只接受已发布版本，evaluator identity 缺失不会误标一致。`EARLY_BREAKOUT_V2_DRAFT`
只作为页面内存 starter，所有持久化和发布动作仍需独立确认。

任务：

1. 实验页展示通用 promotion assessment 与 adaptive personality 附加评估；
2. 明确区分样本 trial、历史 evaluation、strict backtest 和真实 SignalObservation；
3. 对候选版本展示 T+1/T+3/T+5 完成数、缺失率、benchmark 覆盖、分位数和 MFE/MAE；
4. 发布前展示事实引用、限制、definition hash、evaluator identity 与验证区间；
5. 以 `EARLY_BREAKOUT_V2_DRAFT` 作为首个端到端实验，用户确认后才创建/发布版本；
6. 发布后的观察进入既有日周期，不新增自动回滚或自动再训练。

验收：

- 任一关键证据缺失均明确 blocked/unavailable；
- eligible 只表示可人工评审；
- 发布后的 T+1/T+3/T+5 周期可从 observation ids 追溯到对应版本和信号；
- 没有新增 Advice、通知、Watchlist 或 Trade 默认副作用。

### X5：RecommendationPolicy V2

**优先级：P2；预计：3～5 个有效开发日；依赖：X4。**

**实施状态：已完成（2026-08-31）。** 在已验收的 X4 事实口径上独立完成，不与实验 UI 混合修改。

任务：

1. 在 core 扩展版本化 policy，保留 V1 读取兼容；
2. 在调用 LLM 前执行账户级确定性预检：已有持仓、行业集中度、同策略重复暴露、流动性、数据新鲜度、
   entry/exit/risk 冲突和冷却；
3. 输出 `eligible/skipped`、稳定 reason code 和输入 fact refs；
4. 只有 eligible candidate 才进入 `analyze_strategy_candidate`；
5. Advice 继续保留证据、反证、风险、免责声明、有效期和低置信度降级；
6. 不创建 Trade，不自动调整仓位。

验收：

- 相同账户事实与 policy 得到确定性相同结果；
- skipped candidate 不触发 LLM 或通知；
- 缺少账户/行业/流动性事实时保守跳过或标 unavailable，不填默认安全值；
- V1 schedule 继续按原语义读取。

实现补充：V2 预检结果透传至 recommendation、daily-cycle、schedule runner 和 observation completion
workflow；Advice 的策略快照记录 account provenance。当前仓储已有的 JSON policy 列无需 DDL 变化，
memory/Drizzle contract test 覆盖 V2 往返；缺少可证明的候选仓位大小或组合估值时，暴露检查返回
unavailable，不使用 initialCapital 充当当前组合价值。

### X6：RecommendationPolicy V2 设置与预检可观测

**优先级：P1；预计：2～4 个有效开发日；依赖：X5。**

**实施状态：已完成（2026-08-31）。** X5 已提供后端显式 V2 契约；本切片补齐了显式启用入口、只读运行
反馈和三档浏览器验收，不改变默认 Advice/通知范围。

**验证记录（2026-08-31）。** 新增只读历史 Tool、registry/API 脱敏断言、V1/V2 设置与刷新回填测试；定向
Core/Tools/registry 24 项通过，`bun run test:web` 363 项全部通过。`bun run typecheck`、`bun run lint`、
`bun run build` 和 `git diff --check` 通过。真实浏览器已在 1320px、1020px、640px 验证 V1/V2 状态切换、
确认/取消、键盘焦点、必填空值不落库、刷新回填、预检摘要展示和内部标识脱敏。

任务：

1. 策略设置页明确展示当前 policy 为 Legacy V1 或 Account-gated V2；旧 schedule 不自动升级；
2. 用户显式选择 V2 后才保存 `schemaVersion=2` 与完整 `portfolioPreflight`，并在保存前二次确认授权边界；
3. 表单支持现有持仓、流动性、数据年龄、exit/risk 冲突，以及可选单仓/行业暴露阈值；空阈值保持
   `undefined`，不转成 0；
4. 增加只读 Tool/API，从 `strategy-daily-cycle` 的既有 `WorkflowRun.outputSummary.preflight` 中按
   Strategy 聚合最近预检摘要和稳定 reason code 分布；不新增表、不重跑预检、不调用行情或 LLM；
5. 设置页展示最近一次 eligible/skipped/unavailable 计数、候选原因和事实数量；默认不暴露账户、运行、
   Advice 等内部 ID；
6. V1 页面仍可原样保存；从 V2 切回 V1 也必须显式确认，避免静默丢失账户门禁配置；
7. 补 core/tool/server/frontend 回归和 1320px、1020px、640px 真实浏览器验收。

验收：

- 加载旧 schedule 后不触发 POST，保存未选择升级时仍是 V1；
- 显式升级后保存完整 V2，刷新可无损回填；可选阈值为空时 JSON 中不存在对应字段；
- skipped/unavailable 历史只读展示不会调用 LLM、通知或 recommendation workflow；
- reason code 聚合只消费 schema 校验通过、Strategy 归属一致的已结束运行，损坏或旧 output 保守忽略并
  返回 limitations；
- 页面不把 eligible 表述为买入、发布或收益结论，且保留“不会自动交易”的授权边界；
- 不新增 DDL、Trade 路径、MCP trade 暴露或默认开启的 Advice/通知。

## 6. 任务切片与目标文件

| 任务 | 主要目标文件 | 最小验证 |
|---|---|---|
| X0 | `packages/tools/src/tools/run-strategy.ts`、`prepare-strategy-data.ts`、registry/Web/MCP exposure tests | registry + Web + MCP 定向测试 |
| X1 | `packages/core/src/entity/strategy.ts`、`packages/core/src/strategy/evaluator.ts`、相关 core/db/tool tests | evaluator、result-view、repository contract |
| X2 | `packages/core/src/strategy/`、`packages/tools/src/tools/strategy-*.ts`、registry/server routes | core、tools、server 定向测试 |
| X3 | `apps/web/public/js/strategy-workspace.js`、对应 HTML/CSS/tests | `bun run test:web` + 真实浏览器 |
| X4 | experiment UI、observation/evaluation read paths、浏览器 fixtures | core/tools/web + 真实浏览器 |
| X5 | schedule policy、recommendation workflow/tools、memory/Drizzle round-trip | core/db/workflow/tools |
| X6 | schedule V2 form、preflight history read tool/API、设置页摘要 | tools/server/frontend + 真实浏览器 |

每个任务必须先读取目标文件及相邻测试；不得为方便页面而在 Hono route 复制领域判断。新 repository
如确有需要，必须同步 memory、Drizzle、schema、`ensureSchema` 与 contract tests；当前设计预期 X0～X4
不新增 repository 或表。

## 7. 测试与发布策略

### 7.1 开发中

- 先跑最小相关测试；
- core schema/evaluator 变化先做 red/green 回归；
- Web route 与前端状态使用确定性 fixture；
- 外部 provider 测试独立运行，不以 mock 证明生产数据可用；
- worktree 合并后统一跑交叉模块测试，处理 registry 数量和生成 schema 变化。

### 7.2 交付前

```bash
bun run test:all
bun run typecheck
bun run lint
bun run build
```

X3/X4 还必须启动真实 Web，用浏览器验证 1320px、1020px、640px、键盘操作、能力拒绝、trial 失败、
观察不足和 eligible-for-human-review 状态。

### 7.3 灰度顺序

1. X0 直接作为安全修复交付；
2. X1 先写新字段、兼容读旧字段，不做历史回填；
3. X2/X3 默认只读和人工触发，实验页不改变 schedule；
4. X4 先对单个用户 Strategy 开放，首个候选使用 Early Breakout V2；
5. X5 默认关闭，只有显式 V2 policy 才启用账户预检和 Advice 生成。

## 8. 进度与效果指标

工程指标：

- 组合能力门禁绕过数为 0；
- 新运行 scoring breakdown 覆盖率 100%；
- experiment context 中不可追溯的 session/run/observation id 数为 0；
- evaluation/withheld/non-publishing 污染 current run 数为 0；
- Web mutation 未确认执行数为 0。

产品事实指标：

- 草案 → trial → 校验 → 人工发布各步骤转化和退出原因；
- T+N complete、missing、benchmark coverage；
- 候选相对基线的覆盖、入选变动、信号新增/流失和 churn；
- AdviceOutcome 填充率与显式 Trade 归因率；
- RecommendationPolicy V2 各 skip reason 分布。
- Legacy V1 → V2 显式升级率、V2 保存校验失败原因和最近预检 unavailable 分布。

这些指标用于评估流程和数据质量，不以短期平均收益作为版本自动晋级门槛。

## 9. 完成判定

本计划完成必须同时满足：

1. X0～X6 代码与文档均交付，或 X5/X6 经明确产品决策继续保持关闭；
2. Strategy 用户能在一个工作台完成草案、Diff、trial、独立验证、证据评审和人工发布；
3. 新运行总分可以从 component contribution 确定性复算；
4. 所有 unavailable/blocked 都有稳定 reason code 和事实引用；
5. 任何 eligible 状态都不会自动发布、生成 Trade 或扩大默认通知；
6. 全量门禁与真实浏览器验收通过；
7. 首个候选版本进入真实观察后，按实际可获得交易日积累 T+1/T+3/T+5 事实；T+5 后即可进入下一轮人工评审。
