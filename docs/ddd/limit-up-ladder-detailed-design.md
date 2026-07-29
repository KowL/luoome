# 连板天梯详细设计：A 股涨停梯队快照（tool + 缓存 + 端到端）

> 状态：Phase 1 实施稿（PRD §10 已确认三阶段范围；本文实现 Phase 1 主体并对齐 Phase 2/3 演进路径）
> 日期：2026-07-25
> 需求：[连板天梯产品文档](../prd/limit-up-ladder-product.md)
> 数据源：东方财富公开涨停池（`GET https://push2ex.eastmoney.com/getTopicZTPool`，无鉴权；2026-07 由原私有行情服务 `/market/limit-up/ladder` 迁移而来）
> 关联 DDD：[Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)

## 目标

让用户在交易日的任一时刻通过 TUI / Web / CLI 看清 A 股今天的涨停梯队（最高多少板、龙头股是谁、每个层级有谁、它们的封板时间与涨停原因），同时让报告、StockGroup / WatchPlan、LLM 复盘链、未来的策略预警规则都能从同一个稳定 tool 读取结构化数据。

## 已确认决策

- **不落库**：天梯快照走 cache adapter，不写 DB。理由：(1) ruo 旧实现已验证现拉现算 + 修正 + 展示闭环不需要 DB；(2) 盘中数据每日刷新，落库引入"快照失效 vs 用户期望时效"的二义性；(3) 报告/StockGroup/LLM 复盘链只读需求都能用 cache 满足。落库留作未来事件审计需要时另立任务。
- **来源显式注册**：Phase 4 起由 `LUOOME_LIMIT_UP_LADDER_SOURCES` 列出实际来源，默认且当前唯一注册值为 `eastmoney`；公开 API 无鉴权。已确认不接 amazingdata，无隐藏 fallback；未知来源启动失败，上游不可达时返回 `adapter_error`。
- **修正规则下沉 core**：8.58% 涨幅回推 `price` 在 core 层完成；adapter 仅做协议层解析。新主源无 `high` 字段，§6.4 修正不再触发，但逻辑保留（兼容未来重新暴露 `high` 的数据源）。
- **保持单一权威日期**：tool 入参 `date` 是请求方关心的交易日；adapter 不做"今天 → 昨天"自动回退（避免报告日期与数据日期错位，PRD §2.2 第一行问题）。
- **修正字段必须可追溯**：暴露修正后 `price`、原始 `rawClose`、`corrected` 三字段；不允许静默改写（PRD §5.6）。
- **天梯不替其它模块承担职责**：StockGroup / WatchPlan、报告 LLM 输入、策略预警触发都各自有 tool，天梯只暴露只读快照，**不**为这些模块改变输出顺序或参与写入路径（PRD §4.6）。
- **缓存策略分时段**：盘中 TTL 60s（与现有 quote 缓存一致）；收盘后 key 内嵌 `date`，只要还在同一日 + 同进程就持续命中，跨日自动失效；非交易日 / 盘前 `date ≠ today` 的请求同样长期命中（历史回看场景）。这避免了"缓存 1 小时还是 8 小时"的人为硬切（PRD §14 D3）。
- **Web 不在 Phase 1**：避免 PRD §14 D4 的"两套数据来源并行"风险，先 TUI/CLI 单数据源跑稳。**Phase 2 起**：TUI/CLI 跑稳后接入 Web `apps/web/public/index.html + js/limit-up-ladder.js`，由 web 调 `/api/market/limit-up` 走同一 manager。

## 现状（已核实）

- 无 `LimitUpLadder` / `LimitUpLadderEntry` 实体与表（`packages/core/src/entity/` 现有 23 个实体，无天梯）。
- 原基于私有行情服务的 SDK 包、ladder adapter 与 `EastmoneyLimitUpPoolEnricher` 已随主源切换移除；天梯协议层由 `EastmoneyLimitUpLadderAdapter`（`packages/adapters/src/limit-up-ladder/eastmoney.ts`）直连东方财富公开涨停池承担，无独立 SDK 包。
- adapters 市场层（`packages/adapters/src/market/`）有 `MarketDataAdapter` + `MarketDataManager`（Eastmoney 主 → Tencent 备），**不**承载天梯业务；天梯特征是"日级批量快照"而非"实时 quote 流"，合用但语义不同。
- core 已有 `MarketDataAdapterLike`（surface 组装根统一调 `createMarketAdapterFromEnv`），天梯不通过此接口注入——独立加 `LimitUpLadderAdapter`。
- tool 目录无天梯 tool；现 `run_tactic`、`batch_quote` 等 read 类 tool 走 `ctx.tools.*` 调用（`packages/tools/src/tools/` 已有 33 个 tool）。
- `intraday-watch` workflow 已在仓（`packages/workflows/src/intraday-watch.ts`），提供"workflow 只通过 `ctx.tools.*` 编排"的范式样板。
- `clack feishu` 通知通道已就绪，但天梯本身是只读快照，**不**直接触发通知（仅通过"报告"等下游 workflow 联动）。
- cache adapter 在 `packages/core/src/cache`（已存在的 TTL cache，详见 ARCHITECTURE §4.7 "缓存 (带 TTL)"）；天梯直接复用，不再造轮子。
- 用户时区硬约束：A 股交易日判定用 `Asia/Shanghai`；DB 时区不参与。

## 设计

### 1. core：实体与 schema（`packages/core/src/entity/limit-up-ladder.ts`，新建）

```ts
export type LimitUpBoard =
  | 'main_board'      // 沪深主板
  | 'chinext'         // 创业板 30x
  | 'star'            // 科创板 688x（默认排除，仅在 includeStar=true 时出现）
  | 'bse';            // 北交所 8x/4x（默认排除，仅在 includeBse=true 时出现）

export type LimitUpLadderSource = 'eastmoney';   // 当前唯一数据源；保留枚举便于将来扩展

export interface LimitUpLadderEntry {
  readonly code: string;                // 600xxx / 000xxx / 300xxx
  readonly name: string;                // 名称缺失时回退到 code
  readonly industry: string;            // 缺失显示 'unclassified'
  readonly ladderLevel: number;         // 1 = 首板，N = N 连板
  readonly uncategorized: boolean;      // level 来源无法判定时为 true（PRD §5.2）
  readonly firstTime: string | null;    // HH:MM:SS；缺失为 null
  readonly finalTime: string | null;    // HH:MM:SS；缺失为 null
  readonly reason: string;              // 题材/概念；缺失为 ''
  readonly price: number;               // 修正后的收盘价
  readonly rawClose: number;            // 数据源返回的原始 close（eastmoney 池 `p/1000`）
  readonly corrected: boolean;          // true = 命中 §6.4 修正条件
  readonly changePct: number;           // 小数，0.10 = 10%
  readonly limitUpDate: string;         // YYYY-MM-DD；理论上 == date
  readonly board: LimitUpBoard;
}

export interface LimitUpLadderLevel {
  readonly level: number;
  readonly name: string;                // '首板' / 'N 连板'
  readonly count: number;
  readonly stocks: readonly LimitUpLadderEntry[];
}

export interface LimitUpLadder {
  readonly date: string;                // YYYY-MM-DD，请求方关心的基准日
  readonly total: number;               // entry 去重计数
  readonly maxLevel: number;            // 最深 level
  readonly source: LimitUpLadderSource;
  readonly levels: readonly LimitUpLadderLevel[];
  readonly warnings: readonly string[]; // 字段缺失/修正提示
  readonly asOf: Date;                  // manager 拉取时间（缓存 key 辅助）
}

export interface LimitUpLadderQuery {
  readonly date: string;                              // YYYY-MM-DD，必填
  readonly source?: LimitUpLadderSource;              // 默认 'eastmoney'
  readonly days?: number;                             // 样本窗口，默认 15
  readonly includeUncategorized?: boolean;            // 默认 false；true 时 uncategorized=true 的 entry 才出现
  readonly includeStar?: boolean;                     // 默认 false；true 时允许科创板
  readonly includeBse?: boolean;                      // 默认 false；true 时允许北交所
  readonly includeST?: boolean;                       // 默认 false；true 时允许 ST 股票
}

export interface LimitUpLadderDiff {
  readonly totalDelta: number;
  readonly maxLevelDelta: number;
  readonly topLevelAdded: readonly string[];          // code 列表
  readonly topLevelRemoved: readonly string[];
  readonly topLevelRetained: readonly string[];
}
```

- 派生 Zod schema（`LimitUpLadderSchema` / `LimitUpLadderEntrySchema` / `LimitUpLadderLevelSchema` / `LimitUpLadderDiffSchema`）与 TypeScript 类型严格对齐。
- `assertLimitUpLadderInvariants(h)`：
  - `date` 合法 `YYYY-MM-DD`（`/^\d{4}-\d{2}-\d{2}$/`）
  - `total === 去重 entry 数`（即便某只 entry 在多个 level 出现——目前约束：同一 entry 只入最深 level）
  - `maxLevel === max(levels[].level)` 或 `maxLevel === 0` 当 `levels.length === 0`
  - 单 entry：`ladderLevel >= 1`、`price > 0`、`rawClose > 0`、`changePct ∈ [-0.35, 0.35]`（覆盖北交所 30% + 20cm 涨停浮点零头，实测 0.2002；原 ±0.20 硬顶会把真实 20cm 数据挡在 schema 外）
  - 单 entry：`firstTime` / `finalTime` 为 `null` 或 `HH:MM:SS`
  - 单 entry：`limitUpDate === date`（强制与请求基准日一致；若 adapter 返回不同——理论上不该发生——把这条 entry 降级到 `uncategorized=true` 且 `warnings` 追加 `"mismatched limitUpDate"`，但 **不** 静默丢弃）
- `board` 由 code 前缀派生（表 §5.2 PRD）：
  | code 前缀 | board |
  |---|---|
  | 600/601/603/605（SH）/ 000/001/002/003（SZ） | `main_board` |
  | 300/301 | `chinext` |
  | 688/689 | `star`（默认排除） |
  | 8/4 | `bse`（默认排除） |
- `industry === 'unclassified'` 时不返回 `null`，用哨兵字符串避免 nullable 的传播；同样适用于 `name`、`reason`。
- `uncategorized` 区分两种情况：(1) 数据源未给出 level 字段（eastmoney 池缺 `lbc`）；(2) 同股票跨多日 reorg 后无法判定是否首板。两者都打 `uncategorized=true` 但保留在 `levels[0]`（首板层级）—— 这是 fallback，不让请求方零回报。
- 序列化输出时 entry 中已修正 `price` + 原始 `rawClose` + `corrected=true` 暴露为三个独立字段（PRD §5.2）。

### 2. core：辅助函数

- `deriveBoard(code: string): LimitUpBoard`：基于 code 前缀的三字符判定，与 §1 同表，**不**引入外部依赖。
- `isLimitUpLadderTradingDay(date: string, holidays: readonly string[]): boolean`：复用统一交易日日历；非交易日早返回，`levels: []`、`total: 0`、`maxLevel: 0`、`warnings: ['non-trading-day']`。
- `filterAndDedupe(entries, opts): LimitUpLadderEntry[]`：按 `opts.includeStar` / `includeBse` / `includeST` 过滤 ST 股票（名称前缀 `ST`/`*ST`），同一 code 只保留最深 level 的 entry；ST 股票判定**仅看名称前缀**，与策略预警产品文档 §5.2 一致。

### 3. eastmoney 协议层：公开涨停池 `getTopicZTPool`（`packages/adapters/src/limit-up-ladder/eastmoney.ts`）

- 协议层与业务 adapter 合一，不做修正、不过滤、不缓存；只把东方财富公开涨停池响应解成 `LimitUpLadderRawEntry[]`。
- 请求：`GET https://push2ex.eastmoney.com/getTopicZTPool?ut=<公开网页端 token>&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=<YYYYMMDD>`；无鉴权（`ut` 为 eastmoney 网页端公开 token，非私有凭据）。`date` 发送前去掉 `-`，默认超时 10s。
- **`days` 参数被忽略**：连板数由 pool 的 `lbc` 直接给出，不需要样本窗口。
- 远端响应契约：`data.pool[]` 为涨停股票列表（非交易日 / 无数据时 `data` 为 `null` 或 `pool` 缺失 → 空梯队），单条字段映射：

  | pool 字段 | 含义 | 映射 |
  |---|---|---|
  | `c` / `n` | 代码 / 名称 | `code` / `name`（`n` 空则缺失） |
  | `p` | 最新价 ×1000 | `close = p / 1000`；非法值跳过该条 |
  | `zdp` | 涨跌幅 ×100（百分数） | `change_pct = zdp / 100`；并反推 `pre_close = close / (1 + change_pct)` |
  | `lbc` | 连板数（首板 = 1） | `level` / `limit_up_days` |
  | `fbt` / `lbt` | 首次 / 最后封板（HHMMSS int；0/null 缺失） | `first_time` / `final_time`（`HH:MM:SS`） |
  | `hybk` | 行业板块 | `industry` |

- **无涨停原因字段**：`reason` 由 manager 归一为 `'--'` 哨兵；**无 `high`**：§6.4 收盘价修正不再触发（逻辑保留，见 §4.3）。
- 错误处理：网络错误 / 非 2xx / 非 JSON 响应直接抛错，Manager 层捕获后返回 `adapter_error`（无 fallback）；单条字段非法（缺 `c`、非法 `p`）跳过该条，不阻断整体。

### 4. adapters：business adapter + Manager（`packages/adapters/src/limit-up-ladder/`，新建）

不放在 `market/` 下，理由：天梯是"日级批量聚合"，quote 是"实时单/批查询"——特征不同放一起会让 manager 配置混淆。统一由 `adapters` 包桶导出。

```
adapters/src/limit-up-ladder/
├── manager.ts            # LimitUpLadderManager: 缓存、修正、过滤去重
├── eastmoney.ts          # EastmoneyLimitUpLadderAdapter（主源，协议层见 §3）
├── factory.ts            # createLimitUpLadderManagerFromEnv 装配根（§5）
├── lru.ts                # TTL/LRU 缓存实现
├── types.ts              # LimitUpLadderAdapterLike 接口
└── manager.test.ts / eastmoney.test.ts / factory.test.ts
```

#### 4.1 `types.ts`

```ts
export interface LimitUpLadderAdapter {
  readonly name: string;                 // 错误 / 日志标识（当前仅 'eastmoney' 实现）
  fetchLadder(date: string, opts?: { days?: number }): Promise<{
    date: string;
    entries: LimitUpLadderRawEntry[];
  }>;
}
```

#### 4.2 `eastmoney.ts`：薄封装，**不**做修正

```ts
export class EastmoneyLimitUpLadderAdapter implements LimitUpLadderAdapter {
  readonly name = 'eastmoney' as const;
  constructor(fetchImpl?: typeof fetch, timeoutMs = 10_000) {}

  // fetchLadder 契约见 §3：直连 getTopicZTPool，字段天然齐全
  // （close/pre_close/level/first_time/final_time/industry），days 参数忽略
}
```

#### 4.3 `manager.ts`：核心编排

```ts
interface ManagerOptions {
  readonly primary: LimitUpLadderAdapter;
  readonly fallback?: LimitUpLadderAdapter;            // 默认 undefined；缺省不启用 fallback
  readonly cache: TTLCache<LimitUpLadder>;             // 注入，构造时由 core 解析
  readonly clock: () => Date;                          // 业务时钟，方便测试
  readonly logger: Logger;
  readonly holidaysLoader?: () => readonly string[];   // 注入，复用 intraday-watch 的三层 union
}

export class LimitUpLadderManager {
  async fetchLadder(query: LimitUpLadderQuery): Promise<LimitUpLadder> { ... }
  async compareLadder(date: string, prevDate: string, query: Omit<...>): Promise<...>;
}
```

**§6 缓存策略**：

- key：`${query.date}|${query.source}|${query.includeStar ? 's' : ''}|${query.includeBse ? 'b' : ''}|${query.includeST ? 't' : ''}|days=${query.days ?? 15}` —— 不含 `includeUncategorized`，因为 uncategorized 是 entry 级展示过滤，不影响 manager 内部数据。
- TTL 动态计算（同步 §"已确认决策"最后一条）：
  ```ts
  function computeTtl(queryDate: string, now: Date, tradingDayNow: string): number {
    if (queryDate !== tradingDayNow) return Infinity;    // 历史 / 跨日：进程内永久命中
    const sh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const minutes = sh.getHours() * 60 + sh.getMinutes();
    const inSession = (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30)
                   || (minutes >= 13 * 60 && minutes < 15 * 60);
    return inSession ? 60_000 : Infinity;                // 盘中 60s，午后收盘后永久
  }
  ```
  > 收盘判定用 15:00 是简化值；如果当天有延迟收盘（最后交易日）由调用方负责——manager 不读国办通知。
- 主源失败时按 ARCHITECTURE §4.7 `MarketDataManager` 的模式 (`finalFallbackSuppressMs`) 把"已失败"状态短期抑制，避免 5 秒内多次重试打到对端。

**enricher 已随主源切换移除**：原 `EastmoneyLimitUpPoolEnricher`（`eastmoney-pool.ts`）用于补齐旧主源缺失的 `firstTime` / `finalTime` / `industry`；切换后 `EastmoneyLimitUpLadderAdapter` 天然带齐这些字段（`fbt`/`lbt`/`hybk`，见 §3），manager 不再有 enricher 选项，factory 也不再装配。

**§6 修正规则**（PRD §5.6）：

```ts
function applyCloseCorrection(
  entries: LimitUpLadderEntry[],
  fetchTime: Date,
): LimitUpLadderEntry[] {
  return entries.map(e => {
    if (e.rawClose === e.high &&                         // rawClose 与 high 相等
        (e.rawClose - prevClose) / prevClose >= 0.098 &&
        (e.rawClose - prevClose) / prevClose < 0.10) {
      const correctedPrice = prevClose * 1.0858;
      return { ...e, price: correctedPrice, corrected: true };
    }
    return { ...e, price: e.rawClose, corrected: false };
  });
}
```

> 新主源 eastmoney 涨停池无 `high` 字段（raw entry 的 `high` 恒缺失），触发条件 `rawClose === high` 不成立，§6.4 修正在当前数据源下不触发；逻辑保留以兼容未来重新暴露 `high` 的数据源。

**去重与过滤**：调用 §2 的 `filterAndDedupe`。

**§6.5 异常与空态映射**（PRD §6.5）：
- 远端返回空 `entries[]`（`data` 为 `null` 或 `pool` 为空）：直接返回 `{ date, total: 0, maxLevel: 0, levels: [], warnings: ['empty-ladder'], ... }`，manager **不**自动回退到昨天。
- 请求日 = 非交易日：在解析 `LimitUpLadderRawEntry[]` 之前判定 `isTradingDay(date)`，直接返回空 ladder + `warnings: ['non-trading-day']`。
- 主源抛错：捕获 adapter 错误，log warn；无 fallback 可尝试，直接向上抛 `ToolError(kind: 'adapter_error', adapter: 'limit-up-ladder', ...)`。面向用户的诊断文案为"请检查到东方财富行情服务的网络连通性"。
- 字段缺失（`name` / `industry` / `firstTime` / `reason` 等）：不抛错，按 §1 哨兵字符串填充，并在 entry 旁附 `uncategorized` / `warnings`。

### 5. surface 装配根（`packages/adapters/src/limit-up-ladder/factory.ts`）

- `createLimitUpLadderManagerFromEnv(env, deps)`：与 `createMarketAdapterFromEnv` 同模式（位置与签名风格对齐）。
  - Phase 4 起读取 `LUOOME_LIMIT_UP_LADDER_SOURCES`，默认 `eastmoney`。当前只注册东方财富公开涨停池且无鉴权；未知来源在启动期失败，不做隐式 Eastmoney fallback。
  - 不引入 provider/fallback 两套变量；来源顺序统一由一个显式列表表达。
  - **始终装配真实 manager**：原 Phase 2 的"私有服务 URL 缺失 → 软失败 manager"行为已随主源切换移除（公开 API 无配置前置条件）；上游不可达在调用期以 `adapter_error` 表现。
  - 返回 `LimitUpLadderManager`。
- `packages/adapters/src/index.ts` 桶增加 `export * from './limit-up-ladder/index.js'`。

### 6. core：Repository（**不**落库决策记录）

- PRD §9.2 提到 `LimitUpLadder` / `LimitUpLadderEntry` schema 进 `core`；本文不增 `LimitUpLadderRepository`。
- 理由：manager 自身缓存已经满足"同一日同一请求可被下游引用"的需求；落库会增加 migration 风险与归档语义，且当前所有下游消费者都是"请求当下看"或"本次 workflow 内对比"，无持久需求。
- **后续触发器**：若 Phase 3 策略预警规则需要"基于历史天梯比对"，manager 通过 `compareLadder(date, prevDate)` 拿到 diff 即可；勿将 `LimitUpLadder` 落库。

### 7. tools：tool 注册（`packages/tools/src/tools/limit-up-ladder.ts`，新建）

| tool | sideEffect | 说明 |
|---|---|---|
| `limit_up_ladder` | read | 入参 `LimitUpLadderQuery`；出参 `LimitUpLadder`；`workflow` / agent 均可调用 |
| `limit_up_ladder_compare` | read | 入参 `{ date, prevDate, source?, days? }` + 过滤 flags；出参 `{ curr, prev, diff }`；Phase 2 起（PRD §8.2） |

```ts
export const LimitUpLadderInput = LimitUpLadderQuerySchema;
export const LimitUpLadderOutput = LimitUpLadderSchema;

export const limitUpLadderTool = defineTool({
  name: 'limit_up_ladder',
  description: '拉取指定交易日 A 股（主板+创板，可选科创/北交所/ST）的涨停梯队快照。返回不可变快照。',
  sideEffect: 'read',
  input: LimitUpLadderInput,
  output: LimitUpLadderOutput,
  handler: async (input, ctx) => {
    const manager = ctx.adapters.limitUpLadder;        // 新增 AdapterRegistry 字段
    return manager.fetchLadder(input);
  },
});
```

```ts
export const LimitUpLadderCompareInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prevDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(['eastmoney']).default('eastmoney'),
  days: z.number().int().positive().default(15),
  includeUncategorized: z.boolean().default(false),
});

export const LimitUpLadderCompareOutput = z.object({
  curr: LimitUpLadderSchema,
  prev: LimitUpLadderSchema,
  diff: LimitUpLadderDiffSchema,
});

export const limitUpLadderCompareTool = defineTool({
  name: 'limit_up_ladder_compare',
  description: '对比两日 A 股涨停梯队快照。给报告 / 仪表盘使用。',
  sideEffect: 'read',
  input: LimitUpLadderCompareInput,
  output: LimitUpLadderCompareOutput,
  handler: async (input, ctx) => manager.compareLadder(input.date, input.prevDate, input),
});
```

- ToolError 映射：
  - `parse_error` → 请求 `date` 不合法 → `invalid_input`
  - eastmoney 涨停池网络错误 / 超时（无 fallback）→ `adapter_error(adapter='limit-up-ladder', recoverable=true)`
  - eastmoney 涨停池非 2xx 响应 → `adapter_error(adapter='limit-up-ladder', recoverable=false)`
  - 空 ladder 不是错误，**不**抛 ToolError。
- 注册到 `toolRegistry`，并 `WorkflowToolMap` 补 2 行类型映射（MCP 默认 read 类暴露，落地即可被对话侧用上）。

### 8. AdapterRegistry（`packages/core/src/repository/index.ts`，改）

```ts
interface AdapterRegistry {
  market: MarketDataAdapterLike;
  llm: LLMAdapter;
  notification: NotificationAdapter;
  limitUpLadder: LimitUpLadderManagerLike;       // 新增，Manager 通过 Like 接口暴露给 tool
}
```

### 9. workflows：报告 / StockGroup 联动（Phase 2）

**当前架构重审**：PRD §10 提到的 `watchlist refreshTop10` 已由 Strategy → Watchlist source sync 替代，单独的「TOP10 排序」不再存在。

- `daily-review` workflow LLM 输入段：替换为 `limit_up_ladder_compare(...)` 的结构化输出。**Phase 2 实现**（已落地，见 `packages/workflows/src/daily-review.ts` stepLadder）。
- `market-outlook` workflow：在「市场概况」step 之后追加 `limit_up_ladder` 的可选调用，把快照作为 LLM 复盘段的事实来源。Phase 2-3 评估是否做。
- Strategy / AlertPlan 接入：ladder level 可作为未来 Strategy 数据字段；本任务不实现。

> **ruo 旧实现警告**：ruo 旧 adapter 直接 fetch 私有行情服务后做 TOP10 排序，并在 `watchlist.refreshTop10` 中混用「页面排序 / 决策排序」同一份数据 — 是 PRD §2.2 错误隔离的反模式。luoome 把这两类用途（页面展示 vs 算法输入）解耦到不同 tool，且 TOP10 排序本身被分到 watch plans / stock groups 的语义 — **不应再有任何模块绕过 `ctx.tools.limit_up_ladder` 直接读天梯上游数据（现为东方财富涨停池）**。

### 10. TUI 接入（Phase 1，README §7.2）

- 在 opentui 现有"市场"面板增加快捷键 `L` → 进入"涨停梯队"子视图。
- 子视图组件 layout：与 Web 同构（§11），但每层只显示前 3 只，超出显示 `<N> 只未显示，Enter 展开`。
- 数据来源：进入子视图时调 `limit_up_ladder` tool（Phase 1 直接 ctx，过渡期可走 mcp 转发）；按 `r` 键重跑。

### 11. Web 接入（Phase 2 起，本节为布局参考）

PRD §7.1 已经给出页面骨架，本文不再重复 ASCII 简图；Phase 2 实现时：

- 路由：`/market/limit-up`，同侧栏 `/market/overview` 同级；query string `?date=YYYY-MM-DD`。
- 服务端 API：`GET /api/market/limit-up?date=...`，内部调 `limitUpLadder` tool；响应契约与 tool schema 完全一致。
- 缓存层：服务端跑一次 `LimitUpLadderManager.fetchLadder`，命中既存 cache；web 层不再加二级缓存。
- 文案：`levels` 为空 + `warnings.includes('non-trading-day')` → "该日为非 A 股交易日"；`warnings.includes('empty-ladder')` → "今日数据暂未更新，最新可看日期为 <最新交易日>"；`warnings.includes('upstream-unavailable')`（manager 抛错转换） → "行情服务暂不可用，请稍后重试"。
- corrected 角标：表格现价列右侧加灰色小角标"已修正"，hover 提示"`rawClose=<N>，按 8.58% 回推`"。

### 12. CLI 接入（Phase 1，`packages/cli/src/market-limit-up.ts`，新建）

```text
luoome market limit-up [--date YYYY-MM-DD] [--source eastmoney]
                       [--days N] [--include-star] [--include-bse] [--include-st]
                       [--include-uncategorized] [--json]
```

- 默认 `date` = Asia/Shanghai 今天；与 PRD §7.3 一致。
- `--json` 输出 tool schema 一致的 JSON；非 `--json` 走 ruo 兼容的终端表格（`market.ts:111-148` 风格但去除服务端日期兜底）。
- 在 `packages/cli/src/index.ts` 注册 `market` 子命令并复用 `market-overview` 共享的 `parseTradingDate` helper（arch 现有 utility）。

### 13. 与现有页面 / 工具的连接点

- **个股详情（v0.8 已有 `/stocks/:id`）**：在"事件"区追加"近 30 个交易日涨停日 + 当时 level + 原因"——实现走天梯 manager **30 天窗口**一次性拉齐，再做日期过滤。Phase 3 实现（PRD §10）。
- **分组详情（动态分组如"涨停"）**：分组卡片顶部展示"今日在天梯中的最高 level"；同样 Phase 3。
- **报告页**：本 PDF 报告 workflow 已在 daily-review 内；Phase 2 改造其 LLM 输入段（§9）。
- **TOP10（旧 ruo）→ Strategy 候选**：天梯 `code → level` mapping 可作为未来 Strategy 输入字段；本文档不再单独跟踪旧刷新链。

### 14. 调试与观测

- **诊断命令**：`luoome market limit-up --json --date <YYYY-MM-DD>` 直接看 tool 返回；与 web 端响应字段一致便于核对 PRD §11.3 验收。
- **日志**：manager 层 `logger.warn` 记录 (a) 主源失败/重试；(b) rawClose 修正条目比例；(c) 节假日历判定结果；(d) cache hit/miss。
- **埋点**（自建轻量计数，schema 思路与行情源观测一致）：
  - 缓存命中率（cache hit / 总请求）
  - `corrected=true` 占比（当前主源无 `high`，占比恒为 0；若 > 5% 提示数据源行为变化或数据质量下降）
  - 字段缺失率（name / industry / firstTime / reason 各自分子）
- **不引入新指标体系**：复用 core 的 metrics adapter（如果存在），未存在则 Phase 1 不接；走 logger 输出 + 用户自助 grep。

## 实施顺序（实现时）

1. **core：实体 + 不变量 + 派生 schema + 辅助函数**
   - `packages/core/src/entity/limit-up-ladder.ts`（schema + assert + deriveBoard + filterAndDedupe + isTradingDay 接入）
   - 对应 `limit-up-ladder.test.ts`（Zod 合法/非法 + 不变量 + 过滤/去重）
2. **adapters：业务 adapter + Manager**
   - `packages/adapters/src/limit-up-ladder/{types.ts,eastmoney.ts,manager.ts,factory.ts}`（无独立 SDK 包，协议层与 adapter 合一）
   - `manager.test.ts` 覆盖（a）空 ladder 不回退（b）修正规则（c）盘中 60s TTL（d）跨日永久命中（e）主源失败抛 adapter_error（无 fallback）；`eastmoney.test.ts` 覆盖 pool 字段映射与空态
3. **core：surface 装配根**
   - `createLimitUpLadderManagerFromEnv` 不读环境变量，直接装配 `EastmoneyLimitUpLadderAdapter`；带节假日历注入
   - `AdapterRegistry` 加 `limitUpLadder` 字段
   - 同步 `ToolContext.adapters` 类型
4. **tools：tool 主体 + 注册**
   - `packages/tools/src/tools/limit-up-ladder.ts`（两个 tool + Zod）
   - `packages/tools/src/registry.ts` 注册
   - `WorkflowToolMap` 补 2 行
   - 单元测试 `limit-up-ladder.test.ts`：mock manager，验证入参校验、错误映射、空 ladder 行为
5. **TUI 子视图**
   - 新增 `packages/tui/src/views/limit-up-ladder.ts`，主面板 `L` 快捷键绑定
   - 写最小可视化 + `r` 键刷新
   - 验证：起 TUI 跑 mock manager（`bun --filter '@luoome/tui'`)
6. **CLI 命令**
   - `packages/cli/src/market-limit-up.ts` + `index.ts` 注册
   - 单元测试覆盖 `--date`、`--source`、`--json`、`非交易日空态`
   - smoke：`luoome market limit-up --date 2026-07-20 --json` 输出与 tool 完全一致
7. **文档同步**
   - `ARCHITECTURE.md` §5.1 数据模型补充 `LimitUpLadder` / `LimitUpLadderEntry` 实体说明
   - `ARCHITECTURE.md` §8.1 列 Phase 1 不引入新 workflow，Phase 2 起 `daily-review` 改造
   - `docs/README.md` 在 DDD 表增加一行
   - `skills/luoome/references/tools.md` 补充 `limit_up_ladder` 与 `limit_up_ladder_compare` 在"市场数据"桶下
8. **全量验证**
   - `bun run test` —— 包含新 vitest 文件
   - `bun run test:db` —— 不涉及新表，跳过也行；CI 跑一遍确认
   - `bun run test:web` —— Phase 1 无 Web 改动；Phase 2 起 加 `apps/web/src/server.test.ts` 的 limit-up 路由用例
   - `bun run typecheck`
   - `bun run lint`
   - smoke：`luoome market limit-up --date <某个非交易日> --json` 显式空 ladder；`luoome market limit-up --date <真实交易日> --source eastmoney` 拉真数据（需到东方财富行情服务的网络连通）

> **Phase 2 实施（已在 2026-07 完成）**：
> 1. **web 接入** —— `apps/web/src/server.ts` 注入 manager + `GET /api/market/limit-up` 与 `/compare` 端点（`source` 查询参数只接受 `eastmoney`）；`apps/web/public/js/limit-up-ladder.js` 渲染表格 + corrected `*` 角标 + vs 昨日 diff。
> 2. **daily-review workflow** —— `packages/workflows/src/daily-review.ts` 新 step `stepLadder` 拉天梯 + diff，输出 `DailyReviewOutput.ladder: <schema> | null`。
> 3. **TOP10 / StockGroup 接入** —— Phase 2 调研发现 ruo 旧 `watchlist refreshTop10` 在 luoome v0.6+ 已被解构为 `StockGroup` + `WatchPlan` + `StockPool` 三层抽象（无对应单一排序函数）。ladder `code → level` 可作 formula / tactic resolver 输入信号，列入 Phase 3 与策略预警联动一并实现；本文档**不再跟踪 P2-E 单独工单**。
> 4. **数据源迁移（私有行情服务 → eastmoney 涨停池）** —— 主源切换后：factory 不再读任何环境变量、不再有软失败 manager，始终装配真实 manager；enricher（`eastmoney-pool.ts`）删除；CLI / Web 的 `source` 只接受 `eastmoney`；上游不可达时 tool 返回 `adapter_error`，诊断文案改为检查到东方财富行情服务的网络连通性。

## 测试矩阵

| 测试类型 | 覆盖点 |
|---|---|
| 单元（core） | Zod schema 合法/非法；不变量（date 格式、total/maxLevel 关系、changePct 范围）；deriveBoard 全前缀；filterAndDedupe 同 code 多 level 保留最深；ST 前缀过滤；uncategorized 传播 |
| 单元（adapters/eastmoney） | mock fetch 场景（pool 字段映射 c/n/p/zdp/lbc/fbt/lbt/hybk；`data: null` → 空梯队；非 2xx / 非 JSON → 抛错）；`p/1000`、`zdp` 反推 `pre_close`、HHMMSS → `HH:MM:SS` |
| 单元（adapters/manager） | manager 空 ladder 不回退；修正规则 4 个分支；TTL 三段（盘中 60s、收盘后 Infinity、跨日 Infinity）；主源失败抛 adapter_error（无 fallback） |
| 单元（tools） | 入参 schema 校验；error kind 映射；空 ladder 返回与 tool 协议一致；`WorkflowToolMap` 类型映射在 typecheck 通过 |
| 单元（CLI） | `--date` 缺省、显式；`--json` schema 严格对齐；`--source` 非 eastmoney 报错 |
| 集成（仓内） | CLI → tool → manager → eastmoney adapter 端到端 mock；TUI 组件加载不报错（`bun --filter '@luoome/tui'` 起 tsx 渲染单测） |
| 集成（外部） | 到东方财富行情服务连通时跑 `luoome market limit-up --date <最近 A 股交易日>` 与 `curl 'https://push2ex.eastmoney.com/getTopicZTPool?...'` 对照；不可达时 tool 返回 `adapter_error` |
| 不变量回归 | ARCHITECTURE §5.3 advice 全部不变量不受影响（天梯不产出 Advice）；adapter 调用不抛 raw exception，全部经 ToolError |

## 明确不做（Phase 1 冻结）

- 不接入 Web 页面（避免两套数据来源并行）。
- 不联动 `daily-review` / `market-outlook` / `StockGroup` / `WatchPlan`。
- 不接 amazingdata（已确认永不接入；原 throw 占位 adapter 已删除）。
- 不增加 `LUOOME_LIMIT_UP_LADDER_PROVIDER` / `LUOOME_LIMIT_UP_LADDER_FALLBACK` 两套环境变量；Phase 4 后由 `LUOOME_LIMIT_UP_LADDER_SOURCES` 显式列出来源，当前仅支持无需鉴权的 eastmoney。
- 不落库 `LimitUpLadder` / `LimitUpLadderEntry`。
- 不引入个股详情"近 30 日涨停事件"模块（Phase 3）。
- 不支持跨市场（港股 / 美股）；与策略预警 §5.2 一致，仅 A 股主板 + 创板。
- 不复刻同花顺/通达信"封单金额/开板次数"等富字段（PRD §3.4）。
- 不实现 `asOf` 之外的"快照审计"——Phase 2 起真有人需要再开 `LimitUpLadderSnapshotRepository`。
- 不为天梯触发任何通知（即便有高分 level 也不发推送）；与 advisory 边界（PRD §4.6）一致。

## 已知边界与开放决策

- **D1 主线 vs 可选模块**：PRD §14 D1 询问是否纳入主线；本文档默认 A 路径。判定点：v0.8.0 MVP 评审前未提出异议即按 A 执行；若改为 B 路径需把 `limit_up_ladder` tool 与 CLI 命令 gate 到 `LUOOME_OPTIONAL_LIMIT_UP_LADDER=true`，并为下游报告 / TOP10 留 feature flag。
- **D3 缓存时长**：本文用 TTL 动态分时段（盘中 60s / 收盘后 Infinity / 跨日 Infinity），无需额外 env；与 PRD §14 D3 默认推荐一致。
- **D4 Phase 1 不动报告与 TOP10**：本节已表态——Phase 1 只做 TUI/CLI，Phase 2 再切换；这是 PRD 推荐路径。
- **D5 LLM 复盘链**：Phase 2 一起做，Phase 1 不预先改造 prompt。本文档不预先固化 LLM prompt 模板。
- **节假日历复用**：直接走 intraday-watch 设计 §"已知边界" 的三层 union 加载（内置 + `$LUOOME_HOME/holidays.json` + env）；不重新实现。
- **ST 股票名称前缀判断**：仅看中文前缀"ST" 与"*ST"，与策略预警 §5.2 一致；不接英文/异形缩写。
- **修正条件中的 `rawClose === high`**：PRD §5.6 的触发条件；本设计**不**做单边修改——只在 `rawClose === high` **且**涨幅区间匹配时才修正。否则原值通过。SPEC 文档与 ruo 旧实现逻辑对齐。当前主源（eastmoney 涨停池）无 `high` 字段，该条件不成立，修正不触发；逻辑保留。
- **无 fallback**：已确认不接 amazingdata，上游不可达时**直接**返回 `adapter_error`；manager 的 fallback 接口保留在类型层但 factory 不装配任何 fallback。
- **MCP 暴露**：默认 read 类暴露（与 ARCHITECTURE §9.2 默认策略一致），无需新 env。
- **缓存 key 内含 `includeStar/Bse/ST`**：是因为这些是 manager 的过滤维度，可能影响返回值；不至于让 cache 把 false 与 true 的请求混在一起回错。
- **测试覆盖率基线**：新增代码走仓库既有策略（"开发中先跑最小相关测试；交付前跑与改动范围匹配的 typecheck/test/lint"，见 [CONTRIBUTING.md](../../AGENTS.md)）。
