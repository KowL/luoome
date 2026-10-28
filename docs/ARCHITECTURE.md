# Architecture

> luoome 的架构核心。设计哲学、模块边界、数据流、安全模型、**advisor 模型**。

## 1. 目标与边界

### 1.1 我们要解决的问题

普通个人投资者每天被淹没在数据里：行情、新闻、财报、研报、StrategySignal、Watchlist、持仓变化。**最大的痛点不是缺数据，而是没有一个可信的"罗网 + 织机"**：

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
- ✅ **建议可追溯**：每条建议都能回到当时的数据快照、策略证据与生成来源（provenance）
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
- ✅ 生成建议 → DSH 交互分析经 `record_advice` 写回（分析队列写回能力保留）
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
- **Workflow**：组合多个 tool。有顺序、有循环、有条件分支。Workflow **不作为 tool 暴露**给上层 agent（避免循环编排），但可被人手动触发（CLI/TUI/Web）。

例如：
- `compute_indicators`（tool）= 纯计算
- `get_account_facts`（tool）= 汇总账户现金、持仓与账本事实
- `daily-review`（workflow）= 读当日建议 → 读准确率统计 → 读天梯 → 汇总成结构化日报

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
| `queue` | 消费分析队列并写回结果 | `claim_analysis_jobs`, `complete_analysis_job` | ⚠️ 可配置 |
| `trade` | 登记系统外已完成的资金动作 | `record_decision_trade` | ❌ 永不 |

> DSH 瘦身（docs/ddd/luoome-dsh-transformation-detailed-design.md）后：原 `advice` 等级
> （只读 + LLM 推理 + 落建议）随内置 AI 工具一并删除，`SideEffect` 为上表 5 级；
> Advice 实体与存量数据保留，新建议由 DSH 交互分析或手动 worker 写回。`queue` 级随分析队列引入，
> 默认关闭，须由 `luoome-analysis` 实例（read + queue 精确三工具白名单）或手动 worker 实例
> 显式 opt-in（`LUOOME_EXPOSE_QUEUE=true`）。

`sideEffect` 表示主副作用；跨越多个能力边界的 tool 还需声明 `requiredCapabilities`。
所有 surface 按组合能力逐项门控，例如远程资料导入要求 `write + external`。

Research 检索以 SQLite FTS5 为确定性基线。可选 embedding adapter 通过 `ToolContext.researchEmbedding` 注入；Tool 只面向 core 的稳定接口，不读取 provider 配置。embedding 投影属于 db 中可重建读模型，由独立 `ResearchEmbeddingRepository` 的 Drizzle/in-memory 双实现维护，并按 `provider + model + dimensions + version + chunk contentHash` 隔离和失效。混合检索、增量重建和固定跨模型评测均通过 Tool 暴露，Web/Agent 不复制融合或指标逻辑。

**advice ≠ trade**：advice 永远不能直接触发 trade。trade 永远是 human-in-the-loop。

## 3. 模块结构

```
luoome/
├── packages/
│   ├── core/           纯领域类型 + 不变量 + advice 模型
│   ├── db/             Drizzle schema + repository 实现
│   ├── tools/          Tool 注册表 + schema 生成
│   ├── adapters/       行情 / 通知 / 事件 / 研究库 适配
│   ├── workflows/      内置编排：review / report / watch / plan / strategy
│   ├── mcp/            MCP server
│   ├── cli/            命令行入口
│   └── tui/            opentui 应用
└── apps/
    └── web/            Web 端
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

### 模型运行时边界

模型推理与模型配置都由 DSH 承担，luoome 侧没有模型运行时包，也没有模型设置页：

- 领域包（`core` / `db` / `tools` / `workflows` / `mcp` / `adapters`）不得导入 AI SDK。
- 领域能力仍统一经 tools 使用；领域层不推理、不计费。
- `infra/check-layers.ts` 守住 AI SDK 依赖边界。

设计依据：[luoome 的 DSH 改造详细设计](./ddd/luoome-dsh-transformation-detailed-design.md) §5.1、§5.7.4、Q14、D9。

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
// packages/workflows/src/daily-review.ts
export const dailyReviewWorkflow = defineWorkflow({
  name: 'daily-review',
  description: '汇总当日建议、准确率统计与连板天梯，产出结构化日报',
  input: DailyReviewInput,          // { timezoneOffsetHours }
  steps: [
    // 1. 读当日建议（日报要能看到已过期的）
    async (prev, ctx) => {
      const input = prev as DailyReviewInputT;
      const res = await ctx.tools.get_advice.execute({
        since: computeTodayStart(ctx.clock(), input.timezoneOffsetHours),
        includeExpired: true,
        limit: 500,
      });
      if (!res.ok) return res;       // 返回 ToolResult error 即短路
      return { advices: res.data.advices, stats: null, input, ladder: null };
    },
    // 2. 读近 7 日准确率
    async (prev, ctx) => {
      const state = prev as ReviewState;
      const r = await ctx.tools.get_advice_stats.execute({ since: sevenDaysAgo(ctx.clock()) });
      if (!r.ok) return r;
      return { ...state, stats: r.data };
    },
    // 3. 读当日 + 上一日天梯并算 diff（上游不可用 → ladder=null，不阻断日报）
    ...
  ],
});
```

Workflow 通过 `ctx.tools.xxx.execute()` 调用 tool，**不允许直接调 repository 或 adapter**。写建议统一走 `record_advice`（分析队列写入路径），不绕过层级。步骤返回 `ToolResult` error 会短路整条 workflow；步骤抛 `InvariantError` 归为 `invariant_violation`，其它异常归为 `internal`，`run` 永不外抛。

策略相关 workflow：

- `run-strategy-schedules` 原子抢占到期 `StrategySchedule`，再调用 `run_strategy`；调度租约负责
  多实例 tick 防重，`strategyId + strategyVersionId` 运行租约同时覆盖手工与自动正式运行。
  运行提交后只产出 facts-only 的 `preflight` 摘要与 `adviceCount`，仓内不再生成 Advice；
- `complete-strategy-observations` 先通过 tool 同步 qfq 日线，再通过 tool 补齐到期的
  SignalObservation。样本未到期保持 pending，不阻塞其他样本。
- 候选建议由 DSH 交互分析实例经 `record_advice` 写入（见 §6.3）；仓内已无
  `strategy-recommendations` workflow 与 `analyze_strategy_candidate` tool。

`luoome start` / `luoome web serve` 在进程内每分钟唤醒 `strategy-daily-cycle`，启动时也立即
检查一次，不要求用户配置外部 cron；多 Web 实例仍由 lease 防重。观察补全等低频任务的外部 cron
只作为幂等补偿。这些 workflow 都只通过 tool 编排，不直接访问 repository。推荐或通知失败不会
回滚已原子提交的 StrategyRun，也不会触发交易。

**2026-08-14 可靠性状态**：publication、heartbeat + fencing token、`strategy-daily-cycle`、
WorkflowRun 阶段审计与 `get_strategy_reliability_summary` 已落地；汇总会阻塞 schedule/交易日重复
运行并输出阶段 P50/P95/max。跨交易日生产证据和真实全市场性能预算继续属于 Roadmap 的运营观测，
不能把设计目标误报为已验收事实，也不设置固定交易日数量门禁。

**MVP 2.0 盘后/盘中切片**：`strategy-daily-cycle` 一次 tick 会领取全部到期 schedule（调用方的
`limit` 只决定首批，剩余继续 drain）。交易日 16:30 后按账户及当日已发布策略运行指纹领取
`account-plan-batch`，批次身份还包含账户账本摘要；持仓或现金变化后旧批次不能充当当前账户结果。
批次执行 `trading-plan-daily-cycle` 并持久化完成、部分或阻断状态。领取与结束
均使用原子操作及令牌校验；超时运行被收敛后可重试。Web 有独立的每分钟截止 tick，避免策略与
计划批次耗时阻塞 18:00 主报告；`closing-report-cutoff` 读取持久化批次状态，即使无 schedule
或批次未完成，也按账户发布并显式标 partial。当日预期策略均有已发布正式运行且日循环领取
已结束、全部账户计划批次完成或部分完成时，可在 18:00 前按账户提前发布；未来仍有预期运行、
策略分析仍在进行或账户批次阻断时等待，不发送阶段性日报。
重复 tick 不重建主报告。后到策略结果或账户账本变化后重跑的计划批次生成补充版本，原版本按
ID 或周期版本可读；只有核心缺口补齐或计划行动条件变化才再次通知。
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
盘后、盘中、绩效与自治后台调度均要求 write 和 external 同时显式开放。

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
- 全市场快照路由（为扫描候选补充可选快照价，也供消费者按标的分组拼装事实包；
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
market 的 sentiment manager。单机部署的数据源配置写入持久卷
`operator/market.env`：Web 保存后立即重建共享行情栈，消费者按文件 mtime 在任务批次前同步。

`MarketDataManager` 构造时必须传入 `MarketSourceRegistry`，不存在接受 provider 宽接口的兼容
构造路径，也不得在 Registry 之外临时实例化隐藏来源。新增或替换来源时，在
composition root 将 adapter 的实际能力绑定到 Registry；tool、workflow 和 surface 不改。

surface 装配（v0.5 起）：CLI/TUI/Web/MCP 四个组装根统一调
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
其余四个 A 股日级域当前唯一注册值为 `eastmoney`。
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

模型推理与模型配置都由 DSH 承担：luoome 侧没有模型运行时包，没有模型设置页，也没有
`/api/settings/ai` 与运行时热替换。CLI/TUI/MCP 不装配模型，需要模型判断的能力由
DSH agent 经 MCP 调用工具完成。core 不持有模型调用端口，领域层不推理、不计费。

Web 的模型对话已退役：没有 AI 流端点，也没有对话页面。保留下来的是不依赖模型的
「起草 → 明确确认 → 原子执行」链路，写工具在 Web 上只生成待确认描述，只有用户在
Web 点击确认后才进入真实 tool 写路径。`ChatSession` / `ChatMessage` 及
`ChatRepository` 位于 core，memory 与 drizzle repository 位于 db；Web 会话端点经
tools 读写当前账户的持久化历史。草案确认使用
`POST /api/chat/sessions/:id/drafts/:messageId/:toolCallId` → `settle_chat_draft`，仅执行
服务端存储的输入；repository 通过原子认领和 parts 比较更新保存每项执行状态，重复请求不重复写入。
用户文本中的“已执行”不作为凭据。确认要求 write + external
显式开启，请求沿用所选账户 header。
多个 Watchlist 成员统一由 `add_watchlist_members` 生成单个原子草案，避免重复确认和部分写入。

DSH 接入有两条路径，默认部署只保留第一条：

1. **独立 DSH 部署（默认，纯插件形态）**：DSH 用 Node 加载 `dsh-luoome` 插件——host 提供原生只读 /
   market external / 确认写面，client 提供三块核心面板，随包 skills 提供四条投研技能；事实库是
   Node SQLite 的 `$LUOOME_HOME/luoome.db`。运行期不需要 Bun、MCP server、旧 Bun Web、
   analysis worker 或 queue probe。部署入口见 [宿主机直部署](../deploy/direct/luoome-dsh.service)，
   容器栈保留为整栈回退方案。
2. **旧「当前 MCP 过渡形态」（仅手动/隔离验收）**：Web profile 的四个 MCP 实例（只读面 `luoome` /
   设置面 `luoome-settings` / 分析面 `luoome-analysis` / 批处理面 `luoome-batch`）、三个旧 DSH
   插件与手动 worker。源码保留但默认部署不再启动，P5 统一删除。
3. ~~内嵌 DSH Host~~（已随托管形态下线）：原 `apps/agent-runtime` 的内嵌 Host 路径与 hosted ledger 计量一并删除。

批处理调度归 DSH 定时任务：提醒到点唤起会话，agent 调用插件注册的工具，门槛判定随工具走
（非交易日/非盘中时段返回 `skipped`）。不再有 luoome 侧的常驻调度进程。
交互式分析经插件的原生确认操作直接写回，不创建 `analysis_job`；队列能力保留，但默认部署
没有生产者、也没有常驻消费者。仓库完成隔离切换/回退演练后，生产服务器已于 2026-10-25 切到
纯插件形态（`dsh-web` + `caddy`），旧 MCP/Bun 源码仍保留但不再启动。

AI 协作首页通过 `/api/workspace` 聚合独立 ToolResult，区分事实摘要、方向研究、共识与实际跟踪。
聊天主体经服务端 tools 核对当前账户、持仓内容哈希、不可变计划版本与时效；已核验引用和时间随问题持久化，
每轮独立装载当前结构化共识，不能靠最近 20 条聊天推断同意。首页的三项方向操作经
`POST /api/workspace/drafts` 生成服务器草案，再复用原确认协议；不接受客户端执行结果。
确切提醒读取使用专用 `/api/watch/notifications/:triggerId`，私有 resolver 不进入通用 discovery。
原始触发与当前资格分开，始终不把历史触发当作当前行动许可。手机讨论与恢复契约见
[AI 投资协作首页详细设计](./ddd/ai-investment-workspace-detailed-design.md)。

### 4.8 Context

所有 tool / workflow handler 收到的 `ctx`：

```ts
interface ToolContext {
  repos: RepositoryRegistry;
  adapters: {
    market: MarketDataAdapterLike;
    stockUniverse?: StockUniverseManagerLike;
  };
  notification?: NotificationManagerLike;
  eventProviders?: readonly StockEventProviderLike[];
  limitUpLadder?: LimitUpLadderManagerLike;
  dragonTiger?: DragonTigerManagerLike;
  northboundFlow?: NorthboundFlowManagerLike;
  news?: NewsManagerLike;
  sectorQuote?: SectorQuoteManagerLike;
  ashareSentiment?: AShareSentimentManagerLike;
  researchVault?: ResearchVaultAdapterLike;
  researchRemote?: ResearchRemoteImportAdapterLike;
  researchEmbedding?: ResearchEmbeddingAdapterLike;
  researchVaultGitSync?: ResearchVaultGitSyncAdapterLike;
  fundamentalData?: FundamentalDataAdapterLike;
  user: { id: string; defaultAccountId: string };
  clock: () => Date;
  logger: Logger;
  auditLog?: AuditLoggerLike;
  abortSignal?: AbortSignal;
}
```

`ctx` 是唯一被允许注入依赖的方式。**仓内不注入模型 SDK**：`ToolContext` 没有 LLM / Agent
槽位，模型推理在 DSH 宿主侧完成，经分析队列写回（§6.3）。各 manager 缺失时对应能力
按 `unavailable` 降级，不静默回落到别的数据源。
`limitUpLadder` 等非行情 manager 是日级批量快照端口，保持为顶层可选字段，
不混入逐标的实时行情 Gateway；各 manager 的必填 `status()` 是统一观测端口，
直接委托各自 registry 的进程内健康观测（见 §4.7）。

## 5. 数据模型

### 5.1 基础实体

**当前研究与观察模型**：Strategy 是版本化研究规则；StrategyRun 产出可追溯的
StrategyResult/StrategySignal。Watchlist 统一 manual/strategy/ai/portfolio/import 来源和成员
生命周期；Strategy → Watchlist 只有在用户创建持久、可审计的显式订阅契约后，才由
published operational run 投影 strategy source。AlertPlan 引用 Watchlist 并产生 WatchTrigger。公开 surface 只读写这三个模型；
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
ensureSchema 只保留活表的幂等启动迁移（加列 / 结构演进），存量库的旧物理表不再维护。

**Vibe A 股报告迁移 Phase 1**：新增 `Report` 结构化事实简报；收盘报告按
`(kind, scopeKey, periodStart, periodEnd)` 只生成一份不可变报告（新报告固定 version=1），
重复运行复用原报告；底层 version 与前驱字段保留以读取历史报告和周报修订。周期查询返回
最新版，列表先按周期收敛再应用状态和条数筛选，历史版本仍可按 ID 或指定 version 读取。正文只允许受限
section/block，明确区分 `generatedAt` 与 `dataAsOf`，required 维度缺失时必须为
`partial` 并保存原因。`ReportRepository` 同时提供 in-memory 与 Drizzle 实现；
`get_report` / `list_reports` / `render_report` 为 read 且在公共 registry 内；`save_report` /
`set_report_delivery_status` 为 write，属 workflow 内部 tool，不进公共 registry。Web 报告历史、详情和导出统一调用这些 tool，
不复制 partial 判定或 renderer。详细设计见
[Vibe A 股市场报告与策略研究迁移详细设计](./ddd/vibe-ashare-report-and-strategy-research-detailed-design.md)。

**Vibe A 股报告迁移 Phase 2**：新增 `AShareSentimentSnapshot` 与
`get_ashare_sentiment` external tool。东方财富封板/炸板端点独立失败、独立 provenance；
完整结果按跨池去重后的真实样本计算炸板率，封单或开板字段缺失保留 null。实时指数只在
观测日匹配请求日时组合；行情完整性信封落地前 breadth 保持 unavailable。

**Vibe A 股报告迁移 Phase 3**：`opening-report`、`closing-report` 与
`weekly-report` 共用报告 runner，经 `ctx.tools.*` 采集证据、保存 Report、记录
`WorkflowRun` 并执行通知状态迁移。定时模式默认经飞书通知；未配置飞书时保存日志并记 `fallback-log`，`notified=false`。
通知失败不回滚报告，只把投递状态记为 `failed`、运行审计记为 `partial`。报告投递通过
持久领取令牌互斥，失败后等待 15 分钟、遗留 `pending` 超过 5 分钟可接管；
收盘 tick 与策略日循环共用就绪检查：先等待当日预期策略发布完成，再生成账户计划批次；
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
并由 acceptance 与 `publication=published/withheld/non-publishing` 独立决定是否进入生产视图。
正式运行取得 lease 后先写入可查询的 `running` 记录，终态与 results/signals 在同一事务中更新；
意外异常也会把该记录收敛为 `failed`。
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
Report           个性化结构化事实简报（周期、scope、section/block、provenance、partial）
AShareSentimentSnapshot  沪深 A 股日级指数/宽度/封板/炸板/热点证据（维度级完整性）
```

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
  readonly provenance?: AnalysisProvenance; // 分析队列写回时的生成来源（模型 / 会话 / 技能版本）
  readonly id: string;
  readonly subjectKind: AdviceSubjectKind;
  readonly subjectId: string;          // stockId / accountId / sectorName ...
  readonly stockName?: string;          // 标的名称快照，历史建议回显不依赖外部查询
  readonly decision: AdviceDecision;
  readonly confidence: number;          // 0-100
  readonly horizon: AdviceHorizon;
  readonly entryPrice?: Money;          // 建议买点
  readonly entryPriceLow?: Money;       // 入场区间下沿
  readonly entryPriceHigh?: Money;      // 入场区间上沿
  readonly targetPositionPct?: number;  // 目标仓位（按账户总资产）
  readonly targetPrice?: Money;         // 目标价 / 卖点
  readonly stopLoss?: Money;            // 止损价
  readonly reasoning: AdviceReasoning;
  readonly risks: readonly string[];   // 风险点
  readonly disclaimers: readonly string[]; // 必填，至少包含基础免责声明
  readonly sourceTool?: string;         // 哪个 tool 产出
  readonly sourceWorkflow?: string;    // 哪个 workflow 产出
  readonly basedOn: AdviceDataSnapshot; // 当时的数据快照引用（行情、指标、天梯、策略证据）
  readonly validFrom: Date;
  readonly validUntil: Date;            // 过期时间（不再被采纳）
  readonly createdAt: Date;
  readonly outcome?: AdviceOutcome;     // v0.3 起：可选的回填结果（事后复盘）
}

// 数据快照（可被 advice 引用，事后能复盘）
export interface AdviceDataSnapshot {
  readonly quotes?: Record<string, Quote>;
  readonly indicators?: Record<string, TechnicalIndicators>;
  readonly llmReasoning?: string;        // 经过 sanitized 的 LLM 推理文本（用于审计）
  readonly ladder?: AdviceLadderSnapshot;  // 连板天梯摘要
  readonly strategy?: StrategyAdviceEvidence; // 策略证据（版本、运行、信号、观察）
  readonly dataAsOf: Date;               // 数据截止时间
}

// 建议结果的兼容输出；当前账户反馈由 DecisionReviewRevision 投影
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

**当前形态**：仓内不跑模型推理。core / tools / workflows / db / adapters 不依赖任何模型 SDK；
推理由 DSH 宿主承担：交互式分析经独立 `luoome-analysis` 实例的 `record_*` 直接写回本仓，
批量队列写回能力保留但默认部署不再运行常驻消费者（见 §6.3）。仓内保留的
全是确定性事实计算与状态读写。

### 6.1 数据层

来源：
- **行情**：实时报价、日线、技术指标（多源交叉）
- **基本面**：财报、估值、行业地位
- **Strategy**：版本化规则定义、校验、运行结果与可追溯信号
- **Watchlist**：跨 Strategy、AI、组合与手工来源的统一关注集合
- **AlertPlan**：引用 Watchlist 的提醒规则与送达策略
- **持仓**：自己的交易历史、成本、盈亏
- **笔记 / RAG**：用户自己的研究笔记 + 公开资料
- **分析队列**：事实包冻结、租约认领与结论写回（见 §6.3）

### 6.2 分析层

工具化的确定性计算与事实读取（不含模型推理）：

| 工具 | 输入 | 输出 |
|---|---|---|
| `compute_indicators` | daily bars | MA / RSI / MACD / BOLL |
| `run_strategy` | StrategyVersion + universe | StrategyRun + results + signals |
| `get_account_facts` | 账户 + 持仓 + 行情 | 账户事实（现金、持仓市值、账本指纹） |
| `evaluate_trading_plan_budget` | 账户事实 + 候选计划 | 预算校验结果 |
| `run_local_selector_research` | PIT StockUniverse + batch qfq DailyBar revisions + versioned params | deterministic cross-sectional score/evidence/unavailable（read-only research） |
| `assess_adaptive_personality` | StrategyVersion + isolated evaluation sessions + observations/benchmark | versioned credibility gate；insufficient evidence is unavailable（never publishes） |
| `get_stock_research_view` | explicit ResearchTopic/Document links + structured facts | stock research profile with evidence/counter-evidence/unknown（not probability/Advice） |
| `get_strategy_insight_facts` | Strategy runs + signals + observations | 可引用的确定性 facts |

### 6.3 建议层

仓内不再有 `analyze_stock` 这类内置推理 tool。交互式建议由 DSH 宿主推理后经
**独立分析面 `luoome-analysis`** 直接写回：该实例以 read + queue capability 但用精确工具
白名单收窄到 `get_analysis_context`、`record_advice`、`record_analysis_result`，交互分析
不创建 `analysis_job`。批量分析仍保留**分析队列**能力：消费者认领 job、读取冻结事实包、
用宿主模型推理，再经队列工具把结论写回；默认部署没有生产者，也不再运行常驻消费者，
worker profile 仅作手动/隔离验收。

队列工具（写工具需 `LUOOME_EXPOSE_QUEUE=true`；读工具随 read 默认暴露。部署侧按
`QUEUE_TOOL_NAMES` 名单二次收窄，漏配只会让工具更少）：

| 工具 | 副作用 | 用途 |
|---|---|---|
| `claim_analysis_jobs` | queue | 按 kind/subject 认领待分析 job，取回租约 `claimToken` 与绑定的冻结事实包 |
| `complete_analysis_job` | queue | 成功写回：结论 + provenance，原子完成 job |
| `record_advice` | queue | 把结论落成 Advice 实体（`sourceTool` 记为 `complete_analysis_job` 或 `record_advice`） |
| `record_analysis_result` | queue | 落非 Advice 的分析结果 |
| `fail_analysis_job` | queue | 失败写回：错误码 + 是否可重试 + 退避秒数 |
| `get_analysis_context` | read | 读取该事实包快照（`context.id` + `contextHash`），审计读取不等于刷新 |
| `get_analysis_job` | read | 读取分析任务及终态摘要 |
| `list_analysis_jobs` | read | 列出分析任务 |
| `get_analysis_metrics` | read | 读取队列运行指标 |

写入路径：

```txt
[DSH 消费者]  claim_analysis_jobs ──► { job, claimToken, context }
      │
      ▼
             get_analysis_context(contextId) ──► 冻结事实包（行情/持仓/策略证据）
      │
      ▼
             宿主模型推理（模型不在本仓，provenance 记模型与技能版本）
      │
      ▼
             complete_analysis_job(jobId, claimToken, result, provenance)
                    ├─► record_advice ──► Advice 落库（含 provenance）
                    └─► record_analysis_result ──► 分析结果落库
```

事实包过期时（`complete` 返回 `context_expired` / `stale_context`），消费者重新取事实包，
再用 `claim_analysis_jobs({ owner, refresh: { jobId, claimToken, contextId } })` 刷新一次绑定；
旧快照仍可审计但不能写回，同一有效租约只允许刷新一次。租约保证同一 job 只被一个消费者
完成；租约超时的 job 被回收后可重新认领。

写回路径的校验（`packages/tools/src/queue/record.ts`）：

- 事实包必须存在且 `kind` 以 `advice_` 开头，否则 `context_mismatch`
- `contextHash` 必须等于 `analysisHash({ facts, dataAsOf })`，否则 `context_mismatch`
- `provenance.evidenceFactIds` 必须全部落在事实包的 `factIds` 内，否则 `unknown_fact_reference`
- 写回时效按 `kind` 取 `packages/core/src/entity/analysis-context.ts` 的 `analysisTimingRules`
  （`analysisContextTiming` / `analysisContextTimingError` 是唯一事实来源，context 装配、
  enqueue、record、refresh 共用，不复制规则）：

  | kind | `writeUntil` | `dataAsOf` 过期 |
  |---|---|---|
  | `advice_stock` / `advice_position` / `advice_strategy_candidate` | `min(现在+30 分钟, 当日 15:00 Asia/Shanghai)` | 超过 30 分钟 |
  | `advice_market` | `min(现在+24 小时, dataAsOf+7 天)` | 超过 7 天 |
  | `research_directions` / `strategy_version_proposal` / `strategy_insight_narrative` | `min(现在+24 小时, dataAsOf+30 天)` | 超过 30 天 |

  超过 `writeUntil` / `expiresAt` → `context_expired`；超过该 kind 的数据有效期 → `stale_context`。
  15:00 截断只适用于盘中行动类，盘后市场分析与策略研究不被当日收盘截断。
- `AdviceSchema.parse` 校验结构，`disclaimers` 由工具直接填入 `STANDARD_DISCLAIMERS`，调用方无法省略
- `reasoning`（premise / evidence / counterEvidence）与 `risks` 逐条过 prompt-injection 文本清理，
  命中模式的片段替换为 `[redacted]`（`packages/tools/src/internal/sanitize-advice.ts`）
- `validUntil` 由工具按 horizon 计算：intraday 取当日 15:00，其余取 `adviceExpiryDays[horizon]` 个交易日

### 6.4 复盘层

`DecisionReview` 是账户决策记录的权威实体，以账户和明确来源唯一；来源为 Advice、
TradingPlanVersion 或 WatchTrigger。`context` 在首次保存时冻结，来源删除后继续可读。
`DecisionReviewRevision` 追加保存完整内容、成交事实指纹与全局序列；当前关联表是最新修订的投影。
旧 `AdviceOutcome` 和 Trigger feedback 的无账户数据不再直接供当前统计使用，兼容读写 tool
通过当前账户的复盘修订投影结果。启动迁移仅接收可验证的旧 `Trade.adviceId` 显式关联，
既有记录不被覆盖，也不据此生成 followed 反馈。

`get_decision_review_context` 返回冻结依据、当前及历史修订、显式后续观察、关联成交状态与账本资格。
只有沿来源身份校验过的 SignalObservation 能作为后续事实，不按同股或相近日期推断证据链。
`save_decision_review` 接受 content 顶层部分更新：省略保留 expectedRevision 对应历史修订的值，
显式 null 清除可空字段，tradeIds 的显式空数组解除关联；新建从空数组/null 开始。
工具与确认 policy 复用同一解析逻辑，policy 在审批前读取基准修订并冻结完整内容，最终写入仍用
contextHash / expectedRevision 做校验；重放也按原基准补齐，不随当前修订变化。Core 的部分更新
schema 与完整存储 schema 分开，合并函数无 IO；policy 的异步 bind 仍在 tools 层读取仓储。
`save_decision_review` 校验成功后追加修订；
`record_decision_trade` 登记系统外已完成但尚未入账的成交，事务内同时保存 Trade、Holding、
Account.cashBalance、所选来源修订和请求回执。该路径只允许对账可用账本的顺序追加，
不调用券商，sideEffect 为 trade，MCP 永不暴露。

写请求由 `accountId + requestId` 标识：同键同内容返回已保存回执，同键异内容拒绝；
账本、来源或修订已变化时要求刷新确认，任一提交失败不得留下部分成交或关联。
Web 的复盘、成交录入与补充报告端点沿用 write opt-in 和同源校验，并将请求绑定到当前账户。
页面在发送前保存未决请求，恢复时校验原账户并查询回执或复用原请求，避免丢失响应后重复入账。
导出包含修订、关联与回执；合并导入在事务中校验跨账户关系和不可变内容冲突，失败全量回滚。

`list_decision_reviews` 支持 `source`（依据发生时间）与 `recorded`（修订记录时间）两种口径，
时间窗口为 `[since, until)`。游标绑定账户、筛选条件与修订水位；`recorded` 返回窗口内的修订活动，
不能被解释为当时生成的依据。复盘列表在首页最多扫描 10001 条计算 total/coverage，并将统计
快照随游标沿用；旧游标缺少快照时补算一次。超过 10000 条时仍返回 total=null、partial 与 truncated。
成交选择分页绑定事实快照，事实变动时要求重新读取。

`get_advice_stats`、`get_confidence_calibration` 与 `get_decision_loop_review` 使用账户口径，
输出 schemaVersion 2。统计包含已过期建议；通用股票建议只有被本账户明确记录后才进入该账户样本。
`feedbackCount / withOutcome` 表示明确反馈数，`followedWithPnl` 表示 followed 且明确填写盈亏的样本数；
`hitRate` 是该样本中 pnl > 0 的比例，无样本时为 null。未记录、未填盈亏与明确零盈亏分别处理，
不汇总可能重复关联的主观盈亏；`pnlWhenFollowed / pnlWhenIgnored / avgPnl` 保持 null。
这些指标是填报样本的描述，不是交易收益率、收益承诺或 confidence 对应的成功概率。

账户收盘/周报以 `decisionReviewSnapshot` 保存窗口、修订水位、修订身份与当前成交事实指纹。
`refresh_decision_review_report` 只消费本地事实，在校验最新报告、修订水位与成交指纹后原子追加
周报不可变版本和幂等回执，原报告及其其它章节保留；收盘报告拒绝追加复盘补充版。
周报复盘补充版的 `notificationPolicy=never`
同时由 workflow、tool 与 repository 的投递路径约束，不能认领、重试或改写成可投递状态。
正常主报告及研究补充版保持原通知政策；周报事实未变时复用原报告，原失败投递仍可按原政策重试。

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
| `read` | `list_holdings`, `get_advice` | ✅ | ✅ | ✅ |
| `write` | `add_holding`, `add_trade` | ⚠️ opt-in | ⚠️ opt-in | ✅ |
| `external` | `fetch_quote`, `send_notification` | ⚠️ opt-in | ⚠️ opt-in | ✅ |
| `queue` | `claim_analysis_jobs`, `complete_analysis_job` | ⚠️ opt-in | ❌ | ✅ |
| `trade` | `record_decision_trade` | ❌ | ❌ | ✅ |

MCP 与 Web 是模型/远端可调用面，trade 类工具由 `selectExposedTools` 按类型过滤掉，
`requiredCapabilities` 含 `trade` 的工具一并拒绝。CLI 与 TUI 是本机可信操作员入口，
`tools call <name>` 直接取注册表执行、不设副作用闸口，由人显式指名调用即视为人工确认。

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
  | { kind: 'lease_lost_before_commit'; message: string }
  | { kind: 'internal'; cause: string };
```

**Tool 永不抛异常**，永远返回 `Result`。Workflow 层根据 error.kind 决定重试 / 跳过 / 终止。

### 7.4 测试要求

每个 tool 必须有：
- 单元测试：mock ctx，正常路径 + 错误路径
- Zod schema 测试：合法输入通过、非法输入报错
- 不变量测试：违反不变量时返回 `invariant_violation`
- 写建议类额外：disclaimers 必填 + validUntil 按 horizon 正确计算 + 事实包 contextHash 校验

## 8. Workflow 系统

### 8.1 内置 workflow

- `daily-review`：当日建议 + 7 日准确率 + 连板天梯 → 结构化日报
- `opening-report`：生成并幂等保存指定交易日的结构化开盘简报
- `closing-report`：生成并幂等保存指定交易日的结构化收盘复盘
- `closing-report-cutoff`：收盘截止时点核对各账户批次状态；批次未完成也按账户发布并显式标 partial
- `weekly-report`：按本周真实交易日生成并幂等保存结构化周报
- `risk-report`：持仓 + 集中度 + VaR 估算拼成风险日报（大盘背景随内置 AI 下线移除）
- `snapshot-account-performance`：按账户快照绩效指标（基准未配置时保持 unavailable）
- `strategy-autonomy-weekly`：周度评估策略自动发布资格与自治动作
- `replay-strategy-range`：在指定区间重放策略运行
- `evaluate-event-rules`：按 AlertPlan 规则对股票事件求值并产出提醒
- `run-strategies`：顺序运行 active Strategies，并按 active 显式订阅投影到目标 Watchlist；只有 published operational run 可投影
- `run-strategy-schedules`：原子抢占到期 `StrategySchedule` 并触发策略日循环
- `complete-strategy-observations`：同步 qfq 日线并补齐到期的 SignalObservation
- `strategy-daily-cycle`：策略日循环（交易日判定、运行发布、观察补齐、账户计划批次）
- `sync-quotes`：拉所有持仓的最新行情 → 写 PriceSnapshot
- `sync-stock-universe`：同步股票目录与覆盖范围
- `sync-stock-events`：盘后同步公司事件
- `sync-portfolio-watchlists`：按账户同步 portfolio 来源
- `sync-research-vault`：同步本地研究 Vault 索引
- `sync-research-vault-remote`：安全 fast-forward Git Research Vault，并通过既有流程重建本地索引
- `post-market-data`：交易日盘后同步股票目录与相关股票 qfq 日线，目录或单股失败时保留成功项并返回 partial
- `intraday-watch`：AlertPlan → Watchlist members → quote/previous close/persisted
  StrategySignal/event → edge/cooldown/daily limit → WatchTrigger → notification
- `trading-plan-daily-cycle`：账户级盘后计划批次 —— **以当前持仓（账本 Holding）为唯一复核来源**，
  先用 `sync_quotes` 把当日行情落库，再读取当日已持久化的 Advice（`sourceTool='analyze_position'`
  的持仓建议与 `sourceTool='analyze_strategy_candidate'` 的候选）派生「账户事实」（现金字段 + 持仓 × 行情 + 指纹），
  候选建议 → `TradingPlan` 不可变版本 → 组合预算校验；账户事实不可用（缺合格行情或账本未对齐）时不激活精确仓位计划。
  **仓内不产生新建议**：无对应 Advice 时只留复核痕迹，由 DSH 交互分析实例经 `record_advice` 写入。
  盘中持仓估值与行动候选复用 core 的行情资格判断：须有上游事件时间，事件与当前时点均在交易时段，
  抓取完成不晚于判断时点且事件距判断不超过 120 秒。盘外实时报价仍须有上游时间；规范日线的收盘价
  按既有交易日口径使用。缺合格行情时，最近报价只保留参考估值和限制说明，账户事实为 `unavailable`，
  `totalAssets` / `stockMarketValue` 为 `null`，不能借参考价激活其它股票的精确预算或行动计划。
  候选的 `watch` 也必须给出条件性价格计划（区间/买点/目标仓位/目标价/止损），
  缺价位时计划标为草案并写明原因。
  生效计划按 horizon 的最长持有交易日独立设置硬期限，来源 Advice 在构建时必须有效；
  草案最多两个交易日，连续草案继承截止时间，重复或已过期且仍受阻的草案不新增版本。
  条件、账户前提、反证和风险未变化时维持尚未过期的原生效版，复核结果及本次 Advice 引用
  写入 WorkflowRun；批次区分新增、维持与草案数量，含草案的批次标为 partial。
  core 统一选择当前版本；监控和原子预算提交均保留最新草案之前的生效版。
  `list_trading_plans(currentOnly=true, includeMonitoring=true)` 按计划聚合后限制数量，
  返回 `views`（主版本、修订草案）与 `monitoring.expiresAt`（含存量草案的实际截止时间），
  监控投影从复核审计补齐 `lastReviewedAt` / `nextReviewAt`，复核时间更新不延长硬期限；
  Web 根据服务端投影显示当前计划和历史，不复制版本选择与过期规则。
- `intraday-trading-plan-watch`：先按有效计划标的与全部当前持仓的并集分批刷新行情（每批最多 100 个），
  `batch_quote` 落库后派生账户事实，再按新鲜行情求值计划条件，
  入场条件按 ALL 合成单个边沿，风险/退出命中阻止入场提醒；风险与退出条件只在对应仓位已持仓时才投递提醒，
  未持仓计划只监控买入候选，这类命中只写 `not-requested` 留痕（边沿状态仍照常求值）；
  冷却对所有优先级生效，每日上限只约束常规提醒，优先级决定消息 level；风险直接通知原始触发事实与计划版本，
  不调用 AI 或自动改写计划；发布前重新校验账户事实指纹、
  计划版本、行情时效、条件是否仍成立与 10 分钟发布时限（以上游事件时间为计时起点），
  行情刷新和失败重试保留首次可信事件时间，复查时在行情请求结束后重新读取时钟，不能重置该时限，
  在同一租约内提交 Trigger + WatchRuleState。只监控与当前账户事实指纹一致的计划；单条候选过期、
  失效或条件恢复只丢弃该条且不消耗该边沿，不阻断同轮其它信号；失败/中断投递作为重试候选。
  全程复用共享预警租约与续租保护；试跑不保存 Trigger/边沿/投递次数。通知披露下一步、反证和卖出限制。
  盘中报价还要求 `fetchedAt` 不晚于决策时钟；触发快照保存首次上游事件、首次取得和发布复查时间，
  WatchTrigger 保存最近一次投递尝试与完成时间。`sent` 的完成时间仅用于计算渠道受理耗时，
  不代表设备送达。单条候选在发布复查中超时、缺可信事件时间或失效时，
  同租约原子保存 `expired` / `unverifiable` / `invalidated` 触发审计，不推进边沿、
  不生成 SignalObservation，也不进入投递重试；已形成候选后的整轮账户事实、计划或行情读取失败
  同样保存为 `invalidated` / `unverifiable` 审计。候选形成前的数据源失败只保留运行错误，
  不伪造不存在的市场事件。`get_intraday_delivery_audit` 按账户与上海自然日读取完整触发集合，
  将渠道受理的 10 分钟内、超时、时点不可核验与未受理状态分别计数；P95 只对时点可核验的
  渠道受理样本计算，同时展示全部候选分母，不把渠道受理当作设备送达。
- 预警执行：`intraday-watch` 与 `evaluate-event-rules` 共用 SQLite 租约（120 秒有效期、30 秒心跳，
  工具调用前检查所有权）；并发调用返回可重试错误。所有优先级都进入投递：normal 与 urgent 同样受冷却
  和每日上限约束，优先级只决定消息 level 与标题前缀；`notifyOnRecovery` 未开启的 recovered 与试跑
  仍为 `not-requested`。workflow-only 的 `commit_watch_evaluation` 在同一事务校验 owner
  并提交 Trigger + WatchRuleState，试跑不进入提交。通知前保存 deliveryAttempts/lastDeliveryAttemptAt，
  后续轮次补偿当日 failed/pending（最多三次，退避 1/5 分钟，停用计划/移除成员/额度不足时不发送）。
  每日额度包含重试和已开始发送的 pending；WatchRun 本轮触发列表可以包含同 id 的补偿投递。
  飞书没有端到端幂等确认：外部已接收但本地回写前崩溃时，补偿仍可能重复，不能承诺恰好一次送达。
  WatchRun 的历史 `delivered` 计数只表示渠道受理；Dashboard API 投影为 `channelAccepted`，
  `deviceDelivered` 保持 `null`，直到有真实设备回执。
  `render_report(format=notification)` 从结构化报告生成有长度预算的移动摘要，不截取完整 Markdown；
  `markdown/plain-text` 继续保留完整证据。列表可保存 `notificationSummary` 作为生成时的阅读投影，
  旧报告缺少该字段时仅提供核对入口，不从长文本猜测交易结论。飞书适配器只在卡头展示标题。
  通知板块采用显式允许列表，仅包含市场、策略研究、预警和事件；账户估值/仓位/交易计划、交易归因、
  个人行为与混合数据质量板块留在完整报告，私有板块缺口不参与通知告警。存量建议摘要去除目标仓位行。
  正文空指标聚合说明，全空表格列省略，诊断缺口去重后集中展示；结构化快照保留原始 null 和缺失原因。
  单日账户绩效向前取一个交易日作为收益基点；未配置基准不输出空指标，多账户 TWR/回撤不做算术聚合。
  情绪指数按请求交易日逐条筛选，混合日期仅使该维度 partial，不丢弃同日行情；空返回仍为 unavailable。
  规则兜底标记（`RULE_FALLBACK_PREMISE_MARKER` / `RULE_FALLBACK_EVIDENCE_MARKER`）只用于识别
  存量数据：带标记的建议不是模型研究结论，通知中合并提示且不形成交易判断。
- **Phase 2/3 已实施**：连板天梯联动 workflow —— `daily-review` 通过
  `limit_up_ladder` 与 `limit_up_ladder_compare` tool 消费结构化事实，报告、行情和研究视图复用同一
  日期/股票快照；Strategy scan/scheduled 另写 PIT 快照，replay 只读历史表（设计：[docs/ddd/limit-up-ladder-detailed-design.md](./ddd/limit-up-ladder-detailed-design.md)）。

### 8.2 Workflow 与 tool 的边界

| | Tool | Workflow |
|---|---|---|
| 粒度 | 原子 | 组合 |
| 可独立暴露 MCP | ✅ | ❌ |
| 可被 agent 编排 | ✅ | ❌（避免循环） |
| 可手动触发 | ✅ | ✅ |
| 必须有 Zod schema | ✅ | ✅ |
| 必须可测试 | ✅ | ✅ |

### 8.3 模型推理不在 workflow 内

DSH 瘦身（docs/ddd/luoome-dsh-transformation-detailed-design.md）后，仓内 workflow **不含模型推理步骤**：
core / tools / workflows / db / adapters 不依赖任何模型 SDK，`ToolContext` 也没有 LLM 槽位。
需要模型结论的流程由 DSH 交互分析实例经 `record_advice` / `record_analysis_result`
写回本仓（§6.3）；批量队列写回能力保留，默认部署无生产者、无常驻消费者，workflow 只消费
已落库的事实与 Advice。

因此 workflow 步骤的约束是：
- 输入是结构化数据（不是字符串拼接）
- 只经 `ctx.tools.*.execute()` 取事实与写入，不直接访问 repository / adapter
- 步骤返回 `ToolResult` error 即短路；抛 `InvariantError` 归 `invariant_violation`，其它异常归 `internal`

## 9. MCP Server

### 9.1 传输

v0.1: **stdio**（harness 默认）。
v0.3+：HTTP/SSE（远程、移动）。

### 9.2 暴露策略

```ts
// packages/mcp/src/exposure.ts
export const resolveAllowedSideEffects = (
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<SideEffect> => {
  if (env.LUOOME_EXPOSE_TRADE === 'true') {
    throw new Error(
      'LUOOME_EXPOSE_TRADE=true is not allowed: trade tools are never exposed over MCP ' +
        '(AGENTS.md「副作用与权限」硬约束)。',
    );
  }
  const allowed = new Set<SideEffect>(['read']);
  if (env.LUOOME_EXPOSE_WRITE === 'true') allowed.add('write');
  if (env.LUOOME_EXPOSE_EXTERNAL === 'true') allowed.add('external');
  if (env.LUOOME_EXPOSE_QUEUE === 'true') allowed.add('queue');
  return allowed;
};
```

read 默认暴露；write / external / queue 须显式 opt-in。trade 没有 opt-in 通道 ——
`LUOOME_EXPOSE_TRADE=true` 直接让 MCP 启动失败，trade 类工具同时被 `selectExposedTools`
按类型过滤掉（`sideEffect === 'trade'` 或 `requiredCapabilities` 含 `'trade'` 都拒绝）。

工具名单另有两层收窄：`LUOOME_EXPOSE_TOOLS` 是显式白名单（**显式设为空即 fail closed**，
只有不设该变量才表示全部允许）；`LUOOME_EXPOSE_DENY` 是黑名单。私有研究类 tool
（`privateResearchTools`）默认进黑名单，需 `LUOOME_EXPOSE_RESEARCH=true` 才放行。

### 9.3 MCP tool 命名

luoome 内部 snake_case，MCP 同样 snake_case，OpenAI 同样 snake_case。**三套统一**，避免翻译层。

## 10. 多端消费

| 消费者 | 入口 | 暴露范围 |
|---|---|---|
| CLI | `bin/luoome <cmd>` | 全量（`tools call` 不设副作用闸口） |
| TUI | opentui app | 全量（含交互） |
| Web | Hono HTTP API | read 默认；write 需 opt-in + 同源校验；trade 仅走专用人工路由 |
| MCP | stdio server | read 默认；write / external / queue 需 opt-in；trade 永不 |

Web 端最小方案：Hono HTTP API + 同源 SPA。前后端共享 Zod schema。

## 11. 数据流示例

### 场景 A：MCP 客户端问"今天盈亏 + 已有建议"

```txt
[MCP 客户端 LLM]
      │  决策：调 get_account_facts + get_advice
      ▼
[MCP stdio] ───► luoome MCP Server
                    │
                    ├──► list_holdings (read)        ──► HoldingRepo ──► SQLite
                    ├──► get_account_facts (read)    ──► 现金 + 持仓市值 + 账本指纹
                    └──► get_advice (read)           ──► AdviceRepo ──► SQLite（已落库的建议）
                    │
                    ▼
[MCP stdio] ◄── { facts: {...}, advices: [Advice, ...] }
      │
      ▼
[MCP 客户端 LLM]  整合生成自然语言答复（保留反证、风险、免责声明、有效期）
```

默认暴露面只有 read；要取实时行情需另开 `LUOOME_EXPOSE_EXTERNAL=true` 才能用 `batch_quote`。
**客户端拿不到本仓现场生成的建议** —— 建议只能来自已落库的 Advice（由 DSH 交互分析实例或手动 worker 写入）。

### 场景 B：TUI 看持仓与已有建议

```txt
[TUI 启动]
   │
   ▼
[opentui] ───► list_holdings + get_advice
                  │
                  ├──► list_holdings  ──► HoldingRepo
                  └──► get_advice     ──► AdviceRepo（已落库建议，按 subjectId 取最新）
                  │
                  ▼
              [opentui 渲染持仓面板：决策 / 信心度 / 有效期 / 理由 / 证据 / 反证 / 风险]
              [无对应建议时显示「（暂无建议）」—— 内置 AI 已下线，不再本地生成]
```

### 场景 C：DSH 消费者处理待分析队列（手动/隔离验收链路）

```txt
[手动/隔离环境显式拉起的 worker 轮询]
      │
      ▼
[luoome-worker 手动/隔离验收实例] ───► claim_analysis_jobs (queue)
      │                                   │
      │                                   ▼
      │                         { job, claimToken, context }
      │                                   │
      │                                   ▼
      │                         get_analysis_context (read) ──► 冻结事实包
      │                                   │
      │                                   ▼
      │                         宿主模型推理（不在本仓，模型信息记进 provenance）
      │                                   │
      │                                   ▼
      └──► complete_analysis_job (queue) ─┴─► record_advice (queue) ──► Advice 落库
                                                   │
                                                   ▼
                                          [TUI / MCP / Web 读到新 Advice]
```

事实包过期时消费者重新取事实包并用 `claim_analysis_jobs(refresh=...)` 刷新绑定；
租约超时未完成的 job 回收后可被重新认领。

> 2026-10-24 增补：默认部署（Web + Caddy）不再运行该消费者，队列只是保留的领域能力。
> 日常交互分析经 `luoome-analysis` 实例的 `record_*` 直接写回，不创建 `analysis_job`；
> 本场景仅在手动/隔离 worker 验收时使用，空队列不会产生任何模型请求。

## 12. 安全模型

详见 [SECURITY.md](./SECURITY.md)。要点：

- 5 级副作用：`read / write / external / queue / trade`，trade 永不暴露
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

仓内 workflow 不再生成 advice；新增 workflow 只编排已有事实与已落库 Advice：

1. 在 `packages/workflows/src/<name>.ts` 用 `defineWorkflow` 定义
2. 通过 `ctx.tools.get_advice.execute()` / `ctx.tools.get_advice_stats.execute()` 读取已有建议，
   通过 `ctx.tools.*.execute()` 获取事实和写入结果，不直接访问 repository 或 adapter
3. 需要产生新建议时，交给分析队列消费者（`record_advice`），不要在 workflow 内引入模型调用
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

## 16. 个人订阅服务装配

Web 启动只有一种形态：本地单机装配（`apps/web/src/local-start.ts`），
没有登录、没有租户隔离、没有支付计量。CLI/TUI/MCP/DSH 插件共用同一份单机事实库。
默认部署是纯插件形态：DSH（Node）加载 `dsh-luoome`，安装/升级/备份/回退步骤见
[用户手册](./USER_GUIDE.md#7-dsh-单机用法)，部署约束见 [宿主机直部署](../deploy/direct/luoome-dsh.service)。

认证传输默认要求 HTTPS 与 Secure Cookie；临时 HTTP 验证须显式 opt-in，使用独立 Cookie。
浏览器按实际请求 Host（含端口）与配置的传输协议校验同源 Origin，代理保留原始 Host；PUBLIC_ORIGIN 用于通知链接，不限定访问域名或端口。
CSRF、验证码限流及租户隔离不随传输开关关闭；切回 HTTPS 后不复用 HTTP 会话。
登录页通过匿名只读 `/api/auth/config` 获取邮件配置、注册及传输开关，不读取用户身份或部署凭证。

模型推理由 DSH 承担，luoome 侧没有模型设置页，也不做用量计量。仓内已无模型目录文件
（原 `$LUOOME_HOME/ai-models.json` 随 `packages/adapters/src/llm/` 一并删除）；
现存唯一的模型目录是研究 embedding 的 `LUOOME_RESEARCH_EMBEDDING_CONFIG`，密钥从环境取。

没有 control.sqlite、没有租户：全部事实落在单机 `luoome.db`。
core 的 `personal/` 只定义实体与不变量；db 的 memory/Drizzle 实现共享 contract tests。
空库原子初始化一个默认投资 Account；已有唯一账户原样复用，多账户异常保留数据并停止自动迁移。
`update_account` 仅更新名称，资金/持仓依旧通过 ledger。

托管形态的平台 Tools（私有 registry、订阅与预算门禁、请求级租户上下文）已随托管层下线删除，
`packages/tools/src/platform` 不再存在。单机形态下所有业务能力走同一套 `packages/tools/src/registry.ts`
公开 registry；默认部署的 DSH 暴露面由 `dsh-luoome` 插件控制（精确只读白名单、market external
白名单与原生确认 policy），调度由 DSH 定时任务驱动。旧 MCP 过渡形态的四实例
（`luoome` / `luoome-settings` / `luoome-analysis` / `luoome-batch`）仅保留给手动/隔离验收。

单机形态没有租户运行时管理：每个请求一个本地 ctx，账户由 `ctx.user.defaultAccountId` 绑定。
界面不提供新增/切换账户，服务端同时拒绝对应绕行。

原 Strategy schedule、账户计划、报告、观察、绩效及历史评估的编排保留在领域 workflow 里，
由 DSH 定时任务调用的批处理工具触发（保留原领域 lease/fencing/checkpoint）。
workflow 继续只通过 `ctx.tools.*` 编排。`@luoome/batch` 是位于 surface 层的共享入口，依赖
workflows/tools/core，不进入领域 registry，也不依赖 MCP 或 DSH SDK；MCP 兼容转发同一实现，
插件只在显式 batch opt-in 后挂载五条账户绑定 policy，完整要求 write + external。
业务成功、用户额度、provider成本和通知状态分别表达，unknown不按超时猜测为零。

默认账户复用原DecisionReview与开盘/收盘/周报。旧`watchlist-facts`属于补充报告，旧PersonalWatchFeedback
保留历史读取，不与账户采纳/收益自动混算。原设置页只增加个人订阅/通知/账户名称/退出；平台模型密钥、
数据源、Vault路径和整库恢复保留部署/运营边界，不能让一个租户修改所有用户的环境。

共享写屏障覆盖Web、worker、provider活动、会话及迁移；新接入的业务/SSE也必须进入删除排空与恢复验证。
恢复保持冻结，撤销旧凭证/fence，应用最新独立删除ledger，按业务回执对账且不重发旧通知，完成核对后才恢复外部副作用。

单机形态的运行与部署见 [宿主机直部署](../deploy/direct/luoome-dsh.service)，
安装/升级/备份/回退步骤见[用户手册](./USER_GUIDE.md#7-dsh-单机用法)，
形态决策见[详细设计](./ddd/luoome-dsh-transformation-detailed-design.md) D9–D12。
自动证券交易仍禁止；人工已完成成交保持原专用记账契约。

## DSH 分析队列与应用层 AI 运行时

领域层保留 `AnalysisJob`、`AnalysisContext`、来源不变量和 repository 接口；
Drizzle 与 memory 实现共享合约测试。`analysis_job` 的 claim token 对写回构成租约栅栏。
`complete_analysis_job` 在同一数据库事务中校验事实/来源、发布结果并完成任务，
包括 Advice 与非 Advice 结果。直接 `record_advice` / `record_analysis_result` 用于交互上下文，
批量上下文必须经持有 token 的完成路径。终态上下文仅供审计，不得再次写回。

`claim_analysis_jobs.refresh` 在有效租约内将重新装配的交互事实包绑定为新批量事实包，
每个 token 最多一次，关闭旧事实包写回窗口，不延长租约。`context_expired` / `stale_context`
触发一次重新取事实与推理；失去租约立即停止。失败按任务策略退避并最终进入死信。
`get_analysis_metrics` 区分全部 pending、已到期可执行 pending 与未回收的过期 claim。

模型适配器与计量随模型运行时整体退役，推理只在 DSH 侧发生。
core、tools、workflows、db、adapters 的生产代码不依赖 AI SDK；边界由 `infra/check-layers.ts`
检查。领域工具只装配事实、校验和持久化，不自行推理。`write` / `external` opt-in 仍有效。

默认纯插件部署的 read / market / 写操作面互相隔离：read 只接受纯 read 工具，market 只接受
`sideEffect==='external'` 的精确工具，写操作只经确认 policy（含账户改名）；queue 管理工具、
任意 settings registry 和 trade 不暴露。batch 默认关闭，启用后仍只经确认或精确任务授权。旧 MCP 过渡形态的读面、设置面、分析面与批处理面分实例隔离，
手动 worker profile 仅用于隔离验收：`queue` 默认拒绝，`luoome-analysis` 用 read + queue 但收窄到
精确三个工具名，手动 worker 实例才用 `QUEUE_TOOL_NAMES` 显式白名单。部署环境传入的
`LUOOME_EXPOSE_*` 不得扩大任何面的暴露面。
看盘、持仓、关注、策略、复盘通过 `ctx.slots` 注册主面板与侧栏入口；投资设置注册到 DSH 原生
`settings.section`，不占业务侧栏。宿主 prefix 路由复用 DSH Connection.admit
与 Host/Origin 校验；固定 state GET 只投影白名单工具及受信任配置。账户改名走既有 prepare/confirm
协议，预览与取消不写入，未知结果只核对 operation ID。浏览器只保存恢复用的 UUID，不保存授权 token，
不重算业务数字。非交易日的情绪查询取最近交易日，仍展示供应商原始日期，不伪装今日实时行情。

看盘保留账户概览，持仓明细在持仓页查看。关注页独立读取 `list_watchlists`，按选中列表
调用只读 `get_watchlist`；股票名称由工具解析本地目录，缺失名称不猜测。新建/修改/归档列表、
添加/调整/移除手动成员复用领域工具及独立确认 policy，不开放定时授权。AI 管理入口生成带
列表身份的可编辑对话草稿，实际写入仍逐次审批。结束 manual 来源不会删除其他仍有效的来源；
没有业务回执的未知写入只核对，不自动重试。

投资设置的 `/api/luoome/settings/market` 只向已认证的 owner 提供行情源顺序与 FUYAO 配置，
POST 复用同源 JSON 与 64 KiB 上限。Zod 校验后先构造候选 market/sentiment，再将三个允许的
环境键原子写入 `0600` 的 `$LUOOME_HOME/.env`，成功后替换当前 ToolContext；共享 EastmoneySource
与无关 manager 保持复用，后续工具调用立即读取新配置。启动时也只从文件加载这三个行情键，
不能覆盖 owner、工具授权或交易开关。GET/POST 只返回密钥配置状态，不回显 API Key。

客户端 API URL 相对 DSH 的 document base 解析，保留 `/dsh/` 等反向代理前缀。核心指数直接投影
`fetch_index_quotes`，不依赖情绪聚合是否成功；情绪冷启动使用正常外部请求时限，截止超时返回可恢复 adapter_error。

默认公网部署使用 `/dsh/`：Caddy → dsh-pocket → 容器内 `127.0.0.1:3080` 的 DSH。
Pocket 提供密码登录、自动启动 token 握手与移动端抽屉；Caddy 在 Pocket 改写上游 Origin 前
校验浏览器 Origin，3080/3081 均不发布。部署适配器将登录表单、跳转与 Cookie 限定在
`/dsh/`，清除迁移前的同名根 Cookie；根路径不进入 DSH。面板导航通过官方
layout 服务收起手机抽屉，不改变业务确认协议。
应用升级通过 `deploy/dsh/upgrade.py` 将当前工作树的应用产物与部署文件绑定到同一发布清单；
镜像入口固定 loopback，容器健康检查同时检查 DSH/Pocket 端口，公网探针验证密码后的 profile 与实时通道。

策略页按名称切换详情，展示当前已发布定义的筛选、评分与信号规则。`get_strategy_workspace`
同时返回已发布正式运行的实际版本 `currentRunVersion` 与有名称、原始规则事实的 `matches`；
明细默认最多 50 条，`selectedLimit` 最大 200，`matches.total` 保留完整入选数。无发布结果时不返回
`matches`，已发布但无人入选时返回空明细与零总数。浏览器不重新选股或评分；当前版本与结果版本
不同时明确提示。页面与研究草稿使用名称、版本号和事实时间，内部标识仅保留在数据与调用参数中。

个人策略研究空间沿用 Strategy/StrategyVersion、evaluation session、真实信号观察和 manifest。
同快照试跑先固定实际输入事实和 clock，再求值各版本并返回输入身份；它不发布 operational
current。数据资格预检只审计本地保留字段、前序窗口和历史覆盖，不能替代在线源验收或严格
回测门禁。宿主只启动既有 replay 编排、投影进度和维护 Operation 回执，不复制逐日领域逻辑。
研究结论按账户和不可变版本恢复，保存不等于证据通过；有界候选比较保留失败和训练/验证隔离。
存储扩展现有 StrategyEvaluationRepository：`strategy_research_states` 以策略/账户绑定 CAS 修订，
同请求与相同内容可重放，结论和比较历史各有显式容量门槛，满时拒绝追加，不静默删除旧研究。
持续观察分别核对日程、DSH task、grant 与真实业务事实，T+1/T+3/T+5 不被当作组合回测。
客户端与固定研究路由、确认操作及可复现边界见[插件研究工作台契约](./ddd/dsh-luoome-plugin-detailed-design.md#82-个人策略研究工作台)。

策略匹配标的的个股详情按点击时的股票、结果及版本保留来源。点击股票后才经固定
`GET /api/luoome/stock?stockId=...` 调用精确 opt-in 的 `fetch_quote`；只接受一个规范股票代码，
仍经宿主 owner、Host/Origin 校验与有界取消。`fetch_quote` 保留 `retrieval` / `freshness`，
缓存回退及过期状态、行情时间与匹配时间分别呈现。关闭详情取消客户端等待，错误不清空匹配依据。
分析按钮在用户点击后通过官方 Session Controller 创建并保留会话，使用其公开 SessionFace
提交股票分析问题，收到宿主接受后再打开对话；保留期间使用真实作用域，不借用未注入服务，
也不操作或清空已有会话草稿。失败不自动重试，任何业务写入仍走原生审批。

历史图表由独立 `/api/luoome/stock/history?stockId=...` 提供固定三个月日 K，复用
`get_stock_market_view` 的真实 candles/dataStatus。入口只接受单个沪深股票码，沿用 owner
admission、Host/Origin、no-store 和有界取消。历史读取由用户主动触发，报价保持独立；缺日线时
显示不可用，不从单次报价合成历史，图表不提供组合回测结论。

单机事实库是唯一事实源；历史托管租户库已下线。
存量 Advice 的来源幂等回填为 `legacy-ai`，不伪造历史模型信息。

## 纯插件执行与授权内核

`packages/dsh-luoome` 的 DSH/HTTP 包装统一调用 tools 操作服务；`PluginAuthorityRepository` 在 core 定义，db 提供 memory/drizzle、同步 schema/DDL 与合约。操作冻结账户/输入并 CAS 认领，通用操作回执与业务事务分离，结果不明时通过既有业务 receipt 核对，不能自动重执行业务。

宿主审批使用真实 ApprovalService，执行 token 的私有凭据经单调 guard 和 handler 核验。调度身份来自当前 turn 消息与 ScheduleService 持久投递历史的关联，并绑定任务定义指纹、授权版本、账户及精确参数。

生产插件声明 `agents` 依赖，原生调用在插件作用域核对活 Agent；HTTP 读接口不能替代这条验收。
确认入口由操作服务的当前 policy Zod schema 派生 tool/input 契约，直接提供嵌套字段类型并保留每项操作的精确约束。
参数校验失败返回不含提交值的字段路径与类型要求，保留 invalid_input 与 permission_denied 的区分；不会因纠正参数而跳过审批。

新 Web 装配在官方 WebServer 上注册业务前缀，逐请求经 Connection.admit 的 cookie/Host/Origin 与 owner 检查，保持真实监听器 origin 和 64 KiB 流式输入限制。确认页只把操作编号存入 sessionStorage，确认凭据仅在组件内存；模型调用使用官方审批组件。预检经 appReady/appExit 独立退出，或在可信 worker 的 pre-step 中先于模型解析阻断空队列/异常。

无模型预检、完整官方 Web profile、Node DB 只读/写回与 M5 默认部署纯插件切换（含一致性备份与回退合并演练）已有隔离验收。**生产服务器已于 2026-10-25 完成纯插件切换并通过宿主侧、HTTP 与浏览器验收，旧 MCP/Bun 源码尚未删除**；自动执行默认关闭。实现与验证边界见[纯插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md)。

原生操作参数中的账户与 requestId 由 policy 绑定；模型参数 schema 将这些字段标为可省略，完整领域校验仍在绑定后执行。冲突错误只返回安全字段路径。用户拒绝后，宿主基于真实会话事件阻断同一请求的后续写计划，改工具名或 operation ID 不能绕过；新的用户请求可以重新独立审批。
