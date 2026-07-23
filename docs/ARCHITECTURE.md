# Architecture

> luoome 的架构核心。设计哲学、模块边界、数据流、安全模型、**advisor 模型**。

## 1. 目标与边界

### 1.1 我们要解决的问题

普通个人投资者每天被淹没在数据里：行情、新闻、财报、研报、战法信号、自选股、持仓变化。**最大的痛点不是缺数据，而是没有一个可信的"罗网 + 织机"**：

- 不知道哪些信息是真信号、哪些是噪音
- 不知道这些信号对自己的持仓意味着什么
- 不知道当下应该买 / 卖 / 持有 / 观望
- 不知道做出的决策事后看是对是错

luoome = 织机 + 罗网：**罗**进来所有有价值的数据，**织**成一份带理由、带证据、带风险、带信心度的投资建议。

它不只是数据搬运工，是 advisor：每一份数据最终都要回答"所以呢？我该怎么做？"

### 1.2 显式不做的事

- ❌ 自动真实下单（券商合规 + 资金风险，永远人工确认；建议归建议，行动归行动）
- ❌ 云同步账户数据（local-first 默认）
- ❌ 替代券商 App（不做交易 UI，做 advisor 层）
- ❌ 跨用户共享投资建议（个人工具，不是跟单平台）

### 1.3 显式要做的事

- ✅ **生成可执行的投资建议**（buy / sell / hold / watch / avoid），带理由 + 证据 + 风险 + 信心度 + 免责声明
- ✅ **建议可追溯**：每条建议都能回到当时的数据快照、战法信号、LLM 推理
- ✅ **建议可复盘**：事后能验证"按这个建议做，结果如何"
- ✅ 把建议当作数据存储在本地 SQLite，可被任意 tool / workflow / agent 检索

## 2. 设计哲学

6 条核心原则，所有具体设计都要回溯到这 6 条。

### 2.1 Advisor-first

每一份数据最终都服务于"可执行的投资建议"。如果一个数据点不能影响任何建议的产出，那它就不该被罗进来。

倒过来看：**advice 不是 workflow 的副产物，是 first-class 实体**。它有自己的 schema、自己的存储、自己的检索 API、自己的统计（准确率、覆盖率、平均信心度）。

### 2.2 Agent-first

任何用户能做的事，agent 也应该能做。包括：
- ✅ 查询持仓 → tool
- ✅ 添加持仓 → tool
- ✅ 跑战法扫描 → tool
- ✅ 生成建议 → tool / workflow
- ✅ 查看历史建议 → tool
- ❌ 隐藏在 UI 菜单里、没有 tool 对应的功能 → 不允许

### 2.3 Schema-driven

**Zod schema 是 tool I/O 的事实来源**。同一份 Zod 定义同时产出：

1. TypeScript 输入/输出类型
2. MCP tool 定义
3. OpenAI function calling JSON schema
4. 运行时校验

Tool 不允许"裸手写函数签名"。每个 tool 必须从 Zod schema 推导类型。

### 2.4 Workflow ≠ Tool

- **Tool**：原子能力，无编排。可独立测试，可独立暴露给上层 agent。
- **Workflow**：组合多个 tool + 可选 LLM 推理。有顺序、有循环、有条件分支。Workflow **不作为 tool 暴露**给上层 agent（避免循环编排），但可被人手动触发（CLI/TUI/Web）。

例如：
- `compute_pnl`（tool）= 纯计算
- `analyze_stock`（tool）= 拉行情 + 算指标 + LLM 分析 → 输出结构化建议
- `daily-advice`（workflow）= 扫所有持仓 + 调 `analyze_stock` 拿建议 + 排序 + 推送

### 2.5 Repository Pattern

core 包定义 repository **接口**，db 包用 Drizzle 实现。tools/workflows 只依赖 core 接口，不耦合 Drizzle。

好处：
- 测试用 in-memory mock repo，不依赖真实数据库
- 将来换 DuckDB / Postgres 不动业务层

### 2.6 副作用分级 + Advisor 边界

每个 tool 必须显式声明**副作用等级**，消费者据此决定是否可调用：

| 等级 | 含义 | 例子 | 默认暴露给 MCP |
|---|---|---|---|
| `read` | 只读本地 | `list_holdings`, `get_advice` | ✅ |
| `write` | 写本地状态 | `add_holding` | ⚠️ 可配置 |
| `external` | 调用第三方 | `fetch_quote`, `send_notification` | ⚠️ 可配置 |
| `advice` | 生成建议（含 LLM 推理） | `analyze_stock`, `daily_advice` | ✅ |
| `trade` | 触发真实资金动作 | `place_order` | ❌ 永不 |

**新增 `advice` 等级**：advice tool 本质是只读 + LLM 推理，但产出有"建议"性质，需要独立标记。它有自己特殊的安全约束（详见 §11）。

**advice ≠ trade**：advice 永远不能直接触发 trade。trade 永远是 human-in-the-loop。

## 3. 模块结构

```
luoome/
├── packages/
│   ├── core/           纯领域类型 + 不变量 + advice 模型
│   ├── db/             Drizzle schema + repository 实现
│   ├── tools/          Tool 注册表 + schema 生成
│   ├── adapters/       行情 / LLM / 通知 / 券商 适配
│   ├── workflows/      内置编排：review / scan / diagnose / advise
│   ├── mcp/            MCP server
│   ├── cli/            命令行入口
│   └── tui/            opentui 应用
└── apps/
    └── web/            Web 端（v0.4 起）
```

### 依赖方向（强约束）

```txt
cli ──┐
tui ──┤
mcp ──┼──► tools ──► core
web ──┤        │
      │        ├──► db ──► core
      │        │
      │        └──► adapters ──► core
      │
      └──► workflows ──► tools ──► core
```

**禁止反向依赖**：core 不知道 db / tools 的存在；tools 不知道 cli / tui 的存在；adapters 不知道 workflows 的存在。

### packages/core 内部依赖

```
core/types/         Money / Quantity / Percentage branded types
core/entity/        Account / Holding / Trade / Stock / ...
core/entity/        Advice  ← 第一类实体
core/repository/    接口（无实现）
core/error/         InvariantError / ToolError / ...
```

## 4. 核心概念

### 4.1 Domain Entity（core 包）

纯 TS 类型 + 不变量断言，**无 IO**。

```ts
// core/entity/holding.ts
export interface Holding {
  readonly id: string;
  readonly accountId: string;
  readonly stockId: string;
  readonly quantity: number;          // 整数股
  readonly availableQuantity: number; // 可卖数量
  readonly avgCost: Money;            // decimal
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

export const assertHoldingInvariants = (h: Holding): void => {
  if (h.quantity < 0) throw new InvariantError('quantity < 0');
  if (h.availableQuantity < 0) throw new InvariantError('availableQuantity < 0');
  if (h.availableQuantity > h.quantity) throw new InvariantError('available > total');
};
```

**Money / Quantity / Percentage** 用 branded type，禁止直接 `number` 混算。

### 4.2 Advice Entity（第一类）

详见 §6，这是 luoome 区别于普通行情工具的关键。

### 4.3 Repository（core 接口 + db 实现）

```ts
// core/repository/holding.ts
export interface HoldingRepository {
  findById(id: string): Promise<Holding | null>;
  listByAccount(accountId: string): Promise<Holding[]>;
  save(holding: Holding): Promise<void>;
  remove(id: string): Promise<void>;
}

// core/repository/advice.ts
export interface AdviceRepository {
  save(advice: Advice): Promise<void>;
  findById(id: string): Promise<Advice | null>;
  query(filter: AdviceQuery): Promise<Advice[]>;
  recordOutcome(adviceId: string, outcome: AdviceOutcome): Promise<void>;
}
```

```ts
// db/repository/holding.ts (Drizzle 实现)
export class DrizzleHoldingRepository implements HoldingRepository {
  constructor(private readonly db: DrizzleDB) {}
  // ...实现
}
```

### 4.4 Tool（tools 包）

```ts
// tools/list-holdings.ts
import { z } from 'zod';

export const ListHoldingsInput = z.object({
  accountId: z.string().uuid().optional(),
  status: z.enum(['active', 'closed', 'all']).default('active'),
});

export const ListHoldingsOutput = z.object({
  holdings: z.array(HoldingSchema),
  totalValue: MoneySchema,
  totalCost: MoneySchema,
  totalPnL: MoneySchema,
  totalPnLPct: PercentageSchema,
});

export const listHoldingsTool = defineTool({
  name: 'list_holdings',
  description: '列出指定账户下的当前持仓',
  sideEffect: 'read',
  input: ListHoldingsInput,
  output: ListHoldingsOutput,
  handler: async (input, ctx) => {
    const repo = ctx.repos.holding;
    const holdings = await repo.listByAccount(input.accountId ?? ctx.defaultAccountId);
    return { holdings, ...aggregate(holdings) };
  },
});
```

### 4.5 Tool Registry

```ts
// tools/registry.ts
export const toolRegistry = createRegistry([
  listHoldingsTool,
  getHoldingTool,
  addHoldingTool,
  analyzeStockTool,         // advice 类
  getAdviceTool,            // advice 类
  // ...
]);

// 自动产物：
const tsTypes = toolRegistry.toTypeScript();
const mcpTools = toolRegistry.toMCP();
const openaiTools = toolRegistry.toOpenAI();
const openApiSpec = toolRegistry.toOpenAPI();
```

**一次定义，多处生效**。改一个 Zod schema，所有面自动同步。

### 4.6 Workflow（workflows 包）

```ts
// workflows/daily-advice.ts
export const dailyAdviceWorkflow = defineWorkflow({
  name: 'daily-advice',
  description: '为所有持仓股生成当日建议',
  input: z.object({ accountId: z.string().uuid() }),
  steps: [
    step('fetch-holdings', (input, ctx) => ctx.tools.list_holdings.execute({ accountId: input.accountId })),
    step('fetch-quotes', (holdings, ctx) => ctx.adapters.market.batchQuote(holdings.map(h => h.stockId))),
    step('compute-pnl', ([holdings, quotes], ctx) => ctx.tools.compute_pnl.execute({ holdings, quotes })),
    step('run-tactics', (data, ctx) => ctx.workflows.runTacticScan({ scope: 'holdings' })),
    step('analyze-each', (data, ctx) => parallel(data.holdings.map(h =>
      ctx.tools.analyze_stock.execute({ stockId: h.stockId, context: data })
    ))),
    step('persist', (advices, ctx) => Promise.all(advices.map(a => ctx.repos.advice.save(a)))),
    step('notify', (advices, ctx) => ctx.tools.send_notification.execute({
      title: '今日持仓建议',
      summary: `${advices.length} 条建议，其中 ${advices.filter(a => a.confidence >= 70).length} 条高信心度`,
    })),
  ],
});
```

Workflow 通过 `ctx.tools.xxx.execute()` 调用 tool，**不允许直接调 repository 或 adapter**（advice 持久化通过专用 `persist` tool 暴露，不绕过层级）。

### 4.7 Adapter（adapters 包）

每个外部依赖是一个 adapter，统一接口。

```ts
// adapters/market/types.ts
export interface MarketDataAdapter {
  readonly name: string;
  fetchQuote(stockCode: string): Promise<Quote>;
  batchQuote(stockCodes: string[]): Promise<Map<string, Quote>>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
}
```

Adapter manager 提供：
- 健康检查
- 故障降级（主源失败 → 备用源）
- 缓存（带 TTL）
- 限速（per-adapter 配额）
- 股票搜索路由（v0.8 起：`searchStocks` 走 primary → fallback，空数组不降级、抛错才降级）

surface 装配（v0.5 起）：CLI/TUI/Web/MCP 四个组装根统一调
`createMarketAdapterFromEnv`（adapters/market/factory.ts），按
`LUOOME_MARKET_PROVIDER` 必须显式设为 `real`
（MarketDataManager：Eastmoney 主 → Tencent 备，A 股；全源失败报错）。
非法值在启动期抛错（与 `LUOOME_LLM_PROVIDER` 同一 env 解析先例）。

### 4.8 Context

所有 tool / workflow handler 收到的 `ctx`：

```ts
interface ToolContext {
  repos: RepositoryRegistry;
  adapters: AdapterRegistry;
  llm: LLMAdapter;
  user: { id: string; accountId: string };
  clock: () => Date;
  logger: Logger;
}
```

`ctx` 是唯一被允许注入依赖的方式。

## 5. 数据模型

### 5.1 基础实体

**v0.6 起新增**：StockPool（股票池 = 成员来源 + 规则列表 + 冷却 + enabled）、WatchTrigger（盯盘触发 = 池 + 股票 + 规则 + 方向 + 理由 + 证据 + 行情快照）。StockPool 走 CRUD（list/create/update/delete_stock_pools），WatchTrigger 通过 `save_watch_trigger` tool 落库（由 `intraday-watch` workflow 触发）。Cooldown 通过 `WatchTriggerRepository.lastForKey(poolId, stockId, ruleKind, since)` 查询，进程重启后冷却可接续。详见 [docs/intraday-watch-design.md](./intraday-watch-design.md)。

**v0.6.2 起加深**：`MarketDataManager` 容错测试覆盖增加（详见 `packages/adapters/src/market/manager-resilience.test.ts`）：`batchQuote` 部分失败（primary 局部抛错 → fallback 仅补失败的那部分，其它 ok 仍走 primary）、`fetchDailyBars` 三层 fallback（primary → fallback → finalFallback）、自定义 `finalFallbackSuppressMs` 窗口验证。无新功能，纯测试深覆盖。

**v0.6.1 起新增**：intraday-watch workflow 多一个 `stepLoadPrevCloses`：在 batch_quote 之后用 `dailyBar.latestBefore(stockId, now, 1)` 给每个 distinct stock 拉真实昨收；价格变动评估（`price-change`）从 v0.6 的 `q.open` 占位切到 `prevCloses.get(stockId) ?? q.open`，缺失自然 fallback。

**v0.7 起新增**：`packages/cli/src/paths.ts`（`luoomeHome()` 从 context.ts 抽出，被 watch / holidays / future paths 共享）；节假日历支持文件加载（`holidays.ts` 新增 `parseHolidayObject` / `loadHolidaysFromFile` / `defaultHolidaysFilePath`），三层优先级 union 合并：内置 < 文件 < env。

**分组化起新增**：StockGroup（股票分组 = resolver(manual/holdings/formula/llm) + refreshPolicy + enabled，只回答「成员是谁」）、GroupMemberSnapshot（成员快照，一次刷新 = 一批同 refreshId，只增不改）。StockPool 从 `source` 改为 `groupId` 引用分组；启动时 `migrateLegacyPoolSourcesToGroups` 把 v0.6 旧 source JSON 幂等迁移成分组。分组 CRUD 走 list/get/create/update/delete_stock_group，刷新走 refresh_stock_group / refresh-groups workflow（盘外「生产者 + 快照」，hot path 只读快照）。详见 [docs/stock-group-design.md](./stock-group-design.md)。

```txt
Account          账户（真实/模拟，币种，初始资金）
Stock            标的（代码、交易所、名称、行业）
Holding          持仓（账户、标的、数量、成本、开/平仓时间）
Trade            交易记录（买/卖、数量、价、费、时间、来源）
PriceSnapshot    实时行情快照（标的、ts、OHLC、量、源）
DailyBar         日线（标的、日期、OHLC、量、复权因子）
Tactic           战法定义（名称、版本、YAML/JSON spec、标签）
TacticSignal     战法信号（战法、标的、ts、分数、方向、证据）
Alert            预警（账户?、标的?、类型、参数、状态）
Note             笔记（标题、内容、标签、来源）
Config           KV 配置（user/account/global scope）
```

### 5.2 Advice 实体（核心）

```ts
// core/entity/advice.ts
export type AdviceDecision = 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
export type AdviceSubjectKind = 'stock' | 'portfolio' | 'market' | 'sector' | 'position';
export type AdviceHorizon = 'intraday' | 'short' | 'medium' | 'long';

export interface AdviceReasoning {
  readonly premise: string;             // 核心论点（一句话）
  readonly evidence: readonly string[];  // 支持证据（数据点引用）
  readonly counterEvidence: readonly string[]; // 反证
}

export interface Advice {
  readonly id: string;
  readonly subjectKind: AdviceSubjectKind;
  readonly subjectId: string;          // stockId / accountId / sectorName ...
  readonly decision: AdviceDecision;
  readonly confidence: number;          // 0-100
  readonly horizon: AdviceHorizon;
  readonly reasoning: AdviceReasoning;
  readonly risks: readonly string[];   // 风险点
  readonly disclaimers: readonly string[]; // 必填，至少包含基础免责声明
  readonly sourceTool?: string;         // 哪个 tool 产出
  readonly sourceWorkflow?: string;    // 哪个 workflow 产出
  readonly basedOn: AdviceDataSnapshot; // 当时的数据快照引用（行情、信号、LLM 推理文本）
  readonly validFrom: Date;
  readonly validUntil: Date;            // 过期时间（不再被采纳）
  readonly createdAt: Date;
}

// 数据快照（可被 advice 引用，事后能复盘）
export interface AdviceDataSnapshot {
  readonly quotes?: Record<string, Quote>;
  readonly indicators?: Record<string, TechnicalIndicators>;
  readonly tacticSignals?: readonly TacticSignal[];
  readonly llmReasoning?: string;        // LLM 原始推理（用于审计）
  readonly dataAsOf: Date;               // 数据截止时间
}

// 建议结果回填（事后验证）
export interface AdviceOutcome {
  readonly adviceId: string;
  readonly outcome: 'followed' | 'partially_followed' | 'ignored';
  readonly pnl?: Money;                  // 实际盈亏
  readonly benchmarkPnl?: Money;          // 同期基准盈亏
  readonly recordedAt: Date;
}
```

**所有 advice 必须有 disclaimers**（最低限度含"本建议由 AI 生成，不构成投资建议，投资有风险，决策需自行承担"）。

### 5.3 不变量（必须被 assert 校验）

- `Holding.quantity >= 0`
- `Holding.availableQuantity <= Holding.quantity`
- `Trade` 执行后必须更新对应 `Holding` 的 quantity / avgCost / available
- `DailyBar` 同 (stockId, date) 唯一
- `Money` 永远 4 位小数
- `Advice.confidence` ∈ [0, 100]
- `Advice.disclaimers.length >= 1`（不能为空）
- `Advice.validUntil > Advice.validFrom`
- `AdviceOutcome.outcome === 'followed'` 时必须能链回 trade

## 6. Advisor 模型（核心）

luoome 的 advisor 系统按"**数据 → 分析 → 建议 → 复盘**"四步走。每一步都有 tool / workflow / 数据对应。

### 6.1 数据层

来源：
- **行情**：实时报价、日线、技术指标（多源交叉）
- **基本面**：财报、估值、行业地位
- **战法**：自定义规则扫描 + 评分
- **持仓**：自己的交易历史、成本、盈亏
- **笔记 / RAG**：用户自己的研究笔记 + 公开资料
- **LLM**：综合推理（受控输入，Zod 校验输出）

### 6.2 分析层

工具化的纯计算 + LLM 推理：

| 工具 | 输入 | 输出 |
|---|---|---|
| `compute_pnl` | holdings + quotes | PnL breakdown |
| `compute_risk_metrics` | holdings + history | VaR / Sharpe / 最大回撤 |
| `compute_indicators` | daily bars | MA / RSI / MACD / BOLL |
| `run_tactic` | tactic + scope | signals |
| `score_signals` | signals + context | scored signals (LLM) |
| `analyze_stock` | stock + 上下文 | **Advice[]**（buy/sell/hold/...） |

### 6.3 建议层

`analyze_stock` 是核心 advice tool：

```ts
export const analyzeStockTool = defineTool({
  name: 'analyze_stock',
  description: '对指定股票做综合分析并产出结构化投资建议',
  sideEffect: 'advice',
  input: AnalyzeStockInput,
  output: AnalyzeStockOutput,  // { advice: Advice, evidence: DataSnapshot }
  handler: async (input, ctx) => {
    // 1. 拉行情 + 指标
    const quote = await ctx.adapters.market.fetchQuote(input.stockId);
    const bars = await ctx.adapters.market.fetchDailyBars(input.stockId, last60Days);
    const indicators = computeIndicators(bars);

    // 2. 跑战法
    const signals = await ctx.tools.run_tactic.execute({ stockId: input.stockId });

    // 3. 拉持仓上下文（如有）
    const position = await ctx.repos.holding.findByAccountAndStock(ctx.user.accountId, input.stockId);

    // 4. LLM 推理（schema-constrained decoding）
    const llmOutput = await ctx.adapters.llm.generate({
      system: ANALYZE_SYSTEM_PROMPT,
      schema: AdviceLLMSchema,
      data: { quote, indicators, signals, position, notes: input.notes },
    });

    // 5. 组装 Advice 实体
    const advice: Advice = {
      id: crypto.randomUUID(),
      subjectKind: 'stock',
      subjectId: input.stockId,
      decision: llmOutput.decision,
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      reasoning: llmOutput.reasoning,
      risks: llmOutput.risks,
      disclaimers: STANDARD_DISCLAIMERS,
      sourceTool: 'analyze_stock',
      basedOn: { quotes: { [input.stockId]: quote }, indicators: { [input.stockId]: indicators }, tacticSignals: signals, llmReasoning: llmOutput.raw, dataAsOf: ctx.clock() },
      validFrom: ctx.clock(),
      validUntil: addDays(ctx.clock(), adviceExpiryDays[llmOutput.horizon]),
      createdAt: ctx.clock(),
    };

    // 6. 校验 + 持久化
    assertAdviceInvariants(advice);
    await ctx.repos.advice.save(advice);

    return { advice, evidence: advice.basedOn };
  },
});
```

LLM 推理部分用 schema-constrained decoding（OpenAI structured outputs / Anthropic tool use / Zod 校验 + retry），保证输出符合 Advice 结构。

### 6.4 复盘层

`AdviceOutcome` 是建议的事后追踪：

- 用户调 `record_advice_outcome({ adviceId, outcome, pnl })` 回填
- 或工具自动跟踪：检测到 advice 对应持仓已平仓 / 触发止盈止损 → 提示用户回填
- 工具 `get_advice_stats({ subjectId?, since, until })` 算某股票 / 某段时间的建议准确率、平均信心度

```ts
interface AdviceStats {
  totalAdvices: number;
  avgConfidence: number;
  outcomeRate: { followed: number; partiallyFollowed: number; ignored: number };
  pnlWhenFollowed: Money;
  pnlWhenIgnored: Money;
  hitRate: number;             // confidence >= 70 且 followed 且 pnl > 0 的比例
  byDecision: Record<AdviceDecision, AdviceStats>;
}
```

复盘是 advisor 的灵魂：没有它，advice 就是黑盒。

### 6.5 Advice 有效期限

| horizon | validUntil 默认 |
|---|---|
| intraday | 当日 15:00 |
| short | +3 个交易日 |
| medium | +20 个交易日 |
| long | +60 个交易日 |

过期 advice 默认不再被 `get_advice` 主动返回，需显式 `includeExpired: true`。

## 7. Tool 系统

### 7.1 副作用分级（重申）

| 等级 | tool 例 | MCP 默认 | Web 默认 | CLI/TUI 默认 |
|---|---|---|---|---|
| `read` | `list_holdings`, `get_quote`, `get_advice` | ✅ | ✅ | ✅ |
| `write` | `add_holding`, `add_trade` | ⚠️ opt-in | ✅ | ✅ |
| `external` | `fetch_quote`, `send_notify` | ⚠️ opt-in | ⚠️ opt-in | ✅ |
| `advice` | `analyze_stock`, `daily_advice` | ✅ | ✅ | ✅ |
| `trade` | `place_order` | ❌ | ❌ | ⚠️ opt-in |

### 7.2 Schema 推导

同 §2.3，Zod → TS + MCP + OpenAI。

### 7.3 错误模型

```ts
type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

type ToolError =
  | { kind: 'invalid_input'; message: string; issues: ZodIssue[] }
  | { kind: 'not_found'; entity: string; id: string }
  | { kind: 'invariant_violation'; message: string }
  | { kind: 'adapter_error'; adapter: string; cause: string; recoverable: boolean }
  | { kind: 'permission_denied'; required: string }
  | { kind: 'llm_error'; provider: string; cause: string; retryable: boolean }
  | { kind: 'internal'; cause: string };
```

**Tool 永不抛异常**，永远返回 `Result`。Workflow 层根据 error.kind 决定重试 / 跳过 / 终止。

### 7.4 测试要求

每个 tool 必须有：
- 单元测试：mock ctx，正常路径 + 错误路径
- Zod schema 测试：合法输入通过、非法输入报错
- 不变量测试：违反不变量时返回 `invariant_violation`
- advice 类额外：LLM mock，验证输出结构 + disclaimers 必填 + validUntil 正确

## 8. Workflow 系统

### 8.1 内置 workflow

- `daily-advice`：每个持仓股 → `analyze_stock` → 持久化 → 推送高分建议（v0.2）
- `tactic-scan`：跑战法 → 评分 → 转建议（v0.3）
- `market-outlook`：拉大盘指数 + 板块涨跌 → LLM 综合 → 市场观点（v0.3）
- `risk-report`：风控指标 + 持仓建议（v0.3）
- `sync-quotes`：拉所有持仓的最新行情 → 写 PriceSnapshot（v0.2）
- `daily-review`：持仓 + 行情 + PnL + LLM 总结 → Markdown 报告（v0.3）
- `intraday-watch`：单轮盘中盯盘评估 —— daily 分组刷新检查 → 池成员 → batch_quote → 规则评估 → cooldown 过滤 → 触发落库 → 通知（v0.6 起；设计：[docs/intraday-watch-design.md](./intraday-watch-design.md)）
- `refresh-groups`：盘外刷新 enabled 动态分组（formula→run_tactic / llm→resolve_llm_group），失败 / 空结果保留旧快照，输出 entered/exited（分组化起；设计：[docs/stock-group-design.md](./stock-group-design.md)）

### 8.2 Workflow 与 tool 的边界

| | Tool | Workflow |
|---|---|---|
| 粒度 | 原子 | 组合 |
| 可独立暴露 MCP | ✅ | ❌ |
| 可被 agent 编排 | ✅ | ❌（避免循环） |
| 可手动触发 | ✅ | ✅ |
| 必须有 Zod schema | ✅ | ✅ |
| 必须可测试 | ✅ | ✅ |

### 8.3 LLM in workflow

Workflow 可选 LLM 步骤。LLM 步骤必须：
- 输入是结构化数据（不是字符串拼接）
- 输出经过 Zod 校验（schema-constrained decoding 或 JSON mode）
- 失败 fallback：纯数据输出 + 标注"无 LLM 摘要"

## 9. MCP Server

### 9.1 传输

v0.1: **stdio**（harness 默认）。
v0.3+：HTTP/SSE（远程、移动）。

### 9.2 暴露策略

```ts
const mcpServer = createMcpServer({
  registry: toolRegistry,
  exposure: {
    allowSideEffects: ['read', 'advice'],  // 默认 read + advice 全部暴露
    denySideEffects: ['trade'],             // trade 永远禁
    tagFilter: ['finance', 'portfolio', 'advice'],
  },
});
```

read + advice 是默认暴露的（它们都是只读，不会破坏数据完整性）。write / external / trade 必须 opt-in。

### 9.3 MCP tool 命名

luoome 内部 snake_case，MCP 同样 snake_case，OpenAI 同样 snake_case。**三套统一**，避免翻译层。

## 10. 多端消费

| 消费者 | 入口 | 暴露范围 |
|---|---|---|
| CLI | `bin/luoome <cmd>` | 全量 |
| TUI | opentui app | 全量（含交互） |
| Web | Bun.serve HTTP | 全量（除 trade，需 2FA） |
| MCP | stdio server | 白名单（read + advice 默认） |

Web 端最小方案：Hono HTTP API + 同源 SPA。前后端共享 Zod schema。

## 11. 数据流示例

### 场景 A：Claude Desktop 问"今天盈亏 + 建议"

```txt
[Claude Desktop LLM]
      │  决策：调 compute_pnl + analyze_stock for each holding
      ▼
[MCP stdio] ───► luoome MCP Server
                    │
                    ├──► list_holdings (read)         ──► HoldingRepo ──► SQLite
                    ├──► batch_quote (read)           ──► MarketAdapter ──► Eastmoney
                    ├──► compute_pnl (read)           ──► 纯计算
                    └──► analyze_stock (advice) ×N    ──► LLM + 战法 + 数据
                    │
                    ▼
[MCP stdio] ◄── { pnl: {...}, advices: [Advice, ...] }
      │
      ▼
[Claude Desktop LLM]  整合生成自然语言答复（含免责声明）
```

### 场景 B：TUI 看今日建议

```txt
[TUI 启动]
   │
   ▼
[opentui] ───► ctx.workflows.daily_advice.execute({ accountId })
                  │
                  ├──► list_holdings
                  ├──► batch_quote
                  ├──► run_tactic (持仓范围)
                  └──► analyze_stock ×N (并发)
                  │
                  ▼
              [opentui 渲染建议面板：标的 / 决策 / 信心度 / 理由摘要]
              [按 r 键：手动刷新重跑 workflow]
```

### 场景 C：cron 推送每日建议

```txt
[launchd / cron] 每天 8:30
      │
      ▼
[luoome run daily-advice]  ──► CLI 入口
                                  │
                                  ▼
                            workflows/daily-advice
                                  │
                                  ├──► tools.list_holdings
                                  ├──► tools.batch_quote
                                  ├──► tools.run_tactic
                                  ├──► tools.analyze_stock ×N
                                  └──► tools.send_notification
                                  │
                                  ▼
                            [飞书 Webhook 推送建议卡片]
```

## 12. 安全模型

详见 [SECURITY.md](./SECURITY.md)。要点：

- 5 级副作用：`read / write / external / advice / trade`，trade 永不暴露
- advice 永远不直接触发 trade，trade 永远需要 human-in-the-loop
- advice 输出必含 disclaimers
- advice 可被 outcome 验证，准确率可统计
- 密钥只走本地 `.env`，不入 git，不入日志
- MCP stdio 默认信任宿主（本地进程），HTTP 模式需要 token
- 所有 adapter 调用有超时和重试上限
- 所有 IO 异常落到 `ToolError`，不抛 raw exception

## 13. 扩展点

### 13.1 加新 tool

1. 在 `tools/<name>.ts` 用 `defineTool` 定义
2. 注册到 `toolRegistry`
3. 加单元测试 + 集成测试
4. 自动获得 MCP / OpenAI / OpenAPI / TUI / CLI / Web 暴露

### 13.2 加新 advice workflow

1. 在 `workflows/<name>-advice.ts` 用 `defineWorkflow` 定义
2. 通过 `ctx.tools.analyze_stock.execute()` 拿建议
3. 通过 `ctx.repos.advice.save()` 持久化
4. 加 workflow 集成测试（mock 所有依赖 tool + LLM）

### 13.3 加新数据源

1. 在 `adapters/market/<name>.ts` 实现 `MarketDataAdapter`
2. 注册到 `marketManager`
3. 加健康检查 + 限速配置

### 13.4 加新 surface

新 Discord bot / Slack bot：从 `toolRegistry` 取 tool，不碰 core / tools / adapters。

## 14. 不在范围的设计决策（已定，不再讨论）

- ✅ Bun + TypeScript
- ✅ SQLite + Drizzle
- ✅ opentui
- ✅ Zod 4.x
- ✅ MCP stdio 主 + HTTP 后置
- ✅ Monorepo from day 1
- ✅ Advice 内置（不是可选模块）
- ✅ Advisor 思路：human-in-the-loop，advice ≠ trade

## 15. 待定（v0.4 前再定）

- Web 栈：候选 Hono + Solid / Hono + HTMX / SolidStart / SvelteKit
- 移动端：PWA 优先
- 多市场：A 股 → 港股 → 美股 → 加密货币的统一抽象
- 真实券商对接：仅在确认合规与安全模型后启动，且绝不通过 MCP 暴露
- 多用户 / 多设备同步：默认不做，提供 export/import
- LLM 提供商：OpenAI / Anthropic / 国内大模型（DeepSeek / Kimi / Qwen / GLM）的成本-质量-延迟三角
