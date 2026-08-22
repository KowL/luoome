# 数据源可插拔与统一观测设计

> 状态：第一刀实施中（评审修订稿已定稿）
> 日期：2026-08-22
> 范围：`packages/adapters` 数据源接入层重构——通用 `SourceRegistry`、单一 `EastmoneySource`、五个非行情域的源可插拔与统一观测
> 关联文档：[ARCHITECTURE.md §4.7/§4.8](../ARCHITECTURE.md)、[CONTEXT.md](../../CONTEXT.md)「数据源观测」、[同花顺 fuyao 行情适配器设计](./fuyao-market-adapter-design.md)、[Tushare 行情适配器设计](./tushare-market-adapter-design.md)、[行情数据底座详细设计](./market-data-and-stock-universe-detailed-design.md)

## 1. 背景与问题

### 1.1 现状事实（代码证据）

- **可插拔机制只覆盖行情域**。`MarketSourceRegistry`（`packages/adapters/src/market/source-registry.ts`）提供 capability 绑定、源排序、降级与健康观测（`describe()` 派生 `dataAsOf` / `lastErrorKind`），但类型被绑定在 9 种行情 capability 上。
- **五个非行情域各只有 eastmoney 一个源，且工厂写死单源**：limit-up-ladder、dragon-tiger、ashare-sentiment、northbound-flow、news 的 `factory.ts` 都以 `z.tuple([z.literal('eastmoney')])` 限定单源，`LUOOME_*_SOURCES` 形式上存在但实际不可配置。
- **eastmoney 的接入代码碎片化在 6 个模块**：`market/eastmoney.ts`（push2 行情系）、`limit-up-ladder/eastmoney.ts`（push2ex 池系）、`dragon-tiger/eastmoney.ts`（datacenter-web 报表系）、`ashare-sentiment/eastmoney.ts`、`northbound-flow/eastmoney.ts`、`news/eastmoney.ts`。HTTP 管道（AbortController 超时、HTTP/JSON 错误分类）与数值 coercion helper（`asRatio`/`asAmount`/`asPrice`）在各文件重复。
- **观测面不对齐**：`get-market-data-status`（`packages/tools/src/tools/get-market-data-status.ts:96-104`）已把 limit-up-ladder 装进 inventory，但只能填静态字段，`freshness` 恒为 `unknown`；dragon-tiger / ashare-sentiment / northbound-flow / news 完全没有观测出口。源挂了无从发现。
- **替代源已在 roadmap 上**：fuyao（同花顺）侧涨停池、龙虎榜、异动、集合竞价均有现成端点（见 fuyao 设计文档 §11），非行情域的多源不是假设而是预定事项。

### 1.2 问题定义

1. 源可插拔机制与行情域耦合，新域接第二源需要重写路由与观测；
2. 同一供应商（eastmoney）的接入代码缺乏单一归属，修复与观测都按域碎裂；
3. 非行情域源健康不可见。

## 2. 目标

- 本次纳入范围的行情与五个非行情域共用同一套 capability 绑定、源排序、降级与观测机制；股票目录、基本面等已有独立生命周期的 adapter 不在本次强行迁入；
- eastmoney 在上述范围内的全部能力（含 news）收敛到单一 `EastmoneySource` 类，HTTP 管道与 coercion 单点维护；
- 五个非行情域的 `LUOOME_*_SOURCES` 成为真实配置（数组、有序、可追加 fuyao 等替代源）；
- `get-market-data-status` 对本次范围内所有域输出基于真实执行事实的 `freshness`；
- **存量行为不变**：仅配置 eastmoney 时，现有请求的结果字段、错误字面值与降级语义不变；为使第二源无需再次修改 core，`query.source` 的语义和 source schema 会做向后兼容的扩展（§4.6）。

## 3. 非目标

- **不改变端口边界**：非行情域不进入 `MarketDataManager`（ARCHITECTURE §4.8）。ladder/dragon-tiger 的交易日门控、PIT 快照、`warnings` 语义与 market 域的 quote 缓存/抑制窗口/per-key 降级是不同的编排语义，合并会互相污染。
- 不实施 fuyao 特色数据接入（那是第二刀，本文档只为它铺好机制）。
- 不动 `MarketDataManager` 的编排骨架泛化与 `batch-quote` capability（架构评审 C1/C2，与 fuyao 行情接入同批处理）。
- 不改业务实体字段形状、DB schema、ToolResult 或 tool 输出字段形状；允许把四个域中仅接受 `eastmoney` 的 source schema 兼容扩宽为通用 `SourceId`，并把 `query.source` 从带默认值改为可选路由约束（§4.6）。

## 4. 已确认决策

### 4.1 泛化 registry，而不是给每域复制一个

`MarketSourceRegistry` 泛化为域中性的 `SourceRegistry<CapabilityMap>`：capability 枚举、request/result 类型由各域的 capability map 注入。market 域的 9 种 capability 成为第一个实例化（`MarketSourceRegistry` 保留为别名，调用点不改）。

理由：registry 的本质职责（绑定校验、按 capability 路由、观测包装）与领域无关，泛化后五个非行情域各自实例化自己的 registry；复制五个 mini-registry 会把观测与排序逻辑复制五份，deletion test 不通过。

### 4.2 单一 EastmoneySource，领域解析留在领域目录

```ts
// packages/adapters/src/eastmoney/source.ts
export class EastmoneySource implements
  MarketDataAdapter,            // market 能力：fetchQuote / fetchDailyBars / searchStocks / snapshot / index
  LimitUpLadderAdapterLike,     // fetchLadder
  DragonTigerAdapterLike,       // fetchList
  AShareSentimentPoolSource,    // fetchSealedPool / fetchBrokenPool
  NorthboundFlowAdapterLike,    // fetchFlow
  NewsAdapterLike {             // fetchNews
  readonly name = 'eastmoney';
}
```

- HTTP 管道收敛到 `eastmoney/client.ts`（`getJson(url, {timeoutMs})`，不烘焙端点——多个 API 族 base URL 不同），供应商级数值 helper 收敛到 `eastmoney/coercion.ts`；
- URL 模板与字段映射（领域知识）保留在各域目录的纯函数中，`EastmoneySource` 的方法委托调用；解析的 locality 不丢；
- 结构性满足各域 `*AdapterLike`；领域 manager 仍拥有交易日门控、缓存、PIT、结果组装和 warnings，仅把直接 adapter 循环替换为 registry handle 循环。sentiment 为保留池级 fallback，会按两个独立 capability 路由（§4.3）。

权衡记录：单一类有 god-class 风险，接受的依据是（a）方法间不共享领域状态，类主要承担同一供应商的能力集合；（b）解析逻辑外置；（c）共享 client 可统一超时、错误分类，并为未来供应商级限流保留单一归属；（d）源健康观测按 `(source, capability)` 聚合。未来某域出现第二源时，该类不需要拆分——新源实现自己的能力切片即可。

### 4.3 观测由 registry 统一提供，内存态

- 不再单独引入 `SourceObservation` 模块：泛化后的 registry 的 `execute` 包装层就是观测点，所有域一个机制；
- 内存态、进程重启归零，与行情域现状一致；CONTEXT.md「数据源观测」条目按此登记；
- **只记录源失败**：调用方输入错误（`invalid_input`）、非交易日早退不计入；
- binding 使用必填 `observationOf(result)` 对已 resolve 的结果分类，避免把 `ok:false`、`unsupported_date` 或空结果误记为成功：
  - `{ outcome: 'success', dataAsOf? }`：更新 `lastSuccessAt`，清除 `lastErrorKind`；只在提供 `dataAsOf` 时更新该字段，否则清除旧值；
  - `{ outcome: 'failure', kind }`：只更新 `lastAttemptAt` / `lastErrorKind`，保留上一份 `lastSuccessAt` / `dataAsOf` 供诊断；
  - `{ outcome: 'ignored' }`：仅保留 `lastAttemptAt`，不改变成功、错误与数据时间；用于调用方输入限制或该源明确不支持的历史窗口。
- 异常失败同样只更新 `lastAttemptAt` / `lastErrorKind`；下一次成功清除错误。任何执行都先更新 `lastAttemptAt`。
- sentiment 不再用一个聚合 capability 掩盖单池故障，而是注册 `sentiment-sealed-pool` 与 `sentiment-broken-pool` 两个 capability；manager 分别路由、分别 fallback 后再组装现有快照。单池长期失败会在状态页显示为对应 dataset 的 `unavailable`，另一个池仍可为 `fresh`。
- `freshness` 只由最新执行结果和 `dataAsOf` 推导，**不得用 `lastSuccessAt` 代替数据时间**：
  1. `lastErrorKind` 存在（成功会清除，故它表示最新有效 outcome 为失败）→ `unavailable`；
  2. 否则有 `dataAsOf` → 按该 dataset 阈值计算 `fresh` / `stale`；
  3. 否则 → `unknown`。
  因此“成功后断网”会保留旧 `dataAsOf` 供诊断，但 freshness 为 `unavailable`；恢复成功后重新变为 fresh/stale。
  注意：观测表达的是“源最近一次执行事实”。manager 的 TTL 缓存仍在正常供数时，dataset 可能因一次瞬时失败显示 `unavailable`——状态页与业务可用性短暂不一致是**有意语义**，不构成 bug。

### 4.4 错误词表统一

在 core 定义共享 `SourceErrorKind`（因为 `SourceStatus` 端口需要引用），adapters 定义携带该 kind 的 `SourceExecutionError`：

```text
network | timeout | rate_limited | permission | no_data | partial_data |
invalid_payload | unsupported_market | unsupported_capability | unsupported_adjustment | upstream_error
```

- `eastmoney/client.ts` 与领域信封解析必须抛结构化 `SourceExecutionError`，registry 读取 `error.kind`，不依赖错误消息正则：主动超时 → `timeout`，fetch 拒绝 → `network`，HTTP 401/403 → `permission`，429 → `rate_limited`，5xx/其它非成功业务码 → `upstream_error`，JSON 或信封错误 → `invalid_payload`；未知异常统一收口为 `upstream_error` 并保留 cause；
- 存量映射：`network_error → network`、`http_error → network`、`invalid_response → invalid_payload`、`adapter_error → upstream_error`、`unsupported_date → 不计入观测`（输入错误）；
- 各域对调用方的 result 契约（`error.kind` 字面值）**不变**，映射只发生在观测边界。

### 4.5 core 端口最小扩展

- core 新增 `SourceStatus`（`dataset: string`、`coverage: readonly string[]`、`lastErrorKind?: SourceErrorKind`，其余字段同现有 `MarketSourceStatus`）；`MarketSourceStatus` 保留为 dataset/coverage 的收窄别名；
- 五个 `*ManagerLike` 增加必填 `status(): readonly SourceStatus[]`，实现为各自 registry 的 `describe()`；testing fakes 同步实现并可返回空数组。不能为了少改 fake 把生产观测端口做成可选，从而让状态 tool 静默漏域。

### 4.6 领域 factory 的 sources 数组化、source 身份与实例共享

- 各域 `LUOOME_*_SOURCES` 改为与 `LUOOME_MARKET_SOURCES` 同构：逗号分隔、有序、去重校验、未知源启动期抛错；缺省 `eastmoney`；
- limit-up-ladder、dragon-tiger、northbound-flow（news 同样遵循）的 `query.source` 统一定义为**可选的单源路由约束**：未传时按 env 顺序 fallback；显式传入时只尝试该源，未启用则返回既有错误协议。移除 schema 的 `default('eastmoney')`，存量未传请求在第一刀仍因唯一源为 eastmoney 而保持同样结果；
- core 新增通用 `SourceIdSchema`（小写字母/数字/连字符的非空标识），上述请求与结果的 source 字段改为该 schema。manager 必须把**实际成功的 `handle.source`**写入结果 provenance 和缓存 key，不能回写 query.source；这项兼容扩宽在第一刀完成，第二源接入时无需再改 core/tool；
- 非交易日等 manager 本地早退没有成功 handle：为保持现有字段形状，结果 source 使用显式约束或配置顺序第一项，同时以 `warnings=['non-trading-day']` 明确该结果来自本地日历而非远端；早退不写 registry 观测。“实际成功 source”约束只适用于发生外部读取并返回数据的路径；
- 实例共享：各 factory（含 market）的 deps 增加可选 `sources?: { eastmoney?: EastmoneySource }`；未注入时保持现状自行构造（存量测试与单域装配不受影响）；
- web（`apps/web/src/server.ts:299` 与热更新路径 `:916`）、cli（`packages/cli/src/context.ts`）、mcp（`packages/mcp/src/context.ts`）三个组装根先建一次 `EastmoneySource` 再分发；tui 只装配 market，可选择走共享或不走。

### 4.7 Web 热更新的实例生命周期

- composition root 除 `ToolContext` 外持有进程级 `SourceSet`，不把供应商实例泄漏进 core；
- `/api/settings/market` 只改变来源顺序时，candidate market registry 复用现有 `SourceSet`，只重建 market manager 以及直接依赖 market 的 sentiment manager，避免无关 manager 缓存失效，也不会产生第二个 Eastmoney 实例；
- 未来若设置项会改变 Eastmoney client 本身（超时、代理、base URL 等），必须先以新 `SourceSet` 构造并验证 market + 五个非行情 manager 的完整 candidate 图，验证成功后一次性替换 `ctxRef` 与 composition-root source 引用；失败时旧图保持不变；
- 测试同时断言实例引用、原子替换与无关 manager 缓存保留，不能只验证新 market 可请求。

### 4.8 两阶段实施

- **第一刀（本文档）**：泛化 + source schema 兼容扩宽 + 迁移 + 观测，各域仍只有 eastmoney，存量请求输出不变。按三个可独立验证的增量落地，每个增量全量测试绿灯后再进下一个：
  1. core `source.ts` + adapters `source-error.ts` + registry 泛化 + market 域换底座（含 market 四个 adapter 错误路径迁移到 `SourceExecutionError`）；
  2. `EastmoneySource` 合并（含 market/eastmoney）+ 五个非行情域迁移 + factory 数组化与实例共享；
  3. 状态读模型聚合 + 三个 surface 共享实例接线 + 文档同步（`.env.example`、ARCHITECTURE、fuyao §11）。
- **第二刀（fuyao 特色数据接入）**：`FuyaoSource` 实现对应能力切片，factory 加 binding，`LUOOME_*_SOURCES=eastmoney,fuyao` 即完成切换。fuyao 设计文档 §11 的「独立 manager + factory」口径届时更新为「registry binding」。

## 5. 目标架构

```text
Source 层     EastmoneySource（全部 eastmoney 能力）
              未来: FuyaoSource / TushareSource（各自能力切片）
                │ 结构性满足各域 *AdapterLike
Registry 层   SourceRegistry<CapabilityMap>（泛化自 MarketSourceRegistry）
              ├─ market        → MarketDataManager（编排语义不变）
              ├─ limit-up      → LimitUpLadderManager（交易日门控/PIT 保留）
              ├─ dragon-tiger  → DragonTigerManager
              ├─ sentiment     → AShareSentimentManager（sealed/broken 分能力）
              ├─ northbound    → NorthboundFlowManager
              └─ news          → NewsManager
              统一提供：绑定校验、有序 handles、执行包装与观测（dataAsOf/lastErrorKind）
                │
Port 层       core 的 *ManagerLike + 必填 status()；业务 tool / surface 零感知
                │
读模型        get-market-data-status 聚合全域 registry.describe()
```

## 6. 关键契约

### 6.1 泛化 registry

```ts
export type CapabilityMap = Record<
  string,
  { readonly request: unknown; readonly result: unknown }
>;

export type SourceResultObservation =
  | { readonly outcome: 'success'; readonly dataAsOf?: Date }
  | { readonly outcome: 'failure'; readonly kind: SourceErrorKind }
  | { readonly outcome: 'ignored' };

export interface SourceBinding<M extends CapabilityMap, C extends keyof M & string> {
  readonly capability: C;
  readonly source: SourceId;
  readonly coverage: readonly string[];
  readonly configurationReady: boolean;
  execute(input: M[C]['request']): Promise<M[C]['result']>;
  /** 每个 binding 必须显式声明 resolved result 如何影响观测。 */
  observationOf(result: M[C]['result']): SourceResultObservation;
}

export type AnyBinding<M extends CapabilityMap> = {
  [C in keyof M & string]: SourceBinding<M, C>;
}[keyof M & string];

export interface SourceHandle<M extends CapabilityMap, C extends keyof M & string> {
  readonly capability: C;
  readonly source: SourceId;
  readonly coverage: readonly string[];
  execute(input: M[C]['request']): Promise<M[C]['result']>;
}

export class SourceRegistry<M extends CapabilityMap> {
  constructor(bindings: readonly AnyBinding<M>[], clock: () => Date);
  sources<C extends keyof M & string>(capability: C): readonly SourceHandle<M, C>[];
  describe(): readonly SourceStatus[];
}
```

`SourceHandle` 必须暴露 `source`、`coverage` 和类型化 `execute`。registry 提供按配置顺序排列的 handles，具体 manager 保留领域自己的 fallback/partial/cache 语义。market 域的 coverage **过滤规则**保留在 market 的实例化层（`MarketSourceRegistry` 薄壳）；通用 registry 只保存 coverage 元数据，不理解 `MarketCoverage` 的包含关系。四个 A 股日级域登记 `CN_A_SHARES_SH_SZ`，news 登记 `CN_FINANCE_NEWS`。

### 6.2 各域 capability map（类型从各域 `types.ts` 复用）

| 域 | capability | request | result |
|---|---|---|---|
| limit-up | `limit-up-ladder` | `{ date, days }` | `{ date, observedAt, entries: LimitUpLadderRawEntry[] }` |
| dragon-tiger | `dragon-tiger-list` | `{ date }` | `{ date, observedAt, entries: DragonTigerRawEntry[] }` |
| sentiment | `sentiment-sealed-pool` | `{ date, coverage }` | `AShareSentimentRawPool` |
| sentiment | `sentiment-broken-pool` | `{ date, coverage }` | `AShareSentimentRawPool` |
| northbound | `northbound-flow` | `{ endDate, days }` | `{ endDate, entries: NorthboundFlowRawEntry[] }` |
| news | `finance-news` | `{ pageSize }` | `{ items: NewsRawItem[] }` |

`dataAsOf` / 空结果口径是 binding 契约的一部分，不允许由通用 registry 猜测：

| capability | success 的 `dataAsOf` | 空/部分结果 |
|---|---|---|
| market 各能力 | 保留现有 binding 提取规则 | 保留现有语义 |
| `limit-up-ladder` | source 返回的 `observedAt`；历史日为该交易日收盘时刻，当日为 `min(fetchedAt, closeAt)` | 合法空池为 success，但 `dataAsOf` 仍为 source 实际观测时刻；非交易日 manager 早退，不进入 registry |
| `dragon-tiger-list` | 同上，且返回信封日期必须等于请求日期 | 合法空榜为 success；信封错日为 `invalid_payload` |
| sentiment 两池 | `ok:true` pool 的 `observedAt` | `ok:false` 按 error kind 记 failure；`unsupported_date` 记 ignored 并继续尝试其它源 |
| `northbound-flow` | 实际 `entries` 最后一条交易日的收盘时刻 | 空序列 success 但无 `dataAsOf`，freshness 为 unknown；不得使用请求 `endDate` 冒充数据日期 |
| `finance-news` | 返回 items 中最大的 `published_at` | 空列表 success 但无 `dataAsOf`，freshness 为 unknown |

### 6.3 领域 manager 的改动面

除 sentiment 外仅替换源循环：`for (const source of [primary])` → `for (const handle of registry.sources(cap))`；交易日门控、节假日历、PIT 落库、warnings 组装全部保留。带 source 维度缓存的 manager 在每个 handle 的循环内用 `handle.source` 查写缓存，不能在路由前用可选 `query.source` 生成伪 key。sentiment 把原来一次 `source.fetch()` 拆成 sealed/broken 两个 capability 的独立选择循环，以保留跨源池级拼装。发生外部读取时，所有 manager 都把成功 handle 的 `source` 写入结果；`status()` 直接委托 `registry.describe()`。

### 6.4 状态读模型聚合

- `datasets` 是统一观测的权威出口：聚合 market registry、stock-universe checkpoint 以及当前 context 中五个非行情 manager 的 `status()`；manager 端口的 `status()` 为必填，未装配某个可选 manager 时才不产生对应 inventory；
- `providers` 保持现有“关注股票 PriceSnapshot 新鲜度”兼容语义，不冒充供应商全能力健康。只提供非行情能力的源可能在 `providers` 为 `unknown`，其真实状态看 `datasets`；后续若要供应商级聚合，应新增独立字段而不是混用不同 dataset 的阈值；
- `datasets.freshness` 严格采用 §4.3 状态机和逐 dataset 阈值，不再回退到 `lastSuccessAt`。

## 7. 迁移与兼容性

- 五个域的用户可见字段形状（ToolResult、Web API、`ok:false` 的 error.kind 字面值）不变；source 字段从单字面值兼容扩宽，但仅 eastmoney 配置下输出仍为 `eastmoney`；
- `LUOOME_*_SOURCES=eastmoney` 与缺省行为等价；存量 `.env` 无需迁移；
- 存量显式传 `source: 'eastmoney'` 的请求继续只走 eastmoney；未传 source 的请求按 env 顺序路由；
- adapter 解析断言迁移到各领域纯解析函数，`EastmoneySource` 测试验证 URL 构造、client 调用与 parser 委托；manager 测试改为注入 registry/fake binding，不保留仅供测试使用的旧 adapter 构造兼容层；**不允许放宽业务断言**。

## 8. 安全与副作用

- 不新增出向 IO 类型；eastmoney 各端点均为公开无鉴权数据，共享实例不引入凭据面；
- 观测数据不含 payload，仅时间戳与 kind；
- 不触碰 Trade / Advice / WatchTrigger 链路。

## 9. 测试与验收

### 9.1 单元

1. `SourceRegistry` 泛型：重复绑定抛错、`configurationReady=false` 抛错、路由顺序；`success` / `failure` / `ignored` 三种 resolved outcome 与异常 outcome；`success → failure → success` 的时间戳、旧 `dataAsOf` 保留和错误清除；
2. `eastmoney/client.ts`：主动超时、fetch 拒绝、401/403、429、5xx、无效 JSON、上游业务错误逐项映射到结构化 `SourceExecutionError.kind`；
3. `EastmoneySource`：market + 五个非行情域的方法委托到正确 URL/解析函数，复用现有六个 adapter 的解析断言；
4. 词表：`SourceErrorKind` 为唯一来源，legacy result kind 映射表逐条断言，未知异常稳定收口为 `upstream_error`；
5. `SourceIdSchema` 与 query 语义：未传 source 按配置顺序、显式 source 只尝试该源、未启用源返回既有错误、fallback 成功后结果记录实际 source；
6. `dataAsOf`：逐 capability 覆盖 §6.2 表中的正常、空、错日、partial/ignored 情形。

### 9.2 集成

- 每个域：fake binding 注入 registry，验证降级顺序、实际 source provenance 与 `status()` 输出；
- sentiment：主源单池失败时只对该池 fallback，两个 dataset 各自记录成功/失败，最终快照 warnings 与存量语义一致；
- factory：注入共享 `EastmoneySource` 时不再自行构造；未知/重复源名启动期抛错；
- status tool：先成功再失败时 freshness 为 unavailable 且保留旧 `dataAsOf`，再次成功后恢复；`lastSuccessAt` 不作为 freshness 的替代数据时间；
- Web：仅修改来源顺序时复用 `SourceSet`；source client 配置变化时完整 candidate 图原子替换，失败不污染旧图。

### 9.3 合约与回归

- `bun run test:all` / `bun run typecheck` / `bun run lint` / `bun run build` 全绿；
- `get-market-data-status` 输出包含五个非行情域的全部 capability dataset；有真实数据时间的调用后为 `fresh`/`stale`，合法空结果保持 `unknown` 而不伪造 `dataAsOf`。

### 9.4 端到端验收清单

- [ ] 真实环境下 ladder / dragon-tiger / sentiment 两池 / northbound / news 各调一次后，状态读模型显示与 §6.2 一致的 freshness 与 `dataAsOf`；
- [ ] dragon-tiger 先成功、再断网失败：状态显示 `unavailable`、`lastErrorKind=network`，同时保留上次 `dataAsOf`；网络恢复成功后错误清除；
- [ ] sentiment 只断开 broken-pool：sealed dataset 仍为 fresh，broken dataset 为 unavailable，业务快照保持 partial/warnings；
- [ ] Web 设置页只修改行情源顺序后，Eastmoney 实例未重复创建，无关 manager 缓存未清空；
- [ ] 浏览器验证状态页五域展示，`providers` 与 `datasets` 的兼容语义无混淆。

## 10. 文件变更清单

新增：
- `packages/adapters/src/source-registry.ts`（泛化核心，自 `market/source-registry.ts` 迁移）
- `packages/adapters/src/source-error.ts`（`SourceExecutionError`，供所有供应商 client/解析器复用）
- `packages/adapters/src/eastmoney/client.ts`、`coercion.ts`、`source.ts`
- `packages/core/src/source.ts`（`SourceIdSchema`、`SourceErrorKindSchema`、`SourceStatus`）
- 对应测试

修改：
- `market/source-registry.ts` → 薄壳别名 + market capability map
- `market/{eastmoney,tencent,sina,tushare}.ts` 与 `tushare/client.ts` 错误路径迁移到 `SourceExecutionError`（第一刀增量①的一部分，避免 registry 长期并存两套错误判定）
- 五个非行情域的 `factory.ts`（sources 数组 + registry 装配 + 注入）、`manager.ts`（源循环替换 + `status()`；sentiment 拆双 capability）
- 六个现有 `*/eastmoney.ts`：保留 URL 模板与纯解析函数，移除 adapter 类、fetch/timeout 与重复 coercion；由 `eastmoney/source.ts` 委托
- `packages/core/src/context.ts`、`index.ts`（五个 `*ManagerLike.status()` 与共享 source 类型导出）
- `packages/core/src/entity/{limit-up-ladder,dragon-tiger,northbound-flow,news}.ts`（通用 `SourceIdSchema`、可选 query source、结果 source 兼容扩宽）
- `packages/tools/src/tools/get-market-data-status.ts`（五域真实观测聚合 + freshness 状态机）
- `apps/web/src/server.ts`、`packages/cli/src/context.ts`、`packages/mcp/src/context.ts`（共享实例接线）
- `.env.example`、ARCHITECTURE §4.7/§4.8、CONTEXT.md（已登记）、fuyao 设计文档 §11

删除：
- 六个旧 `EastmoneyXxxAdapter` 类及其重复传输代码；领域解析文件本身不删除，避免丢失 locality。

不动：`MarketDataManager` 编排骨架、DB、tool 输出字段形状、TUI。

## 11. 评审焦点（供 Codex 评审时重点挑战）

1. **泛化 vs 复制的临界点**：`SourceRegistry<CapabilityMap>` 的泛型代价是否值得？替代方案是每域复制 180 行 registry。
2. **`observationOf` 契约**：要求每个 binding 显式分类 success/failure/ignored 的样板成本，是否值得换取确定的状态转换？
3. **EastmoneySource 的边界**：纳入 news 后的 god-class 风险是否仍被“无领域状态 + 解析外置 + client 共享”充分约束？
4. **source 身份兼容扩宽**：`SourceIdSchema` 使用开放字符串、factory 使用封闭已注册列表，是否是合适的稳定端口/启动校验分工？
5. **错误词表**：`adapter_error → upstream_error` 等观测映射是否保留了足够语义，同时又不改变业务 result 契约？
6. **共享实例热更新**：只改路由顺序时复用实例、client 配置变化时原子替换完整依赖图，是否覆盖未来设置项？
7. **coverage 边界**：通用 registry 仅保存 `readonly string[]`，market 薄壳负责 `MarketCoverage` 过滤，是否足够类型安全？

## 12. 验收原则

- 本次重构后，为非行情域添加第二个数据源 = 实现 source 能力切片 + factory 加 binding/已注册 source id + env 追加源名，不动 manager、不动 core/tool/surface；
- 发生外部读取的结果 provenance 永远来自实际成功 handle，不由请求默认值伪造；本地日历早退按 §4.6 明确标识；
- 本次范围内所有域的源健康在同一个 `datasets` 读模型可见，词表单一来源，部分失败不被整体成功掩盖；
- 存量行为不变由全量既有测试证明；新增 source 身份、观测状态机和热更新语义由新增测试证明，不由人工抽查替代。
