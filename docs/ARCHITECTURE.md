# Architecture

> luoome 的架构核心。设计哲学、模块边界、数据流、安全模型、**advisor 模型**。

## 1. 目标与边界

### 1.1 我们要解决的问题

个人投资者每天需要处理大量数据：行情、新闻、财报、研报、StrategySignal、Watchlist、持仓变化。**最大的痛点不是缺数据，而是缺少统一的"罗网 + 织机"**：

- 不知道哪些信息是真信号、哪些是噪音
- 不知道这些信号对自己的持仓意味着什么
- 不知道当下应该买 / 卖 / 持有 / 观望
- 不知道做出的决策事后看是对是错

luoome = 织机 + 罗网：**罗**进来有价值的数据，**织**成一份带理由、带证据、带风险、带信心度的投资建议。

它不只是数据搬运工，是 advisor：每一份数据最终都要回答"所以呢？我该怎么做？"

### 1.2 显式不做的事

- ❌ 自动真实下单（券商合规 + 资金风险，永远人工确认；建议归建议，行动归行动）
- ❌ 替代券商 App（不做交易 UI，做 advisor 层）
- ❌ 跨用户共享投资建议（个人工具，不是跟单平台）

### 1.3 显式要做的事

- ✅ **生成可执行的投资建议**（buy / sell / hold / watch / avoid），带理由 + 证据 + 风险 + 信心度 + 免责声明
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
- ✅ 校验、发布和试跑 Strategy → tool
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
- **Workflow**：组合多个 tool + 可选 LLM 推理。有顺序、有循环、有条件分支。Workflow **不作为 tool 暴露**给上层 agent（避免循环编排），但可被人手动触发（CLI/Web）。

例如：
- `compute_pnl`（tool）= 纯计算
- `analyze_stock`（tool）= 拉行情 + 算指标 + LLM 分析 → 输出结构化建议
- `daily-advice`（workflow）= 扫所有持仓 + 调 `analyze_stock` 拿建议 + 排序 + 推送

### 2.5 Repository Pattern

core 包定义 repository **接口**，db 包用 Drizzle 实现。tools/workflows 只依赖 core 接口，不耦合 Drizzle。

好处：
- 测试用 SQLite `:memory:` 库（同一套 Drizzle 实现），不依赖磁盘数据库
- 将来换 DuckDB / Postgres 不动业务层

### 2.6 副作用分级 + Advisor 边界

每个 tool 必须显式声明**副作用等级**，消费者据此决定是否可调用：

| 等级 | 含义 | 例子 | 默认暴露给 MCP |
|---|---|---|---|
| `read` | 只读本地 | `get_account_overview`, `list_watch_plans`, `get_advice` | ✅ |
| `write` | 写本地状态 | `update_holding`, `save_trading_plan` | ⚠️ 可配置 |
| `external` | 调用第三方 | `fetch_quote`, `fetch_news`, `get_stock_market_view` | ⚠️ 可配置 |
| `advice` | 生成建议（含 LLM 推理） | `analyze_stock`, `analyze_position` | ✅ |
| `trade` | 触发真实资金动作 | 无（`add_trade` 以 `write` 声明 + MCP name denylist 拦截） | ❌ 永不 |

**新增 `advice` 等级**：advice tool 本质是只读 + LLM 推理，但产出有"建议"性质，需要独立标记。它有自己特殊的安全约束（详见 §11）。

`sideEffect` 表示主副作用；跨越多个能力边界的 tool 还需声明 `requiredCapabilities`。
所有 surface 按组合能力逐项门控，例如远程资料导入要求 `write + external`。

**advice ≠ trade**：advice 永远不能直接触发 trade。trade 永远是 human-in-the-loop。

## 3. 模块结构

```
luoome/
├── packages/
│   ├── core/           纯领域类型 + 不变量 + advice 模型
│   ├── db/             Drizzle schema + repository 实现
│   ├── toolkit/        defineTool + 共享查询、账本与公共应用能力
│   ├── plugins/        每个子目录是独立 workspace 包，见下表
│   ├── tools/          Tool 目录、权限、surface 公共聚合 + schema 生成
│   ├── adapters/       行情 / LLM / 通知 / 券商 适配
│   ├── workflows/      内置编排：review / scan / diagnose / advise
│   ├── mcp/            MCP server
│   └── cli/            命令行入口
└── apps/
    └── web/            Web 端（v0.4 起）
```

### 依赖方向（强约束）

```txt
cli / mcp / web ──► tools ──► plugins/* ──► toolkit ──► core
        │             │                       │
        │             └───────────────────────┤
        │                                     └─► adapters ──► core
        └─► workflows ──► tools
```

`core` 保持零 IO；`db` / `adapters` 只依赖领域契约，不反向导入 toolkit、插件、tools、workflows 或 surface。
插件依赖 toolkit/core，必要时使用 adapters 的既有解析器；仓储通过 `ToolContext` 注入。
toolkit 不导入插件或聚合目录，插件不导入 tools/workflows/surface，也不直接依赖其它插件。
跨插件调用在 tools 的应用组合入口或 Workflow 中完成，Workflow 继续只通过 `ctx.tools.*` 使用能力。
依赖图、源码跨包 import 及工具实例一致性由 [插件包契约测试](../packages/tools/src/plugin-packages.test.ts) 检查。

### 独立插件包与共享底座

`packages/plugins/<name>/package.json` 定义独立包，`src/index.ts` 导出该包工具与插件描述，`src/tools/` 和
`src/internal/` 存放实现。`src/plugin.ts` 收拢 definitions、工具贡献和惰性资源工厂；
`src/contributions.ts` 声明该包工具的 owner、权限、公共性、依赖和模式，`src/resources.ts` 实现定时资源。所有包由根 workspace 的 `packages/plugins/*` 发现；类型检查和构建直接读取
workspace 配置，不依赖固定目录深度。独立包可用自己的 `typecheck` 脚本检查；Vitest 从根发现全部测试。

| 包 | 迁入实现 | 保留的执行控制 |
|---|---|---|
| `@luoome/plugin-analysis` | 个股、持仓、策略候选与市场展望 Advice、分析 LLM helper | `business.analysis` |
| `@luoome/plugin-strategy` | 策略运行/试跑、回测、版本试跑/提案、AI 洞察及运行 helper | 策略执行与可选 AI 原有独立开关 |
| `@luoome/plugin-watch` | 新触发与边沿提交、投递领取和状态写入 | `business.watch-monitoring` |
| `@luoome/plugin-report` | 报告保存、投递领取和状态写入 | `business.report` |
| `@luoome/plugin-notification` | 通用通知发送 | `business.notification` |
| `@luoome/plugin-performance-task` | 批量账户估值受控工具入口 | `task.snapshot-account-performance` |
| `@luoome/plugin-market-tasks` | 盘中快照、日线/行情/目录/dump/板块历史采集 | 各 task 原有独立开关 |
| `@luoome/plugin-market-providers` | 提供者定义、默认值、就绪与影响元数据；供数实现保留在 adapters | 各 source 原有独立开关 |

包是代码归属，开关仍按能力 ID 管理；一个包内的多个 ID 不合并启停。
`toolkit` 保留 defineTool/ToolResult、历史和本地查询、账本/持仓操作、共享行情解析/指标/事实投影、
按需绩效计算与已有快照缓存、文本安全处理、跨业务许可断言。
混合模块已经拆开：策略窗口事实不依赖 AI 洞察插件，已发布行情快照与盯盘历史不依赖新采集/求值，
按需绩效不依赖批量任务。源路由、缓存、请求协调器与 ProviderRuntime 仍在 adapters；持久化仍在 db。

`packages/tools/src/builtin-plugins.ts` 是内置包的统一装配清单，从各包描述派生 `BUILTIN_PLUGINS`、
`BUILTIN_PLUGIN_DEFAULTS`、工具贡献集合和资源集合。装配时检查插件定义完整性、重复 ID 与依赖环；
工具装配检查重复名和执行对象名字，资源必须归属声明它的包。共享工具贡献在 toolkit，跨功能应用贡献在 tools。
`packages/tools/src/catalog.ts` 合并这些唯一来源，按工具名排序；不再手写业务插件条目。
WorkflowToolMap/registry/MCP/Agent 继续从装配目录派生，工具名称、原始 schema、副作用、公共性、
依赖、模式与 owner 保持一致，插件不会自动进入场景白名单。

配置 adapter 只处理 core 中稳定的 ID 协议与持久化，不导入插件定义。初始化须显式传入宿主派生的默认值；
默认仅开启原有策略 AI 洞察，source/task/其它业务项继续默认关闭。迁移新增项仍一律关闭，不借包默认值自动启用。
管理页按定义中的 settings 元数据投影能力、模型/凭证就绪和影响说明，不维护另一套插件 ID 分支。

跨功能 Workflow 留在 workflows，Web 只在 write + external 双闸口下使用
`createBuiltinPluginResources(webPluginOperations)`，由 PluginTasks 统一管理。五类受控 timer 的实现与注册在各插件包，
通过上下文及窄执行端口调用宿主绑定的 Workflow；插件不反向导入 workflows/tools。
宿主端口只组合实际 Workflow，例如报告补投仍先处理上一交易日，再处理当日；不缓存跨世代上下文。
跨任务的盘后数据组合调度仍由宿主负责，每个采集步骤分别校验原 task 开关。
读取插件描述和生成资源清单均不注册 timer、不执行 Workflow、不启动 IO，激活后才创建资源。
旧数据 scope、immediate 写事务 guard、ProviderRuntime 路由缓存、通知可选作用域、
停用卸载/旧工作排空后重建等机制沿用。关闭执行插件保留历史和共享查询，重开不恢复旧许可或重复注册资源。
代码拆包不提供任意第三方程序安装、进程隔离或动态卸载模块；Web 的运行/排空状态仍表达实际任务与调用。

现有工具行为与组合回归集中在 `packages/tools/src` / `packages/workflows/src` 及 Web 测试，
通过插件包导出验证实现；这些测试属于聚合宿主，不成为插件的反向运行依赖。新增只依赖本包的单测可放在插件 `src/`。

### Web Chat Runtime 边界

`apps/web` 的对话由 Bun 进程内的 `AiSdkChatRuntime`（[`apps/web/src/ai-sdk-chat-runtime.ts`](../apps/web/src/ai-sdk-chat-runtime.ts)）执行，不把 Agent SDK 耦合进 `core` / `db` / `tools` / `workflows`：

- AI SDK v6 负责模型调用与工具循环；服务端持有 `ChatRepository` 历史、场景白名单、草案与取消/超时语义。
- 领域能力仍统一经 tools 使用：模型只能按本轮授权的 `AgentCallableTool` 契约调用工具，不复制领域逻辑，也不能绕过 tool 契约访问 repository 或 adapter。
- 只读外部 MCP 由 `packages/tools/src/external-mcp.ts` 在每轮对话开始时按 ToolContext + 场景发现并合入本轮工具；不引入独立 Host 或 Manifest。

设计依据：[Web 对话助手设计](./ddd/web-chat-design.md)。

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
// tools/registry.ts: derived from catalog.ts
export const toolRegistry = createRegistry(agentTools);
export const applicationToolRegistry = createRegistry(Object.values(catalogTools));

const tsTypes = toolRegistry.toTypeScript();
const mcpTools = toolRegistry.toMCP();
const openaiTools = toolRegistry.toOpenAI();
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
    step('run-strategies', (data, ctx) => ctx.tools.run_strategy.execute({
      strategyId: data.strategyId,
      persist: true,
    })),
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

Workflow 通过 `ctx.tools.xxx.execute()` 调用 tool，**不允许直接调 repository 或 adapter**（上面的
`persist` 片段是 v0.1 历史示意，当前 advice 写入经专用 tool）。2026-11-20 起只有 10 个注册入口：

- 多模式入口：`report`（仅 weekly 建议成绩单）、`strategy`（仅 `job=run`）、
  `sync-market`（quotes/universe/dump）；
- 专用入口：`daily-advice`、`daily-stock-briefs`、`sync-portfolio-watchlists`、`post-market-data`、
  `intraday-watch`、`snapshot-account-performance`、`sync-sector-catalog`。

报告、策略与行情同步的原管线改为 `defineOperation`（可复用步骤管线，不注册为 workflow）；
审计名仍由各管线内部写入，合并不会改写历史 WorkflowRun 身份。数量由
`packages/workflows/src/architecture.test.ts` 守住。

策略已降级为“信号事实源”，不再有独立定时器与发布状态机：

- `daily-advice`（每日 17:30，Web 进程内调度）先读持仓，再展开关注列表成员（上限 10 只），
  并按需运行最多 2 个 active 策略的 `scan`（不持久化），把评分 ≥60 的看多信号按分数补进候选池
  （上限 3 只）。逐只调用 `analyze_stock` 生成判断，单只失败只记 warn，不阻断整轮；最后调用
  `settle_advices` 补算到期结算，输出 `judgment`（`今日不动` / `今日可动`）与汇总计数。
- `run-strategies` / `strategy`（`job=run`）只做一次正式运行并返回 `{runId, selected, signals}`；
  不再创建观察候选、不同步关注订阅、不触发推荐 workflow。
- `report`（`kind=weekly`）委托 `weekly-report` 生成唯一一类报告“建议成绩单”：先结算、再取
  `get_advice_scorecard`，附本周建议条数与反馈覆盖；成绩单为空时输出 unavailable 说明而不伪造 0。

这些 workflow 都只通过 tool 编排，不直接访问 repository。推荐或通知失败不会
回滚已原子提交的 StrategyRun，也不会触发交易。

**2026-11-20 简化状态**：可发布性状态机（acceptance policy + `publication` 三态）已删除，
`strategy_runs` 不再有 `publication_json`/`publication_status` 列；运行是否参与建议只由
`scope=operational` 且 `status ∈ {complete, partial}` 决定（`isAdvisoryEligibleRun`）。
`strategy-daily-cycle`、观察补全与策略定时器一并下线，策略只在每日判断里按需运行取当日信号。
存量 V4 summary 里的 `acceptance` 字段保留只读解析，新运行不再计算。

**盘后/盘中调度**：交易日 17:30 先跑 `daily-stock-briefs` 生成当日个股观察（唯一 LLM 入口），
再由 `daily-advice(briefsOnly)` 从当日 brief 派生「今日不动/今日可动」；交易日 08:45 另跑
`daily-stock-briefs(phase='premarket')`，只出事实包 + 规则预筛的研究名单，0 次 LLM、不写 advices。
每周一 08:00 由 `report`（kind=weekly）生成建议成绩单；不再有 `strategy-daily-cycle`、策略定时租约和
截止补报 tick，也不再有开盘/收盘/复盘/风险四类报告。

`web serve` 的盘中账户计划调度每分钟在交易日上午/下午时段顺序检查全部账户，启动时立即检查；
每个账户仍经 `intraday-trading-plan-watch` workflow 和共享预警租约求值、复查与投递。
调度重叠 tick 被跳过，停机及午休/闭市停止新账户轮次；`luoome start` 则在同一 CLI
盯盘循环内先顺序检查账户计划，再运行 AlertPlan，避免争抢共享租约。`start --no-watch` 关闭这两项。
交易时段由 core 按上海时间和 A 股休市日统一判定为 `[09:30,11:30)`、`[13:00,15:00)`；
工作流本身也在开始、发布前及每次发送前复核时段，跨过午休或收盘的候选失效并留审计；
已经提交但尚未发送的触发在同一预警租约和事务中作废并释放对应边沿，使下一交易时段能重新求值。
若进程在提交后、中断投递前退出，下一交易时段会核对该规则上一次触发；遗留 `pending`
在同一租约内作废并释放边沿，`failed` 保留失败审计但也释放边沿，重新以当时的行情求值。
失败投递仅在本次连续竞价时段内重试，午休或隔夜后的新信号不再与旧重试同时发送。
盘后、盘中、绩效与盘后数据 dump 等后台调度均要求 write 和 external 同时显式开放；Web 启动层未同时满足时不注册调度并记录原因。

### 4.7 Adapter（adapters 包）

每个外部依赖通过 adapter 接入。行情对外暴露稳定的 `MarketDataAdapterLike` Gateway，
内部按 capability 拆分注册，caller 不探测 provider 的可选方法。

```ts
type MarketCapability =
  | 'quote'
  | 'batch-quote'
  | 'daily-bars'
  | 'search'
  | 'market-snapshot'
  | 'market-snapshot-envelope'
  | 'realtime-index'
  | 'delayed-index'
  | 'intraday-minutes'
  | 'minute-bars';

interface MarketCapabilityBinding<C extends MarketCapability> {
  readonly capability: C;
  readonly source: string;
  readonly coverage: readonly MarketCoverage[];
  readonly configurationReady: boolean;
  execute(input: CapabilityRequestMap[C]): Promise<CapabilityResultMap[C]>;
  observationOf(result: CapabilityResultMap[C], input: CapabilityRequestMap[C]): SourceResultObservation;
}
```

Adapter manager 提供：

- 从同一 Registry 派生启用状态、顺序、覆盖范围和进程内健康观测
- 按 capability 路由和故障降级；所有来源均来自显式配置
- 缓存（带 TTL）
- 限速（per-adapter 配额）
- 股票搜索路由（空数组不降级、抛错才降级）
- 批量快照：`batch-quote` capability（第 10 种）让原生支持多代码单请求的源
  （eastmoney ulist、tencent qt、sina hq、fuyao snapshot）一次请求取整批；
  `batchQuote` 保留每个来源的有效成功项，按启用顺序仅向后续批量源补取缺失项，最后对
  剩余股票做有界逐股重试。单行校验失败或重复身份只影响对应股票，未请求的行不写缓存；
  原生批量空返回记 `no_data`，部分返回记 `partial_data`，完整结果用最早的可信上游时间
  表达 `dataAsOf`；含 retrieval 时间时不声明数据新鲜度。结果按请求 key 回写缓存，允许
  裸代码请求匹配带后缀响应，但不同交易所后缀不能相互匹配。
- 全市场快照路由（为扫描候选补充可选快照价，也供 LLM 分组生成候选上下文；
  `run_strategy` 全市场扫描的候选身份全集必须来自
  `StockUniverse coverage='CN_A_SHARES_SH_SZ' status='active'`，快照不得增删候选。
  Manager 只路由注册了 `market-snapshot` 的源，带 TTL 缓存默认 5 分钟；
  eastmoney 实现走 `clist/get` 分页，覆盖沪深主板 + 创业板 + 科创板）
- 指数行情严格区分 `realtime-index` 与 `delayed-index`；Tushare 日线型指数数据不能进入实时接口
- 腾讯单股与批量报价共用 qt 原生 OHLCV，不从分时采样推算高低价；A 股量/额从手/万换算，
  港股保持股数与原币金额。新浪与腾讯缺少有效 OHLCV 时拒绝该行，不合成价格或成交量。
  腾讯指数要求有效的上游时间，恒生指数的斜杠日期也按交易所时区解析，缺失时间不能冒充实时。
- 连续分钟 OHLCV 必须走显式 `minute-bars` capability；不得把 `intraday-minutes` 或 PriceSnapshot
  区间查询冒充 MinuteBar，provider 不可用时由 Tool 返回 partial/unavailable

数据源路由底座是泛型 `SourceRegistry<CapabilityMap>`（adapters/source-registry.ts）：
market 域的 `MarketSourceRegistry` 只是它的收窄薄壳，五个非行情域（连板天梯、龙虎榜、
北向资金、要闻、A 股情绪）各自用同一泛型装配。registry 的 `execute` 包装层是唯一观测点：
binding 用必填 `observationOf(result, input)` 把已 resolve 的结果分类为
`success`（可带 `dataAsOf`）/ `failure(kind)` / `ignored` 三态，进程内内存态、重启归零；
`lastErrorKind` 存在即 `unavailable`，否则按 `dataAsOf` 阈值判 fresh/stale，否则 `unknown`，
不回退 `lastSuccessAt`。错误词表统一为 core 的 `SourceErrorKind`，传输与解析失败经
`SourceExecutionError` 携带 kind，不依赖错误消息正则。

东方财富在本仓库的全部能力收敛到单一 `EastmoneySource`（adapters/eastmoney/source.ts）：
HTTP 管道在 `eastmoney/client.ts`，URL 模板与字段映射保留在各域目录的纯函数中，本类只做
方法委托。CLI/MCP/Web 三个组装根先创建一次实例，再经各 factory 的 `deps.sources.eastmoney`
分发共享；Web 行情源热更新只改来源顺序时复用同一实例，仅重建 market manager 与直接依赖
market 的 sentiment manager。

`MarketDataManager` 构造时必须传入 `MarketSourceRegistry`，不存在接受 provider 宽接口的兼容
构造路径，也不得在 Registry 之外临时实例化隐藏来源。新增或替换来源时，在
composition root 将 adapter 的实际能力绑定到 Registry；tool、workflow 和 surface 不改。

surface 装配（v0.5 起）：CLI/Web/MCP 三个组装根统一调
`createMarketAdapterFromEnv`（adapters/market/factory.ts）。`LUOOME_MARKET_PROVIDER`
必须显式设为 `real`；`LUOOME_MARKET_SOURCES` 用逗号分隔、从左到右定义最多三个
启用源及各 capability 的尝试优先级，可选
`eastmoney`、`sina`、`tencent`、`tushare`、`fuyao`。未配置时默认 Eastmoney → Tencent → Sina。显式启用
Tushare 时必须配置 `TUSHARE_TOKEN`（`TUSHARE_URL` 可选，覆盖默认网关
`http://api.tushare.pro`），显式启用 fuyao 时必须配置 `FUYAO_API_KEY`（`FUYAO_BASE_URL` 可选，
缺省 `https://fuyao.aicubes.cn`），非法配置在启动期抛错。
详见 [tushare-market-adapter-design](./ddd/tushare-market-adapter-design.md) 与
[fuyao-market-adapter-design](./ddd/fuyao-market-adapter-design.md)。
fuyao 快照信封时间在休市日仍随请求更新，逐股行无行情事件时间；其报价标为
`timestampSource=retrieval`，全市场快照不填 `observedAt/dataAsOf`，不能作为盘中行动的可信时间证据。

连板天梯、龙虎榜、北向资金、要闻与 A 股日级情绪都不进 `MarketDataManager`，分别由
`create*ManagerFromEnv` 独立装配；`LUOOME_*_SOURCES` 与 `LUOOME_MARKET_SOURCES` 同构
（逗号分隔、有序、去重校验、未知源启动期抛错）。其中要闻注册 `eastmoney` 与 `10jqka`，
A 股情绪默认使用 `eastmoney`，配置扶摇凭据时追加 `fuyao` 作为封板池和炸板池的备用源。
显式设置 `LUOOME_ASHARE_SENTIMENT_SOURCES` 时按配置顺序取数。
各 manager 的 `status()` 直接委托 registry 观测，健康读模型（`get_market_data_status`）
聚合 market registry、stock-universe checkpoint 与这五个 manager 的 `status()` 生成
`datasets` 库存。

A 股情绪 manager 内部把封板池与炸板池注册为 `sentiment-sealed-pool` /
`sentiment-broken-pool` 两个独立 capability，分别路由、分别 fallback，单池故障在状态页
只显示对应 dataset 为 `unavailable`；维度级 partial/unavailable、provenance 与短 TTL 缓存
仍由 manager 隐藏；指数由 `get_ashare_sentiment` 组合现有 `fetchIndexQuotes`。只有指数观测日
与请求交易日一致时才进入快照。`MarketSnapshot` 通过 coverage/source/asOf/completeness 信封
表达完整性；breadth 只消费完整真实信封，全部真实来源不可用时保持 unavailable，不从部分
实时报价推算全市场宽度。详见
[Vibe A 股市场报告与策略研究迁移详细设计](./ddd/vibe-ashare-report-and-strategy-research-detailed-design.md)。

Web 额外提供 `/api/settings/market`：GET 返回数据源启用状态、优先级与配置就绪状态，
不返回密钥；受同源 Origin 保护的 POST 将配置原子写入权限为
`0600` 的 `$LUOOME_HOME/.env`，验证新 adapter 后替换 `ctxRef.current.adapters.market`，
使路由在当前 Web 进程立即生效。只改来源顺序时复用进程级共享 SourceSet，不产生第二个
EastmoneySource 实例，无关 manager 的缓存不清空。

LLM 装配采用 adapters 内的 AI SDK Provider Registry。CLI/Web/MCP 三个
composition root 均调用 `createAIStackFromEnv`，一次加载
`$LUOOME_HOME/ai-models.json`（或 `LUOOME_AI_CONFIG`），把 `generation` profile
解析为 `LLMAdapterLike` 注入 `ctx.adapters.llm`。`agent` profile 仍是 Agent 模型的
配置来源（Web 设置页读写），供 Web 对话运行时消费，不再注入 `ToolContext`。
provider、模型 ID、默认生成参数、超时和 agent 预算不进入 core；core 只保留 SDK 无关的
端口。配置文件只引用 `apiKeyEnv`，不存储凭证。

Web 额外提供受同源 Origin 保护的 `/api/settings/ai`：
GET 只返回 provider、模型参数及 `apiKeyConfigured`，永不返回密钥；POST 原子写入
模型目录与权限为 `0600` 的 `$LUOOME_HOME/.env`，随后替换
`ctxRef.current.adapters.llm`，使新配置在当前进程立即生效。模型未配置或
配置损坏时 Web 使用 `ai-unconfigured` 占位端口启动，允许用户从设置页修复；其它
surface 仍保持启动期快速失败。

旧版自研 AI SDK `ToolLoopAgent` agent loop 与 `agent_run` tool 已删除，不保留回退运行时。
Web 对话只经 `ChatStreamRuntime` 端口；生产默认实现是 Bun 进程内的
`AiSdkChatRuntime`，测试可注入桩运行时（未配置模型时 `POST /api/chat` 返回 503
「AI 模型尚未配置」）。Web 只提供从 registry 派生的显式工具白名单
并消费标准 Web `Response`，core 不依赖任何 Agent SDK 类型。写工具在聊天中是仅返回待确认描述的虚拟草案调用，只有用户在
Web 点击确认后才进入真实 tool 写路径。`ChatSession` / `ChatMessage` 及
`ChatRepository` 位于 core，Drizzle repository 位于 db（测试跑 `:memory:`）；Web 会话端点经
tools 读写当前账户的持久化历史，`POST /api/chat` 只接收本轮 user message，
服务端加载最近 20 条消息并在 runtime 的 `onFinish` 后保存 assistant UI message parts。
已完成的工具结果和 step 边界保留到下一轮。草案确认使用
`POST /api/chat/sessions/:id/drafts/:messageId/:toolCallId` → `settle_chat_draft`，仅执行
服务端存储的输入；repository 通过原子认领和 parts 比较更新保存每项执行状态，重复请求不重复写入。
执行结果随原消息传回模型，用户文本中的“已执行”不作为凭据。对话和确认都要求 write + external
显式开启，流与确认请求沿用所选账户 header。SDK 服务端消费流以保存取消后的部分回答，完成时记录用量。
多个 Watchlist 成员统一由 `add_watchlist_members` 生成单个原子草案，避免重复确认和部分写入。

Web 对话路径（当前唯一运行时）：Bun Web → `AiSdkChatRuntime` → AI SDK Provider Registry → tools。
模型请求由 Bun 进程直接发出，密钥只从 `$LUOOME_HOME/.env` 解析，不进入浏览器或日志；没有独立
Node Host、跨进程协议或模型代理。工具在本进程执行，保持白名单、草案与 ToolResult 错误语义。

每轮从 `ChatRepository` 的可信历史重建模型上下文，不依赖运行时私有 Session 或游标。新消息使历史
超过既有窗口时，Web 在落库前明确要求通过可编辑交接摘要新建关联会话；运行时的
`historyTruncated` 边界直接拒绝而不静默截断。失败回答可用同一用户消息重试。助手消息保存失败时，
流以错误收尾而不是假装成功；保存成功后才发送 finish。会话消息通过游标分页读取，界面可加载完整历史。
实时事件合并为标准 UI Message Stream；同会话在回答保存期间保持占用。取消保存已收到的部分回答并标记
cancelled；超时按错误呈现而不是「已停止」；只有工具真正排空后 `executionStopped` 才为 true。
外部只读 MCP 在 `LUOOME_EXPOSE_EXTERNAL=true` 时每轮重新发现并按场景白名单合入；停用后下一轮不再出现。

AI 协作首页通过 `/api/workspace` 聚合独立 ToolResult，区分事实摘要、方向研究、共识与实际跟踪。
聊天主体经服务端 tools 核对当前账户、持仓内容哈希、不可变计划版本与时效；已核验引用和时间随问题持久化，
每轮独立装载当前结构化共识，不能靠最近 20 条聊天推断同意。首页的三项方向操作经
`POST /api/workspace/drafts` 生成服务器草案，再复用原确认协议；不接受客户端执行结果。
确切提醒读取使用专用 `/api/watch/notifications/:triggerId`（绑定 `resolve_watch_notification`），私有 resolver 不进入通用 discovery。
原始触发与当前资格分开，始终不把历史触发当作当前行动许可。手机讨论与恢复契约见
[AI 投资协作首页详细设计](./ddd/ai-investment-workspace-detailed-design.md)。

### 4.8 Context

所有 tool / workflow handler 收到的 `ctx`：

```ts
interface ToolContext {
  repos: RepositoryRegistry;
  adapters: {
    market: MarketDataAdapterLike;
    llm: LLMAdapterLike;
  };
  limitUpLadder?: LimitUpLadderManagerLike;
  dragonTiger?: DragonTigerManagerLike;
  northboundFlow?: NorthboundFlowManagerLike;
  news?: NewsManagerLike;
  ashareSentiment?: AShareSentimentManagerLike;
  user: { id: string; defaultAccountId: string };
  clock: () => Date;
  logger: Logger;
}
```

`ctx` 是唯一被允许注入依赖的方式。多步 Agent 推理不属于 `ToolContext`：Web 对话由
`AiSdkChatRuntime` 在 tools 之外编排，只经显式白名单调用 tool，不能绕过 tool 契约直接访问
repository 或 adapter；core 不定义任何 agent loop 类型。
`limitUpLadder` 等非行情 manager 是日级批量快照端口，保持为顶层可选字段，
不混入逐标的实时行情 Gateway；各 manager 的必填 `status()` 是统一观测端口，
直接委托各自 registry 的进程内健康观测（见 §4.7）。

## 5. 数据模型

### 5.1 基础实体

**当前研究与观察模型**：Strategy 是版本化研究规则；StrategyRun 产出可追溯的
StrategyResult/StrategySignal。Watchlist 统一 manual/strategy/ai/portfolio/import 来源和成员
生命周期；Strategy → Watchlist 只有在用户创建持久、可审计的显式订阅契约后，才由
operational 且已结束（`complete`/`partial`）的运行投影 strategy source。AlertPlan 引用 Watchlist 并产生 WatchTrigger。公开 surface 只读写这三个模型；
旧 Tactic/StockGroup/StockPool 模型（含 migration decoder 与旧表 DDL）已整体移除，
存量库的旧物理表不再维护（不 DROP、不读取）。

**v0.6.2 起加深**：`MarketDataManager` 容错测试覆盖增加（详见 `packages/adapters/src/market/manager-resilience.test.ts`）：`batchQuote` 部分失败（primary 局部抛错 → fallback 仅补失败的那部分，其它 ok 仍走 primary）、`fetchDailyBars` 三层 fallback（primary → fallback → finalFallback）、自定义 `finalFallbackSuppressMs` 窗口验证。无新功能，纯测试深覆盖。

**行情底座 Phase 2 起收口**：intraday-watch 在 batch_quote 之后通过
`get_previous_closes` tool 批量读取严格早于目标交易日的 qfq 收盘价；`price-change`
缺昨收时为 `unknown`，不再直接访问 DailyBarRepository，也不使用 `quote.open` 兜底。

**行情底座 Phase 3 起收口**：`Quote` 区分市场观测时间 `observedAt` 与抓取时间
`fetchedAt`，并记录时间来源；price snapshot 以 `(stockId, observedAt, source)` 唯一。
`batch_quote` 逐股票返回 live/local-fallback、fresh/stale、unresolved/unavailable 状态，
display、intraday-rule、post-market 三类 caller 使用不同有效性边界。盘中规则只消费当日且
在允许延迟内的 fresh Quote，不再为缺失行情合成 `close=0` 快照。

**行情底座 Phase 4 起收口**：`MarketSourceRegistry` 是行情来源启用顺序、capability、
coverage 与运行时健康观测的唯一事实来源。生产 `MarketDataManager` 只接受 Registry；
`realtime-index` 与 `delayed-index` 分路，Tushare 不再通过隐藏 Eastmoney 旁路提供实时
指数。`get_market_data_status` 从 Registry、股票目录 checkpoint 和连板天梯显式来源动态
生成数据集状态，不维护固定 provider 常量。

**v0.7 起新增**：`packages/cli/src/paths.ts`（`luoomeHome()` 从 context.ts 抽出，被 watch / holidays / future paths 共享）；节假日历支持文件加载（`holidays.ts` 新增 `parseHolidayObject` / `loadHolidaysFromFile` / `defaultHolidaysFilePath`），三层优先级 union 合并：内置 < 文件 < env。

**迁移与兼容**：Strategy/Watchlist/AlertPlan 切换早已完成，只写目标表，不双写。
一次性 migration decoder（`schema_migrations` runner 与 verify 命令）已随旧模型整体移除；
ensureSchema 只保留活表的幂等启动迁移（加列 / 结构演进 / 存储形态重建），存量库的旧物理表不再维护。

**存储生命周期**：被替换的大表（`strategy_results`、`strategy_data_checkpoint*`）先做一次性搬迁，
死数据已在 P0 人工清理；可回填的小配置表（`strategy_schedules`）保留一版供人工核对，不再写入。
新增退役表按“搬迁后 DROP”处理，不长期双写；`daily_bar_revisions` 已直接在启动迁移中删除。
逐股明细（`strategy_runs.results_json`）写入前统一 zlib+base64（同一规则表达式逐股重放，压缩比约 30x），
读取侧兼容未压缩存量行。历史明细与终态观察的回收走 `prune_strategy_history`
（默认 dryRun，只清逐股明细与过期观察，不删 run 元数据与信号）。

**日线口径：原始价落库 + 因子投影**。`daily_bars` 只存**未复权** OHLCV（`adjustment='raw'`），
除权除息事件单独存 `adjustment_factors`（`factor = 除权价 / 前收盘`，`(stock_id, ex_date)` 唯一）。
前复权是读时投影：`qfq(t) = raw(t) × ∏{factor | exDate > t}`，由 `DrizzleDailyBarRepository`
在 `findInRange` / `latestBefore` 里完成，`saveMany` 反向还原成原始价。领域层 `DailyBar` 仍是 qfq，
调用方无感知。因子表尚未初始化、且 provider 未提供 `sourceAdjFactor` 时，qfq 行情按原值缓存
（`adjustment='qfq'`）并原值读出，等 dump 的原始价覆盖同一交易日；这样不会把 qfq 当原始价、
在因子到达后二次复权。这样原始价是不变量：新分红只新增一行因子，不用重写历史 K 线，也不会出现
"各 provider 各自锚定"造成的接缝。`daily_bar_revisions` 因此废弃删除——日线固定、盘后同步，
replay 直接按 `dataAsOf` 截断读取。

**id 长度即存储成本**：`strategy_signals.id` 过去是 `${runId}:${ruleId}:${stockId}:${iso}`（约 100 字符），
会被复制进 470 万行 `signal_observations.source_id` 和两张二级索引；现在改为 snowflake 布局的
64 位整数（41 位毫秒 + 22 位序列，十进制字符串对外），18 字符。`signal_observations`、
`adjustment_factors` 不存合成 id，主键直接是自然键。新增合成 id 时优先用
`nextStrategySignalId()` 这类紧凑有序 id，不要再拼长字符串。

**Vibe A 股报告迁移 Phase 1**：新增 `Report` 结构化事实简报；收盘报告按
`(kind, scopeKey, periodStart, periodEnd)` 只生成一份不可变报告（新报告固定 version=1），
重复运行复用原报告；底层 version 与前驱字段保留以读取历史报告和周报修订。周期查询返回
最新版，列表先按周期收敛再应用状态和条数筛选，历史版本仍可按 ID 或指定 version 读取。正文只允许受限
section/block，明确区分 `generatedAt` 与 `dataAsOf`，required 维度缺失时必须为
`partial` 并保存原因。`ReportRepository` 提供 Drizzle 实现（测试跑 `:memory:`）；
`get_report` / `list_reports` / `render_report` 为 read，`save_report` /
`set_report_delivery_status` 为 write。Web 报告历史、详情和导出统一调用这些 tool，
不复制 partial 判定或 renderer。详细设计见
[Vibe A 股市场报告与策略研究迁移详细设计](./ddd/vibe-ashare-report-and-strategy-research-detailed-design.md)。

**Vibe A 股报告迁移 Phase 2**：新增 `AShareSentimentSnapshot` 与
`get_ashare_sentiment` external tool。东方财富封板/炸板端点独立失败、独立 provenance；
完整结果按跨池去重后的真实样本计算炸板率，封单或开板字段缺失保留 null。实时指数只在
观测日匹配请求日时组合；行情完整性信封落地前 breadth 保持 unavailable。

**Vibe A 股报告迁移 Phase 3（2026-11-20 已下线，本段仅存档）**：`opening-report`、`closing-report` 与
`weekly-report` 共用报告 runner，经 `ctx.tools.*` 采集证据、保存 Report、记录
`WorkflowRun` 并执行通知状态迁移。定时模式默认经飞书通知；未配置飞书时保存日志并记 `fallback-log`，`notified=false`。
通知失败不回滚报告，只把投递状态记为 `failed`、运行审计记为 `partial`。报告投递通过
持久领取令牌互斥，失败后等待 15 分钟、遗留 `pending` 超过 5 分钟可接管；
当时的收盘 tick 与策略日循环共用就绪检查：先等待当日预期策略发布完成，再生成账户计划批次；
各账户批次不再处于 running/failed/blocked 后才统一出报。18:00 到达也不会发布未完成批次的
缺口报告；没有当日预期策略时在 18:00 后完成账户计划再出报。报告生成后不再追加补充版本，
已有但未完成投递的报告按同一报告与通知身份重试。
旧执行者失租后不能改写新状态；外部飞书 webhook 本身不承诺恰好一次送达。
`sent` 仅表示飞书渠道受理，接口和 Web 不把它表述为用户设备已收到；设备回执仍需独立验收。
账户收盘报告另外读取前一交易日的计划版本、盯盘触发和已登记交易，三类事实分开展示；
仅有触发或同股票同日期不能推断实际成交，未登记也不能证明未交易。
计划版本按 `createdSince/createdUntil` 在应用 `limit` 前过滤，历史版本不会被较新的版本挤出复盘窗口。
收盘计划章节使用 `currentOnly` / `views` / `monitoring`，汇总当前资格、修订草案与停止跟踪记录；
不再自行把最高版本当作当前计划。当前版本查询的 `createdUntil` 在版本解析前生效，防止次日修订遮住
目标日版本；跨日补发的资格核验仍使用报告生成时的账户事实，正文明确此口径。
`list_workflow_runs` 保留 `inputSummary` 的账户归属；收盘报告读取计划复核审计，按目标日、账户与
确切版本去重新增、维持和重复草案，前一交易日未新增版本的复核仍纳入回看。
跟踪清单最多展示 20 项并标明其余数量，过期、失效和退役记录单列；含未发布草案时计划章节为 partial。
交易计划区块通过 `inputFingerprint` 固定全部已读取版本的身份与当前资格，
报告快照涵盖动作、条件、仓位、反证与风险；展示前 20 项不缩小快照事实范围。
后续计划和复核记录继续正常保存，但不会重新生成或通知已发布的收盘报告。
隔日补发时按目标交易日封闭区间查询触发，避免将次日事件写入旧报告；
后补交易继续保存在账本与决策记录中，已生成的收盘报告保持原样。
周报预警反馈按目标周封闭区间和完整分布统计；账户周报只计入该账户计划监控提醒，
未归属账户的全局关注预警不混入账户反馈率。策略复盘的运行和洞察也按目标周开始时间过滤，
周后暂停的策略仍保留历史正式运行。洞察中的行业目录与 AlertPlan 配置仍为当前状态，
历史窗口会明确标记这一限制。
`get_closing_batch_audit` 按上海日期只读聚合 `account-plan-batch` 的 WorkflowRun、当前账户清单及
收盘主版/补充版，显示 16:30 批次开始、18:00 截止、报告生成延迟与通知状态。
审计返回 `tradingDay`；休市日当前账户不计入应出报分母，已有异常批次或报告仍保留在结果中。
Web `/api/reports/closing-audit` 仅返回当前选中账户；全账户核对使用 Tool。
历史预期账户从当前清单及留存的批次/报告推断，已删除且无留痕的账户无法据此恢复。
CLI 通过 `workflow run ... --mode` 触发，
Web 通过同源 Origin 校验的 `/api/reports/run/:kind` 手动触发。

**Strategy 研究事实**：指标快照可包含最新价、动量、均线与 Bollinger 字段。规则求值的
unknown/error、evidence 与 dataAsOf 必须保存在 StrategyResult；Signal 只表达事实，
不表示胜率、Advice 或交易。StrategyRun 的执行状态与数据完整度分离：新运行只写
`running / complete / failed`，其中 `complete` 表示结果包已原子提交；Summary V4 通过
`dataHealth=complete / partial / unavailable`、evaluated/incomplete/failed 计数描述覆盖质量，
`scope` 与 `status` 共同决定它是否进入建议视图：`evaluation`、`running`、`failed` 一律不参与。
正式运行先写入可查询的 `running` 记录，终态与 results/signals 在同一事务中更新；
意外异常也会把该记录收敛为 `failed`。策略运行不再持有租约，`lease_lost_before_commit`
现在只会出现在读取存量 `strategy-daily-cycle` 审计时。
旧 `status=partial` 记录继续可读，并按“执行完成、数据部分可用”参与当前结果视图。

**Strategy 模块深化（2026-09-01）**：`StrategyEvaluationData` 由 Live 与 Checkpoint 两个真实
Adapter 实现，统一 quote/daily-bars 读取和 provider audit；`StrategyRunSnapshot` Compatibility Module
统一解释 V3/V2/legacy 输入身份；`StrategyObservationEvidence` 批量校验 run → signal → observation
关系并报告 missing/truncated；`StrategyRunTimeline` 一次装载 run/version/results，供 Workspace、Diff
与 Insight 复用。Web Strategy Workspace 按 overview、experiment、runs、insights、cycle、settings、
backtest 功能模块拆分，入口文件只负责路由与页面组合。

```txt
Account          账户（真实，币种，初始资金）
Stock            标的（代码、交易所、名称、行业）
Holding          持仓（账户、标的、数量、成本、开/平仓时间）
Trade            交易记录（买/卖、数量、价、费、时间、来源）
PriceSnapshot    实时行情快照（标的、ts、OHLC、量、源）
DailyBar         规范前复权日线（标的、日期、qfq OHLC、量、来源、可选原始复权因子）
Strategy         版本化研究规则身份
StrategyVersion  不可变 DSL 定义、hash、校验与发布时间
StrategyRun      一次运行的 coverage、dataAsOf、执行状态、数据完整度和 provider 状态
StrategyResult   逐股规则结果、分数、排名、证据
StrategySignal   按规则产生的方向、分数、证据事实
SignalObservation StrategySignal 在 T+1/T+3/T+5 的真实表现事实；存量 T+20 仅兼容读取
Watchlist        统一观察集合
WatchlistMember  股票、研究阶段、优先级
AlertPlan        引用 Watchlist 的规则、冷却和通知策略
WatchTrigger     AlertPlan 命中事实与送达状态
Alert            预警（账户?、标的?、类型、参数、状态）
Note             笔记（标题、内容、标签、来源）
Config           KV 配置（user/account/global scope）
LimitUpLadder    连板天梯快照（date, source, maxLevel, levels[]）；实时 manager + PIT snapshot repository
LimitUpLadderEntry  单 entry（price / rawClose / corrected / ladderLevel / firstTime / finalTime）
MarketSnapshotBatch 盘中全市场不可变批次（coverage, sampledAt, source, 行情/抓取时间, completeness, gaps, items）；按采样时点去重发布
Report           个性化结构化事实简报（周期、scope、section/block、provenance、partial）
StockBrief       每日个股观察日视图（交易日 × 账户 × 标的 × phase、decision/confidence、quality、factDigest、missing、LLM 计量、可选 adviceId 引用）；唯一键即幂等键，不引入新生命周期
AShareSentimentSnapshot  沪深 A 股日级指数/宽度/封板/炸板/热点证据（维度级完整性）
SectorCatalogEntry      行业 / 概念目录条目（内部 id、kind、source、vendorCode、name、firstSeenAt、lastSeenAt、retiredAt）；内部标识不复用供应商代码
SectorMembership        板块成分多对多事实（core 的 `StockSectorMembership`；(sectorId, stockId) 主键、state、memberStatus、firstSeenAt、lastSeenAt、missingSince、lastSyncId）；成分消失只标 missing，不物理删除
SectorChangeEvent       目录 / 成分变更追加记录（自增 seq 主键、kind、sectorId、stockId?、occurredAt、syncId、previousValue / nextValue）；append-only，不回写历史
SectorSyncRun           一次同步的审计与幂等凭据（syncId 主键、source、succeeded / partial、appliedAt、观察与增删计数、failures）；同 id 重放返回原摘要，不重复落事实
LimitUpLadderSample     按采样时点保存的连板天梯事实（`tradingDate|source|sampledAt` 主键、levels、warnings、asOf）；与盘中批次时点对齐，同采样时点幂等且保留首次写入内容
MarketRoomEvent         盘中扩散 / 分化 / 换位事件（`tradingDate|kind|sectorId|sampledAt` 主键、(tradingDate, kind, sectorId, sampledAt) 唯一、thresholds、evidence、verification、recordedAt）；重复扫描只落一条，阈值与证据保存扫描当时的口径
```

目录与成分来源是扶摇（同花顺金融数据 API）的行业 / 概念目录与按股反查，经
`sync_sector_catalog`（`external + write`）原子写入；目录条目 `retired`、成分 `missing`
都是状态变化而非删除，变更进 `SectorChangeEvent`，一次同步对应一条 `SectorSyncRun`。
`LimitUpLadderSample` 来自东方财富连板天梯（与 `limit_up_ladder` 默认源一致），由
`collect_market_snapshot` 按一分钟对齐发布批次，要求抓取时间不早于当前分钟；Manager 和共享请求缓存以新鲜度时点区分请求，查询沿用既有缓存。调度日志记录完整轮次耗时、行情时间、抓取时间与覆盖计数。发布批次时按同一采样时点写入；`MarketRoomEvent` 是本地派生事实，
只使用已发布批次、目录成分与对齐的天梯样本，不引入新的外部来源。

作战室概念榜、概念成交分布与新扫描的盘中事件默认使用精选题材：读模型剔除市场通道、上市状态、财报 / 指数 / 持股组合等非题材标签，并对 active 成分完全相同的概念只保留一个代表；宽概念不再按成分数量剔除，主流锚点（人工智能、新能源汽车等）由主流题材分类定义按 vendorCode 归入固定父板块。精选只影响原始概念视图，不改写目录与成分事实；涨幅榜和成交分布可用 `conceptScope=all` 回查原始目录，回放按各时点生效的成分重新选择。主流的「父板块 → 标准题材」读模型见 `GET /api/market/room/mainstream` / `get_market_room_mainstream`：分类定义版本化、零 IO 在 core，题材行情取所映射概念的 active 成分并集，父板块取子题材并集，同一股票只计一次；未映射概念保留在原始目录并计入 coverage，不伪装成已覆盖。 同一响应还返回每个标准题材的代表股、最多 5 只核心股（领涨 / 当前窗口成交额增量最高 / 最高连板 / 增量补位）与全部成分的 close、日涨幅、5 / 15 分钟涨幅、今日累计成交额、窗口成交额增量、题材内窗口占比与环比、封板与连板；中文名只取 stockUniverse，ST 默认不参与核心股与占比分母，炸板只在前后两个与批次时点对齐的天梯样本可证明时显示。个股弹窗的 1 分钟序列见 `GET /api/market/room/stock-series` / `get_market_room_stock_series`：只读本地已发布 `market_snapshot_batches`，缺口断线不插值，成交额负修正按缺失，不补零。

账户记账通过 `LedgerRepository` 原子更新账户与交易/持仓/流水：Drizzle 在 IMMEDIATE 事务内读取现金、
计算增减并校验余额；内存实现串行提交。持仓写入携带读取时的旧持仓，在事务内检查冲突，
失败不留下任何交易、持仓调整或现金变化。`HoldingCashAdjustment` 持久化手工持仓变化的金额与数量，
对账重放这些记录；它不作为外部入金或出金计入收益率计算。SQLite 迁移原子回填旧余额与可恢复的调整记录，
旧快照计划迁移同步 `plan_json` 和外层状态；active/draft 失效后保留历史读取能力。

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
  readonly strategySignals?: readonly StrategySignal[];
  readonly dataAsOf: Date;               // 数据截止时间；不保存原始模型响应
}

// 建议结果的兼容输出；当前账户反馈由 DecisionReview.content.adviceFeedback 投影
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
- DecisionReview 的来源快照和历史修订不可覆盖；更新需匹配 expectedRevision
- 成交关联必须校验账户、股票与来源时间；用户 followed 反馈与成交关联彼此独立
- 相同账户的同一 requestId 不得用于不同请求内容；成交、账本、复盘修订与回执原子提交

## 6. Advisor 模型（核心）

luoome 的 advisor 系统按"**数据 → 分析 → 建议 → 复盘**"四步走。每一步都有 tool / workflow / 数据对应。

### 6.1 数据层

来源：
- **行情**：实时报价、日线、技术指标（多源交叉）
- **基本面**：财报、估值、行业地位
- **Strategy**：版本化规则定义、校验、运行结果与可追溯信号
- **Watchlist**：跨 Strategy、AI、组合与手工来源的统一关注集合
- **AlertPlan**：引用 Watchlist 的提醒规则与送达策略
- **持仓**：自己的交易历史、成本、盈亏
- **笔记 / RAG**：用户自己的研究笔记 + 公开资料
- **LLM**：综合推理（受控输入，Zod 校验输出）

### 6.2 分析层

工具化的纯计算 + LLM 推理：

| 工具 | 输入 | 输出 |
|---|---|---|
| `compute_indicators` | daily bars | MA / RSI / MACD / BOLL |
| `run_strategy` | StrategyVersion + universe | StrategyRun + results + signals |
| `get_strategy_signals` | 股票 + 时间窗 | StrategySignal + T+1/5/20 观察统计 |
| `analyze_stock` | stock / market / strategy-candidate + 上下文 | **Advice**（evidence + counter-evidence + risks） |

纯投顾计算（PnL / 风险指标）与 Watchlist source 同步是 Application Service 或 repo 读模型，
不再注册为 Agent Tool（设计 §5.1）。

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

    // 2. 读取已持久化的 StrategySignal
    const signals = await ctx.repos.strategyRun.signalsByStock(input.stockId);

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
      basedOn: { quotes: { [input.stockId]: quote }, indicators: { [input.stockId]: indicators }, dataAsOf: ctx.clock() },
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

`DecisionReview` 是账户决策记录的权威实体，单表保存：`(account_id, subject_kind, subject_id)`
唯一，`subject_kind` 为 `advice | trading-plan | trade`，`content_json` 内联复盘结论（`note`）、
教训标签（`lessonTags`）、关联成交（`tradeIds`）与 Advice 结果反馈（`adviceFeedback`）。
再次保存同一对象是 upsert：保留原 `id` 与 `created_at`，整体替换内容并更新 `updated_at`；
不保留修订历史、依据快照或写回执，避免版本链与幂等回执协议。

`save_decision_review` 校验复盘对象存在且属于当前账户，关联成交必须属于该账户并与对象同股；
建议结果只允许出现在 Advice 复盘上。`list_decision_reviews` 按 `updated_at` 倒序，
`[since, until)` 半开窗口，游标绑定账户与筛选条件。
`get_advice_stats`、`get_confidence_calibration` 与 `get_decision_loop_review` 从单表
`adviceFeedback` 投影 AdviceOutcome；未记录、未填盈亏与明确零盈亏分别处理，不把未知盈亏写成 0。

盯盘提醒反馈直接写 `watch_triggers.feedback / feedback_at`（`set_watch_trigger_feedback`），
不再经由复盘表。录入系统外成交统一走 `add_trade`，不再提供复盘专用成交包装器。

账户收盘/周报以 `decisionReviewFingerprint` 保存窗口内复盘输入的指纹；周报补充版在该指纹
变化时以 `notificationPolicy=never` 保存，且不能认领、重试或改写成可投递状态。
正常主报告及研究补充版保持原通知政策；周报事实未变时复用原报告，原失败投递仍可按原政策重试。

导出导入按单表 `decision_reviews` 校验成交归属，失败全量回滚。

启动迁移：旧库的 `decision_reviews` 缺少 `content_json` 时，建新表并复制 advice /
trading-plan-version 复盘的最新修订内容（`trading-plan-version` → `trading-plan`），
再把旧表重命名为 `decision_reviews_legacy` 保留数据；旧附属表不再创建也不要求删除。

### 6.5 Advice 有效期限

| horizon | validUntil 默认 |
|---|---|
| intraday | 当日 15:00 |
| short | +3 个交易日 |
| medium | +20 个交易日 |
| long | +60 个交易日 |

过期 advice 默认不再被 `get_advice` 主动返回，需显式 `includeExpired: true`。

## 7. Tool 系统

### 7.1 工具目录与公共 Agent 库存

`packages/tools/src/catalog.ts` 是完整工具库存的统一装配出口：从插件、toolkit 和应用的唯一贡献定义
关联实际 tool 对象，保留公共性、权限、模型/行情 capability/资讯/Vault 依赖。贡献声明与实现按归属放置，
不复制另一套名字和 I/O 映射。Zod schema 与业务实现仍定义在各 tool 文件中。

- `toolRegistry` 从 `agent: true` 条目派生，供 MCP、OpenAI schema 和公共 Web 路由使用。
- `applicationToolRegistry` 从完整目录派生，替代 CLI/Web 对包导出的运行时扫描；专用路由与调用方继续负责原有授权。
- `WorkflowToolMap` 和已绑定上下文的执行访问器从同一目录派生，输入保留 Zod 默认值和可选字段语义，不再维护第二套 I/O 类型与内部工具数组。
- Web 公共名字表和 MCP 必需依赖表自动派生。MCP 禁用规则、各入口权限与聊天场景白名单继续独立收窄；内部工具不进入公共 discovery。

目录契约测试校验工具名、对象唯一性和导出覆盖，既有公共库存测试保护暴露范围。
Skill 的调用示例由 MCP 契约测试校验工具可暴露性与输入 schema；内部 ToolResult 与 MCP 文本内容的响应格式分别说明。

每日个股观察的工具分工：`generate_stock_briefs`（`advice`，owner `business.analysis`，`agent: false`）
只进应用 registry，不进入 Agent registry / MCP / OpenAI schema；`get_stock_brief` 与
`list_stock_briefs`（`read`，owner `shared-query`）随只读基线进入 MCP。生成只保留一个入口，
读工具不触发生成。

### 7.1.1 插件归属与执行控制

catalog 为全部 Tool 标注唯一 owner；`execution: 'p1' | 'p2' | 'p3'` 标出受控入口。
归属本身不授予权限：`defineTool.execute` 在错误收口内绑定执行 scope，解析 Zod 输入后先按 owner（及其声明依赖）
查一次启用位，再执行 handler；禁用时抛 `PluginExecutionDenied('plugin:<id>')`。Workflow 可声明 `requiredPlugins`，
入场时同样只查启用位；嵌套 Tool 访问器仍由 catalog 派生，不手写第二份映射。

启用位只有一份：`PluginConfigStore.isEnabled(id)`（读 `plugins.json` 的 `entries[id].enabled`，只读）。
`core/plugin-policy` 是 SDK 无关的纯端口，只有 `PluginPolicyLike.isEnabled`；不存在许可令牌、遗弃世代或撤销队列。
`adapters/plugins/config` 只做只读解析：限长读取、`entries[id].enabled` 判定，缺失/损坏/未知 id 一律按停用处理；`inspect()` 额外保留未知 id 供只读诊断。
`plugins.json` 由使用者手写，进程启动时读入；没有写接口、锁、incarnation/revision 或写入式管理界面。Web 设置页与 `luoome plugins check` 只读展示文件状态、未知 id、缺失项与依赖未满足。
开关在**下一次请求**生效：已运行的工作不会被打断，也不再声称「关闭后旧句柄永久失效」——旧句柄同样按当前启用位判断。

`ProviderRuntime` 在组装根统一包裹 provider port、真实 HTTP transport 和调用数据 scope。
启用集按需读取；启用集合变化时懒重建一次路由图，未变化时复用同一实例，因此停用某个数据源后的下一次取数即切换。
源总开关与域内来源顺序取交集，关闭后不实例化该来源；已启用源的凭证仍须有效。
提供者配额/cooldown 仍按稳定 source 身份，使用 `public_market_entries` 的 SQLite immediate CAS 跨同库宿主共享。
公开缓存只存公共行情与请求状态，过期条目在更新时清理，不写入账户数据。
采集 scope 把同步校验回调传给 repository；日线、报价、目录、快照、分钟线等写入取得 immediate 写锁后校验，持锁同步到提交。
dump 文件按下载请求使用独立文件名，并在落盘前校验，防止同名上游文件在多宿主间互相覆盖。
全关后本地查询和 `compute_indicators` 无网络依赖；混合入口保留既有权限并显式降级。

`business.strategy-execution` 纳管 `run_strategy` 与非持久化试跑；策略定义维护与历史查询常驻。
`run_strategy` 不要求 live quote/bars 同时就绪，按 scan/scheduled 与规则引用决定实际依赖；
运行只记录「是否完成、是否可用」与信号，不再计算验收结论或发布状态，消费方用 `isAdvisoryEligibleRun`（operational 且已结束）判断是否进建议。
策略运行 repo 取得 immediate 写资格后校验 scope；失败收尾仍校验不可变身份与状态迁移。

Web 的 [PluginTasks](../apps/web/src/plugin-tasks.ts) 管理实际 timer owner：
盘中快照调度依赖 `task.collect-market-snapshot`，账户绩效盘后调度依赖 `task.snapshot-account-performance`，
每周成绩单依赖 `business.report`；策略不持有独立定时器，由每日判断按需运行少量 active 策略取当日信号。
单宿主 timer 每 250ms reconcile，业务 timer 只为当前启用项创建；停用时清除 timer 并停止发起新 tick，
退出排空有 5 秒上限，超时报告未排空，不强制关闭共用 DB。

2026-11-20 起不再有写入式插件设置页、preview/CAS 保存或 CLI 插件写命令；启用状态只由手写 `plugins.json` 决定，
诊断读取不外发。MCP 每次 list/call 使用实时可用表；插件开关变化需重启宿主才重新装配，不提供同连接管理变更。
CLI 只提供只读的 `plugins check`，且不为查看状态初始化业务上下文。

`business.analysis` 是默认关闭的建议生成 owner，catalog 将 `analyze_stock`、`analyze_position`、`market_outlook`、
`analyze_strategy_candidate` 与 `generate_stock_briefs` 统一标为受控执行。分析模型调用在 `build-advice` 的共同边界统一出站，
未通过判断契约（七要素、confidence 与仓位单调）的输出不入库。
即使没有行情 DataScope，存在执行策略的 Tool 仍安装 repository write guard；AdviceRepository 在 immediate 写锁内同步校验后保存。
历史查询、反馈与其它插件不归此 owner，已提交事实保持可读。

`business.watch-monitoring` 管理 intraday-watch 统一求值器（AlertPlan + TradingPlan）与触发/边沿/投递写入口；
Watchlist/AlertPlan 编辑、历史、反馈及通用通知保留原归属。Web 将 intraday scheduler 移入 PluginTasks，
CLI 每轮仍经同一 Workflow 门禁。WatchTrigger 与 WatchRuleState 接入 RepositoryWriteScope，提交与投递认领在 immediate 写锁内复核。
投递前由 `begin_watch_delivery` 生成并预留 notificationId；manager 保存真实 transport 回执后，
repository 的 completeDelivery 仅在回执存在、全部 trigger ID 匹配同一预留通知且状态允许时结束既有 pending。
关闭不能撤回已发出的请求，回执与有限重试沿用原通知语义，不声称外部 exactly-once。

`business.report` 默认关闭，catalog 纳管 save_report 与 set_report_delivery_status；历史 get/list/render/delete 不受此开关限制。
report（weekly）声明 requiredPlugins；共享 runner 隔离 provider scope 并在区块收集后复核。
ReportRepository 的生成、覆盖、领取与普通状态写入均在 immediate 写锁内校验共享 write scope。
Web 的每周成绩单 scheduler 由 PluginTasks 以 business.report 管理，与盘中/盘后 tick 分开创建销毁，关闭报告不会停掉其它 tick。

### 7.2 副作用分级（重申）

| 等级 | tool 例 | MCP 默认 | Web 默认 | CLI 默认 |
|---|---|---|---|---|
| `read` | `get_account_overview`, `list_watch_plans`, `get_advice` | ✅ | ✅ | ✅ |
| `write` | `update_holding`, `save_trading_plan`, `add_trade` | ⚠️ opt-in | ⚠️ opt-in | ✅ |
| `external` | `fetch_quote`, `fetch_news`, `get_stock_market_view` | ⚠️ opt-in | ⚠️ opt-in | ✅ |
| `advice` | `analyze_stock`, `analyze_position` | ✅ | ✅ | ✅ |
| `trade` | 无（真实成交记录只在用户本地 CLI/Web 录入） | ❌ | ❌ | ❌ |

`add_trade` 以 `write` 声明以复用 Web 写入门，同时在 MCP 暴露层加入 name denylist（永不暴露）；
`LUOOME_EXPOSE_TRADE=true` 启动硬卡保留。

### 7.3 Schema 推导

同 §2.3，Zod → TS + MCP + OpenAI。

### 7.4 错误模型

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

### 7.5 测试要求

每个 tool 必须有：
- 单元测试：mock ctx，正常路径 + 错误路径
- Zod schema 测试：合法输入通过、非法输入报错
- 不变量测试：违反不变量时返回 `invariant_violation`
- advice 类额外：LLM mock，验证输出结构 + disclaimers 必填 + validUntil 正确

## 8. Workflow 系统

### 8.1 内置 workflow

只保留 10 个注册入口（`architecture.test.ts` 守住数量与名字）；其余可复用管线用 `defineOperation`，不作为 workflow 注册。

| workflow | 职责 |
|---|---|
| `daily-advice` | 每日判断：账户事实 + 价格结构 + 当日新闻 + 板块 + 策略信号 → 逐只 `analyze_stock`；持仓全覆盖，候选池 ≤10（手动关注 + 策略信号 ≤3），输出「今日不动/今日可动」汇总。17:30 调度默认 `briefsOnly=true`，只消费当日 `stock_briefs`，不自己调 `analyze_stock` |
| `daily-stock-briefs` | 每日个股观察批次：候选集（持仓 ∪ 关注池 ∪ 当日策略信号）→ 事实包 → 规则预筛 → AI 技术研究（并发 2、预算内）→ 落库 `stock_briefs`；`phase='premarket'` 只出研究名单，0 次 LLM、不写 advices；写 `workflow_runs` coverage/budget 审计 |
| `report` | 只接受 `kind=weekly`：调用 `settle_advices` 结算 T+1/3/5，再生成建议成绩单（命中率、超额、confidence 分组、门禁），落库为一份 Report |
| `strategy` | 只接受 `job=run`：按显式策略运行 `run_strategy`，不再有 scheduled/daily/observations 编排 |
| `intraday-watch` | AlertPlan → Watchlist members → 报价/昨收/策略信号/事件 → 边沿、冷却、每日上限 → WatchTrigger → 通知；含交易计划监控分支 |
| `post-market-data` | 交易日盘后同步股票目录、fuyao 全市场 dump 的原始日线与复权因子；任一步失败保留成功项并返回 partial；Web 进程内 16:00 后按交易日去重触发 |
| `snapshot-account-performance` | 每日账户估值快照，供 TWR/回撤/归因读取 |
| `sync-market` | 手动/定时拉指数的行情与情绪快照 |
| `sync-portfolio-watchlists` | 按账户把持仓同步为 portfolio 来源的关注项 |
| `sync-sector-catalog` | 同步板块目录与成分关系，供 `marketContext.sectors` 使用 |

已下线（2026-11-20）：`opening-report`、`closing-report`、`closing-report-cutoff`、`daily-review`、`risk-report`、`market-outlook`、`run-strategy-schedules`、`strategy-daily-cycle`、`trading-plan-daily-cycle`、`intraday-trading-plan-watch`、`replay-strategy-range`、`complete-strategy-observations`、`sync-research-vault`。对应能力与设计文档见 `docs/archive/`。

盘中提醒仍由 `intraday-watch` 承担：入场条件按 ALL 合成单个边沿，风险/退出命中阻止入场提醒；风险与退出条件只在对应仓位已持仓时投递；冷却对所有优先级生效，每日上限只约束常规提醒；发布前重新校验计划版本、账户事实指纹与行情时效，条件未变时保留尚未过期的原生效版；`sent` 只表示渠道受理，不代表设备送达。

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

MCP 的工具集合是公共 registry、授权策略、启动时依赖就绪状态的交集。
`packages/tools/src/catalog.ts` 显式声明每个公共工具的必需依赖，MCP 从目录派生依赖表；
库存一致性测试防止漏声明。行情依赖按 source registry 中已启用且配置就绪的 capability 判断，
模型、资讯 manager 和 Vault 按实际装配状态判断；可本地回退的查询不强制要求外部源。

无模型或行情配置时仍可启动并查询本地数据。默认允许 read + advice；write / external
必须显式 opt-in，read / advice 可分别通过 `LUOOME_EXPOSE_READ=false` /
`LUOOME_EXPOSE_ADVICE=false` 关闭。trade 与人工成交登记 `add_trade` 永不通过 MCP 暴露；
`LUOOME_EXPOSE_TRADE=true` 在任何 IO 前阻止启动。研究工具另受研究权限门控。
发现与调用共用同一过滤结果，直接调用被隐藏工具也会被拒绝。修改配置后需要重启 MCP。
依赖就绪不保证上游在线，运行时失败仍遵循 ToolResult 错误模型。

### 9.3 MCP tool 命名

luoome 内部 snake_case，MCP 同样 snake_case，OpenAI 同样 snake_case。**三套统一**，避免翻译层。

### 9.4 受控只读 MCP 客户端

`adapters/mcp` 负责读取部署配置、真实 MCP stdio 握手/发现/调用、JSON Schema 校验和进程生命周期。
`tools/external-mcp` 将已授权远端工具包装为 external ToolResult、统一输入校验与审计，不将动态工具
写入静态业务 catalog。`apps/web` 每轮按场景加载这些受信 callable，并把它们合入本轮 AI SDK
工具集；发现与执行都不进入静态 catalog，也不引入独立 Host 或 Manifest。

准入取服务显式启用、远端名字白名单、场景白名单及只读元数据的交集。发现与执行分别复核配置，
调用前重新发现并比对完整声明，阻止 schema/注解漂移。运行时的每次外部工具执行前也复核服务当前状态；
停用后下一轮删除工具，已宣告但未执行的调用立即失效。静态业务白名单、账户 scope、external
opt-in、每轮调用上限、单次超时与 64KB 结果上限继续独立生效。

Web 的 `McpSettingsStore` 与客户端共用配置 schema 和路径解析。设置页通过专用接口读取安全投影、
按版本保存已登记服务的授权；只读文档服务可由服务器使用固定启动配置首次登记。
`POST /api/settings/mcp/preview` 经 tools 层按当前场景发现实际工具；保存不重建 Agent runtime，
后续发现与旧调用直接复核同一份配置。设置页不暴露 command/args，也不开放任意进程安装或编辑。

首个只读实现 `packages/mcp/src/docs-server.ts` 只检索固定维护文档。配置格式与启停方法见
[用户手册](./USER_GUIDE.md#只读-mcp-服务供内置-agent-使用)。客户端不自动安装代码，不继承完整
主进程环境，也不把未知服务器能力当作只读保证；受信子进程不等于 OS 沙箱。

## 10. 多端消费

| 消费者 | 入口 | 暴露范围 |
|---|---|---|
| CLI | `bin/luoome <cmd>` | 全量 |
| Web | Bun.serve HTTP | 全量（除 trade，需 2FA） |
| MCP | stdio server | 白名单（read + advice 默认） |

Web 端最小方案：Hono HTTP API + 同源 SPA。前后端共享 Zod schema。
服务端结构（S4.2）：`apps/web/src/server.ts` 只做 Hono 实例、ctx/依赖注入、同源静态资源与进程启动；
领域路由按 `routes/{market,portfolio,watchlist-alert,strategy,research,chat,settings,dashboard,tool-gateway}.ts`
注册，共享 HTTP helper 在 `http/`，路由模块只通过显式 `WebRouteDeps` 依赖 server 内部闭包，禁止循环 import。

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
                    └──► analyze_stock (advice) ×N    ──► LLM + StrategySignal + 数据
                    │
                    ▼
[MCP stdio] ◄── { pnl: {...}, advices: [Advice, ...] }
      │
      ▼
[Claude Desktop LLM]  整合生成自然语言答复（含免责声明）
```

### 场景 B：cron 推送每日建议

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
                                  ├──► tools.run_strategy
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

1. 在所属 `plugins/<name>/src/tools/`（业务插件）或 `toolkit/src/tools/`（共享能力）用 `defineTool` 定义
2. 桶导出并加入所属包的唯一工具贡献；宿主自动合并为 `toolCatalog`，再派生 `toolRegistry`
3. 加单元测试 + 集成测试
4. 自动获得 MCP / OpenAI / OpenAPI / CLI / Web 暴露

### 13.2 加新 advice workflow

1. 在 `workflows/<name>-advice.ts` 用 `defineWorkflow` 定义
2. 通过 `ctx.tools.analyze_stock.execute()` 拿建议
3. 通过 `ctx.tools.*.execute()` 获取事实和写入结果，不直接访问 repository 或 adapter
4. 加 workflow 集成测试；测试替身只限测试边界，生产路径不注入 mock 数据

### 13.3 加新数据源

1. 在 `adapters/market/<name>.ts` 实现 `MarketDataAdapter`
2. 注册到 `marketManager`
3. 加健康检查 + 限速配置

### 13.4 加新 surface

新 Discord bot / Slack bot：从 `toolRegistry` 取 tool，不碰 core / tools / adapters。

## 14. 不在范围的设计决策（已定，不再讨论）

- ✅ Bun + TypeScript
- ✅ SQLite + Drizzle
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
