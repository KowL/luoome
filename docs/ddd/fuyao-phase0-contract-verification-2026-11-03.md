# Fuyao 扩展 Phase 0 真实契约验证记录（2026-11-03）

> 类型：验收证据（脱敏）。对应 [Fuyao 数据能力扩展与 Tushare 退役详细设计](./fuyao-data-expansion-and-tushare-retirement-design.md) §16 Phase 0。
> 验证时间：2026-11-03 23:01–23:12（Asia/Shanghai）；验证人：编码 Agent（task-3）。
> 凭据：仓库 `.env` 中已配置的标准 `FUYAO_API_KEY`（值不进入本文档、日志或任何持久化产物）。
> 原始脱敏响应快照：`.tmp/fuyao-verify/results.json`（本地临时文件，不入库、不提交；预签名 URL 已整体脱敏为 host+路径前缀）。
> 本文所有响应均为**真实上游证据**；文档示例值仅用于对照，不作为证据。

## 1. 权限矩阵（真实 Key 逐 capability 探测）

| 能力域 | 端点 | 结果 | 证据 |
|---|---|---|---|
| dump 下载 URL ×3 | `GET /api/dump/market-dumps/{daily-k,daily-k-10d,adjustment-factors}/download-url` | ✅ code=0 | 三者均返回 `presigned_url / presigned_url_expires_at / expires_in_seconds=300` |
| 公司行动（在线单股） | `GET /api/a-share/corporate-actions/adjustment-factors` | ✅ code=0 | 600519.SH 全历史 30 条；000001.SZ 窗口 7 条 |
| 涨停池 | `GET /api/a-share/special-data/limit-up-pool` | ✅ code=0 | 当日 total=52、pages=2（size=50） |
| 炸板池 | `GET /api/a-share/special-data/limit-break-pool` | ✅ code=0 | 当日 total=34、pages=1 |
| 连板天梯 | `GET /api/a-share/special-data/limit-up-ladder` | ✅ code=0 | window.length=30，当日含 2/3/4 板 |
| 涨停统计 | `GET /api/a-share/special-data/limit-up-statistics` | ✅ code=0 | trade_date=2026-11-03，seal_rate≈0.5854 |
| 龙虎榜 ×3 | `GET /api/a-share/special-data/dragon-tiger-list?board_type={all,org,hot_money}` | ✅ code=0 | all=77 条/73 股；org=52 条；hot_money=16 个游资分组 |
| 快讯列表/刷新 | `GET /api/news/flash/{list,refresh}` | ✅ code=0 | tag_id=21103（栏目名「A股」）可用；seq 翻页无重叠 |
| 板块目录 ×2 | `GET /api/a-share-index/catalog/ths-index-list?tag={industry,cn_concept}` | ✅ code=0 | industry=320 条；cn_concept=390 条 |
| 板块快照 | `GET /api/a-share-index/prices/snapshot?thscodes=…TI` | ✅ code=0 | 881273.TI / 881101.TI 均返回完整 OHLC |
| 个股板块反查 | `GET /api/a-share-index/constituents/ths-index-list-by-stock` | ✅ code=0 | 600519.SH→白酒(industry)；000001.SZ→银行(industry) |
| 三大报表 ×3 | `GET /api/a-share/financials/{income-statements,balance-sheets,cash-flow-statements}` | ✅ code=0 | 600519.SH annual limit=2 均返回 |
| 财务指标 | `GET /api/a-share/financials/indicators` | ✅ code=0 | 5 类 ability 全部返回 |
| 估值快照 | `GET /api/a-share/valuations/snapshot` | ✅ code=0 | 2 只股票 5 指标齐全 |

**权限缺口**：本次验证未发现 2003 capability 级拒绝；当前 Key 对上述全部目标能力均有权限。错误语义实测：缺失或无效 `X-api-key` **均返回 `code=2003`**（文档称缺失应返回 2001——以实测为准，2001 仍按文档保留处理分支）。

## 2. Dump 下载契约（真实响应固化）

### 2.1 download-url 响应 schema（文档未列，本次实测固化）

```json
{
  "code": 0,
  "data": {
    "presigned_url": "https://o.thsi.cn/fuyao-financial-api.fuyao-a-share-prices-market-dump/market-dump/<data_type>/releases/<yyyymmdd>/<dump_id>_<yyyymmdd>.parquet?<签名查询参数>",
    "presigned_url_expires_at": "2026-11-03T23:09:51.763042361+08:00",
    "expires_in_seconds": 300
  }
}
```

- 字段名是 `presigned_url` / `presigned_url_expires_at` / `expires_in_seconds`；**没有独立的 `dumpId` 字段**。dump 身份须从 URL 路径段解析（`<data_type>/releases/<date>/<dump_id>_<date>.parquet`），实测三种 dump 的路径均含规范 `dump_id`（`a_share_daily_k_1d_none_10y` / `a_share_daily_k_1d_none_10d` / `a_share_adjustment_factors_event_none_all`）。
- `presigned_url_expires_at` 是带纳秒的 RFC3339（`+08:00`），解析器必须容忍小数秒 9 位。
- 签名查询参数名为 `AWSAccessKeyId / Expires / Signature`（S3 兼容）；**HEAD 请求返回 403**（签名按 GET 签发），探测文件大小必须用 `Range: bytes=0-0` 读 `Content-Range`，不能用 HEAD。
- 有效期实测 300 秒，与文档「通常 5 分钟」一致；URL 不落库、不落日志、不进入 ToolResult 的要求可行。

### 2.2 三种 artifact 实测

| dump | 大小 | 行数 | 唯一 thscode | 日期范围（Asia/Shanghai） | 主键重复 | 其他 |
|---|---:|---:|---:|---|---:|---|
| daily-k（10 年全量） | 182,137,876 B | 10,368,988 | 5,577 | 2016-11-03 → 2026-11-03 | 0 | 全行 `interval=1d / adjusted=none / currency=CNY`；0 行 volume=0；0 行 null turnover；0 行非正 OHLC |
| daily-k-10d | 1,057,663 B | 55,689 | 5,574 | 2026-10-21 → 2026-11-03（恰好 10 个交易日） | 0 | 同上 |
| adjustment-factors | 297,592 B | 57,739 | 5,436 | 1991-02-26 → 2026-11-10 | **3 键** | 含 `allotment_ratio / allotment_price` 列；配股事件 985 条 |

**复权事件 dump 的 3 个重复 (thscode, ex_date_ms) 键（真实证据）**：

1. `000601.SZ | 1997-11-06`：两行内容完全相同（bonus=0.4）——纯重复行，内容 hash 去重可吸收。
2. `000812.SZ | 1998-09-22`：一行 dividend=0.2、一行 bonus=0.1——同日现金+送转拆成两行。
3. `603883.SH | 2024-06-27`：一行 dividend=0.16、一行 dividend=0.5+bonus=0.3——同日两次现金事件拆行。

结论：主键 `(thscode, ex_date_ms)` **不唯一**，设计 §5.4「重复主键但不同内容必须保留新 revision」是真实必要行为；同日现金分红与送股必须按设计 §6.3 映射为两条动作。

### 2.3 Parquet / Node 可行性（真实验证）

- 物理 schema 与文档完全一致：日 K 11 列（`thscode/currency/interval/adjusted: Utf8`，`date_ms: Int64`，OHLC/volume/turnover: Float64）；复权事件 8 列（含 `ticker`、`allotment_ratio`、`allotment_price`）。
- **压缩编码是 ZSTD**（实测 `parquetjs-lite` 与 `@dsnp/parquetjs` 均抛 `invalid compression method: ZSTD`）。
- **可行 Node 方案**：`parquet-wasm`（`/node` 入口，Rust arrow2，支持 ZSTD）+ `apache-arrow`（`tableFromIPC(table.intoIPCStream())`）。182 MB 全量文件在 Bun（macOS arm64）上一次读入并全表扫描成功；生产实现仍应按设计 §5.2 用 cursor/分批读取，不整表载入内存。
- 结论：设计 §5.2「Node 运行时兼容的 Parquet cursor」落地时应以 `parquet-wasm` 为候选依赖；`parquetjs-lite` 不可用，需在实施时写入依赖决策。

## 3. 公司行动在线端点（真实证据）

- 响应为 `data.item[]`，字段仅 `ticker / ex_date_ms / dividend_per_share / per_share_bonus`——**确认在线端点不返回 `event_type / record_date / adjust_factor / allotment_*`**，设计 §6.1「仅凭在线响应不得声明配股覆盖完整」成立；配股证据只能来自 dump。
- `ex_date_ms` 为上海零点毫秒；item 按 `ex_date_ms` 降序。
- 600519.SH 最新事件 `ex_date_ms=1782403200000`（2026-06-26），dividend=28.02423。

## 4. 天梯 / 情绪池（真实证据）

- 涨停池：`data.pagination{total,pages,size,page}` 完整；item 字段与文档一致（含 `is_st/is_new/seal_money/max_seal_money/open_times`）。`limit_up_time` 实测为 `"09:25"`（HH:mm，**不是**设计 §7.2 假设需补的 HH:MM:SS 之外的形态——按 HH:mm 解析并补 `:00` 即可）。
- 炸板池：`first_seal_time / last_seal_time` 为 `HH:mm` 字符串；当日 34 条单页返回。
- 连板天梯：**`window.date_list` 与 `item[].date` 实测格式为 `YYYY-MM-DD`**（文档示例为 `YYYYMMDD`）——真实 schema 漂移，解析器必须按实测格式。`seal_nextday` 在最近交易日为 `null`，与文档一致。六个板位键齐全，空板位补 `[]`。
- 涨停统计：`trade_date` 回显请求日口径；`seal_rate` 为小数；`page_boards` 5 档（one/two/three/four/five_plus），`exact_boards` 为精确连板家数。

## 5. 龙虎榜（真实证据）

- 默认日期行为与文档一致（2026-11-03 23:00 请求返回 trade_date=2026-11-02，因当日榜单未发布）。
- `timestamp` 为目标交易日上海零点（1793548800000 = 2026-11-02 00:00+08:00），**确认不是发布时间**，设计 §8 的时间语义成立。
- `stock_items[]` 含 `range_days`（实测值 1）；`change/net_rate` 为小数；金额单位为元。
- **确认无 `close` 与换手率字段**——设计 §8 要求 `DragonTigerEntry.close/turnoverRate` 改可选并加 warning 的决策成立。
- `board_type=org` 追加 `org_net_rate/org_buy_num/org_sell_num/hot_money_net_value` 等字段；`hot_money` 榜走 `hot_money_items[{name,buying,rows[]}]`，`stock_items` 为空数组。

## 6. 快讯 tag/seq（真实证据）

- `tag_id=21103` 实测对应栏目名「A股」，可作为 `LUOOME_FUYAO_NEWS_TAG_ID` 的已核实候选值（不再是文档示例冒充）。
- `seq='0'` 首屏返回 20 条；以末条 `seq` 翻页返回下一页 20 条，**两页无重叠**，游标语义成立。
- `flash/refresh` 传入最新 `seq + create_time_ms` 返回空 items（无更新时），行为符合增量刷新语义。
- **未知 `tag_id`（如 999999999）返回 `code=0` + `items:[]`，不是错误码**——配置校验不能依赖错误码；空首屏不得解释为「tag 有效」。
- `id` 与 `seq` 均为十进制字符串（实测 id=5557725 量级、seq=681424550 量级，当前未超 2^53，但契约仍按字符串处理）；`create_time_ms/update_time_ms` 为毫秒。

## 7. 板块（真实证据）

- 目录：`industry` 320 条、`cn_concept` 390 条，单 tag 全量无分页；代码为 `.TI`。
- 快照：`/api/a-share-index/prices/snapshot?thscodes=881273.TI,881101.TI` 返回完整 OHLC + `prev_price` + `volume/turnover`；`price_change_ratio_pct` 为百分数原值（1.567575 = 1.57%），与设计 §10.1「除以 100 转小数」一致。`data.timestamp` 为抓取期时间，维持 retrieval 语义。
- 个股反查：600519.SH→`881273.TI 白酒 (industry)`；000001.SZ→`881155.TI 银行 (industry)`；`type=industry` 过滤生效。空 `index_list` 语义按文档保留。

## 8. 财务（真实证据）

- 三大报表契约一致：`period/fiscal_year/fiscal_period/report_date_ms/period_end_ms/currency` 元数据齐全；金额原币元、`basic_eps` 元/股；`data.timestamp` = 最大 `period_end_ms`。
- **跨表 `report_date_ms` 不一致（真实证据）**：600519.SH FY2025 利润表/现金流量表 `report_date_ms=1776355200000`（2026-04-13），资产负债表同期为 `1793376000000`（2026-10-26）。披露日必须按报表分别记录，不得假设同一报告期三表同日披露。
- 财务指标：**`index_id` 与文档存在漂移（真实证据）**。growth 类实测为 `calculate_operating_income_yoy_growth_ratio / calculate_operating_profit_yoy_growth_ratio / total_assets_growth_ratio / calculate_parent_holder_net_profit_yoy_growth_ratio`；文档写作 `operating_income_yoy_growth_ratio / net_profit_yoy_growth_ratio` 等。且 `calculate_parent_holder_net_profit_yoy_growth_ratio` 语义是「归母净利润同比」，与文档的 `net_profit_yoy_growth_ratio`（净利润同比）**不是同一指标**。其余四类（profitability/solvency/operation/cash-flow）id 与文档一致。指标 registry 必须按实测 id 建立，并对 growth 类标注单位与口径来源。
- **revision 证据检查（PIT 门禁）**：响应只提供 `report_date_ms`（披露日）与 `period_end_ms`，**没有任何重述版本身份、修订发布时间或撤回关系字段**；同一报告期多次请求只返回当前值。结论：设计 §11.2 的双轨判断成立——`REAL_FINANCIAL_FACT_SOURCES` 继续不包含 Fuyao，strict PIT 财务门禁维持 `not-ready`；当前快照轨必须展示 `viewKind='current-vendor-view'` 与 `pitStatus='not-ready'`。
- 估值快照：5 指标（pe_ttm/pe_mrq/pb_mrq/ps_ttm/pcf_ttm）齐全；`data.timestamp` 为上游元数据最大有效时间，不代表同刻更新。

## 9. 动态限流

本次验证为低频顺序请求（22+ 次调用，间隔自然），未触发 429/4001；限流行为无真实证据，标记为**待验证**（设计 §17.2 要求多域并发下实测共享冷却，留待 Phase 1 共享协调器实现后补验）。

## 10. 与文档/设计不一致点汇总（全部来自真实证据）

| # | 位置 | 文档/设计假设 | 实测 |
|---|---|---|---|
| 1 | dump download-url | 字段名未列出，设计猜测 `downloadUrl/expiresAt/dumpId` | 实为 `presigned_url/presigned_url_expires_at/expires_in_seconds`；无独立 dumpId，须从 URL 路径解析 |
| 2 | dump 文件大小探测 | —（未约定） | HEAD 403（签名按 GET）；须用 `Range: bytes=0-0` + `Content-Range` |
| 3 | 复权事件主键 | `(thscode, ex_date_ms)` 为主键 | 3 个重复键（1 纯重复、2 同日拆分事件）；导入必须内容 hash 去重并保留多动作 |
| 4 | Parquet 读取 | 「Node 运行时兼容 cursor」 | 文件为 ZSTD；`parquetjs-lite`/`@dsnp/parquetjs` 不可用，`parquet-wasm`+`apache-arrow` 可行 |
| 5 | 天梯日期格式 | 示例 `YYYYMMDD` | 实测 `YYYY-MM-DD` |
| 6 | 快讯未知 tag_id | 未约定 | 返回 `code=0` 空列表而非错误；空首屏≠tag 有效 |
| 7 | 财务指标 id | growth 类 4 个文档 id | 3 个带 `calculate_` 前缀；`net_profit_yoy_growth_ratio` 实为归母口径 `calculate_parent_holder_net_profit_yoy_growth_ratio` |
| 8 | 三表披露日 | 隐含同期一致 | 600519.SH FY2025 资产负债表披露日晚于利润表约 6 个月；披露日须按表记录 |
| 9 | 鉴权错误码 | 缺失 key → 2001 | 缺失与无效 key 均 → 2003 |
| 10 | 涨停时间格式 | 设计假设补为 HH:MM:SS | 实测 `HH:mm`，补 `:00` 即可 |

## 11. 后续动作建议（不属本任务实施范围）

- Phase 1 共享 `FuyaoClient.getData()` 按上述实测 schema 固化各域 Zod；下载 URL 解析增加路径段 `dump_id` 提取与 300s 有效期处理；禁用 HEAD。
- dump 导入器：内容 hash 去重 + 同日多动作拆分；`parquet-wasm` 依赖决策写入实施 PR。
- 指标 registry 按实测 id 建表，growth 类标注「归母 vs 净利润」口径差异。
- 财务快照输出固定携带 `viewKind/pitStatus='not-ready'`；三表 `report_date_ms` 分别落库。
- 限流共享冷却留待 Phase 1 协调器实现后用并发实测补证据。
