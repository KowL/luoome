# Phase 3 基本面 PIT 因子与横截面评分详细设计

> 状态：P3-0 Core、P3-1 mock 装配与 P3-2 deterministic score engine 已实现；mock 只用于验证 revision/披露时点、双仓储、横截面评分和 Tool 契约，真实数据门禁仍为 `not-ready`，不能据此宣称 Phase 3 已完成。（2026-08-22）
>
> 上位约束：[AI 投资决策闭环产品总纲](../prd/ai-investment-decision-loop.md)、[Strategy DSL PRD](../prd/strategy-dsl.md)、[CONTEXT.md](../../CONTEXT.md)、[架构说明](../ARCHITECTURE.md)、[安全说明](../SECURITY.md)。
>
> 相关实现边界：[行情与股票目录详细设计](./market-data-and-stock-universe-detailed-design.md)、[Strategy 日运行与历史评估可靠性详细设计](./strategy-daily-cycle-and-replay-detailed-design.md)、[策略工作台详细设计](./strategy-workspace-detailed-design.md)、[Tushare 行情适配器设计](./tushare-market-adapter-design.md)。

本文件冻结 Phase 3 的数据、计算、存储、门禁和验收契约；当前按 §13 逐切片实现。任何实现都不得把现有报价、日线、报告或 Strategy 运行结果解释成基本面数据，真实完成仍必须通过本文的数据证据门禁。

## 1. 目标与完成定义

Phase 3 的目标是让用户可以在严格 point-in-time（PIT）口径下，用可追溯的基本面因子生成横截面评分，并把评分作为 Strategy 的一个明确、可复现的数据维度。闭环仍然是：

```text
外部披露事实
  → publication/revision vintage
  → 注册因子（单位、方向、缺失策略）
  → 横截面归一化
  → 不可变 score version
  → Strategy evaluation/run 事实
  → 只读解释与后续复盘
```

完成定义同时满足：

1. 任一被评分的财务值都能回溯到 `stockId`、metric、报告期间、披露/修订发布时间、来源记录和内容 hash。
2. 历史 `asOf` 只能看到在该时点已公开、且本地已记录的 revision；不能读取当前重述值倒灌历史。
3. 因子只能来自版本化 registry；单位转换、方向、期间选择和缺失原因都有稳定 schema。
4. 横截面分母、行业分组、并列排名、最小样本和缺失股处理可确定性重算；不悄悄填零或重分配权重。
5. score version、factor registry、normalizer、PIT vintage 和 evaluator identity 都进入审计快照。
6. Drizzle 与 in-memory 仓储通过同一套 contract tests；迁移幂等且不回填伪造 publication 时间。
7. 外部真实数据门禁未通过时，生产 Strategy 不消费基本面评分；工具明确返回 `unavailable`/`unsupported`，而不是使用 mock、当前接口或默认值。
8. 基本面评分仍是研究事实，不是 Advice、收益概率、订单或自动交易授权。

## 2. 现状、范围与不变量

### 2.1 可复用现状

当前 Strategy 已有不可变 `StrategyVersion`、`StrategyRun`、`StrategyResult`、数据 checkpoint、`DailyBarRevision` 和 `revisionCutoff`。`DailyBarRevision` 只证明 qfq 日线在某个本地记录时间的版本，不包含财报期间、披露时间或修订 vintage，因此不能作为 financial fact 的替代品。

当前 Strategy DSL 的 `schemaVersion=1` 主要承载技术行情字段、selection rule、signals 和 weighted-sum rule score；现有 `STRATEGY_FIELD_REGISTRY` 的 data source 只有 quote、daily-bars、meta 和 limit-up-ladder。Phase 3 不修改 V1 的既有语义，也不把未注册的 `fundamentals.*` 字段静默放入 V1。

当前 market adapters 暴露 quote、daily-bars、universe 等能力，没有通过验收的 financial publication/revision PIT 能力。行情 adapter 不能被包装成“基本面 adapter”，外部 endpoint 只返回当前重述值时也不能用于历史评分。

### 2.2 Phase 3 范围

- CN A 股沪深覆盖下的报告型财务事实及其 publication/revision vintage；
- 注册、版本化、可审计的 reported 或 deterministic derived factor；
- market/industry 横截面 percentile v1；
- 基本面 score version、score run、逐股组件解释和 Strategy 快照引用；
- 只读查询、显式同步、显式研究/评估 workflow 及真实数据门禁。

### 2.3 非目标

- 不支持自动交易、券商下单、调仓或把 score 转成 Advice；
- 不在 Phase 3 复制完整财报正文、XBRL 全量图谱或全文搜索系统；
- 不用 LLM 生成因子、解释缺失值、修改单位或参与逐股求值；
- 不把当前 `Stock.industry`、当前股票池、当前报价或报告摘要当作历史 PIT 分组/财务事实；
- 不提供“缺基本面时退回当前值/最近季度值/行业平均值”的隐式 fallback；
- 不修改 `Trade`、`AdviceOutcome`、`weekly-report` 的领域契约。

## 3. 术语与时间轴

一个财务事实有三个不可混用的时间：

| 时间 | 字段 | 语义 | 可否作为 PIT 截止条件 |
|---|---|---|---|
| 报告期间 | `periodStart` / `periodEnd` | 事实描述的财务期间或 instant 日期 | 不是披露时间，不能单独决定可见性 |
| 对外发布时间 | `publishedAt` | 发行人/监管源首次公开该报告/事实的时间 | 必须不晚于 `asOf` |
| 本 revision 发布时间 | `revisionPublishedAt` | 当前值这一版被公开、重述或撤回的时间；首次版本等于 `publishedAt` | 必须不晚于 `asOf` |
| 本地记录时间 | `recordedAt` | luoome 收到并持久化这一个 source revision 的时间 | strict PIT 必须不晚于 `asOf` |

`asOf` 使用 `Asia/Shanghai` 的明确 instant；交易日 key 的日终截止统一为该交易日 `15:59:59.999+08:00` 的等价 UTC instant。任何没有可验证 `publishedAt` 或 `revisionPublishedAt` 的源记录，都不能进入可评分 vintage。

`recordedAt` 是严格本地可重放口径：即使源声称一份历史报告很早公开，如果 luoome 到 `asOf` 之后才首次记录该 revision，也不能把它当成当时已经可用。若未来需要“源公开时间口径、忽略本地是否已同步”的研究模式，必须另设版本化 `vintagePolicy`，不能改变本文的 strict PIT v1。

## 4. PIT Financial Fact 契约

### 4.1 有效事实结构

有效事实是 append-only 的 source revision，不是按 `(stockId, metricId, periodEnd)` 覆盖的当前值。建议 core schema 冻结为：

```ts
type FinancialPeriodType = 'instant' | 'quarter' | 'annual' | 'ttm';
type FinancialFactStatus = 'reported' | 'restated' | 'retracted';
type FinancialCanonicalUnit =
  | 'percent-points'       // 15 表示 15%，不是 0.15
  | 'ratio'                // 0.15 表示 0.15 倍
  | 'CNY'
  | 'CNY-per-share'
  | 'share'
  | 'day';

interface FinancialFact {
  readonly id: string;
  readonly stockId: string;
  readonly metricId: string;             // registry 中的 source metric，不是用户自定义字段
  readonly periodType: FinancialPeriodType;
  readonly periodStart?: Date;           // instant facts 可省略
  readonly periodEnd: Date;
  readonly value: number;                // finite；已转换为 canonicalUnit
  readonly canonicalUnit: FinancialCanonicalUnit;
  readonly currency?: 'CNY';
  readonly rawValue?: number;
  readonly rawUnit?: string;
  readonly source: string;
  readonly sourceRecordId: string;
  readonly sourceRevision: string;
  readonly publishedAt: Date;
  readonly revisionPublishedAt: Date;
  readonly recordedAt: Date;
  readonly status: FinancialFactStatus;
  readonly supersedesId?: string;
  readonly industryKey?: string;         // 仅源提供的同 vintage PIT 分组，不能回填当前 Stock.industry
  readonly contentHash: string;          // canonical fact payload 的 sha256
}
```

不变量：

- `value` 必须 finite；不能把 `null`、空字符串、NaN、Infinity 或“暂无数据”转成 0。
- `canonicalUnit` 是 factor registry 的唯一计算单位。`rawValue/rawUnit` 只用于 provenance 和审计，不参与计算。
- `currency` 仅在单位需要时出现，CNY 以外的源必须先经过显式、可审计的货币转换能力；没有转换就返回 `invalid-unit`。
- `revisionPublishedAt >= publishedAt` 且 `recordedAt >= revisionPublishedAt`；违反时拒绝保存并记录 ingestion issue。
- `status=retracted` 的 revision 保留历史，但 resolver 不返回可用值；撤回事件本身仍参与 vintage 选择，以阻止读取更早的值。
- `supersedesId` 若存在必须引用同一 `stockId + metricId + period` 的较早 revision；没有 source revision id 时也必须有稳定 `contentHash`，不能依靠抓取顺序猜版本。
- `id` 不作为 PIT 排序依据；排序只使用版本化的发布时间、source revision、记录时间和 hash。
- `industryKey` 缺失不影响 `market-percentile`，但 `industry-percentile` 必须将该股标记为 `group-missing`，不得读取当前股票目录行业字段。

源端有 publication 缺失、单位无法识别或 payload 不合法时，不生成“半有效” `FinancialFact`。同步工具可保存结构化 ingestion issue（source、stock、metric、reason、observedAt），但 issue 不能进入 score population。

### 4.2 Identity、重复与 revision

事实的逻辑期间键为：

```text
(source, sourceRecordId, metricId, periodType, periodStart, periodEnd, sourceRevision)
```

同一 source revision 的重复同步按 `contentHash` 幂等；相同逻辑键但内容变化只能追加新 revision，不能更新旧行。表级唯一约束至少包含 `(source, sourceRecordId, sourceRevision, contentHash)`。

`revisionPublishedAt` 是 resolver 认定“这版已经可公开使用”的时间，不是本次同步时间。若供应商只返回当前 restated value、没有历史 revision identity 和发布时间，工具必须返回 `publication-unknown`/`revision-unknown`，不得把该值标记为 PIT 可用。

### 4.3 Vintage resolver

输入：`stockIds`、`metricIds`、期间策略、`asOf`、`vintagePolicy='strict-pit-v1'`。对每个 `(stockId, metricId, period)` 独立选择：

1. 过滤 `publishedAt <= asOf`、`revisionPublishedAt <= asOf`、`recordedAt <= asOf` 的 revision。
2. 将 `retracted` revision 作为截止事件处理；若最新 eligible revision 为撤回，则结果为 `retracted`，不回退读取旧值。
3. 在剩余 revision 中按 `(revisionPublishedAt DESC, sourceRevision DESC, recordedAt DESC, contentHash DESC)` 选一行。
4. 对因子定义所需的所有期间执行 period policy；缺任何必要期间就返回结构化 missing reason，不用另一期间替代。
5. 计算 `vintageKey = sha256(canonical(asOf, policy, selectedRevisionIds, missingReasons))`。相同输入和仓储内容必须得到同一 key。

resolver 输出不是裸数组，而是带覆盖信封：

```ts
interface FinancialVintage {
  readonly policy: 'strict-pit-v1';
  readonly asOf: Date;
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly vintageKey: string;
  readonly facts: readonly FinancialFact[];
  readonly missing: readonly {
    readonly stockId: string;
    readonly metricId: string;
    readonly periodEnd?: Date;
    readonly reason: FinancialMissingReason;
  }[];
  readonly coverage: {
    readonly requested: number;
    readonly available: number;
    readonly missing: number;
    readonly retracted: number;
  };
}
```

`status=partial` 只能表示部分输入有事实，不能被 score engine 当作 complete。`status=unavailable` 表示没有任何可评分事实或门禁拒绝；调用方必须把原因带到 ToolResult/StrategyRun summary。

### 4.4 缺失与数据质量枚举

Phase 3 v1 固定使用以下原因，不以字符串自由发挥：

| reason | 语义 | 允许隐式替代 |
|---|---|---|
| `not-covered` | 标的/指标不在源覆盖范围 | 否 |
| `no-eligible-vintage` | 有记录但没有满足 asOf 的 revision | 否 |
| `publication-unknown` | 缺 `publishedAt` | 否 |
| `revision-unknown` | 缺 revision identity/发布时间 | 否 |
| `not-published` | 报告期间存在但截至 asOf 尚未公开 | 否 |
| `recorded-after-cutoff` | 本地记录晚于 asOf | 否 |
| `retracted` | 最新 PIT revision 撤回 | 否 |
| `insufficient-periods` | derived factor 所需期间不完整 | 否 |
| `invalid-unit` | 单位未知或转换失败 | 否 |
| `invalid-value` | 非 finite、越界或违反 metric 不变量 | 否 |
| `no-denominator` | 比率因子分母为 0/缺失/不适用 | 否 |
| `group-missing` | industry-percentile 没有同 vintage 分组 | 否 |
| `sample-too-small` | 分组样本低于 normalizer 门槛 | 否 |
| `source-error` | adapter 网络、限流或 payload 错误 | 否 |

所有“不可用”都必须保留 reason 与 provenance；不得用 0、均值、上一期、当前值或行业值代替。

代码契约固定为枚举，而不是允许调用方扩展的字符串：

```ts
type FinancialMissingReason =
  | 'not-covered'
  | 'no-eligible-vintage'
  | 'publication-unknown'
  | 'revision-unknown'
  | 'not-published'
  | 'recorded-after-cutoff'
  | 'retracted'
  | 'insufficient-periods'
  | 'invalid-unit'
  | 'invalid-value'
  | 'no-denominator'
  | 'group-missing'
  | 'sample-too-small'
  | 'source-error';
```

## 5. Factor Registry

### 5.1 Registry 是代码事实，不是用户自由字段

因子 registry 由 core 中版本化、可审计的静态定义提供；Factor ID、source metric、单位和方向不能由 LLM、Web 表单或 Strategy DSL 临时发明。新增/改变因子必须产生新的 `registryVersion` 和测试向量，旧 score version 仍引用旧 registry。

```ts
type FactorKind = 'reported' | 'derived';
type FactorDirection = 'higher' | 'lower';
type FactorPeriodPolicy = 'latest-annual' | 'latest-quarter' | 'ttm-4-quarter';
type FactorMissingPolicy = 'unknown' | 'exclude-stock' | 'fail-run';

interface FactorDefinition {
  readonly id: string;                 // 例如 fundamental.profitability.roe
  readonly registryVersion: string;    // 例如 fundamental-factor-registry-v1
  readonly kind: FactorKind;
  readonly sourceMetricIds: readonly string[];
  readonly computeId: string;           // 已注册 deterministic function；不保存任意 JS 表达式
  readonly periodPolicy: FactorPeriodPolicy;
  readonly outputUnit: FinancialCanonicalUnit;
  readonly direction: FactorDirection;
  readonly allowedNormalizers: readonly ('market-percentile-v1' | 'industry-percentile-v1')[];
  readonly missingPolicy: FactorMissingPolicy;
  readonly validRange?: { readonly min?: number; readonly max?: number };
  readonly description: string;
}
```

registry 自身必须通过：ID 唯一、source metric 已知、`computeId` 已注册、output unit 与 compute 结果一致、方向明确、normalizer 有效、range 不矛盾。derived factor 的输入期间必须由 `periodPolicy` 同时解析，不能将不同报告期的值拼成一个“最新”结果。

### 5.2 v1 单位与方向

规范值只使用下列 canonical unit：

| unit | 示例 | 约定 |
|---|---|---|
| `percent-points` | ROE=15 表示 15% | 不存 0.15；显示可加 `%` |
| `ratio` | PE=20、PB=2.1 | 无量纲倍数；分母不合法时 missing |
| `CNY` | revenue、market cap | 统一人民币；转换必须有来源和汇率 vintage |
| `CNY-per-share` | EPS | 人民币/股；股本期间必须匹配 |
| `share` | shares outstanding | 股；不能与手、万股混算 |
| `day` | days | 交易日/自然日由 factor 明确，v1 只用于期间派生 |

方向只表达“对 score 的偏好”：`higher` 原始值越大越有利，`lower` 原始值越小越有利。原始值永远保留，归一化时才按 direction 翻转；不能通过取负数破坏原始事实。

### 5.3 v1 因子目录示例

以下是设计示例，不代表当前源已经可用；每项必须等真实数据门禁通过后才可标为 operational：

| factorId | source / compute | period | unit | direction | 默认缺失 |
|---|---|---|---|---|---|
| `fundamental.profitability.roe` | `roe` / identity | latest-annual | percent-points | higher | unknown |
| `fundamental.growth.revenue-yoy` | `revenue-yoy` / identity | latest-annual | percent-points | higher | unknown |
| `fundamental.quality.ocf-margin` | `operating-cashflow` + `revenue` / divide-percent | latest-annual | percent-points | higher | unknown |
| `fundamental.valuation.pe` | `pe` / identity | latest-quarter | ratio | lower | unknown |

v1 不将 `roe`、`revenue-yoy` 等名称直接当成任意 provider 字段；adapter 必须把 source payload 映射到 registry 认可的 metric、period、unit 和 publication/revision 元数据。

## 6. 横截面 Normalization

### 6.1 v1 支持的方法

Phase 3 v1 只冻结以下两个 normalizer：

- `market-percentile-v1`：整个 PIT StockUniverse 中同一 factor、同一 period policy 的可用样本；
- `industry-percentile-v1`：按同一 `asOf` 的 PIT `industryKey` 分组，每个行业独立计算。

industry 分组必须来自与 financial fact 同时点可验证的 source vintage。当前 `Stock.industry` 或今日研究档案行业字段不是合法分组。没有 industry vintage 时只能返回 `group-missing`；不退回 market percentile，避免同一 score version 在不同股票上混用口径。

每个 normalizer 配置必须包含 `minSampleSize`，v1 默认值冻结为 20；未来修改必须产生新的 normalizer version。样本小于门槛时该组所有归一化值为 `sample-too-small`，不输出伪造的 50 分。评估模式可以显式设置更高门槛，不能降低生产 score version 已冻结的门槛。

### 6.2 Percentile 公式

对一个 factor/group 的 `n` 个可用 raw values，按 `(rawValue ASC, stockId ASC)` 稳定排序；相同 rawValue 使用平均名次 `r`。使用：

```text
n = 1: ascending = 50
n > 1: ascending = 100 * (r - 1) / (n - 1)
higher: normalized = ascending
lower:  normalized = 100 - ascending
```

实现必须：

- 只用满足同一 `asOf`、period policy、unit、PIT status 的样本；缺失值不进入分母；
- 先按 raw value 分组再取平均名次，stockId 只负责稳定 tie order；
- normalized、contribution、score 按 score version 指定的小数精度持久化；v1 统一 round-to-6-decimal，展示层才 round-to-2；
- 输出样本数、组 key、分母 hash、缺失数和 normalizer version；
- 不做 winsorize、z-score、分位桶、行业回退、跨日合并或 current snapshot fallback；这些都属于未来版本。

### 6.3 缺失与排名

Factor missing policy 在 score version 中再次确认：

- `unknown`：保留该股结果和每个 missing reason，但 `score/rank` 缺省；不重分配其它 factor 权重；
- `exclude-stock`：该股不进入 score/rank population，同时保留 `excluded` 结果和原因；不能把排除当作 0 分；
- `fail-run`：任一必要事实缺失即整次 score run `unavailable`。

同一 score run 内，缺失政策、normalizer、asOf 和 PIT vintage 必须固定；不能根据缺失股票数量动态改变权重、分母或样本范围。

## 7. Score Version 与结果

### 7.1 不可变 score version

`FundamentalScoreVersion` 是 factor registry、normalizer、权重、缺失和舍入规则的不可变快照。它不是 Advice，也不等同于 StrategyVersion；StrategyVersion 可以引用它，但发布 score version 或 StrategyVersion 都必须经过现有显式确认/发布流程。

```ts
interface FundamentalScoreVersion {
  readonly id: string;
  readonly version: number;
  readonly registryVersion: string;
  readonly registryHash: string;
  readonly normalizationVersion: string;
  readonly components: readonly {
    readonly factorId: string;
    readonly weight: number;
    readonly normalizer: 'market-percentile-v1' | 'industry-percentile-v1';
  }[];
  readonly missingPolicy: FactorMissingPolicy;
  readonly rounding: 'round-to-6-decimal';
  readonly definitionHash: string;
  readonly status: 'draft' | 'published' | 'retired';
  readonly createdAt: Date;
  readonly publishedAt?: Date;
}
```

不变量：component factor 唯一；weight 为 finite、正数且总和恰为 1（canonical decimal 误差不超过 1e-9）；factor、normalizer 与 registry 版本匹配；`published` 版本不可修改；修改必须新建 version/hash。`definitionHash` 对 canonical JSON 做 sha256，字段顺序和数组顺序固定。

### 7.2 Score 计算

对每股：

```text
normalized_i ∈ [0, 100]
contribution_i = round6(normalized_i * weight_i)
score = round6(sum(contribution_i))
```

只有所有必要 component 满足 score version 的 missing policy 时才有 score。score 是 0–100 的规则分，不是概率、置信度、收益率或 Advice。rank 按 `score DESC, stockId ASC` 稳定排序；`top` 截断是 Strategy/score run 的显示或选择策略，不改变原始 rank。

结果结构至少包含：

```ts
interface FundamentalScoreResult {
  readonly scoreRunId: string;
  readonly stockId: string;
  readonly status: 'available' | 'missing' | 'excluded' | 'unavailable';
  readonly score?: number;
  readonly rank?: number;
  readonly components: readonly {
    readonly factorId: string;
    readonly rawValue?: number;
    readonly unit: FinancialCanonicalUnit;
    readonly direction: FactorDirection;
    readonly normalizedValue?: number;
    readonly contribution?: number;
    readonly sourceRevisionIds: readonly string[];
    readonly missingReason?: FinancialMissingReason;
  }[];
  readonly dataAsOf: Date;
  readonly vintageKey: string;
}
```

一次评分本身也要作为不可变运行事实保存，至少包含：

```ts
interface FundamentalScoreRun {
  readonly id: string;
  readonly scoreVersionId: string;
  readonly scoreVersionHash: string;
  readonly registryHash: string;
  readonly universeSyncId: string;
  readonly universeMemberChecksum: string;
  readonly asOf: Date;
  readonly financialVintageKey: string;
  readonly normalizerDenominatorHash: string;
  readonly counts: {
    readonly evaluated: number;
    readonly available: number;
    readonly missing: number;
    readonly excluded: number;
  };
  readonly providerStatus: 'complete' | 'partial' | 'unavailable';
  readonly evaluatorCodeIdentity: string;
  readonly status: 'started' | 'committed' | 'unavailable' | 'failed';
  readonly createdAt: Date;
  readonly committedAt?: Date;
}
```

`scoreVersionId/hash`、`registryHash`、`universeSyncId/memberChecksum`、`asOf`、`financialVintageKey`、normalizer 分母摘要、evaluated/available/missing/excluded counts、provider status 和 evaluator code identity 都必须落在该运行事实中。没有这些 identity 的 score 不能进入 operational StrategyRun。`commit` 只能从 `started` 进入一次 `committed`；失败或 unavailable 运行保留状态和原因，不产生可消费的部分结果。

### 7.3 Strategy DSL 对接

现有 `StrategyDslV1` 保持完全兼容，技术 `scoring.components[].ruleId` 的语义不变。Phase 3 采用新的显式 DSL 版本（名称冻结为 `StrategyDslV2`）或等价的独立 `fundamental` block，至少包含：

```yaml
schemaVersion: 2
fundamental:
  scoreVersionId: fundamental-score-v1
  asOfPolicy: strategy-run-as-of
```

V2 的 `fundamental.scoreVersionId` 只引用已发布 score version；不能在 DSL 中覆盖 factor 的单位、方向、compute 或 missing policy。`StrategyRun.inputSnapshot` 增加 `fundamentalScoreVersionId`、`financialVintageKey` 和对应 data checkpoint；`StrategyResult` 以可选 `fundamentalScore`/`factorResults` 或 score-run 引用承载结果，旧结果没有这些字段时继续按技术策略读取。

Phase 3 初始只把基本面分数作为独立、可解释的 Strategy 事实；不得把它隐式加到现有技术 score，也不得改变 `StrategySignal`、Advice 或 Trade 语义。若未来需要技术+基本面合成，必须发布新的 score version/DSL schema，显式定义组件、权重和门禁。

## 8. 双实现仓储与数据库

“双仓储”在本文中指每一个新增 repository contract 都必须同时有 Drizzle/SQLite 与 in-memory 实现，并由同一 contract test suite 验证，不是只写一条生产路径。

### 8.1 Core interfaces

建议新增以下接口，均位于 `packages/core`，不依赖 db、tools 或 adapters：

```ts
interface FinancialFactRepository {
  appendMany(facts: readonly FinancialFact[]): Promise<void>;
  listRevisions(input: {
    readonly stockIds: readonly string[];
    readonly metricIds?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly FinancialFact[]>;
  resolveVintage(input: {
    readonly stockIds: readonly string[];
    readonly metricIds: readonly string[];
    readonly asOf: Date;
    readonly policy: 'strict-pit-v1';
  }): Promise<FinancialVintage>;
}

interface FundamentalScoreVersionRepository {
  save(version: FundamentalScoreVersion): Promise<void>;
  findById(id: string): Promise<FundamentalScoreVersion | null>;
  list(input?: { readonly status?: FundamentalScoreVersion['status'] }): Promise<readonly FundamentalScoreVersion[]>;
}

interface FundamentalScoreRunRepository {
  saveStarted(run: FundamentalScoreRun): Promise<void>;
  commit(input: {
    readonly run: FundamentalScoreRun;
    readonly results: readonly FundamentalScoreResult[];
  }): Promise<void>;
  findById(id: string): Promise<FundamentalScoreRun | null>;
  listResults(runId: string): Promise<readonly FundamentalScoreResult[]>;
}
```

`FactorRegistry` 是版本化 core 常量和 resolver，不设用户运行时 repository；`registryHash` 进入 score version。所有 repository 方法都必须 parse schema、复制 Date/数组、稳定排序并明确空结果与 unavailable 的区别。

### 8.2 SQLite 表与索引

迁移新增以下表，具体列名按现有 snake_case 约定落地：

1. `financial_fact_revisions`：append-only，保存 §4 的有效事实和 provenance；不得以 `(stock_id, metric_id, period_end)` 做覆盖 upsert。
2. `fundamental_score_versions`：保存 canonical definition、registry/normalizer hash、status 和发布时间。
3. `fundamental_score_runs`：保存 score version、asOf、universe/vintage identity、coverage、status、provider/evaluator 信息。
4. `fundamental_score_results`：按 `(score_run_id, stock_id)` 唯一，保存 status、score、rank、factor component JSON（必须通过 core schema 验证）及 vintageKey。

至少建立：

- financial fact：`(stock_id, metric_id, period_end, revision_published_at, recorded_at)`、`(source, source_record_id, source_revision, content_hash)` 唯一/查询索引；
- score version：`definition_hash` 唯一、`status/version` 查询索引；
- score run/result：`(score_version_id, as_of)`、`(score_run_id, stock_id)` 唯一、`(score_run_id, rank)` 查询索引。

Drizzle schema、SQLite `ensureSchema`、memory 实现和 contract tests 必须同一提交同步。大批量 stock/metric 查询使用显式 chunk，不能生成超出 SQLite bind 上限的单 SQL。

## 9. Adapter、Tool 与 Workflow 边界

### 9.1 Adapter

新增独立 `FundamentalDataAdapterLike`/`FundamentalDataManager`，不扩展 `MarketDataAdapterLike` 来隐藏财务能力。adapter 只负责：

- 调用外部 financial endpoint，设置 timeout、retry、限流和 source health；
- 解析 source payload，保留 sourceRecordId、sourceRevision、publishedAt、revisionPublishedAt、raw unit/value；
- 将 raw metric 映射到 registry 认可的 metric，并完成显式 canonical unit conversion；
- 对缺 publication/revision/单位的记录返回结构化 issue，不生成可用事实。

adapter 不负责：

- 选择 PIT vintage、跨股票归一化、权重、rank 或 Strategy 选择；
- 调用 repository 直接写库；
- 猜测报告发布时间、用抓取时间冒充发布时间、用当前行业替代历史行业；
- 在主源失败时切换到不具备 PIT 元数据的“当前值”源。

多个 PIT-capable source 才能 fallback 时，必须把最终 source、revision 和内容 hash 写入事实；同一 score run 不得把不同 source 的同一 metric 混合成无 source identity 的值。

### 9.2 Tools

工具契约建议如下：

| Tool | sideEffect/能力 | 职责 | 门禁与暴露 |
|---|---|---|---|
| `sync_financial_facts` | `external` + `write` | 拉取、校验并 append PIT facts/ingestion issues | 显式 opt-in；不进 Agent read 白名单；未配置 adapter 返回 unavailable |
| `get_financial_facts` | `read` | 按 asOf 查询 vintage、事实、覆盖和 missing | 不得回源当前接口补历史；可供只读 surface |
| `run_fundamental_score` | `write`（`persist=false` 也不改变副作用声明） | 读取已发布 score version + PIT facts，计算并可持久化 score run | 只接受显式 asOf/scoreVersion；不产生 Advice/Trade |
| `get_fundamental_score` | `read` | 查询已持久化 score run/result 和逐因子解释 | 只读；必须展示 score version、vintage、缺失和 dataAsOf |

Tool input/output 用 Zod schema 派生，失败统一 `ToolResult`。`sync_financial_facts` 与可持久化 `run_fundamental_score` 的 write/external 能力须经过现有 Web/MCP hard gate；MCP 默认不暴露写入路径。score 工具即使被用户确认，也只写事实/研究结果，不能调用 `add_trade`、Advice 或通知。

### 9.3 Workflow

workflow 只通过 `ctx.tools.*.execute()` 编排：

- `fundamental-data-sync`：显式触发 `sync_financial_facts`，记录 `WorkflowRun`、provider status 和 coverage；单源失败不能伪造 complete。
- `fundamental-score-evaluation`：取得 PIT universe/checkpoint，调用 `get_financial_facts`/`run_fundamental_score`，持久化可审计 score run；evaluation/non-publishing 运行不覆盖生产 Strategy 视图。
- `run-strategies` 的 scheduled 分支只有在 data gate=`operational` 且 StrategyVersion 显式引用 score version 时才准备/消费基本面 checkpoint；否则运行保持 technical-only 或明确 withheld，不能自动补基本面。

workflow 不直接调用 `ctx.repos` 或 `ctx.adapters`，不把 LLM 放入 factor/normalizer 热路径，不自动生成 Advice、Watchlist 成员或交易。

## 10. Strategy 发布、迁移与兼容

### 10.1 版本兼容

- `StrategyDslV1`、已有 `StrategyVersion`、技术 `StrategyResult.score` 和历史 StrategyRun 不重写。
- `StrategyDslV2`/`fundamental` block 只有在 score version 为 `published`、registry hash 匹配、真实数据 gate 允许时才能发布。
- V1 Strategy 默认没有 `fundamentalScoreVersionId`，继续 technical-only；不得因新表为空而被判定为失败。
- V2 运行的 input snapshot 必须同时保存 score version、financial vintage、universe member checksum 和 evaluator identity；缺任何 identity 的 replay 只能 `unavailable`。

### 10.2 数据库迁移

迁移采用现有幂等 `ensureSchema` 方式：

1. 新库创建四张 Phase 3 表及索引。
2. 存量库只添加新表/索引，不修改或删除 `daily_bars`、`daily_bar_revisions`、Strategy、Trade、Advice 或 Report 数据。
3. 不从当前报价、日线、报告摘要、研究正文或数据库中的任意“ROE/PE”字段 backfill financial facts；没有 publication/revision/recordedAt 的历史值保持未覆盖。
4. 失败迁移可重跑；事实 append 以 source revision/hash 幂等，score version/run commit 以稳定 identity 幂等。
5. 旧导入文件不自动获得 PIT metadata；导入端必须拒绝或标记 `publication-unknown`，不能把文件导入时间当成历史发布时间。

### 10.3 生命周期与删除

Financial facts 和 score results 是审计事实，默认不物理删除；撤回使用 `retracted` revision。已发布 score version 不修改、不级联删除；retired 只阻止新 run，不影响历史结果读取。清理策略若未来需要，必须保留 provenance/hash 并单独设计 retention audit。

## 11. 测试契约

### 11.1 Core/schema/registry

- FinancialFact schema：单位、币种、时间顺序、status、supersedes、hash、不接受 NaN/Infinity/空 publication。
- vintage resolver golden tests：同期间多 revision、截至 cutoff 前后、retraction、相同发布时间 tie、recorded-after-cutoff、缺 revision metadata。
- factor registry：重复 ID、未知 source metric、compute/unit 不匹配、非法方向/range/period、registry hash 稳定。
- derived factor：期间对齐、分母为 0、缺期间、canonical unit 转换和每个 missing reason。
- normalizer golden tests：market/industry 分组、n=1、并列平均名次、higher/lower、sample-too-small、缺 group、稳定 stockId tie、无隐式 fallback。
- score version/engine：权重和、round-to-6、组件贡献、缺失不重分配、stable rank、definition/vintage hash identity。

### 11.2 Repository contract

同一 contract suite 必须对 in-memory 与 Drizzle 运行：

- append-only 与重复 revision 幂等；旧 revision 不被覆盖；
- `resolveVintage` 严格过滤 `publishedAt/revisionPublishedAt/recordedAt`，撤回不回退；
- 分页/chunk、日期边界、空集合、稳定排序和大样本查询；
- score version immutable、重复 commit 幂等、score result `(run, stock)` 唯一；
- 读写对象不会暴露可变引用，迁移前后旧 Strategy/Trade/Advice contract 不变。

### 11.3 Adapter/tool/workflow

- adapter fixture 只验证 parser/timeout/retry/provenance；没有 PIT metadata 的 payload 必须 unavailable；
- Tool 不读取 current market endpoint 补历史，不绕过 repository，不泄漏 raw credentials；
- `sync` 失败/部分覆盖的 `ToolResult`、provider health、ingestion issue 和 workflow audit；
- score tool 的 persist=false 不写库，persist=true 只写 score run/result；不调用 Advice/Trade；
- workflow 只经 `ctx.tools`，evaluation/non-publishing 不覆盖 operational Strategy；
- Agent/CLI/Web 只看到注册工具契约，未通过 gate 的基本面分数展示原因而非空数组。

### 11.4 Migration and browser acceptance

- 使用旧 schema 建临时 SQLite，启动 `ensureSchema` 后检查四张表、索引、旧数据和重复启动；
- 使用真实 tool API 验证 `asOf`、vintage、missing、score version、factor explanation 和 dataAsOf；
- UI（若 Phase 3 slice 包含 Strategy workspace 展示）必须实际启动 Web，用浏览器确认 score version、PIT cutoff、分母样本、缺失原因和“非收益概率”文案；测试不能只验证 HTML 字符串。

测试 fixture 可以使用合成财务行，但只能证明 schema/算法/仓储 contract，不能作为真实数据门禁证据或生产完成证明。

## 12. 真实 PIT 数据门禁

### 12.1 门禁状态

`fundamental-data-gate-v1` 有三个状态：

- `not-ready`：没有 PIT-capable adapter、凭据、publication/revision 时间或单位映射；只能跑 contract/算法测试，生产 score tool 返回 `unavailable`。
- `evaluation-ready`：真实源通过最小历史样本检查，只允许显式 evaluation/research run，不允许覆盖 operational Strategy。
- `operational`：所有强门禁和复核证据通过，才允许 scheduled Strategy 消费基本面 score。

当前仓库状态按 `not-ready` 处理；现有 market/daily-bar provider、mock fixture、当前财报 API 或手工 CSV 不会自动升级状态。

### 12.2 evaluation-ready 最小证据

必须使用脱敏真实 source 响应和真实 source timestamps，不接受测试 fixture：

- 至少 50 个沪深 A 股、至少 3 个行业分组、至少 4 个报告期间；
- 至少 3 个 registry factor，其中至少 1 个 ratio、1 个 percent-points；
- `publishedAt`、`revisionPublishedAt`、`recordedAt` 和 source revision identity 完整率 100%；
- 至少一组同期间发生 restatement/retraction 的真实样本，resolver 能在 cutoff 前后选出不同 revision；
- unit mapping、currency mapping、period mapping 100% 通过；
- 重复执行 canonical query 得到相同 fact/vintage/score hash；
- 缺失、撤回、源失败均按 reason 输出，没有任何隐式 0/fallback。

### 12.3 operational 强门禁

`fundamental-data-gate-v1` 的 operational 评估至少需要：

1. 至少 100 个沪深 A 股、至少 5 个行业、至少 8 个连续报告期间的真实 PIT 覆盖。
2. required fact 请求的 PIT resolvability 不低于 99%；剩余缺失必须逐条有 reason，不能被统计吞掉。
3. publication/revision/recordedAt 完整率 100%，且不出现 `revisionPublishedAt > recordedAt` 或 future period 泄漏。
4. 至少 10 条真实 restatement/retraction revision，前后 cutoff 的 resolver 结果与 source evidence 一致。
5. canonical unit/metric/period 转换通过率 100%；无未注册 metric、未知单位或未经审计汇率。
6. market percentile 与使用中的 industry percentile 分母 coverage 100%；行业组低于 `minSampleSize=20` 的股票明确 unavailable，不做回退。
7. score engine golden vector、repository contract、迁移、失败重试和重复运行全部通过；不同实现得到相同 hash/rank。
8. 连续两次真实同步/评估运行的 provider health、latency、source revision、vintageKey、missing report 可审计；任何 raw key/token 不进入证据。

门禁证据包至少包括：provider/capability 名称、查询区间、asOf/cutoff、覆盖统计、缺失原因计数、source revision/content hash 摘要、resolver golden sample、score version/registry hash、运行时间和 reviewer。证据包不提交密钥、私人账本或完整财报正文。

### 12.4 门禁失败处理

- gate 失败只产生 `unavailable`/`withheld` 结果，保留上一版 operational Strategy 视图；
- 不因为“有部分股票可算”就发布完整横截面 score；
- provider 返回当前值但没有 PIT metadata 时，错误类型必须是 `unsupported_capability` 或 `publication-unknown`；
- 重试、fallback 和恢复不能改变历史已持久化 fact 的 revision identity；
- 只有 gate evidence 达到 `operational` 且经过人工复核，才允许打开 production schedule；这不是测试通过的自动推断。

## 13. 可独立验收的纵向切片

每个切片都必须能独立运行相关测试，并明确不越过真实数据门禁。

### P3-0：契约与 registry（无外部数据）

交付：FinancialFact/Vintage、FactorDefinition、normalizer、ScoreVersion/Result schema；代码化 registry；core golden tests。

验收：未知字段/单位/方向/compute 被拒绝；缺失不填零；percentile 和 score vector 可重算；没有 tool/adapter 声称生产可用。

### P3-1：PIT facts ingestion（真实源前置）

交付：FinancialDataAdapterLike、source registry、`FinancialFactRepository` Drizzle + memory、`sync_financial_facts`/`get_financial_facts`、SQLite migration/contract tests。

当前 mock 装配已交付上述契约、仓储、迁移和 Tool，并通过 `LUOOME_FUNDAMENTAL_PROVIDER=mock` 显式启用；所有输出固定披露 `providerKind=mock`、`gate=not-ready`。真实源 adapter、evaluation-ready 证据与生产 schedule 仍未交付。

验收：重复 revision 幂等、append-only、cutoff 选择正确、publication/revision 缺失为 unavailable；没有通过 evaluation-ready gate 时生产入口保持关闭。

### P3-2：deterministic factor/score engine

交付：registered compute functions、market/industry percentile v1、FundamentalScoreVersion/Run/Result repositories、`run_fundamental_score`/`get_fundamental_score`。

当前已交付 registered compute、固定最小样本、market/industry percentile、稳定 round/rank、score version/run/result 的 Drizzle + memory 仓储与幂等迁移，以及上述两个 Tool。`run_fundamental_score` 只接受 published score version 和显式 universe/asOf identity，校验 member checksum，evaluator identity 由代码固定；`persist=false` 不写 score 仓储，unavailable run 只保存终态原因而不保存可消费结果。所有输出继续固定披露 `providerKind=mock`、`gate=not-ready`，且未接入 Strategy DSL 或生产 schedule。

验收：单位和方向明确、分母/缺失/小样本状态正确、贡献/round/rank 稳定；persist=false 不写库；不调用 Advice/Trade。

### P3-3：Strategy integration（evaluation-only）

交付：StrategyDslV2/fundamental block、Strategy input snapshot 和 result 可选字段、fundamental score checkpoint、evaluation workflow；V1 compatibility tests。

验收：V1 technical-only 行为不变；V2 必须引用已发布 score version 和 vintage identity；evaluation/non-publishing 不覆盖 operational 视图；缺门禁时 withheld/unavailable 可解释。

### P3-4：真实数据门禁与 operational schedule

交付：gate evaluator/evidence formatter、provider health/metrics、人工复核 runbook、scheduled workflow 开关。

验收：达到本文 12.2/12.3 的真实数据证据才允许切换状态；失败保留上一版并报告 missing；证据不含 secrets；重复真实运行 hash/rank 稳定。

### P3-5：只读解释与用户验收

交付：Strategy workspace/Agent facts 的只读 score 展示（若产品排期包含），引用 factor、raw/normalized、unit、direction、sample、PIT cutoff、source revision 和 missing reason。

验收：浏览器能区分 score 与 Advice/收益概率；未知/partial/unavailable 明示；任何确认/写入不产生交易；未通过 gate 的页面不会展示“完成”或伪造空结果。

## 14. 交付检查表

实现提交前必须逐项给出证据：

- [ ] core schema/invariants、registry hash、normalizer golden vectors；
- [ ] financial fact PIT resolver 及 publication/revision/recordedAt contract；
- [ ] Drizzle/in-memory repository 与同一 contract tests；
- [ ] adapter capability、timeout/retry/health、单位和 provenance；
- [ ] tool Zod schema、ToolResult、write/external gate、无 Advice/Trade 路径；
- [ ] workflow 只经 `ctx.tools`，evaluation/publication/lease 语义清楚；
- [ ] Strategy V1 兼容、V2 引用和 input snapshot identity；
- [ ] idempotent migration，不伪造历史 publication，不改 Trade/weekly；
- [ ] 真实 PIT gate evidence 达到 evaluation-ready/operational 对应级别；
- [ ] 定向测试、typecheck、lint、migration test 和实际 Web/浏览器验收（若包含 P3-5）；
- [ ] 仍明确“基本面 score 是规则事实，不是 Advice、收益概率或交易”。
