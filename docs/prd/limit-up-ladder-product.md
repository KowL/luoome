# 连板天梯产品文档

> 状态：目标模型已落地（Phase 1～3 核心实现完成；当前/正式日与历史 PIT Strategy DSL 字段已接入；2026-08-15 已冻结炸板/断板语义并安全降级，数据源门禁未满足前不注册字段）
> 日期：2026-07-25
> 参考：旧项目 `ruo` 的 `market limit-up` 命令及 luoome [ruo 能力迁移产品设计](./ruo-feature-migration-product-design.md) 与 [统一 Watchlist](./watchlist.md)。
> 产品边界：仅做 A 股短线方向的"看盘辅助页面 + 数据接口"；不替用户决策、不自动下单、不承诺任何"必涨/必板"语义
> 关联产品：涨停分组同步（依赖行情源的涨停股票列表接口）、TOP10 自选股（依赖天梯 level 排序）、市场复盘报告（天梯是 LLM 输入段之一）

## 1. 文档结论

luoome 应引入**连板天梯（涨停梯队）**作为看盘辅助模块，但不照搬 ruo 的"天梯驱动一切"模式。建议拆成两条产品路径：

1. **页面 / TUI：可读的梯队视图**——按连板层级（首板 / N 连板 / 最高板）分组展示当日涨停股票，附首次封板时间、原因、所属行业与现价涨跌幅。
2. **数据接口：稳定的天梯快照**——以 `tool` 形式向 LLM、报告生成、TOP10 排序等下游暴露同一份结构化数据，约定口径与日期边界。

天梯自身只承担"读懂市场结构"这一职责；选股、排序、决策建议分别由 strategy 模板、TOP10 排序与 advice 链路承担，**不**让天梯越过边界替代它们。

## 2. 背景与问题

### 2.1 ruo 里的连板天梯

ruo 在 `market limit-up` 子命令实现了天梯入口（`ruo-cli/src/commands/market.ts:111-148`），数据来源有两路：

- `getLimitUpLadder(days, date)`，调用私有行情服务 `GET /market/limit-up/ladder`（ruo 旧 adapter 实现）。
- `amazingdata.getLimitUpLadder(days)`，从涨停股票列表按 `limitUpDays` 分组（`amazingdata.adapter.ts:301-336`）。

数据结构在两条 adapter 上对齐为：

```ts
{
  date: string;          // 数据日期 YYYY-MM-DD
  total: number;         // 涨停股票总数
  maxLevel: number;      // 最高连板数
  levels: [
    {
      level: number;     // 连板数（1 = 首板）
      name: string;      // "首板" / "2连板" / "3连板" ...
      count: number;
      stocks: [
        {
          code, name, level, industry,
          firstTime, finalTime,    // 首次/最后封板时间
          reason,                   // 涨停原因（题材/概念）
          price, changePct,         // 现价、涨跌幅
          limitUpDate               // 涨停日 YYYY-MM-DD
        }
      ]
    }
  ]
}
```

天梯在 ruo 内有四个真实使用点：

- `market limit-up`：终端表格输出，按 level 分块打印代码/名称/现价/涨跌幅/涨停日/首次涨停/原因（`market.ts:111-148`）。
- `market overview`：从 prisma 涨停分组 `count()` 推算当日涨停数，作为市场概况的一部分（`market.ts:181-222`）。
- `report`：天梯是市场复盘报告"L 涨停梯队 / M 短线龙头"两节的直接数据源，同时作为 `MarketReviewChain` 的人类可读 prompt 段（`report.ts:415, 630-654, 822-836`、`market-review.chain.ts:31-52`）。
- `watchlist refreshTop10`：综合分公式 `ladderLevel*20 + score*0.5 + 行业聚类加分`，level 直接驱动 TOP10 排序（`watchlist.service.ts:280-302, 381-394`）。

### 2.2 ruo 解决过、但留下的问题

整理 ruo 实际踩过的坑，便于决定是否带进 luoome：

| ruo 的做法 | 暴露出的问题 | 文档结论里怎么处理 |
|---|---|---|
| `market limit-up` 不传 `-d` 时，由行情服务端"上海时间昨天"兜底 | 与 `-d` 指定日期错位、报告日期和实际数据日期不一致 | luoome 必须由**调用方**显式指定目标交易日，adapter 不再兜底 |
| 收盘价有时被错填为当日最高价（盘中触板但收盘未板） | ruo 旧 adapter 在 `getLimitUpLadder` 内做了一次 9.8%–10% 区间的回退修复（写死 8.58% 涨幅） | 在 luoome 仍由 adapter 一次性修正，但禁止把"修正值"当成"真实收盘价"暴露给外部，应保留原始 `rawClose` 与 `corrected` 标记 |
| 同一接口 `getLimitUpLadder` 既返回 `date` 又返回 `limitUpDate`，调用方按不同字段做日期过滤 | `report.ts:360-415` 注释：probe 拿到的 `limitUpDate` 才是上游实际数据的日期；调用方需主动 reconcile | luoome 天梯的"基准日"只允许一个权威字段 `date`（请求日），股票级 `limitUpDate` 仅作展示 |
| `watchlist refreshTop10` 用 `ladderLevel*20` 把天梯等级作为综合分主项 | 当下游用同一个 level 既做"页面排序"又做"决策排序"时，TUI 和 TOP10 共享同一份数据，调权重一改两边都错 | luoome 把天梯当作"事实层"，页面排序、TOP10 排序各自维护权重 |
| 天梯与涨停分组同步共用 `getLimitUpStocks*` 系列 | 一个调用方关注"近 15 日哪些股票涨停过"，另一个关注"今日按连板分组的快照" | luoome 拆为两个 tool：`limit_up_ladder`（结构化快照）与 `limit_up_stocks`（成员列表），共用底表不复用 API |

### 2.3 luoome 现状

- 已有专门的 Web `/market/limit-up` 页面、TUI `L` 子视图、CLI `market limit-up` 子命令和
  `limit_up_ladder` / `limit_up_ladder_compare` 两个只读 tool；所有入口复用同一 manager/cache。
- `daily-review`、`opening-report`、`market_outlook` 与个股行情/研究事实已消费同一结构化快照；缺数据
  明确返回 unavailable/adapter_error，不回退到 mock 或伪造空记录。
- 涨停、炸板、断板事实仍可作为未来 Strategy 的上游数据源，避免各规则重复拉取。
- [ruo 能力迁移产品设计](./ruo-feature-migration-product-design.md) §P3 写明"连板天梯与昨日梯队表现：页面和接口较完整，外部依赖重；A 股短线方向明确时再做"——本文档是这条决策的展开。
- 数据源已迁移为东方财富公开涨停池（`getTopicZTPool`，公开 API、无鉴权）；已确认不接 amazingdata，无 fallback。

### 2.4 一句话缺口

原始缺口已由上述页面和统一结构化 tool 闭环；剩余工作是连续真实 provider 运行证据、历史快照审计，以及
需另行冻结产品口径的 Strategy 字段联动与炸板/断板历史增强。

## 3. 产品目标

### 3.1 定位

> 让用户在交易日的任一时刻，用一页看清 A 股今天的涨停结构——最高多少板、龙头股是谁、每个层级有谁、它们的封板时间与涨停原因。

### 3.2 目标用户

- 短线/打板交易者，需要快速判断"龙头是否晋级、跟风是否掉队"。
- 做市场复盘的内容创作者、运营或投顾，需要一份"今日涨停梯队"截图或结构化数据。
- 平台内其它模块（TOP10 排序、报告、预警规则、LLM 复盘）作为下游消费者。

### 3.3 核心价值

| 用户问题 | 产品回答 |
|---|---|
| 今天涨停的"龙头"是谁、几连板？ | 顶部一行 `最高 ${maxLevel} 板` 与龙头的代码/名称/原因 |
| 每个连板层还有谁？ | 按 `level` 降序的分组视图，每组内显示 `count` 与成员 |
| 哪只最先封板、哪只是炸板回封？ | `firstTime` / `finalTime` 两个时间字段 |
| 同一题材下还有谁在跟？ | 表格给出 `industry`，与未来的"热点概念"模块挂钩 |
| 今天梯队相比昨天是变强还是变弱？ | 接口暴露 `total` / `maxLevel` / `date`，对比口径见 §5.5 |
| 报告、TOP10、预警规则能否拿到同一份数据？ | 单一 tool + 单一 schema，下游只读 |

### 3.4 非目标

- 不复刻同花顺/通达信的"板块联动力、封单金额、开板次数"等富字段。luoome 只做"够用的几列"，详细数据留给专业行情客户端。
- 不做"打板胜率/连板成功率"等量化统计；这属于 P3 [ruo 能力迁移产品设计](./ruo-feature-migration-product-design.md) §Phase 3 的真实复盘范围。
- 不做实时推送（盘中秒级）；刷新节奏由调用方控制（见 §6.4）。
- 不引入新的用户配置项（用户不能改 level 分组规则或定义新的连板口径）；数据口径由代码与文档固定。
- 不做跨市场、跨品种；只服务沪深 A 股主板+创业板。

## 4. 产品原则

1. **天梯是事实层，不做判断。** 严禁把"该追哪个龙头""该不该接力"等结论写进天梯的返回值或文案。
2. **单一权威日期。** 一次请求只有一个基准日 `date`；股票级 `limitUpDate` 仅做展示用，不参与过滤、再计算。
3. **调用方决定日期，adapter 不兜底。** 与 ruo 旧实现相反：默认 `date = 今天（Asia/Shanghai）`；如果当天没有数据必须明确返回空 levels，而不是悄悄退到昨天。
4. **下游可独立排序。** 天梯接口固定按 `level DESC, changePct DESC` 输出，**不**为 TOP10 或报告改变顺序；下游在自己的数据上重排。
5. **修复后的字段必须可追溯。** 收盘价修正、首次封板时间缺失等异常，必须保留原始值或显式标记；不允许静默改写。
6. **不替其它模块承担职责。** 涨停分组同步、TOP10 排序、报告 LLM 输入、预警规则触发都各自有 tool，天梯只暴露结构化快照，不参与这些模块的写入路径。

## 5. 领域模型

### 5.1 产品概念对照

| 产品概念 | luoome 实体（建议） | ruo 旧实体 | 说明 |
|---|---|---|---|
| 一次"天梯快照" | `LimitUpLadder`（不可变快照） | `getLimitUpLadder` 返回值 | 同一日一份，刷新即覆盖 |
| 某只股票在快照中的位置 | `LimitUpLadderEntry` | `levels[].stocks[]` | 一只股票在同一日只出现一次（按 level 最深的层级归类） |
| 连板层级 | `ladderLevel` 字段 | `levels[].level` | 1 = 首板，N = N 连板 |
| 涨停原因 | `reason` 字符串 | `reason` | 由数据源提供；当前主源（东方财富涨停池）无该字段，恒为缺失；不展示时也需保留 |
| 封板时间 | `firstTime` / `finalTime` | 同 | 缺失时显示 `--`，不臆造 |

### 5.2 字段与口径

| 字段 | 类型 | 口径 | 缺失时 |
|---|---|---|---|
| `date` | string `YYYY-MM-DD` | 请求方指定的基准日（Asia/Shanghai） | 不允许缺失 |
| `total` | int | 当日 level ≥ 1 的股票去重计数 | 0 |
| `maxLevel` | int | 所有 entry 的 `ladderLevel` 最大值 | 0 |
| `level` | int | 1=首板，N=N 连板 | 缺失按 1 兜底并标 `uncategorized=true` |
| `code` / `name` | string | 沪市 6/9 开头、深市 0/3 开头；名称缺失时回退到代码 | name 缺失显示 code |
| `industry` | string | 数据源返回的行业（当前为东方财富涨停池 `hybk`）；缺数据时回退到 `unclassified` | 不臆造 |
| `firstTime` | string `HH:MM:SS` | 首次封板时间；盘中未开板显示 `--` | `--` |
| `finalTime` | string `HH:MM:SS` | 最后封板时间；与 `firstTime` 相等表示未开板 | `--` |
| `reason` | string | 涨停原因摘要（题材/概念） | `--` |
| `price` | number | 收盘价（已修正，见 §5.6） | `--` |
| `rawClose` | number | 数据源返回的原始 close（东方财富涨停池 `p/1000`），未经修正 | 与 `price` 不一致时打 `corrected=true` |
| `corrected` | bool | 收盘价是否经过 9.8%–10% 区间回退修正 | false |
| `changePct` | number（小数，0.10 = 10%） | 相对昨收 | 缺失按 0 |
| `limitUpDate` | string `YYYY-MM-DD` | 该股票的涨停日（理论上等于 `date`） | 等于 `date` |
| `board` | enum `主板` / `创业板` / `科创板` / `北交所` | 股票所属板块 | `--` |

> 字段命名以 luoome 现有 Zod 风格为准（小写蛇形），调用方可按语言习惯做映射；本文档用驼峰仅为描述统一。

### 5.3 阶梯计算口径

- **level = 1（首板）**：该股票当日涨停，且前 20 个交易日内无涨停记录；或前一次涨停距今 > 20 个交易日。
- **level = N（N ≥ 2）**：该股票当日涨停，且最近一次涨停发生在前一交易日（中间不出现跌停或未涨停日）。
- **样本窗口**：默认 15 个交易日，与 ruo `days=15` 保持一致。窗口外不计。
- **过滤**：默认排除科创板（688 开头）和北交所（8/4 开头）；用户不能改。
- **ST 股票**：默认排除（名称前缀含 "ST"）。
- **去重**：同一股票在同一日只出现在一个 `level` 中；以最深 level 为准。
- **数据修正**：若数据源返回的 `close == high` 且涨幅在 [9.8%, 10%)，认为"盘中触板但收盘未板"，按 8.58% 涨幅回推收盘价，详见 §5.6。当前主源（东方财富涨停池）无 `high` 字段，该修正不触发，逻辑保留。

### 5.4 时间边界

- 所有"日"都以 **Asia/Shanghai** 为准；UTC 时间不参与判定。
- `date` 字段是请求方关心的"交易日"。请求方传入 `date=2026-07-25` 但当天尚未收盘或非交易日，adapter 必须返回空 `levels` 并把 `date` 原样回传，便于调用方做友好提示。
- adapter **不**自动"上海时间昨天"兜底。如果调用方关心"最近一个有数据的日子"，由调用方按交易日历自行回溯。

### 5.5 与"昨日天梯"的对比口径

为了支持 §3.3 中"今天梯队相比昨天是变强还是变弱"，建议下游同时请求 `date` 与 `prevDate` 两天快照，比较规则固定为：

- `maxLevel` 高低；
- `total` 数量增减；
- 顶级 level 成员变化（`added` / `removed` / `retained`）。

不引入"梯队强度"等聚合分数；下游展示 raw 数字与差值即可。

### 5.6 收盘价修正规则

- 触发条件：`rawClose == high` 且 `(rawClose - preClose) / preClose ∈ [0.098, 0.10)`。
- 修正方式：按 8.58% 涨幅回推 `price = preClose * (1 + 0.0858)`，与 ruo 旧 adapter 实现一致。当前主源（东方财富涨停池）无 `high` 字段，触发条件不成立，修正逻辑保留但不触发。
- 暴露字段：保留 `price`（修正后）和 `rawClose`（修正前），并设 `corrected=true`。
- 拒绝范围：若涨幅 ≥ 10%（真涨停），按原值通过；若涨幅 < 9.8%（未触板），按原值通过；这两种情况下 `corrected=false`。

## 6. 核心用户流程

### 6.1 看天梯（手动）

1. 用户进入 TUI 或 Web 的"市场 / 涨停"页。
2. 默认请求 `date=今天`（Asia/Shanghai）。
3. 后端调用 `limit_up_ladder` tool，返回 `LimitUpLadder`。
4. 页面按 `level DESC, changePct DESC` 渲染：每块顶部是层级标题 `3 连板 (4 只)`，下方是成员表格。
5. 用户点击某只股票跳转个股详情（沿用现有 TUI/Web 个股页）。

### 6.2 选日期回看

1. 用户在页面顶部选择日期 `2026-07-20`。
2. 浏览器/终端发起请求 `date=2026-07-20`。
3. 命中缓存直接返回；未命中后端调东方财富涨停池拉数据并按 §5.6 修正后入缓存。
4. 缓存策略：同 `date` + 同数据源版本，TTL 1 小时；过期或版本变化重新拉取。

### 6.3 与报告联动

1. 每日复盘报告 workflow 在生成时，先调 `limit_up_ladder(date=今天)` 与 `limit_up_ladder(date=昨天)` 拿到 `prev` 和 `curr`。
2. 把两天的 `maxLevel` / `total` / 顶级成员 diff 写入报告的"涨停梯队"段。
3. 把 `curr` 的字符串化版本喂给 LLM 复盘链（替代 ruo `market-review.chain.ts:31-52` 的拼装方式）；LLM 只读取、不修改。

### 6.4 与 TOP10 排序联动

1. `watchlist refreshTop10` 在初始化时拉当天 `limit_up_ladder`，只取 `code → level` 映射。
2. 排序权重由 TOP10 模块维护，**不**改天梯接口。
3. 如果天梯为空（无涨停或非交易日），TOP10 退回到"按 score 排序"，并在 UI 显示"今日无涨停梯队"。

### 6.5 异常与空态

| 情况 | 行为 |
|---|---|
| 请求日尚未收盘 | `levels: []`、`total: 0`、`maxLevel: 0`，UI 显示"今日暂未收盘，请稍后再看" |
| 请求日为非交易日 | 同上，UI 显示"该日非 A 股交易日" |
| 行情服务（东方财富涨停池）不可用 | tool 返回 `ToolError(kind: "upstream-unavailable")`，UI 显示"行情服务暂不可用，请稍后重试"；诊断文案提示检查到东方财富行情服务的网络连通性 |
| 数据源返回空 levels（盘前 9:30 之前） | 不再自动回退到昨天；UI 显示"今日数据暂未更新，最新可看日期为 <prevDate>" |
| 单只股票字段缺失 | 表格显示 `--`，不阻断整个 levels 渲染 |

## 7. 页面与交互

### 7.1 Web：涨停梯队页（新增）

入口放在现有"市场"侧栏下，路径 `/market/limit-up`，与 `/market/overview` 同级。

```text
┌──────────────────────────────────────────────────────┐
│ 📈 涨停梯队              日期: [2026-07-25 ▾] [刷新] │
├──────────────────────────────────────────────────────┤
│ 总计: 78 只   最高: 5 连板   vs 昨日: +12 / +1       │
├──────────────────────────────────────────────────────┤
│ 🏆 5 连板 (1 只)                                       │
│   600xxx  XX 科技   现价 32.10 +10.01% 首次 10:31     │
│   原因: 算力租赁 + 国产替代                            │
├──────────────────────────────────────────────────────┤
│ 4 连板 (3 只)                                         │
│   ...                                                 │
├──────────────────────────────────────────────────────┤
│ 3 连板 (8 只)                                         │
│   ...                                                 │
├──────────────────────────────────────────────────────┤
│ 2 连板 (15 只)                                        │
│   ...                                                 │
├──────────────────────────────────────────────────────┤
│ 首板 (51 只)                                          │
│   ...                                                 │
└──────────────────────────────────────────────────────┘
```

表格列：`代码 | 名称 | 现价 | 涨跌幅 | 涨停日 | 首次 | 最后 | 原因 | 行业`。点击代码跳个股详情；点击名称复制；首/最后时间缺失显示 `--`；`corrected=true` 的现价加灰色角标"已修正"。

### 7.2 TUI：涨停梯队区块（新增）

在 TUI 现有"市场"面板下增加一行快捷键 `L` 进入"涨停梯队"子视图。布局与 Web 类似，但每层只显示前 3 只，超出部分用 `<N> 只未显示，Enter 展开` 提示。

### 7.3 CLI：`luoome market limit-up`

保留 ruo 的 CLI 形态作为高级入口。命令参数：

```text
luoome market limit-up [--date YYYY-MM-DD] [--json] [--source eastmoney]
```

- 默认 `date` = 今天（Asia/Shanghai），不再走服务端"昨天"兜底。
- `--json` 输出与 tool schema 一致的 JSON。
- `--source` 选择数据源；缺省且当前唯一可选值为 `eastmoney`（不接 amazingdata，无 fallback）。

### 7.4 与现有页面的连接

- 个股详情：在"事件"区展示该股最近 30 个交易日的"涨停日 + 当时 level + 原因"。
- 分组详情：动态分组如"涨停"可在分组卡片上展示"今日在天梯中的最高 level"。
- 报告页：涨停梯队段直接引用本快照，LLM 段可折叠到"AI 复盘"。

## 8. 数据与接口

### 8.1 Tool：`limit_up_ladder`

```ts
input = {
  date: string;            // YYYY-MM-DD
  source?: "eastmoney";    // 默认 eastmoney（当前唯一数据源）
  days?: number;           // 默认 15
  includeUncategorized?: boolean;  // 默认 false
}

output = {
  date: string;
  total: number;
  maxLevel: number;
  source: "eastmoney";
  levels: Array<{
    level: number;
    name: string;          // "首板" / "N 连板"
    count: number;
    stocks: LimitUpLadderEntry[]
  }>;
  warnings?: string[];     // 数据源异常、单股字段缺失等
}
```

错误模型沿用现有 `ToolError.kind`：参数错误返回 `invalid_input`；上游不可用返回 `upstream-unavailable`；数据解析失败返回 `parse_error`。**不**为"当日没数据"返回错误，视为正常空态。

### 8.2 Tool：`limit_up_ladder_compare`（P2）

```ts
input = { date: string; prevDate: string; source?: "eastmoney" }
output = { curr: LimitUpLadder; prev: LimitUpLadder; diff: {
  totalDelta, maxLevelDelta, topLevelAdded, topLevelRemoved, topLevelRetained
}}
```

把 §5.5 的对比口径封装为单独 tool，下游不再各自实现。

### 8.3 缓存与刷新

- 同 `date` + 同 `source` 的请求 1 小时内直接命中缓存。
- 缓存 key 含 `source`，不同数据源的 `date` 不复用同一缓存 key（当前仅 eastmoney 一源）。
- 缓存层沿用 luoome 现有 `core` 内的 cache adapter；不引入新的存储后端。

### 8.4 下游消费方清单

| 下游 | 用什么字段 | 写入路径？ |
|---|---|---|
| Web 涨停梯队页 | 全部展示字段 | 否（只读） |
| TUI 涨停梯队区块 | `levels[].stocks[].{code,name,level,price,changePct,reason,firstTime,finalTime}` | 否 |
| CLI `market limit-up` | 全部展示字段 | 否 |
| 报告 workflow | `levels`、`maxLevel`、`total` | 否 |
| LLM 复盘链 | 字符串化的 `levels[0..3]` | 否（LLM 只读） |
| `watchlist refreshTop10` | `code → level` 映射 | 否（仅排序权重输入） |
| 策略预警规则（未来 P2） | `code` 命中规则时读取 `level` / `firstTime` 做语义增强 | 否（仍由 rule tool 写触发） |

## 9. 与当前系统的结合

### 9.1 保留

- 东方财富涨停池 adapter（`EastmoneyLimitUpLadderAdapter`，公开 API、无鉴权、无环境变量）；本文档不修改上游协议。已确认不接 amazingdata，无 fallback adapter。
- 现有涨停分组同步逻辑（依赖 `getLimitUpStocks*`），与天梯解耦。
- 现有 TOP10 排序、报告生成、LLM 复盘链；只调整它们的"输入来源"，不改它们的核心算法。

### 9.2 扩展

- `packages/core` 增加 `LimitUpLadder` / `LimitUpLadderEntry` schema（Zod），并派生 TypeScript 与 OpenAPI schema。
- `packages/tools` 增加 `limit_up_ladder` tool，挂在"市场数据"桶下；`sideEffect: "read"`。
- `apps/web` 增加 `/market/limit-up` 页面与对应 API 路由。
- `apps/tui` 增加 `L` 快捷键与"涨停梯队"子视图。
- 缓存 key：`(date, source, schemaVersion)`。
- 报告 workflow：`MarketReviewChain` 输入段的"涨停梯队"由字符串拼接改为引用本快照，移除硬编码示例。

### 9.3 不引入

- 不引入新的用户配置项；不接受"自定义连板规则 / 自定义首板口径"。
- 不引入 Redis、外部 KV；用 luoome 现有 cache adapter。
- 不让 TUI/Web 直接连行情数据源；数据由 tool 统一封装。
- 不复刻 ruo 旧 adapter 把修正字段写回上游缓存的做法；adapter 只暴露修正后的 `price` 与保留的 `rawClose`。
- 不在 tool 内做"今天 → 昨天"自动回退；调用方按 §6.5 处理空态。

## 10. 分阶段范围

### Phase 0：调研与本文档（已完成）

- 完成 ruo 旧实现与 luoome 现状盘点。
- 输出现状差异与字段口径（本文档 §2、§5）。
- 标记未决决策（见 §14）。

### Phase 1：天梯快照（已完成）

目标：跑通"tool → 缓存 → TUI 展示"的最小闭环。

- [x] 实现 `limit_up_ladder` tool（数据源 eastmoney 公开涨停池，无 fallback）。
- [x] 实现 `LimitUpLadder` / `LimitUpLadderEntry` Zod schema。
- [x] TUI 增加 `L` 快捷键与涨停梯队子视图。
- [x] CLI `luoome market limit-up` 保留 ruo 形态但去掉日期兜底。
- [x] Web 页面和统一 API 已在 Phase 2 接入；不保留第二套数据来源。
- [x] 报告/市场观点只通过 tool 消费快照，不改天梯事实层排序。

### Phase 2：页面与下游联动（已完成）

目标：让所有下游消费方统一从本快照读取。

- [x] Web `/market/limit-up` 页面，含日期切换与 vs 昨日 diff。
- [x] 报告 workflow 改造为通过 `limit_up_ladder_compare` 消费天梯快照。
- [x] 旧 `watchlist refreshTop10` 已由 Strategy/Watchlist 目标模型替代，不再保留独立联动路径。
- [x] 增加 `limit_up_ladder_compare` tool。

### Phase 3：与策略预警联动（核心事实投影已完成）

- [x] Strategy DSL 的涨停字段统一引用本快照：`meta.limitUpLevel` / `meta.limitUpToday` 由
  `limit-up-ladder` manager 提供；scan/scheduled 按运行 `dataAsOf` 的 Asia/Shanghai 日期查询真实快照并写入
  PIT repository，provider coverage 可审计；replay 优先读取对应历史快照，缺失时保持 `unknown`，不读取当前快照。
- [ ] 增加"炸板 / 断板"历史语义字段。语义、审计信封、数据源矩阵与上线门禁已在 DDD 冻结；
  当前 Eastmoney 无正式发布时间/revision/历史保留契约，Tushare 候选在本环境无 token，故字段保持
  未注册，历史个股事实只读 PIT repository，不用当前情绪接口或空响应倒推。
- [x] 与个股详情/研究事实/行情 marker 区打通；缺失历史保持 unavailable。

## 11. 验收标准

### 功能

- 用户在 TUI 按 `L` 后 ≤ 2 秒内看到今日天梯（或明确的空态提示）。
- Web `/market/limit-up?date=2026-07-20` 返回该日快照，刷新后命中缓存 ≤ 200ms。
- CLI `luoome market limit-up --date 2026-07-20` 输出与 Web 同一份 JSON。
- 报告中的"涨停梯队"段与同日 `limit_up_ladder` tool 输出完全一致（结构、字段、顺序）。
- 同一股票在同一日只出现一次；level 取最深层。
- 数据修正：`rawClose` 与 `price` 不一致时 `corrected=true`，且 `rawClose` 字段不为空。
- 字段缺失：缺失值显示 `--`，不阻塞整个 `levels` 渲染。

### 可靠性

- 行情服务（东方财富涨停池）不可用时返回明确的 `adapter_error`（无 fallback；已确认不接 amazingdata）。
- 缓存命中失败不污染下游；回源请求有超时与重试限制。
- 非交易日 / 盘前 / 盘后请求统一返回空 `levels` 与明确提示，**不**自动回退到昨天。
- 跨时区统一 Asia/Shanghai；不出现 UTC 日期错位。
- tool 调用错误使用既有 `ToolError.kind`，不把异常泄漏为协议层错误。

### 安全

- tool `sideEffect: "read"`，不在 MCP 自动暴露任何"触发/告警"能力。
- 不在响应中包含账户、持仓、订单等用户私有信息。
- 不通过 tool 写入数据库；下游写入路径仍走各自的写 tool。
- 不因天梯触发任何交易；天梯纯只读。

## 12. 指标

天梯自身是只读快照，KPI 围绕"可用、可信、可被引用"。

| 指标 | 定义 | 建议目标 |
|---|---|---|
| 页面可用率 | TUI/Web 涨停梯队页正常返回的请求占比 | ≥ 99% |
| 缓存命中率 | 同日同源二次请求命中缓存占比 | ≥ 80%（日活用户 ≥ 2 次访问时） |
| 数据修正率 | `corrected=true` 的 entry 占比 | 观察指标；当前主源无 `high` 字段恒为 0，如 > 5% 提示数据源数据问题 |
| 字段完整率 | `industry` / `reason` / `firstTime` 缺失占比 | 各字段缺失 < 30% |
| 下游覆盖度 | 报告、TOP10、LLM 复盘链中天梯字段的引用点 | 100%（Phase 2 之后） |
| 接口一致性 | tool schema 与 Web/API 响应字段一致 | 100% |

## 13. 风险与应对

| 风险 | 应对 |
|---|---|
| 上游协议变化（东方财富涨停池字段重命名、缺失） | 隔离在 `core/adapter` 内部；schema 校验失败时返回 `parse_error` + 详细 warning，UI 降级展示 |
| "今日无数据"被误读为"系统坏了" | 明确文案 + 暴露 `prevDate` 提示；状态码区分"空态"和"上游不可用" |
| 收盘价修正（8.58%）被引用为"真实收盘" | `corrected=true` 标记 + `rawClose` 字段保留；UI 在表格里加角标 |
| TOP10 综合分因天梯 level 变化而抖动 | 把天梯从 TOP10 排序公式里独立出来；level 仅作"加分项"且权重可被覆盖 |
| 跨日对比把"非交易日"误判为"梯队弱" | `prevDate` 必须是交易日；调用方负责，tool 不做隐藏补全 |
| TUI 在窄终端下显示拥挤 | 与 ruo 一致每层最多展示前 3 只；超出用 `<N> 只未显示>` 折叠 |
| LLM 把天梯 level 当作"买入建议"喂给用户 | LLM 复盘链路只读天梯快照，且提示词明确"天梯是事实不是建议"；advice 链路独立 |

## 14. 当前决策与后续确认点

Phase 1～3 已按以下默认口径实现；若要改变这些产品边界，应先更新 PRD/DDD、Tool schema 和测试矩阵，
再修改代码：

### D1：天梯是否纳入 luoome 主线（已采用 A）

当前采用选项 A：纳入主线。

影响：A 路径会影响 Web 导航与 CLI 速查；B 路径所有下游（TOP10、报告）需要 feature flag 隔离。

### D2：天梯数据是否限制在主板+创业板（已采用默认限制）

默认排除科创板和北交所；通过 `includeStar` / `includeBse` 显式 opt-in，不改变默认覆盖。

### D3：缓存时长（已冻结为按交易时段）

缓存由 manager 按盘中短 TTL、盘后/历史日期 key 复用；当前 Eastmoney 未提供独立数据时间戳，响应 `asOf`
只表示本机抓取时间，不冒充市场观测时间。

### D4：报告与 TOP10 是否在 Phase 1 同步切换（已采用分阶段）

Phase 1 先完成 TUI/CLI，Phase 2 再接入 Web 与报告；旧 TOP10 路径已由 Strategy/Watchlist 目标模型替代。

### D5：LLM 复盘链是否同步改造（核心路径已接入）

报告/市场观点已通过结构化 tool 输入天梯事实；后续只允许在独立设计中扩展 prompt，不把 level 翻译为 Advice 或收益概率。
