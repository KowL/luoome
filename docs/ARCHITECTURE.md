# Architecture

> 当前 DSH 插件的模块、数据流与实现契约。业务概念先读[领域语言](../CONTEXT.md)，安装与运行先读[插件说明](../packages/dsh-luoome/README.md)。
> 本文保留部分旧章节标题供历史链接定位；正文标注的退役入口和阶段方案不构成当前依赖。

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

事实服务于研究、提醒、建议和复盘。ResearchTopic、资料与事实型报告可以独立存在，不要求先转成 Advice。
引入数据以当前用户问题与可验证来源为依据，不为了未来可能的建议预建整套模型。

Advice 是有独立 schema、存储、检索与账户反馈统计的领域实体；推理由 DSH 承担，写回必须引用
当时事实。统计披露样本与缺失，不把 confidence 或填报盈利占比表述为未来概率。

### 2.2 Agent-first

业务能力通过统一 tools 实现，插件按明确需求开放对应 Interface；用户入口与 Agent 复用业务逻辑，
但可调用范围分别受能力与账户约束，trade 不向 Agent 开放。例如：
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
- **Workflow**：组合多个 tool，有顺序、循环与条件分支。Workflow 对象不直接注册为 agent tool；需要对外触发的确定性编排由 `@luoome/batch` 提供精确 `run_*` 入口，再由 DSH 插件按明确意图或持久任务授权调用。批处理入口不进入领域 tool registry，内部仍只经 tools 编排。独立 CLI/TUI 已退役。

例如：
- `compute_indicators`（tool）= 纯计算
- `get_account_facts`（tool）= 汇总账户现金、持仓与账本事实
- `daily-review`（workflow）= 读当日建议 → 读准确率统计 → 读天梯 → 汇总成结构化日报

### 2.5 Repository Pattern

core 包定义 repository **接口**，db 包用 Drizzle 实现。tools/workflows 只依赖 core 接口，不耦合 Drizzle。

当前价值：
- in-memory 与 Drizzle 共用 contract tests，验证相同业务行为；持久化与事务语义仍通过真实 SQLite 测试。
- Node 插件与 Bun 测试复用领域 repository 契约，事务、幂等和存储细节留在 db。

当前只维护 SQLite，不以未来更换数据库为由预建额外 Adapter 或兼容分支。

### 2.6 副作用分级 + Advisor 边界

每个 tool 必须显式声明**副作用等级**，消费者据此决定是否可调用：

| 等级 | 含义 | 例子 | 默认暴露给远端面 |
|---|---|---|---|
| `read` | 只读本地 | `list_holdings`, `get_advice` | ✅ |
| `write` | 写本地状态 | `add_holding` | ⚠️ 可配置 |
| `external` | 调用第三方 | `fetch_quote`, `send_notification` | ⚠️ 可配置 |
| `queue` | 消费分析队列并写回结果 | `claim_analysis_jobs`, `complete_analysis_job` | ⚠️ 可配置 |
| `trade` | 登记系统外已完成的资金动作 | `record_decision_trade` | ❌ 永不 |

> DSH 瘦身（docs/ddd/luoome-dsh-transformation-detailed-design.md）后：原 `advice` 等级
> （只读 + LLM 推理 + 落建议）随内置 AI 工具一并删除，`SideEffect` 为上表 5 级；
> Advice 实体与存量数据保留，新建议由 DSH 推理后写回。`queue` 是领域写回与租约消费能力分类，
> 不代表部署了队列进程。交互分析通过插件精确 `record_*` policy 直接写回；队列管理工具不在
> 默认插件暴露面。普通后台分析可显式配置 `analysisModel`，执行仍使用 DSH 宿主服务（§6.3）。

`sideEffect` 表示主副作用；跨越多个能力边界的 tool 还需声明 `requiredCapabilities`。
所有 surface 按组合能力逐项门控，例如远程资料导入要求 `write + external`。

Research 检索以 SQLite FTS5 为确定性基线。可选 embedding adapter 通过 `ToolContext.researchEmbedding` 注入；Tool 只面向 core 的稳定接口，不读取 provider 配置。embedding 投影属于 db 中可重建读模型，由独立 `ResearchEmbeddingRepository` 的 Drizzle/in-memory 双实现维护，并按 `provider + model + dimensions + version + chunk contentHash` 隔离和失效。混合检索、增量重建和固定跨模型评测均通过 Tool 暴露，Web/Agent 不复制融合或指标逻辑。

**advice ≠ trade**：advice 永远不能直接触发 trade。trade 永远是 human-in-the-loop。

## 3. 模块结构

```
luoome/
├── packages/
│   ├── core/           领域类型、不变量与纯计算
│   ├── db/             SQLite schema 与 repository 实现
│   ├── tools/          Tool 注册表与 schema 生成
│   ├── adapters/       行情 / 通知 / 事件 / 研究库适配
│   ├── workflows/      review / report / watch / plan / strategy 编排
│   ├── batch/          确定性 run_* 批处理入口
│   └── dsh-luoome/     DSH host / client / skills，唯一产品入口
└── deploy/             DSH 插件部署、升级与恢复
```

### 依赖方向（强约束）

```txt
dsh-luoome ─────────────► tools ──► core
      │                     │
      │                     ├──► db ──► core
      │                     └──► adapters ──► core
      │
      └──► batch ──► workflows ──► tools ──► core
```

**禁止反向依赖**：core 不依赖 db / tools；tools 不依赖 DSH 插件；adapters 不依赖 workflows。
插件的 host 与 client 提供原生工具和 Web 面板，独立 `packages/cli`、`packages/tui`、
`packages/mcp` 与 `apps/web` 已下线；历史章节中的这些入口不构成当前部署依赖。

### 模型运行时边界

模型推理与模型配置都由 DSH 承担，luoome 侧没有模型运行时包，也没有模型设置页：

- 领域包（`core` / `db` / `tools` / `workflows` / `adapters`）不得导入生成式模型 SDK；`mcp` 包已删除。
- 领域能力仍统一经 tools 使用；领域层不推理、不计费。
- `infra/check-layers.ts` 守住 AI SDK 依赖边界。

「零 AI」按**行为**判定，不只看包依赖：领域包（`core` / `db` / `tools` / `workflows` / `adapters` /
`batch`）的源码里不得出现模型 endpoint 字面量（`/embeddings`、`/chat/completions`、`/completions`），
由同一支 `infra/check-layers.ts` 扫描。只 import `node:fs` 的适配器照样能 POST 到模型供应商，
只查 import 会放过这种写法。需要模型结论的流程由 DSH 写回（§6.3、§8.3）。

唯一受控例外是 `packages/adapters/src/research-embedding/`（`OpenAICompatibleResearchEmbeddingAdapter`），
白名单在 `infra/check-layers.ts` 中以目录形式声明：

- **为什么例外**：研究库向量检索要求查询向量与文档向量出自同一模型，向量空间无法在仓外代算。
  这项能力做的是「检索文本 → 向量」，属于检索基础设施，不是判断能力。
- **边界**：只接受 `purpose=document|query|evaluation` 的文本并回传向量与用量；向量只写入本地研究库
  索引；不产出判断、不写 Advice、不进入 tool/workflow 决策，也没有 chat/completions 通道。默认关闭，
  `LUOOME_RESEARCH_EMBEDDING_ENABLED=true` 才装配；模型目录缺失或密钥环境变量为空直接报错，
  不回退 mock。
- **如何收紧**：DSH 侧提供 embedding 供应商后，删除 `packages/adapters/src/research-embedding/`、
  对应 provider 目录与这条白名单，领域层回到零模型请求。白名单只允许随这条路径一起收缩，不新增目录。

设计依据：[luoome 的 DSH 改造详细设计](./ddd/luoome-dsh-transformation-detailed-design.md) §5.1、§5.7.4、Q14、D9。

### 零 IO 的受控例外：evaluator code identity

`packages/core` 是纯领域层，默认不发起文件/网络 IO。唯一例外是
`packages/core/src/strategy/evaluator-code-identity.ts`：它在模块加载期读取
`strategy/` 下 5 个 evaluator 实现文件与 `trading-calendar.ts`，计算真实文件内容的 SHA-256，
作为回测可复现性的锚（REQ-M3-12）。

- **为什么必须在这里**：identity 必须在任何进程、任何 surface 上都能从「实际被加载的代码」算出。
  放到 db/tools 会让 core 的 run 快照反向依赖上层，且覆盖不了所有加载路径。
- **边界**：只读本包内固定清单的文件；不读 `node_modules`、不读用户数据、不写文件、不联网；
  dist 产物模式没有源码文件，退化为对产物文件本身取 hash，并把依据（`src-files` /
  `dist-artifact`）写进 run snapshot，避免把「加载方式不同」误报成「代码变了」。
- **如何收紧**：构建期把源码 hash 注入产物（`--define` 或生成常量）后删除运行时读取，
  core 回到零 IO；`codeIdentitySource` 继续保留，用于区分历史 run。

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

core 定义 repository Interface，db 提供 Drizzle 与 in-memory 两个 Adapter，并用同一组
contract tests 验证行为。普通读取通过实体 repository；跨实体原子写入使用已有 Ledger、Analysis、
DecisionReview 等事务契约，不在调用者拼接多次 save 代替原子提交。

账户反馈的权威写入是 DecisionReviewRevision；旧 AdviceOutcome 只保留兼容投影，见 §6.4。

### 4.4 Tool（tools 包）

每个 tool 通过 `defineTool` 声明稳定名字、描述、副作用、输入/输出 Zod schema 与 handler；
跨能力操作同时声明 `requiredCapabilities`。handler 使用注入的 ToolContext 读取 repository 或
Adapter，调用者始终收到 `ToolResult`。实际 schema 以对应 tool 源码为准，本文不复制字段快照。
例如 `list_holdings` 只读已落库持仓与报价，刷新行情须显式调用 external 工具；缺价格不填零。

### 4.5 Tool Registry

`packages/tools/src/registry.ts` 保存领域 tool 库存，workflow-only 工具单独装配；
批处理 `run_*` 不进入该 registry。插件描述与输入契约从已有 schema 派生，allowlist 与
Operation policy 决定当前可达范围。schema 派生能力不表示已恢复 MCP server。

**一次定义，多处消费**。修改 schema 时同步验证描述、policy 与实际调用，不维护另一份手写契约。

### 4.6 Workflow（workflows 包）

`defineWorkflow` 声明输入 schema 与有序步骤。例如 `daily-review` 读取已有建议、账户反馈统计
和连板天梯，再输出确定性事实；外部缺口显式保留，不临时让模型补齐。各 workflow 的完整输入
与结果以其源码 schema 为准，当前可触发的批处理入口见 `packages/batch` 和插件 policies。

Workflow 通过 `ctx.tools.xxx.execute()` 调用 tool，**不允许直接调 repository 或 adapter**。写建议统一走 `record_advice`（分析队列写入路径），不绕过层级。步骤返回 `ToolResult` error 会短路整条 workflow；步骤抛 `InvariantError` 归为 `invariant_violation`，其它异常归为 `internal`，`run` 永不外抛。

策略相关 workflow：

- `run-strategy-schedules` 原子抢占到期 `StrategySchedule`，再调用 `run_strategy`；调度租约负责
  多实例 tick 防重，`strategyId + strategyVersionId` 运行租约同时覆盖手工与自动正式运行。
  运行提交后只产出 facts-only 的 `preflight` 摘要与 `adviceCount`，仓内不再生成 Advice；
- `complete-strategy-observations` 先通过 tool 同步 qfq 日线，再通过 tool 补齐到期的
  SignalObservation。样本未到期保持 pending，不阻塞其他样本。
- 候选建议由 DSH 交互分析实例经 `record_advice` 写入（见 §6.3）；仓内已无
  `strategy-recommendations` workflow 与 `analyze_strategy_candidate` tool。

`strategy-daily-cycle` 等编排由 DSH 定时任务经精确 `run_*` 批处理入口触发，luoome 不再运行
进程内常驻调度器。宿主确认真实日程投递与任务授权后直接执行批处理，不依赖模型决定是否调用工具。
观察补全仍可作为幂等补偿执行；所有 workflow 只通过 tool 编排。分析或通知失败不回滚已原子
提交的 StrategyRun，也不触发交易。

**2026-08-14 可靠性状态**：publication、heartbeat + fencing token、`strategy-daily-cycle`、
WorkflowRun 阶段审计与 `get_strategy_reliability_summary` 已落地；汇总会阻塞 schedule/交易日重复
运行并输出阶段 P50/P95/max。跨交易日生产证据和真实全市场性能预算继续属于 Roadmap 的运营观测，
不能把设计目标误报为已验收事实，也不设置固定交易日数量门禁。

**MVP 2.0 盘后/盘中切片**：`strategy-daily-cycle` 一次 tick 会领取全部到期 schedule（调用方的
`limit` 只决定首批，剩余继续 drain）。交易日 16:30 后按账户及当日已发布策略运行指纹领取
`account-plan-batch`，批次身份还包含账户账本摘要；持仓或现金变化后旧批次不能充当当前账户结果。
批次执行 `trading-plan-daily-cycle` 并持久化完成、部分或阻断状态。领取与结束
均使用原子操作及令牌校验；超时运行被收敛后可重试。`closing-report-cutoff` 由独立 DSH
任务触发并读取持久化批次状态，避免长批次阻塞就绪检查。当日预期策略均有已发布正式运行、
日循环领取已结束、全部账户计划批次完成或部分完成后统一出报；未来仍有预期运行、策略分析
仍在进行或账户批次阻断时继续等待，18:00 也不发布未完成批次的缺口版。没有当日预期策略时，
在 18:00 后完成账户计划再出报。历史日期未留存主报告的补记单独披露历史快照缺失，不用当前事实替代。
同一日期、同一范围只保存一份收盘报告；重复调用与投递重试复用原报告，后到结果和账本变化
不追加收盘补充版，也不改写原正文。周报复盘补充版按 §6.4 的独立契约处理。
盘中账户计划由 DSH 的 `run_intraday_plan_batch` 触发，各账户经
`intraday-trading-plan-watch` workflow 和共享预警租约求值、复查与投递。午休、闭市或
非交易日由工具和 workflow 的时段门槛跳过；停机期间不新建执行轮次。
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
- 指数行情严格区分 `realtime-index` 与 `delayed-index`；日线型或缺少可信行情时间的指数数据不能进入实时接口
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
方法委托。插件组装根先创建一次实例，再经各 factory 的 `deps.sources.eastmoney`
分发共享；插件行情源热更新只改来源顺序时复用同一实例，仅重建 market manager 与直接依赖
market 的 sentiment manager。单机行情设置经插件写入 `$LUOOME_HOME/.env` 的允许键，
替换当前共享行情栈；不再依赖旧 Web 的 `operator/market.env` 或跨进程 worker 同步。

`MarketDataManager` 构造时必须传入 `MarketSourceRegistry`，不存在接受 provider 宽接口的兼容
构造路径，也不得在 Registry 之外临时实例化隐藏来源。新增或替换来源时，在
composition root 将 adapter 的实际能力绑定到 Registry；tool、workflow 和 surface 不改。

当前插件通过共享 adapter 装配调用
`createMarketAdapterFromEnv`（adapters/market/factory.ts）；历史 CLI/TUI/Web 组装根已删除。`LUOOME_MARKET_PROVIDER`
必须显式设为 `real`；`LUOOME_MARKET_SOURCES` 用逗号分隔、从左到右定义最多三个
启用源及各 capability 的尝试优先级，可选
`eastmoney`、`sina`、`tencent`、`fuyao`、`xueqiu`。未配置时默认 Eastmoney → Tencent → Sina。
显式启用 fuyao 时必须配置 `FUYAO_API_KEY`（`FUYAO_BASE_URL` 可选，缺省
`https://fuyao.aicubes.cn`），非法配置在启动期抛错。Tushare 已下线，不再是可配置来源；
存量历史事实中的来源字符串保持只读兼容。
详见 [fuyao-market-adapter-design](./ddd/fuyao-market-adapter-design.md)。
雪球仅绑定沪深个股 `quote` 与 `daily-bars`，日 K 固定使用上游 `type=before` 前复权口径，按列名解析并向过去分页；成交量原本以股计，不再乘 100。访客 cookie 仅保存在适配器内存中，首次请求自动建立，会话失效最多重建一次；失败经既有 registry 降级并记录来源状态。报价保留上游交易时间，缺失时明确标记 retrieval。没有批量报价、全市场快照、指数、搜索或分时绑定。
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

插件通过 `/api/luoome/settings/market` 返回数据源启用状态、优先级和配置就绪状态，
不回显密钥。写入经 owner 与同源 Origin 校验，先验证候选 adapter，再将允许的行情键原子
写入权限为 `0600` 的 `$LUOOME_HOME/.env` 并替换当前 ToolContext。只改来源顺序时复用
进程级共享 SourceSet，不产生第二个 EastmoneySource 实例，无关 manager 的缓存不清空。
精确允许键与设置契约见文末插件装配说明。

模型推理与模型配置都由 DSH 承担：luoome 侧没有模型运行时包，没有模型设置页，也没有
`/api/settings/ai` 与运行时热替换。交互判断由 DSH 会话承担；可选后台分析和 GoalRun 的插件
Adapter 使用宿主模型服务，领域层只接收结构化结果并校验、保存。模型配置和凭据归 DSH。

独立 Web 的模型对话、草案确认 HTTP 端点和账户切换入口已退役。保留的 `ChatSession` /
`ChatMessage` / `ChatRepository` 及其 memory、Drizzle 实现属于未暴露的历史能力，不构成
当前插件聊天系统。会话与消息由 DSH 宿主承载；业务写入由插件精确 Operation policy 按用户
明确意图执行，prepare 冻结输入后直接 confirm，保留幂等与业务回执，不要求面板二次确认。
用户文本中的“已执行”不作为业务回执。多个 Watchlist 成员复用 `add_watchlist_members`
原子写入，不复制成员处理逻辑。

DSH 接入有两条路径，默认部署只保留第一条：

1. **独立 DSH 部署（默认，纯插件形态）**：DSH 用 Node 加载 `dsh-luoome` 插件——host 提供原生只读 /
   market external / 个人直接执行写面，client 提供看盘、持仓、关注、策略、复盘五块面板，随包 skills 提供投研技能；事实库是
   Node SQLite 的 `$LUOOME_HOME/luoome.db`。运行期不需要 Bun、MCP server、旧 Bun Web、
   analysis worker 或 queue probe。部署入口见 [宿主机直部署](../deploy/direct/luoome-dsh.service)，
   容器栈保留为整栈回退方案。
2. ~~旧「当前 MCP 过渡形态」~~（已删除）：Web profile 的四个 MCP 实例（只读面 `luoome` /
   设置面 `luoome-settings` / 分析面 `luoome-analysis` / 批处理面 `luoome-batch`）、三个旧 DSH
   插件与手动 worker 随 REQ-M2-03 一起下线；`packages/mcp` 与 `luoome mcp serve` 已删除，
   暴露面判定保留在 `packages/tools/src/exposure/`。
3. ~~内嵌 DSH Host~~（已随托管形态下线）：原 `apps/agent-runtime` 的内嵌 Host 路径与 hosted ledger 计量一并删除。

批处理调度归 DSH 定时任务：真实投递落库后，插件通过 `executeScheduled` 直接调用原生
批处理入口，并核对任务定义指纹、账户、精确参数与持久授权。业务执行不依赖模型工具调用；
当前宿主仍可唤醒会话，但业务门槛由工具判断，非交易日/非盘中时段返回 `skipped`。
luoome 不运行常驻调度进程，批处理和自动写入默认关闭。
交互式分析经插件 `record_*` Operation 直接写回，不创建 `analysis_job`；队列有完整执行实现，
普通后台分析需显式配置 `analysisModel`，默认插件没有入队生产入口和常驻消费者。
生产服务器已于 2026-10-25 切到纯插件形态；旧 MCP 用户入口源码已删除，Bun 用于构建与测试。

投资工作区仍由领域 tools 区分事实摘要、方向研究、共识与实际跟踪；当前入口是 DSH 会话与
插件面板。旧独立 Web 的 `/api/workspace`、`/api/workspace/drafts` 与
`/api/watch/notifications/:triggerId` 已随 `apps/web` 删除，不是当前 HTTP 契约。
结构化共识与来源校验继续由 tools 负责，历史提醒不作为当前行动许可。历史首页设计及迁移范围见
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

`ctx` 是唯一被允许注入依赖的方式。**领域层不注入模型 SDK**：`ToolContext` 没有 LLM / Agent
实例；可选 `jobRunner`、`analysisRunner`、`goalRoundRunner` 等执行 Interface 由插件的宿主 Adapter
装配，实际模型请求仍经 DSH。交互结果直接写回，可选队列执行见 §6.3。各 manager 缺失时对应能力
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
`realtime-index` 与 `delayed-index` 分路，延时指数不会通过隐藏旁路进入实时接口。`get_market_data_status` 从 Registry、股票目录 checkpoint 和连板天梯显式来源动态
生成数据集状态，不维护固定 provider 常量。

**v0.7 起新增**：`luoomeHome()` 路径工具（当时从 CLI 的 context 抽出，被 watch / holidays / future paths 共享；该 CLI 包已随 T15 删除，实现归位到 core）；节假日历支持文件加载（`holidays.ts` 新增 `parseHolidayObject` / `loadHolidaysFromFile` / `defaultHolidaysFilePath`），三层优先级 union 合并：内置 < 文件 < env。

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
`set_report_delivery_status` 为 write，属 workflow 内部 tool，不进公共 registry。当前插件报告读取与导出复用领域能力，
不复制 partial 判定或 renderer；旧独立 Web 报告页面已退役。详细设计见
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
当前审计由插件获准的 `get_closing_batch_audit` 读取；旧 Web `/api/reports/closing-audit` 已退役。
历史预期账户从当前清单及留存的批次/报告推断，已删除且无留痕的账户无法据此恢复。
当前通过 DSH 插件的精确批处理入口触发，沿用 owner、参数范围和执行授权校验；
旧 CLI 命令与独立 Web `/api/reports/run/:kind` 已退役。

**Strategy 研究事实**：指标快照可包含最新价、动量、均线与 Bollinger 字段。规则求值的
unknown/error、evidence 与 dataAsOf 必须保存在 StrategyResult；Signal 只表达事实，
不表示胜率、Advice 或交易。StrategyRun 的执行状态与数据完整度分离：新运行只写
`running / complete / failed`，其中 `complete` 表示结果包已原子提交；Summary V4 通过
`dataHealth=complete / partial / unavailable`、evaluated/incomplete/failed 计数描述覆盖质量，
并由 acceptance 与 `publication=published/withheld/non-publishing` 独立决定是否进入生产视图。
正式运行取得 lease 后先写入可查询的 `running` 记录，终态与 results/signals 在同一事务中更新；
意外异常也会把该记录收敛为 `failed`。
旧 `status=partial` 记录继续可读，并按“执行完成、数据部分可用”参与当前结果视图。

### Strategy 内部运行视图与兼容契约

这些 Module 为 Strategy 提供运行、审计与读取契约，不是新增用户必配对象，也不新增持久化
业务生命周期。调用者复用以下 Interface，避免在各 surface 重复解释原始记录：

| Module | 当前 Implementation 与调用纪律 |
|---|---|
| `StrategyDailyCycleAudit` | `strategy-daily-cycle` WorkflowRun 的稳定投影。v1 显式记录版本、Strategy/Schedule 归属与 `dataAsOf`；无版本旧记录通过同一解码入口只读兼容。按 Strategy、Schedule 或 `dataAsOf` 查询时先确定归属与时间范围，再截取数量，避免其它策略的新运行挤掉目标审计。 |
| `StrategyEvaluationData` | Live Adapter 服务实时 scan；Checkpoint Adapter 服务 scheduled/replay，只读本地 checkpoint 或 PIT revision。两者共享同一 Interface，逐股 quote/daily-bars、重试和 provider coverage 的知识集中于此，`run_strategy` 不再重复模式分支。 |
| `StrategyRunSnapshot` | 不可变输入身份当前写入 V3；V2 与任意旧对象只经统一 Compatibility Module 读取。evaluator identity、`requestedBy`、`evaluationSessionId`、universe 与 data checkpoint 不由调用者探测原始 key。 |
| `StrategyObservationEvidence` | 批量核验 run → signal → observation 的 Strategy/version/stock/horizon 归属，按 stock-day-horizon 去重，显式返回 `expected`、`missing`、`truncated` 与 `limitations`。只消费 ACTIVE T+1/T+3/T+5；存量 T+20 不进入事实链。 |
| `StrategyRunTimeline` | 工作台、运行比较与洞察共用的只读视图，一次装载 run/version/results，统一选择当前 published operational run、上一基准和最近尝试。它不是新持久化实体，也不改变 publication 规则。 |

正式信号沿跟踪事件求值：entry 面向最终入选股票，exit/risk 面向当前入选与该版本此前仍在跟踪
的股票；退出条件成立后结束跟踪。持续命中仅在首次命中或恢复后再次命中时产生事件，并遵守冷却。
触发前态与最近事件时间独立于可裁剪的 StrategyResult 保存，与运行事实原子提交；operational
与各 evaluation session 隔离，试跑和未发布运行不改正式前态。仅有有效跟踪事件范围标记的信号
创建 T+1/T+3/T+5 观察。明细清理不改写当时计数、建议快照与引用，读取区分当时产出与当前留存。

StrategyRun 新写入只用 `running/complete/failed`，旧 `partial` 仅作读取兼容，表示执行完成且数据
部分可用；数据健康、acceptance 与 publication 分别表达，不混成执行状态。AI 可以提出候选策略，
冻结版本后的历史匹配与收益计算由确定性引擎完成。自治发布须通过现有历史验证门禁；历史样本要求
不等于提议后强制等待 20 个交易日。自动批处理仍须显式开启并具备对应任务授权。

这些真实 Adapter 和统一读取路径提供 Locality：历史兼容、输入身份与证据校验各有一处权威实现。
历史独立 Web 工作台的页面拆分不构成当前插件入口；当前研究工作台契约见文末。

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

**当前形态**：领域层不自行请求生成式模型，插件调用 DSH 宿主服务；研究 embedding 例外见 §3。
推理由 DSH 宿主承担：交互式分析经插件精确 `record_*` Operation 直接写回；可选后台分析
通过宿主执行 Interface 运行并沿队列事务提交（见 §6.3）。领域包负责确定性事实计算、校验与状态读写。

### 6.1 数据层

来源：
- **行情**：实时报价、日线、技术指标（多源交叉）
- **基本面**：当前财务快照与实验 strict PIT 事实分别披露，当前快照不进入生产基本面评分
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

仓内不再有 `analyze_stock` 这类内置推理 tool。当前交互主线是：插件
`get_analysis_context` 保存冻结事实包 → DSH 会话推理 → 精确 `record_advice` /
`record_analysis_result` Operation 校验并写回。该路径不创建 `analysis_job`，也不依赖 worker。

`AnalysisJob` 是已经实现的可选租约执行能力。受信任配置显式提供 `analysisModel`，或成对设置
`LUOOME_ANALYSIS_PROVIDER` / `LUOOME_ANALYSIS_MODEL`，插件才注入普通后台分析 Adapter；
模型与凭据由 DSH 管理。内部 `enqueue_analysis_job` 在有 JobRunner 时可启动宿主后台任务，
完成事实装配、认领、分析与原子写回；缺少分析器时明确失败，不伪装完成。
默认插件不暴露入队工具，生产 workflow 没有入队调用，也不运行常驻消费者；显式配置模型不增加
模型可见的生产者。手动队列验收通过现存工具与测试装配，已删除的 MCP 实例不是验收前提。

`GoalRun` 另有已接入的 `start_goal_run` / `get_goal_run` / `cancel_goal_run` 入口：显式请求
冻结目标、事实范围、DSH 模型路由与轮次/时间/token 预算，宿主 JobRunner 执行有界研究。
每轮取得持久化 AnalysisContext，单次修订复用同一快照；合法事实引用与结构校验通过的输出才算成果。
进度用 CAS 防止迟到提交覆盖取消，重启后保留审计而不自动重放请求。`completed` 表示目标结论通过
校验；缺事实、时间或轮次耗尽为带具体条件的 `blocked`，依赖失败为 `failed`，取消保留已有产出。
模型请求经 DSH `llm.stream`，不带工具权限；研究结果不自动写成 Advice、Strategy 或 Trade。

以下是领域工具清单；是否暴露由插件精确 allowlist/policy 决定，注册不等于默认可调用：

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

两条写回路径共用事实校验与持久化实现：

```txt
交互：get_analysis_context → DSH 推理 → record_advice / record_analysis_result
队列：内部 enqueue → 宿主任务或显式消费者 → claim + context → DSH 推理
                                                  → complete_analysis_job
```

事实包过期时（`complete` 返回 `context_expired` / `stale_context`），消费者重新取事实包，
再用 `claim_analysis_jobs({ owner, refresh: { jobId, claimToken, contextId } })` 刷新一次绑定；
旧快照仍可审计但不能写回，同一有效租约只允许刷新一次。租约保证同一 job 只被一个消费者
完成；租约超时的 job 被回收后可重新认领。

**这套机制的边界**（`missingFacts` 与 `contextHash`）：

> hash 与完整性 checker 防的是「已有 context 的缺口被事后删除或篡改」；
> 它们不保证「缺口一定被发现」——若 context 生成阶段本身就没识别出缺口，
> 下游无从得知。后者需要生成侧的事实对账，不在本机制范围内。

写回路径的校验（`packages/tools/src/queue/record.ts`）：

- 事实包必须存在且 `kind` 以 `advice_` 开头，否则 `context_mismatch`
- `contextHash` 必须与事实包一致，否则 `context_mismatch`。口径有版本（`ANALYSIS_CONTEXT_HASH_VERSION`）：
  **v1** 只覆盖 `{ facts, dataAsOf }`；**v2** 追加 `missingFacts`。校验侧用
  `analysisContextHashMatches` 按口径重算比对（先 v2 再 v1），因此历史 context 不会被误判，
  而 `missingFacts` 的增删改**会改变 hash**——它是 P8 的判断输入（`unavailable` 必须阻断），
  必须受 hash 保护，否则删掉一条 blocking 缺口就能绕过门禁而 hash 不变。
- `provenance.evidenceFactIds` 必须全部落在事实包的 `factIds` 内，否则 `unknown_fact_reference`
- `checkAnalysisReportCompleteness` 做**完整性**对账：事实包里的每条 blocking 缺口，报告必须用
  `provenance.acknowledgedMissingFacts` 按 **(kind, subjectId) 配对**逐条声明，否则
  `omitted-blocking-missing-fact`（带具体 kind 与 subjectId）。只对 `advice_*` 生效——研究类报告
  允许在缺行情时产出，套这条会挡住合法研究。
- 错误优先级是产品语义：引用错误 → 时序错误 → 完整性错误。完整性检查因此**独立成函数**而不是
  并进 `checkAnalysisReportReferences`，避免"上下文已过期"被"缺口没声明"抢答。

### 分析事实包与写回时效

`AnalysisContext` 是带 `dataAsOf`、事实哈希与证据编号的冻结事实包；`writeUntil` 限制写回，
`expiresAt` 表示审计保留期限。过期事实包仍可按 ID 审计读取，不能据此继续写回；取新事实包
不等于沿用旧结论。交互事实包 `jobId=null`，队列绑定则必须遵守有效 claim token。

写回时效按 `kind` 取 `packages/core/src/entity/analysis-context.ts` 的 `analysisTimingRules`。
`analysisContextTiming` / `analysisContextTimingError` 是装配、入队、写回、刷新共用的唯一规则实现：

| kind | `ruleVersion` | `writeUntil` | `dataAsOf` 过期 |
|---|---|---|---|
| `advice_stock` / `advice_position` / `advice_strategy_candidate` | `intraday-action-v1` | `min(现在+30 分钟, 当日 15:00 Asia/Shanghai)` | 超过 30 分钟 |
| `advice_market` | `market-analysis-same-day-v1` | `min(现在+24 小时, dataAsOf 的上海自然日次日 00:00)` | 超过 `dataAsOf` 的上海自然日（次日 00:00） |
| `advice_strategy_candidate_after_close` | `after-close-strategy-v1` | `min(现在+24 小时, dataAsOf+7 天)` | 超过 7 天 |
| `research_directions` / `strategy_version_proposal` / `strategy_insight_narrative` | `research-analysis-30d-v1` | `min(现在+24 小时, dataAsOf+30 天)` | 超过 30 天 |

超过 `writeUntil` / `expiresAt` → `context_expired`；超过该 kind 的数据有效期 → `stale_context`。
15:00 截断只适用于盘中行动类，盘后策略候选与策略研究不被当日收盘截断。

市场级（`advice_market`）自 REQ-M3-20 起按 **Asia/Shanghai 自然日**判定，用显式 `sameDayOnly`
表达，不用固定毫秒数近似。跨日市场事实不进可用事实，`missingFacts` 留下 blocking 原因码
`market-advice-same-day-only`（context 披露 `unavailable`），写回返回 `stale_context`。
市场级判断引用须带 `observedAt`；当日 15:00 之后或非当日的观察由 `classifyMarketObservation`
标为「历史观察」，保留可读但不作为当前建议依据。规则带 `ruleVersion`，context 带
`timingRuleVersion`；旧 context 仍可审计，但不能复活为今日依据。

其它 Advice 写回约束继续由领域工具执行：

- `AdviceSchema.parse` 校验结构，`disclaimers` 由工具填入 `STANDARD_DISCLAIMERS`
- `reasoning`（premise / evidence / counterEvidence）与 `risks` 逐条过 prompt-injection 文本清理，
  命中模式的片段替换为 `[redacted]`（`packages/tools/src/internal/sanitize-advice.ts`）
- `validUntil` 由工具按 horizon 计算：intraday 取当日 15:00，其余取 `adviceExpiryDays[horizon]` 个交易日

完成 AnalysisJob 与保存 Advice、研究工作区、待审批策略版本或叙事结果须在同一事务提交；
重试不重复发布，死信保留错误。`AnalysisProvenance` 记录生成器、模型、技能版本、事实包和任务来源；
`legacy-ai` 仅表示迁移前缺完整来源的历史建议，不推断已知模型。策略提案仍需原有发布流程。

市场分析的个人范围仅含指定账户有效持仓与全局启用 Watchlist；其它账户持仓和未关注事件股票
不扩大范围。外部即时指数、情绪与新闻只有被持久化并纳入事实包后，才能宣称为 Advice 的冻结依据；
聊天刷新本身不构成写回证据。实时外部事实的持久化引用还须通过 `externalMarketFact` 存在性检查。

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
工具与操作 policy 复用同一解析逻辑，policy 在执行前读取基准修订并冻结完整内容，最终写入仍用
contextHash / expectedRevision 做校验；重放也按原基准补齐，不随当前修订变化。Core 的部分更新
schema 与完整存储 schema 分开，合并函数无 IO；policy 的异步 bind 仍在 tools 层读取仓储。
`save_decision_review` 校验成功后追加修订；
`record_decision_trade` 登记系统外已完成但尚未入账的成交，事务内同时保存 Trade、Holding、
Account.cashBalance、所选来源修订和请求回执。该路径只允许对账可用账本的顺序追加，
不调用券商，sideEffect 为 trade，任何暴露面都不暴露。

写请求由 `accountId + requestId` 标识：同键同内容返回已保存回执，同键异内容拒绝；
账本、来源或修订已变化时要求刷新确认，任一提交失败不得留下部分成交或关联。
当前复盘写入由插件精确 Operation policy 绑定 owner 账户并保存请求回执；丢失响应后先核对回执，
避免重复入账。旧 Web 的复盘、专用成交录入和补充报告端点已退役，不构成 trade 暴露例外。
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

| 等级 | tool 例 | 当前插件准入 |
|---|---|---|
| `read` | `list_holdings`, `get_advice` | 精确 read allowlist；不因在 registry 中就自动暴露 |
| `write` | `add_holding`, `add_trade` | 精确 Operation policy，按明确意图执行并保留回执 |
| `external` | `fetch_quote`, `send_notification` | market allowlist 或精确 Operation policy，组合能力逐项校验 |
| `queue` | `record_advice`, `complete_analysis_job` | 交互 `record_*` 有精确 policy；claim/complete/fail 管理工具默认不暴露 |
| `trade` | `record_decision_trade` | 永不经插件原生工具、HTTP 或其它远端面暴露 |

`selectExposedTools` 同时过滤 `sideEffect=trade` 与 `requiredCapabilities` 含 `trade` 的工具。
`LUOOME_EXPOSE_TRADE=true` 在任何业务 IO 前使插件启动失败。独立 CLI/TUI 已删除，
没有可绕过当前暴露规则的操作员命令入口。个人写入的幂等与授权协议见「纯插件执行与授权内核」。

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
- `closing-report-cutoff`：核对策略与账户批次就绪状态，全部预期批次完成后统一发布；18:00 不强行发布未完成批次的缺口报告
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
  插件面板根据服务端投影显示当前计划和历史，不复制版本选择与过期规则。
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
  报告正文的行动词禁令（REQ-M3-08）覆盖 `text` 块与 `list` 的 `title`/`detail`，并对 `table` / `metrics`
  逐字段检查：列名与 `metrics.label` 永远是报告自撰文本，**一律检查**；单元格与指标值只在**字段键**
  命中 `REPORT_FACTUAL_FIELD_KEYS` 时豁免。白名单当前只有 `side`（已发生成交的方向，`Trade.side` 的
  事实转述），每条必须带非空理由（`assertFactualFieldReasons` 强制），不许通配、不许按文本嗅探、
  不许因为「这段是成交表」整块跳过。这是对 PRD 字面正则的**收窄**：成交明细表里的「买入/卖出」是
  账本事实而不是指令，禁掉它等于让用户看不到自己的成交记录。含成交事实字段时，正文追加一句
  「以下为已发生成交的记录，不是建议。」（`REPORT_FACTUAL_TABLE_NOTE`，由内容派生、不常驻，且自身过守卫）。
  新增豁免键时必须同时回答「为什么这是事实而不是指令」，否则白名单测试会红。
  `render_report(format=notification)` 从结构化报告生成有长度预算的移动摘要，不截取完整 Markdown；
  `markdown/plain-text` 继续保留完整证据。列表可保存 `notificationSummary` 作为生成时的阅读投影，
  旧报告缺少该字段时仅提供核对入口，不从长文本猜测交易结论。飞书适配器只在卡头展示标题。
  通知板块采用显式允许列表，仅包含市场、策略研究、预警和事件；账户估值/仓位/交易计划、交易归因、
  个人行为与混合数据质量板块留在完整报告，私有板块缺口不参与通知告警。存量建议摘要去除目标仓位行。
  正文空指标聚合说明，全空表格列省略，诊断缺口去重后集中展示；结构化快照保留原始 null 和缺失原因。
  单日账户绩效向前取一个交易日作为收益基点；未配置基准不输出空指标，多账户 TWR/回撤不做算术聚合。
  情绪指数按请求交易日逐条筛选，混合日期仅使该维度 partial，不丢弃同日行情；空返回仍为 unavailable。
  规则兜底标记（`RULE_FALLBACK_EVIDENCE_MARKER`，以及 premise 侧的内联字面量「LLM 推理不可用」）
  只用于识别存量数据：`isRuleFallbackAdvice` 按 **premise 或 evidence 任一命中**判定，命中的建议
  不是模型研究结论，通知中合并提示且不形成交易判断。规则兜底生成路径已删除，标记只读不写。
- **Phase 2/3 已实施**：连板天梯联动 workflow —— `daily-review` 通过
  `limit_up_ladder` 与 `limit_up_ladder_compare` tool 消费结构化事实，报告、行情和研究视图复用同一
  日期/股票快照；Strategy scan/scheduled 另写 PIT 快照，replay 只读历史表（设计：[docs/ddd/limit-up-ladder-detailed-design.md](./ddd/limit-up-ladder-detailed-design.md)）。

### 8.1.1 提醒要素矩阵（REQ-M3-09 §5）

PRD §5 要求「提醒消息必须含触发价、止损/目标价、反证、风险、有效期、卖出限制」，缺任一项则不投递。
但这六项里有三项（止损/目标价、有效期、卖出限制）**本质是 plan 层概念**：若要求每条提醒都有它们，
就必须同时要求「每条提醒都关联一个 `TradingPlan`」——而 PRD 没有这条要求，`AlertPlan` 里也
**没有任何指向 `TradingPlan` 的字段**（`alertPlan.ts` 的 `AlertPlanSchema` 只有 watchlist / rules /
送达策略）。字面读法与数据模型矛盾，因此按**两类提醒**执行（实现对：`workflows/src/internal/reminder-elements.ts`）：

| 类型 | 何时 | 判定依据 | 要素 |
|---|---|---|---|
| `planned` 计划型 | `intraday-trading-plan-watch`，关联 active `TradingPlan` | 计划 + 触发行情 | **六项全要**；缺任一 → 不投递 |
| `threshold` 阈值型 | `intraday-watch`（AlertPlan 盘中），无 plan | `WatchTrigger.quote.close` | 触发价必须有；计划五项 **`not-applicable`** |
| `event` 事件型 | `evaluate-event-rules`（事件日期），无 plan | 事件本身（`eventKind` + `occursAt` + `remindDay`） | 触发条件即事件；计划五项（含触发价）**`not-applicable`** |

**要素的四种状态**（`present` / `empty` / `absent` / `not-applicable`）必须分开：
`empty` 是「字段在但值为空」，`absent` 是「字段不存在」，`not-applicable` 是「这类提醒本就不该有」。
三者都不等于「填了 0 / 填了 false」——`stopLoss: 0` 是 `present`。
`missingElements` 只装 `empty` / `absent`；`notApplicableElements` 另计。

**不适用必须被说出来**：阈值型与事件型的投递正文末尾必须追加
`NON_PLAN_DISCLOSURE`，原文为：

> 这是价格/事件提醒，不含止损、反证、风险、有效期与卖出限制——它不是建议。

**缺口留痕与计数**：判为不投递的触发记 `deliveryStatus='not-requested'`，并把
`reminderType` / `reminderElements` / `missingElements` / `missingElementReasons` /
`notApplicableElements` 写进 `evalSnapshot`（附加式，无 schema 变更）。
`not-requested` 是**终态**——重跑评估不会把它重新算成待投递。
`list_watch_triggers(includeSummary=true)` 的 `summary.reminderGaps` 把
`missingElements`（真正没投出去的）与 `notApplicableElements`（都发出去了的）**分开计数**，
避免用户把「不适用」误读成「提醒失败」。

> **这是对 PRD §5 字面适用范围的收窄。** PRD 正文仍写「提醒消息必须含六要素」，本矩阵把
> §5 限定为**关联计划**的提醒；阈值型/事件型按「触发条件 + 依据来源 + 观察时点」判定，
> 并以可见披露替代计划五项。PRD 是否同步改写由需求负责人决定。

### 8.2 Workflow 与 tool 的边界

| | Tool | Workflow |
|---|---|---|
| 粒度 | 原子 | 组合 |
| 可独立暴露给远端面 | 按暴露策略 | Workflow 对象不直接暴露；可提供精确 batch 入口 |
| 可被 agent 编排 | 按准入调用 | 经插件精确 `run_*` 调用既定编排，不开放任意 workflow 执行 |
| 可手动触发 | ✅ | ✅ |
| 必须有 Zod schema | ✅ | ✅ |
| 必须可测试 | ✅ | ✅ |

### 8.3 模型推理不在 workflow 内

DSH 瘦身（docs/ddd/luoome-dsh-transformation-detailed-design.md）后，仓内 workflow **不含模型推理步骤**：
领域包不导入生成式模型 SDK，`ToolContext` 不持有 LLM 实例；研究 embedding 的受控例外见 §3。
需要模型结论时，由 DSH 会话直接经 `record_advice` / `record_analysis_result` 写回，或由插件的
可选宿主执行 Adapter 沿队列提交（§6.3）。默认插件没有队列生产入口与常驻消费者，workflow
只消费已落库事实和 Advice，不自行向模型供应商发请求。

因此 workflow 步骤的约束是：
- 输入是结构化数据（不是字符串拼接）
- 只经 `ctx.tools.*.execute()` 取事实与写入，不直接访问 repository / adapter
- 步骤返回 `ToolResult` error 即短路；抛 `InvariantError` 归 `invariant_violation`，其它异常归 `internal`

## 9. 暴露面判定（原 MCP Server 章节，stdio 入口已下线）

> **已下线（REQ-M2-03 / T13）**：`packages/mcp`、`luoome mcp serve` 与四个 MCP 实例已删除，
> `deploy/dsh/mcp-tool-probe.ts` 一并移除。本节的规则本身仍然生效，但唯一实现已归位到
> `packages/tools/src/exposure/judge.ts`，由 DSH 插件的 read/market surface 消费；
> 交互分析写回契约迁到 `packages/dsh-luoome/src/host/analysis-surface.contract.e2e.test.ts`。

### 9.1 传输（历史）

v0.1 曾用 **stdio**（harness 默认），v0.3+ 规划 HTTP/SSE（远程、移动）。两条路径都随
stdio 入口一起下线；当前唯一的远端调用面是插件注册进 DSH ToolRuntime 的原生工具。

### 9.2 暴露策略

判定集中在 `packages/tools/src/exposure/judge.ts`，surface 只负责把配置解析成 criteria：

```ts
// packages/tools/src/exposure/judge.ts
export const judgeTool = (tool: JudgedTool, criteria: ExposureCriteria): ExposureVerdict => {
  if (declaresTrade(tool)) return { exposed: false, reason: 'trade' };
  if (!isNameAllowed(tool.name, criteria.allowlist))
    return { exposed: false, reason: 'not-in-allowlist' };
  if (isNameDenied(tool.name, criteria.denylist)) return { exposed: false, reason: 'denylisted' };
  if (!criteria.exposeResearch && isPrivateResearchTool(tool.name))
    return { exposed: false, reason: 'private-research' };
  if (!capabilitiesSatisfied(capabilitiesOf(tool), criteria.allowedSideEffects))
    return { exposed: false, reason: 'capability-not-allowed' };
  return { exposed: true };
};
```

read 默认暴露；write / external / queue 须显式 opt-in。trade 没有 opt-in 通道 ——
`LUOOME_EXPOSE_TRADE=true` 让插件在创建目录、打开事实库之前就启动失败
（`assertTradeNeverExposed`），trade 类工具同时被 `selectExposedTools` 按类型过滤掉
（`sideEffect === 'trade'` 或 `requiredCapabilities` 含 `'trade'` 都拒绝）。

surface 侧另有两层收窄：点名白名单（**显式空名单即 fail closed**）与拒绝清单；配置里出现
registry 不存在的工具名时 `assertSurfaceSelection` 直接拒绝装配，而不是静默过滤。私有研究类
tool（`privateResearchTools`）默认拒绝，需部署侧显式 opt-in 才放行。

### 9.3 命名

luoome 内部 snake_case，派生出的 MCP / OpenAI schema 同样 snake_case。**统一命名**，避免翻译层。

## 10. 多端消费

| 消费者 | 入口 | 暴露范围 |
|---|---|---|
| DSH 会话 | `dsh-luoome` 原生工具 + 精确 Operation policy | read/market allowlist；写入按明确意图与精确 policy；trade 永不 |
| DSH 插件面板与投资设置 | 官方 WebServer 的 `/api/luoome/*` 固定路由 | owner、Host/Origin、输入范围校验；共用领域 tools 与 Operation 回执 |
| DSH 定时任务 | `executeScheduled` + 精确批处理入口 | 默认关闭；启用后仍核对真实投递、任务指纹、档位与持久授权 |

独立 CLI/TUI、stdio MCP 与 `apps/web` 源码均已退役；目录内残留构建产物不代表现役 surface。
当前浏览器界面是插件的 client 面板，由 DSH 宿主提供传输与会话。

## 11. 数据流示例

### 场景 A：DSH 会话问"今天盈亏 + 已有建议"

```txt
[DSH agent]
      │  决策：调 get_account_facts + get_advice
      ▼
[dsh-luoome 工具] ───► toolRegistry
                    │
                    ├──► list_holdings (read)        ──► HoldingRepo ──► SQLite
                    ├──► get_account_facts (read)    ──► 现金 + 持仓市值 + 账本指纹
                    └──► get_advice (read)           ──► AdviceRepo ──► SQLite（已落库的建议）
                    │
                    ▼
[dsh-luoome 工具] ◄── { facts: {...}, advices: [Advice, ...] }
      │
      ▼
[DSH agent]  整合生成自然语言答复（保留反证、风险、免责声明、有效期）
```

插件 read 与 market external 使用独立精确 allowlist，环境开关不扩大名单；实时行情须经获准的
market 工具。以上只读查询返回已落库 Advice；需要新建议时另走 §6.3 的 DSH 分析与写回路径。

### 场景 B：TUI 看持仓与已有建议

本标题保留历史引用锚点，TUI 与 opentui 实现已退役。当前对应旅程由 DSH 插件持仓面板承担：

```txt
DSH client 面板 → 固定面板读计划 → list_holdings / get_advice → SQLite
               ← 估值、已有建议、事实时间与缺口 ← 领域 tools
```

client 只渲染服务端投影，不补算缺失价格或生成建议；实时刷新须另经获准的 market 工具。

### 场景 C：DSH 消费者处理待分析队列（手动/隔离验收链路）

```txt
显式测试/内部生产者 → enqueue_analysis_job → AnalysisJob
宿主 JobRunner 或显式消费者 → 装配 + claim → { job, claimToken, context }
                            → DSH 模型 → complete_analysis_job → 原子结果与终态
DSH 插件 → 读取已落库结果
```

事实包过期时显式消费者重新取事实包并用 `claim_analysis_jobs(refresh=...)` 刷新绑定；
有效 token 最多刷新一次，不延长租约。失租后旧执行者停止写回，超时任务可回收重领。
本场景描述保留的队列契约和可选执行实现；普通后台分析需显式 `analysisModel`，默认部署
没有生产者和常驻消费者，已删除的 `luoome-worker` / `luoome-analysis` MCP 实例不再是入口。
日常交互分析走插件 `record_*`，不创建 AnalysisJob。

### 11.1 同一语义的两处实现：有意不同清单（task-25 排查留痕）

> **本节的目的**：M3b 期间「同一语义两个实现」出现过多次，其中一部分是**刻意如此**。
> 本节逐条记录「为什么有意不同」与「各自的适用范围」——**不要因为看起来像 bug 就顺手统一**。
> 发现新的「同一语义两实现」时：先判断属于本节哪一类，不属于才动代码。
> 排查清单见 `output/dsh-brainstorm/review/t25-same-semantics-two-impls.md`。

#### 11.1.1 有意不同（9 项）

| # | 两个实现 | 为什么有意不同 | 适用范围 |
|---|---|---|---|
| 1 | **Advice 过期**（`packages/tools/src/internal/advice-selection.ts:44`，注入时钟 `ctx.clock()`） vs **TradingPlan 有效期**（`packages/workflows/src/intraday-trading-plan-watch.ts:605`） | 两种实体、两种写回纪律：Advice 的可用窗口由 core 时效规则决定（含当日 15:00 截断、当日口径），TradingPlan 的有效期是计划自身字段。合并会把两种时效纪律缠在一起 | Advice 侧只认 `selectAdvices`；TradingPlan 侧只认 `validFrom/validUntil`。**边界比较符（`>` vs `>=`）两处必须显式写，不许抽成「顺手」的共享函数** |
| 2 | **账户健康**：`get_account_facts`（账本完整性：`reconcileCashBalance` 的 `reconciled` 与 `gaps`） vs `get_portfolio_risk`（价格覆盖：`coverage.pricedCount` / `unpricedStockIds`） | 两个**独立维度**：账本是否自洽 ≠ 价格是否齐全。合并会让「手工录入持仓（无对应成交）」这类合法路径被整体打成 `unavailable`（误报） | 同一账户可能出现「facts 说 unavailable、risk 说 available」——这是**正常**，不是矛盾。两者各自在输出里披露自己的维度，**不做整体降级**（细则见下） |

| 3 | **报告写入口**：`save_report`（`packages/tools/src/internal/workflow-only-tools.ts:52`，**workflow-only，无 agent 面入口**） vs `write_report_artifact`（`packages/dsh-luoome/src/host/report-artifact-operations.ts`，**operation policy，模型可经 prepare/confirm 调用**） | **写库 = 改事实**，只能由 workflow 在算完全部事实后一次性提交；**写文件 = 产出交付物**，可由模型按用户明确意图触发。这是**刻意的不对称** | 想给模型「存报告」的能力时，不要顺手把 `save_report` 加进 policy——那会让模型可以不经事实装配直接写库。要交付文件就调 `write_report_artifact` |
| 4 | **交易日历**：core `previousTradingDate`（入参 `Date`） vs `opening-report.ts` 的 `previousTradingDay`（入参日期字符串） | 两个 Interface 的入参形式不同，日历 Implementation 已统一；workflow 通过 `previousTradingDate(shanghaiDate(date))` 薄包装调用 core | 日期字符串转换保留在调用处，交易日历规则只有 core 一份；新增调用继续复用，不另写周末/节假日循环 |
| 5 | **交易日键 vs 日历日**：`DailyBar.date` / `factDate`（UTC 午夜键，`packages/core/src/strategy/fact-date.ts:54`） vs `dateInShanghai`（用户可见日历日） | **必须不同**：bar 的日期是全仓约定（`tradingMidnight` = UTC 午夜），事实日和回测窗口都建在它上面；用户可见日期是 Asia/Shanghai 自然日。把两者统一会让已落库的 bar 日期整体错位 | 行情/事实/回测**一律用交易日键**；报告期、文件名、展示**一律用上海日**。判据是「这个日期会不会拿去和已落库的 bar 比对」 |
| 6 | **面板健康**：服务端 `PANEL_HEALTH_STATUSES`（`packages/dsh-luoome/src/host/panel-health.ts:14`：available/partial/unavailable + 原因码 + 聚合 asOf） vs client `HEALTH_LABEL`（`packages/dsh-luoome/src/client/projection.js:409`：数据健康 / 数据部分可用 / 数据不可用） | REQ-M3-09 Q1/Q5 裁定：**判定在服务端，client 只做措辞与配色**。client 不得自行推断可用性 | 服务端改三档语义时 client 措辞表要同步；**client 永远不允许出现「自己判断可用性」的代码**（判据只能读 `health.status`） |
| 7 | **建议五段 vs 报告六槽 vs 通知摘要**：`ADVICE_SEGMENTS`（5 段） / `REPORT_ENVELOPE_SLOTS`（6 槽）/ `report-notification.ts` 的 `notificationSections` 白名单 | **三者不是同一集合**，所以不是「抽一个常量三处引用」。① 六槽 = 五段 + `dataAsOf`（报告作为交付物多一个观测时点，代码里 `[...ADVICE_SEGMENTS, 'dataAsOf']`）；② 通知摘要选的是 **`Report.sections[].key`**（`market-pulse` / `strategy-actions` / …），与建议五段**完全不重叠**——把它并进五段是「把两套语义硬焊」 | 段名同源（通知兜底文案由 `ADVICE_SEGMENTS` + `segmentLabel()` 生成），**措辞可各自不同**。谁要新增「建议段」，改 `ADVICE_SEGMENTS` 一处；谁要新增「报告段」，改 `ReportSection.key` 与通知白名单两处 |
| 8 | **结果级可用性 vs 值级存在性**：`available/partial/insufficient/unavailable`（单项指标 / 面板 / 报告） vs `RuleInputFact.status = available\|missing`（`packages/core/src/entity/strategy.ts:526`） | `missing` 回答「**这条输入**有没有」，不是「**这份结果**能不能用」。粒度不同（值级 vs 结果级）、可缺性不同（值级没有 `partial`）、落盘与否不同（`missing` 进 `strategy_results.rule_evaluations_json`） | 新增「结果」用结果级词汇；新增「单条输入」用值级词汇。**不许把 `missing` 映射成 `unavailable`**——见下方反证 |
| 9 | **scope vs attributability**：`get_decision_loop_review` 的 `adviceBelongsToScope`（`packages/tools/src/tools/get-decision-loop-review.ts:179-183`：portfolio 主体的 `subjectId === accountId`，**天然在复盘范围内**） vs `get_advice_attribution` 的 `isAttributableSubjectKind`（`packages/tools/src/internal/advice-attribution.ts`：只认 `stock`/`position`，**能否算贡献度**） | **两个不同的问题**：前者问「这条建议属不属于本次复盘范围」，后者问「这条建议能不能产生贡献度」。`portfolio` 主体没有单一标的，回答不了「该建议贡献了多少」——但**它仍然属于该账户的复盘范围**。把后者当 scope 判据去删分支，等于让 portfolio 主体的建议从复盘范围里消失，是**功能退化**而不是口径统一 | **两工具的计数单位不同，不可对拍**：decision-loop 的 `attributionCounts.advice` 是**成交笔数**（`trades.filter(...)`），attribution 的 `totals.traded` 是**建议行数**。一条建议关联 5 笔成交 → 前者 +5、后者 +1。**这两个数不该相等**。要披露「有建议算不了贡献度」，用 `unattributableAdvice`（建议计数），不要动 `attributionCounts` |

**第 2 项的细则（REQ 共享维度，写成可执行规则）**

| 问题 | 结论 |
|---|---|
| **各自适用范围** | `get_account_facts` 回答「这个账户的现金/持仓能不能与成交、调整记录对上」→ 维度 = **账本完整性**；任一原因成立即整份 `status: 'unavailable'`（含 `reconciled === false`、`gaps.length > 0`、缺合格行情、现金为负）。`get_portfolio_risk` 回答「有多少持仓有可用报价、集中度能不能算」→ 维度 = **价格覆盖**；`pricedCount === 0` → `unavailable`，部分未定价 → `partial` |
| **为什么不能合并** | 手工录入持仓（无对应成交）在生产上是**合法路径**。把 reconciliation 接进 `get_portfolio_risk` 会把这类账户全打成 `unavailable`，属**误报**；反过来把价格覆盖接进 `get_account_facts` 会让「账本完全自洽、只是今天还没行情」的账户被说成「账本有问题」，也是误报 |
| **冲突时怎么办** | **两个独立维度各自披露，不做整体降级。** 两份输出都带一句固定声明（`ACCOUNT_FACTS_AVAILABILITY_DIMENSION` / `PORTFOLIO_RISK_AVAILABILITY_DIMENSION`）：本工具的可用性只看自己那一维，另一维的问题**不反映**在本工具的状态里，要看另一维请调另一个工具 |
| **`totalAssets` 为什么数值同源而状态可以不同** | 两者都用 `Account.cashBalance` + 合格行情估值，所以**数值口径同源**；但一侧可能因为**账本对账缺口**把整份结果标 `unavailable`（数值因此为 `null`），另一侧只看价格覆盖仍给 `available`。这是「同一个数、两种可用性判定」，不是两套算法 |
| **不要在这里再造聚合视角** | 聚合视角是 `PANEL_NAMES` 的面板健康（REQ-M3-09 S1，`packages/dsh-luoome/src/host/panel-health.ts`）。要让角标同时反映这两维，改的是 `panel-health.ts` 的 `OUTPUT_PROBES`——**不属于这两个工具** |

**第 8 项的反证（这个裁定只需要这一条证据）**

> 一条表达式有 8 条输入，7 条 `available` + 1 条 `missing` 时，正确语义是**「缺输入」**
> （`RuleExplanationSchema.code` 已有 `'missing-input'`，`strategy.ts:534`），
> **不是「这条输入不可用」**。强行把 `missing` 映射成 `unavailable`，会把用户排查规则的方向
> 从「补这条输入」带偏到「这条输入坏了」——两种说法导向完全不同的动作。

#### 11.1.1a 可用性词汇的粒度判据（**可引用规则**）

**主判据（一句话问法）**：

> 问：「取值变了，用户看到的是『**结果信度变了**』还是『**这一行有没有数据**』？」
> ——**后者不属于结果级可用性。**

三种粒度各用哪套词（按「被描述对象的数量」判，**不按词面判**）：

| 粒度 | 描述对象 | 词汇 | 例 |
|---|---|---|---|
| **结果级** | 一整份结果：一个指标 / 一个面板 / 一份报告 | `available` / `partial` / `insufficient` / `unavailable` | `PortfolioMetricStatusSchema`、`PANEL_HEALTH_STATUSES` |
| **值级存在性** | 一条输入 / 一个标的有**没有**这条数据 | `available` / `missing` | `RuleInputFactSchema.status` |
| **样本级** | 一批样本**够不够** | `sufficient` / `insufficient` | `advice-hit-rate.ts` 的 `sampleStatus` |

**「样本级 `sufficient|insufficient` 是正向表述，映射会丢语义」**：
`sufficient` 说的是「够用」，不是「可用」；把它压成 `available` 会丢掉「样本量达标」这层意思，
而 `insufficient` 压成 `partial` 又会和「结果部分可用」混为一谈（前者等数据、后者补数据）。

**执行守卫**：`packages/core/src/entity/availability-granularity.test.ts`。
判据是**取值集合**（一个 `z.enum` 的**全部**取值都落在结果级词表里 ⇒ 必须在其**本行或上方 3 行**
标注 `可用性粒度:`），**不是**「名字里带 status」——后者会把几十个运行状态机误判进来。
白名单 `GRANULARITY_EXEMPT` 每条必须写理由（照 `REPORT_FACTUAL_FIELD_KEYS` 的做法）。

**为什么是守卫而不是统一（**本节的警示语**）**：

> 全仓可用性类 `z.enum` 有一百多处（严格判据下，`core/entity` + `tools/src` 两个根内就有 7 处
> 需要标注）。把其中 3 个统一成「一个枚举」，会让**剩下那些没被统一的地方被误认为已统一**。
> **做一个看起来像收了口的事，比不做更坏——因为它会让人停止检查。**


**第 9 项的数据依据（为什么这个口径今天只留痕、不改行为）**

> 本机库 `advices.subject_kind` 分布：`stock` **705** 条，`portfolio` / `position` / `market` /
> `sector` 均 **0** 条。**单机库样本，不可外推**；但它足以说明「今天没有真实场景驱动把
> portfolio 主体挪进/挪出归因」。所以本项只做三件事：判据单一化、新增 `unattributableAdvice`
> 披露计数、写下这条留痕——**不改任何现有数字**。


#### 11.1.2 「缺数据」的表达优先级：`缺席 > null > 0`（**可引用规则**）

同一个缺失概念有三种表达，**优先级固定**，越靠前越诚实：

| 表达 | 含义 | 适用场景 | 反例（本仓库真实发生过） |
|---|---|---|---|
| **字段缺席** | 「这个值**不存在**」——连计算它的分母都不存在 | 缺价导致市值/盈亏整体不成立（`packages/tools/src/internal/holding-pnl.ts` 的 `currentPrice`/`marketValue`/`pnl`/`pnlPct`）；上限/下限本身未配置 | 旧实现用 `avgCost` 顶替缺价，于是 `pnlPct` 算出 **0%** 并渲染成 `0.00%`——**用户看到的假结论**，比「没有数字」坏得多 |
| **`null`** | 「值**存在但未知**」——基准缺失导致这一项算不出来，但对象本身是有效的 | 昨收缺失时的 `todayPnl`（不伪造基准）；`totalTodayPnl` 任一项缺失即 `null` | 用 `0` 表示「昨收未知」，会让「今日没涨没跌」和「算不出来」看起来一样 |
| **`0`** | 「**真值就是 0**」 | 有价且成本等于市值（真实零盈亏）；空持仓账户的合计 | 因「算不出来」而给 `0`，等于把缺失伪装成结论 |

**违反的后果**（活教材）：REQ-M3-09 S3 修的就是这条——缺价被兜底成成本价，`pnlPct` 输出 `0%`，
渲染层显示 `0.00%`。这不是「少了一个数字」，而是**用户会把它当成真实结论**。
**新增字段时必须显式选择三档之一，并在字段注释里写明选了哪档、为什么。**

client 侧配套守卫：`packages/dsh-luoome/src/client/projection.test.js` 的静态守卫禁止对
`pnlPct / todayPnlPct / currentPrice / marketValue / totalPnL / totalPnLPct / totalValue` 写 `?? 0` / `|| 0`。

#### 11.1.3 建议账户归属的三层职责（不要在外面再加一层）

| 层 | 位置 | 职责 |
|---|---|---|
| 判定 | `adviceAttribution`（`packages/tools/src/internal/account-advice-outcomes.ts:78`） | 对**一条**建议给出归属结论：`this-account` / `other-account` / `undetermined` / `unscoped`。判据顺序：复盘记录认领 → strategy 快照 `accountId` → portfolio `subjectId` → position 所属持仓 → analysis context → 无信号（stock 可能被他账户认领，其余判 unscoped） |
| 过滤 | `accountScopedAdvices`（同文件 `:127`） | 对**一批**建议套用上面的判定，只留 `this-account`。**不重复实现判定** |
| 选择 + 统计 | `selectAdvices`（`packages/tools/src/internal/advice-selection.ts:37`） | 过期过滤（注入时钟）→ 账户过滤（调 `adviceAttribution`）→ limit 截断，并额外统计 `unattributedCount`（「因没有任何账户认领而没进列表」的条数，缺数据要说不许静默丢弃） |

顺序固定：**账户过滤 → 过期过滤 → limit 截断**。先截断再过滤会让「前 N 条都不属于本账户」把结果误压成空。
`get_advice` / `list_advices` 走 `selectAdvices`；`get_advice_stats` / `get_confidence_calibration` /
`get_strategy_decision_cycles` 走 `accountScopedAdvices` 后再各自聚合——**两条路径共用同一个判定内核**，
新增消费方只能二选一复用，**不许再写第三份归属逻辑**。

#### 11.1.4 成交方向词与立场词：两张表，不许合并

| 概念 | 表 | 词面 | 语义 |
|---|---|---|---|
| **成交方向**（账本事实） | `Trade.side`：`buy` / `sell` | 展示词「买入 / 卖出」 | 「这笔成交实际发生在哪个方向」——已记账的事实 |
| **投资立场**（研究结论） | `Advice.decision`：`buy/sell/hold/watch/avoid` | 报告面 `REPORT_STANCE_LABELS`（看多 / 看空 / 观望 / 观察 / 回避） | 「研究结论倾向」——不是动作，也不是既成事实 |

**不许合并的原因**：把成交方向换成立场词（「看多」）会让**账本事实看起来像建议**；
把立场词换成成交词（「买入」）会让**建议看起来像已执行的动作**（这正是 REQ-M3-08 文本禁令要防的）。
今天的现状是**同一笔成交在收盘报告写「买入/卖出」、在周报写 `buy`/`sell`**——这是待统一项（task-25 U1），
但统一的目标是**一张「成交事实词」表**，**不是**合并进 `REPORT_STANCE_LABELS`。
另外：报告文本禁令的 `REPORT_FACTUAL_FIELD_KEYS.side` 白名单豁免的是**成交事实字段**，
词面统一后这条豁免才不再取决于「写中文还是英文」。

#### 11.1.5 五段概念：三处渲染，一份定义

`结论 / 反证 / 风险 / 有效期 / 免责` 这个概念现在有三处渲染实现：

| 位置 | 形态 |
|---|---|
| `packages/core/src/entity/advice-card.ts:18` `ADVICE_CARD_SEGMENTS` | 建议卡片（`renderable` / `blocked` + `missing[]`） |
| `packages/core/src/entity/report-document.ts` + `workflows/src/internal/report-envelope.ts` | 报告 envelope（`REPORT_ENVELOPE_SECTION_KEYS`，六槽：另含 `dataAsOf`） |
| `packages/tools/src/internal/report-notification.ts` | 通知摘要（第二套措辞，只做裁剪） |

**当前实现**：core `ADVICE_SEGMENTS` 与 `missingAdviceSegments` 已统一段名和缺段判定；
`ADVICE_CARD_SEGMENTS` 是同一数组的兼容别名，`REPORT_ENVELOPE_SLOTS` 在五段后追加
`dataAsOf`，通知兜底措辞也复用段名与 `segmentLabel()`。

三处渲染形态与用途仍有区别：卡片保留 `renderable/blocked`，报告 envelope 强制六槽，通知
另按报告 section 白名单裁剪。维护时复用共同概念，不把三种产物或各自适用规则合并成一套输出。

## 12. 安全模型

详见 [SECURITY.md](./SECURITY.md)。要点：

- 5 级副作用：`read / write / external / queue / trade`，trade 永不暴露
- advice 永远不直接触发 trade，trade 永远需要 human-in-the-loop
- advice 输出必含 disclaimers
- advice 可被 outcome 验证，准确率可统计
- 密钥只走本地 `.env`，不入 git，不入日志
- 原生调用核对当前 owner 与活 Agent；HTTP 经 DSH Connection.admit、Host/Origin 与 owner guard，luoome 不自建登录体系
- 所有 adapter 调用有超时和重试上限
- 所有 IO 异常落到 `ToolError`，不抛 raw exception

## 13. 扩展点

### 13.1 加新 tool

1. 在 `tools/<name>.ts` 用 `defineTool` 定义
2. 注册到 `toolRegistry`
3. 加单元测试 + 集成测试
4. 从 Zod schema 派生类型与工具描述；按需求显式加入插件 read/market allowlist 或精确 Operation policy，注册本身不自动开放入口

### 13.2 加新 advice workflow

仓内 workflow 不再生成 advice；新增 workflow 只编排已有事实与已落库 Advice：

1. 在 `packages/workflows/src/<name>.ts` 用 `defineWorkflow` 定义
2. 通过 `ctx.tools.get_advice.execute()` / `ctx.tools.get_advice_stats.execute()` 读取已有建议，
   通过 `ctx.tools.*.execute()` 获取事实和写入结果，不直接访问 repository 或 adapter
3. 需要新建议时，先由 DSH 交互分析经插件 `record_advice` 写回，再由 workflow 消费；明确需要批量分析时复用可选队列执行契约，不在 workflow 内引入模型调用
4. 加 workflow 集成测试；测试替身只限测试边界，生产路径不注入 mock 数据

### 13.3 加新数据源

1. 在对应领域实现能力 Adapter；行情能力满足现有 `MarketDataAdapterLike` / capability Interface，其它数据域保持独立端口
2. 在共享 composition root 和 `SourceRegistry` 注册真实能力，复用已有配置与观测
3. 补齐解析、健康观测、限速与失败测试；保持事实时间和缺失语义，不用当前快照代替历史 PIT

### 13.4 加新 surface

新增 surface 须有明确需求，并经现有 tools、暴露面判定和组合能力校验接入；不得复制领域逻辑或
绕过 Operation 回执与 trade 禁止暴露规则。当前产品仅维护 DSH 插件入口，不预先增加其它通信渠道。

## 14. 不在范围的设计决策（已定，不再讨论）

- ✅ TypeScript workspace；Bun 用于构建与测试，生产插件由 DSH 的 Node 运行时加载
- ✅ 单机 SQLite + Drizzle，默认插件使用 Node SQLite
- ✅ DSH host/client/skills；独立 opentui TUI 与 stdio MCP 入口已退役
- ✅ Zod 4.x 与 schema 驱动工具契约
- ✅ Monorepo，领域能力统一经 tools 调用
- ✅ Advice 是领域实体，推理由 DSH 承担
- ✅ Advisor 思路：按明确意图执行并保留回执，advice ≠ trade

## 15. 待定（v0.4 前再定）

本标题保留旧版本文档锚点；以下更新为当前决策，不再作为 v0.4 选型清单：

- Web 与移动访问复用 DSH 插件面板及宿主能力，不再选择独立 Web/PWA 技术栈。
- 当前研究范围以沪深 A 股为准，不为未来市场预建统一抽象。
- 不新增自动券商下单路径，trade 不对任何插件或远端面开放。
- 单机事实库与业务导入导出继续维护；多用户托管、订阅计费和云同步已退役。
- 生成式模型供应商、模型目录、路由与凭据由 DSH 管理；luoome 仅声明已有业务所需输入和结果契约。

## 16. 个人订阅服务装配

**单机形态只有一个入口：DSH 插件。** 旧单机 Web（`apps/web`）已随 M3-01 下线，
其能力（五块面板、设置分区、数据导入导出）全部由 `packages/dsh-luoome` 提供；
luoome 不自建登录、租户隔离或支付计量；宿主准入由 DSH 和部署层负责。插件使用单机 `luoome.db` 保存业务事实。
默认部署是纯插件形态：DSH（Node）加载 `dsh-luoome`，安装/升级/备份/回退步骤见
[用户手册](./USER_GUIDE.md#7-dsh-单机用法)，部署约束见 [宿主机直部署](../deploy/direct/luoome-dsh.service)。

本节标题保留历史锚点；“个人订阅服务”不再是当前产品形态。旧 `apps/web` 的登录、邮件、
验证码、租户隔离及 `/api/auth/config` 已下线，历史托管资料见文档归档。当前 HTTP 身份与
Host/Origin 校验由 DSH 宿主和插件 owner guard 负责，不恢复旧 Web 认证系统。

模型推理由 DSH 承担，luoome 侧没有模型设置页，也不做用量计量。仓内已无模型目录文件
（原 `$LUOOME_HOME/ai-models.json` 随 `packages/adapters/src/llm/` 一并删除）；
现存唯一的模型目录是研究 embedding 的 `LUOOME_RESEARCH_EMBEDDING_CONFIG`，密钥从环境取。

没有 control.sqlite、没有租户：全部事实落在单机 `luoome.db`。
core 的 `personal/` 只定义实体与不变量；db 的 memory/Drizzle 实现共享 contract tests。
默认插件要求受信任配置绑定已经存在的投资账户；不会在启动时创建示例账户或猜测 owner。
历史 personal 初始化能力与当前插件启动分开，不把初始化或单账户迁移规则当作多账户领域限制。
`update_account` 仅更新名称，资金/持仓依旧通过 ledger。

托管形态的平台 Tools（私有 registry、订阅与预算门禁、请求级租户上下文）已随托管层下线删除，
`packages/tools/src/platform` 不再存在。单机形态下所有业务能力走同一套 `packages/tools/src/registry.ts`
公开 registry；默认部署的 DSH 暴露面由 `dsh-luoome` 插件控制（精确只读白名单、market external
白名单与个人直接执行 policy），调度由 DSH 定时任务驱动。旧四个 MCP 实例及入口源码均已删除；
保留的是领域队列工具和隔离验收契约，不是仍可启动的旧实例。

单机形态没有租户运行时管理：每个请求一个本地 ctx，账户由 `ctx.user.defaultAccountId` 绑定。
界面不提供新增/切换账户，服务端同时拒绝对应绕行。

原 Strategy schedule、账户计划、报告、观察、绩效及历史评估的编排保留在领域 workflow 里，
由 DSH 定时任务调用的批处理工具触发（保留原领域 lease/fencing/checkpoint）。
workflow 继续只通过 `ctx.tools.*` 编排。`@luoome/batch` 是位于 surface 层的共享入口，依赖
workflows/tools/core，不进入领域 registry，也不依赖 MCP 或 DSH SDK；插件按明确意图直接执行同一实现，
插件只在显式 batch opt-in 后挂载五条账户绑定 policy，完整要求 write + external。
业务成功、用户额度、provider成本和通知状态分别表达，unknown不按超时猜测为零。

默认账户复用 DecisionReview 与开盘/收盘/周报。旧 `watchlist-facts` 属于历史补充报告，
旧 PersonalWatchFeedback 仅供历史读取，不与当前账户采纳/收益自动混算。
投资设置提供允许的行情源与账户名称；账户维护、数据导入导出使用对应精确工具和入口，
可用范围以当前 policy 为准，不推定已迁移全部旧 Web 设置。模型凭据由 DSH 管理。
恢复沿用单机数据导入、备份和业务回执核对契约，不重发旧通知；旧租户删除屏障与订阅设置已退役。

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

默认纯插件部署的 read / market / 写操作面互相隔离：read 接受精确 read 工具，market 接受
精确 external 工具，写操作经个人直接执行 policy；queue 管理工具、任意 settings registry 与
trade 不暴露。batch 默认关闭，启用后仍按明确意图或精确任务授权执行。
部署环境传入的 `LUOOME_EXPOSE_*` 不得扩大任何面的名单。

队列与历史 chat 能力保留但默认不暴露，不能据此推断已废弃；可选执行能力与当前入口分别是：

- `enqueue_analysis_job` 不在领域 registry，仅在 WorkflowToolMap 注册为内部工具；当前生产
  workflow 没有入队调用，插件没有入队 policy。有 JobRunner 时已能启动后台任务，普通分析还需
  显式 `analysisModel`，见 §6.3。
- `claim_analysis_jobs` / `complete_analysis_job` / `fail_analysis_job` 保留租约消费与提交能力，
  默认插件不运行轮询 worker，也不把这三个名字注册为 Operation policy。
- `record_advice` / `record_analysis_result` 作为交互写回 policy 可达，不直接作为 agent 工具注册。
- GoalRun 有显式生产 Operation 与宿主执行 Adapter，不等于 AnalysisJob，也不自动生成 Advice。
- `list_chat_sessions`、`append_chat_message` 等历史 chat 工具没有插件入口，当前会话由 DSH 承载。

**`execute_strict_strategy_backtest` 是内部执行步，不是对外入口**：它在 registry 里（保证
「一个能力一份实现」），但既不在 read / market 白名单、也没有 operation policy，所以
`bun run tools:list` 把它标成 `unreachable-by-design`。插件里的组合回测执行由
`create_strict_strategy_backtest` policy 在门禁完备后经后台任务触发，不另开第二个对外名字。
能力声明由 `packages/dsh-luoome/src/host/surface-consistency.test.ts` 逐字段对账：
`start_/resume_strategy_evaluation_session` 在 registry 侧也声明 `external`（受理即代表宿主推进的
逐日 replay 会经 `prepare_strategy_data` 取外部数据），`create_strict_strategy_backtest` 只声明
`write`（创建与执行都只读本地事实）。

`record_decision_trade` 是**专用人工入口：永不暴露、不摘除、不经远端暴露面**。它的不可达是暴露规则的结果，
不是摘除依据，维护时不得标成废弃、也不得按「不暴露」标签删掉。三条依据：AGENTS.md「trade tool
永不通过任何暴露面暴露；不得绕过 `LUOOME_EXPOSE_TRADE=true` 的启动硬卡」；插件宿主在创建目录、打开数据库
等任何 IO 之前用该变量硬卡启动失败（`packages/dsh-luoome/src/host/production.ts:77`）；
[插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md) §1 要求「trade 语义不可改记为 write，
只能保留专用人工入口」。

看盘、持仓、关注、策略、复盘通过 `ctx.slots` 注册主面板与侧栏入口；投资设置注册到 DSH 原生
`settings.section`，不占业务侧栏。宿主 prefix 路由复用 DSH Connection.admit
与 Host/Origin 校验；固定 state GET 只投影白名单工具及受信任配置。账户改名走 prepare 后直接执行的
协议，取消与未知结果只核对 operation ID。浏览器只保存恢复用的 UUID，不保存执行 token，
不重算业务数字。非交易日的情绪查询取最近交易日，仍展示供应商原始日期，不伪装今日实时行情。

看盘保留账户概览，持仓明细在持仓页查看。关注页独立读取 `list_watchlists`，按选中列表
调用只读 `get_watchlist`；股票名称由工具解析本地目录，缺失名称不猜测。新建/修改/归档列表、
添加/调整/移除手动成员复用领域工具，面板提交即按冻结输入直接执行并返回 Operation 回执，
不开放定时授权。AI 管理入口生成带列表身份的可编辑对话草稿，对话中的写入按明确意图直接执行。
结束 manual 来源不会删除其他仍有效的来源；
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
客户端与固定研究路由、直接执行操作及可复现边界见[插件研究工作台契约](./ddd/dsh-luoome-plugin-detailed-design.md#82-个人策略研究工作台)。

策略匹配标的的个股详情按点击时的股票、结果及版本保留来源。点击股票后才经固定
`GET /api/luoome/stock?stockId=...` 调用精确 opt-in 的 `fetch_quote`；只接受一个规范股票代码，
仍经宿主 owner、Host/Origin 校验与有界取消。`fetch_quote` 保留 `retrieval` / `freshness`，
缓存回退及过期状态、行情时间与匹配时间分别呈现。关闭详情取消客户端等待，错误不清空匹配依据。
分析按钮在用户点击后通过官方 Session Controller 创建并保留会话，使用其公开 SessionFace
提交股票分析问题，收到宿主接受后再打开对话；保留期间使用真实作用域，不借用未注入服务，
也不操作或清空已有会话草稿。失败不自动重试，任何业务写入仍按明确意图直接执行并保留回执。

历史图表由独立 `/api/luoome/stock/history?stockId=...` 提供固定三个月日 K，复用
`get_stock_market_view` 的真实 candles/dataStatus。入口只接受单个沪深股票码，沿用 owner
admission、Host/Origin、no-store 和有界取消。历史读取由用户主动触发，报价保持独立；缺日线时
显示不可用，不从单次报价合成历史，图表不提供组合回测结论。

单机事实库是唯一事实源；历史托管租户库已下线。
存量 Advice 的来源幂等回填为 `legacy-ai`，不伪造历史模型信息。

## 纯插件执行与授权内核

`packages/dsh-luoome` 的 DSH/HTTP 包装统一调用 tools 操作服务；`PluginAuthorityRepository` 在 core 定义，db 提供 memory/drizzle、同步 schema/DDL 与合约。操作冻结账户/输入并 CAS 认领，通用操作回执与业务事务分离，结果不明时通过既有业务 receipt 核对，不能自动重执行业务。

`PluginOperation` 保存冻结输入与操作回执，绑定用户、账户、参数摘要及授权版本；它不替代
DecisionReview 或 Analysis 的领域事务回执。`executing/unknown` 表示结果仍需核对，不可直接
解释为业务失败或盲目重试。当前个人版 prepare 后直接 confirm，历史“待确认”命名不要求额外弹窗。

`PluginAutomationGrant` 是人工建立的特定 DSH profile/session/task 授权，绑定任务定义指纹、
账户、工具、精确参数、组合能力与有效期；它不等于 StrategySchedule，也不赋予交易权限。
可信日程投递来自宿主持久事实，prompt、callId 和模型自报 taskId 不构成授权。batch 默认关闭，
自动化档位默认 `off`；`notify` 只产草稿/提醒，`granted` 才在匹配 grant 后执行受控业务写入。
设置、授权目录、持续运行状态与派发统一读取当前档位，写入闸门在实际执行时再次校验；
不保留独立的调度器启动档位快照。派发器处理宿主投递，精确 policy 由既有操作服务集中检查。
档位开关不替代逐任务授权。授权目录只读返回任务指纹与规范化调用，不创建任务或 grant；
旧日程须在同一 ID/cron 上使用当前原生入口，核对指纹并逐项建立授权后再启用。

个人版不再调用 ApprovalService，也不要求面板二次确认。原生与 HTTP 操作在 prepare 后直接 confirm，执行 token 的私有凭据仍经单调 guard 和 handler 核验；宿主对插件工具及 luoome 日程工具返回 ask 时由插件覆盖为 allow，明确 deny/cancel 与 owner guard 继续生效。调度身份来自当前 turn 消息与 ScheduleService 持久投递历史的关联，并绑定任务定义指纹、授权版本、账户及精确参数。

生产插件声明 `agents` 依赖，原生调用在插件作用域核对活 Agent；HTTP 读接口不能替代这条验收。
操作入口由操作服务的当前 policy Zod schema 派生 tool/input 契约，直接提供嵌套字段类型并保留每项操作的精确约束。
参数校验失败返回不含提交值的字段路径与类型要求，保留 invalid_input 与 permission_denied 的区分。

新 Web 装配在官方 WebServer 上注册业务前缀，逐请求经 Connection.admit 的 cookie/Host/Origin 与 owner 检查，保持真实监听器 origin 和 64 KiB 流式输入限制。操作页只把操作编号存入 sessionStorage，执行凭据仅在组件内存；HTTP prepare 直接返回最终回执。预检经 appReady/appExit 独立退出，或在可信 worker 的 pre-step 中先于模型解析阻断空队列/异常。

无模型预检、完整官方 Web profile、Node DB 只读/写回与 M5 默认部署纯插件切换（含一致性备份与回退合并演练）已有隔离验收。**生产服务器已于 2026-10-25 完成纯插件切换并通过宿主侧、HTTP 与浏览器验收，旧 MCP 用户入口源码已删除（REQ-M2-03）**；自动执行默认关闭。实现与验证边界见[纯插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md)。

原生操作参数中的账户与 requestId 由 policy 绑定；模型参数 schema 将这些字段标为可省略，完整领域校验仍在绑定后执行。冲突错误只返回安全字段路径。个人版按用户明确意图直接执行，不再把审批拒绝作为会话状态保存。
