# Fuyao Phase 0 专项证据：天梯/情绪、龙虎榜、资讯、板块

> 日期：2026-11-03（Asia/Shanghai，探测窗口 23:18–23:22）
> 范围：本文只覆盖 `limit-up-pool` / `limit-break-pool` / `limit-up-ladder` / `limit-up-statistics`、`dragon-tiger-list`、`news/flash/list` + `news/flash/refresh` + `news/stock/timeline-list`、`a-share-index/catalog` + `prices/snapshot` + `constituents/ths-index-list-by-stock`。dump、公司行动、财务由其它证据文件负责。
> 凭据：使用仓库 `.env` 中既有 `FUYAO_API_KEY`，未打印、未落盘、未写入任何 fixture 或日志。
> 脱敏规则：fixture 的 `request_id` 统一置零；列表类响应截断为前 2–3 条保留形状；新闻链接为公开文章地址（非预签名 URL），按契约形状保留。原始未截断响应保存在探测机 `/tmp/fuyao-phase0/raw/`，不入库。
> 上游文档：`/tmp/luoome-fuyao-llms-full.txt`（与线上 `https://fuyao.aicubes.cn/llms-full.txt` 同步的取证副本）。

## 1. 权限矩阵（真实 Key 逐 capability 验证）

| Capability | 端点 | 结果 | 证据 |
|---|---|---|---|
| sentiment-sealed-pool | `GET /api/a-share/special-data/limit-up-pool` | `code=0` 已授权 | fixture `limit-up-pool.page1.json` |
| sentiment-broken-pool | `GET /api/a-share/special-data/limit-break-pool` | `code=0` 已授权 | fixture `limit-break-pool.page1.json` |
| limit-up-ladder | `GET /api/a-share/special-data/limit-up-ladder` | `code=0` 已授权 | fixture `limit-up-ladder.json` |
| limit-up-statistics（新增事实端口） | `GET /api/a-share/special-data/limit-up-statistics` | `code=0` 已授权 | fixture `limit-up-statistics.json` |
| dragon-tiger-list（all/org/hot_money） | `GET /api/a-share/special-data/dragon-tiger-list` | 三种 `board_type` 均 `code=0` 已授权 | fixture `dragon-tiger-list.{all,org,hot-money}.json` |
| finance-news（快讯） | `GET /api/news/flash/list`、`/refresh` | `code=0` 已授权 | fixture `news-flash-list.seq0.json`、`news-flash-refresh.up-to-date.json` |
| 个股分时新闻 | `GET /api/news/stock/timeline-list` | `code=0` 已授权 | fixture `news-stock-timeline.first.json` |
| sector-quote（目录+快照） | `GET /api/a-share-index/catalog/ths-index-list`、`/prices/snapshot` | `code=0` 已授权 | fixture `sector-catalog.industry.json`、`sector-snapshot.json` |
| sector-membership（个股反查） | `GET /api/a-share-index/constituents/ths-index-list-by-stock` | `code=0` 已授权 | fixture `sector-membership.industry.json` |

本轮探测未遇到 `code=2003`（权限拒绝）、`code=2001`（鉴权失败）、HTTP 429 或 `code=4001`（限流）。**限流行为未取证**，动态限流设计（§4.2）仍只能按文档承诺实现，不能按"已观测"处理。

所有响应 HTTP 恒 200，信封固定为 `{code, message, request_id, data}`；`request_id` 为 32 位十六进制字符串。错误响应 `data` 为 `null`。

## 2. 涨停池 / 炸板池 / 天梯 / 涨停统计

### 2.1 limit-up-pool（2026-11-03 实盘）

- `data` 形状：`{timestamp, pagination{total,pages,size,page}, item[]}`，与设计文档 §7.2 假设一致（`item[]` 非 `items`）。
- 当日实测：`total=52, pages=2, size=50`；page=2 返回剩余 2 条，`pagination.page/size` 回显请求值。分页读尽逻辑可按 `page < pages` 推进。
- `data.timestamp` 是**数据就绪/采样时间**（实测 `2026-11-03T23:18:51+08:00`，即请求时刻），**不是交易日零点**，不得当作业务日期；业务日期由请求参数 `date_ms`（上海时区零点毫秒）决定。
- `item[]` 实测字段并集：`thscode, ticker, name, is_st, is_new, last_price, price_change_ratio_pct, limit_up_time, limit_up_reason, continue_day_text, continue_day_cnt, seal_money, max_seal_money, open_times`。
- 空值实测：`open_times` 28/50 为 `null`（未开板股票）；`limit_up_reason` 当日全部非空，但文档声明可空，schema 必须允许 `null`。
- `limit_up_time` 格式实测为 `HH:MM`（如 `09:25`、`14:52`），**无秒**；设计文档"格式补为 `HH:MM:SS`"需要在 adapter 层补 `:00`。
- `price_change_ratio_pct` 是已乘 100 的百分数（如 `19.9367` 表示 19.9367%），映射现有小数口径时必须 `/100`。
- `continue_day_cnt` 实测范围 1–4；`continue_day_text` 出现 `首板`、`2连板`、`3连板`、`4连板`；`is_st=true` 4/50（如 ST 豆神 20cm 涨停，`price_change_ratio_pct≈19.94`），ST/20cm 与主板 10cm 混在同一池内，不能按涨跌幅推断板数。
- 历史日可取：`date_ms=2026-10-30`（上海零点）返回 `total=49`，证明按日回溯可用；但 `data.timestamp` 仍是请求时刻，历史响应不携带"当时可见性"证据（对齐设计 §7.3 门禁结论）。
- 参数错误实测：非法 `sort_field` → `code=1002`；`page=0` → `code=1003`。

### 2.2 limit-break-pool（2026-11-03 实盘）

- 形状同涨停池（`pagination` + `item[]`）。当日 `total=33, pages=1`；请求 `page=2` 返回 `item=[]` 且 `pagination` 回显 `page=2` —— **超页返回空列表而非错误**，分页终止必须以 `pages` 为准，不能以空页当错误、也不能以空页当"还有数据"。
- `item[]` 字段并集：`thscode, ticker, name, last_price, price_change_ratio_pct, open_times, first_seal_time, last_seal_time, turnover_ratio_pct, turnover`。
- `first_seal_time/last_seal_time` 为 `HH:MM` 字符串，当日全部非空；文档声明可空，schema 允许 `null`。
- `open_times` 在炸板池为必填整数（实测 1–5+），与涨停池的可空语义不同。
- **无 `seal_money` 字段**：设计文档 §7.2"炸板池 `sealAmount=null`，不从成交额合成封单额"得到实测确认。
- 无行业/概念字段，确认不得用当前板块关系倒灌。

### 2.3 limit-up-ladder（2026-11-03 实盘）

- 无入参。`data` 形状：`{timestamp, window{length, date_list[], board_caps{}}, item[{date, boards{}}]}`。
- 实测 `window.length=30`，`date_list` 30 个交易日，**日期格式为 `YYYY-MM-DD`**（如 `2026-11-03`），与文档示例的 `YYYYMMDD`（`20250620`）**不一致**——以实测为准，parser 按 ISO 带连字符解析，不要按文档示例写死 8 位数字。
- `date_list` 降序（最新在前：`2026-11-03, 2026-11-02, 2026-10-30, …, 2026-09-15`），跳过非交易日。
- `item[]` 每天固定含 `two_board/three_board/four_board/five_board/six_board/seven_over` 六个键，空板位返回 `[]`（30 天 × 6 板位实测无缺键），与文档"缺失板位补 `[]`"一致。
- `boards.*[]` 字段：`thscode, ticker, name, board_num, seal_nextday, sign_level`。
- `seal_nextday` 实测分布：`null` 15（全部集中在最新交易日）、`true` 131、`false` 213 —— 确认**仅最新交易日为 null**，是事后字段，不得回写当时快照（设计 §7.3）。
- `board_num` 实测 2–11，`seven_over` 容纳 7 板及以上；`sign_level` 当日全为 0，字段含义未在文档展开，保留原值即可。
- `board_caps` 是展示高度元信息（如 `two_board: 4`），实际列表可超过该值（当日 `two_board` 12 只），**不能用 cap 截断**。

### 2.4 limit-up-statistics（2026-11-03 与 2026-10-30 实盘）

- 入参 `date=YYYY-MM-DD`（省略取当天/最近交易日）；`data` 形状：`{timestamp, trade_date, seal_rate, open_stock_count, limit_up_stock_count, touched_limit_up_stock_count, page_boards[], exact_boards[]}`。
- 实测 2026-11-03：`seal_rate=0.5926`（小数，非百分数）、`open=33 / limit_up=48 / touched=81`；与炸板池 `total=33`、涨停池收盘口径 48（盘中 52 含曾打开）可交叉核对。
- `trade_date` 回显请求日期，可用于错日检测。
- `page_boards` 固定 5 档：`one/two/three/four/five_plus`；`promotion_rate` 为小数（`0.11` 表示 11%），`one` 档恒为 `null`；`five_plus` 是合并档位。
- `exact_boards` 只列实际存在的板数（如 `[{board_num:4,stock_count:2},{3,1},{2,12}]`），**不保证连续、不保证包含所有档位**，且实测按 `board_num` 降序；消费方不得假定从 1 开始或升序。
- 历史日可取（2026-10-30 正常返回）；`date` 超过一年（2020-01-01）或未来日期（2026-12-01）均返回 `code=1003 date must be within one year`。
- `data.timestamp` 是采样时刻（请求时刻），不是交易日零点。

## 3. 龙虎榜 dragon-tiger-list

- 三种 `board_type` 均授权。`data` 形状：`{timestamp, board_type, trade_date, count, stock_count, stock_items[], hot_money_items[]}`。
- **缺省日期行为实测**：2026-11-03 23:18（当日为交易日且已收盘）不带 `date` 请求，返回 `trade_date=2026-11-02`（上一交易日）。与文档"今天是交易日则默认取上一个交易日"一致。消费方必须读 `trade_date` 回显，不能假定缺省=当天。
- `data.timestamp` 是**目标交易日上海零点**（如 `2026-11-02T00:00:00+08:00`），确认不是发布时间（设计文档 §8 假设成立）。
- 显式 `date=2026-11-03` 返回当日榜（`count=88, stock_count=78`），说明当日榜在收盘后可用。
- `stock_items[]` 实测字段并集（all 榜）：`thscode, ticker, name, change, concept_list[{name}], net_value, net_rate, hot_rank, buy_value, sell_value, limit_reason, range_days, org_net_value, hot_money_net_value`；org 榜额外出现 `org_net_rate, org_buy_num, org_sell_num`。**文档列出的 `amount` 字段在 all/org 榜实测未出现**，只在 hot_money 榜的 `rows[]` 中出现——schema 必须把 `amount` 列为可选。
- **`thscode` 可为 `null`**：2026-11-02 all 榜 77 行中 4 行 `thscode=null`（样本为退市整理股 `萃华退`，`ticker=002731` 仍在）。设计文档按 `thscode` 做身份映射时必须处理 null：建议该行降级为展示行、不生成可路由 stockId，或按 `ticker` 补后缀但标注推断。
- `range_days ∈ {1, 3}` 实测确认当日榜与三日榜混排，同一股票可出现两行；`count`（77）> `stock_count`（73）的差值即多日榜重复。设计的新增可选 `rangeDays` 身份字段有实测依据。
- `change` 与 `net_rate` 实测已是小数（`0.100111`、`0.04443623`），**不要**再 `/100`；金额为元。`hot_rank`、`limit_reason`、`org_net_value`、`hot_money_net_value` 均可为 `null`（实测 null 比例 3/77、41/77、25/77、11/77）。
- **无收盘价、无换手率字段**：确认设计 §8 的 `close/turnoverRate` 改可选 + warning 方案。
- `hot_money` 榜：`stock_items=[]`，`hot_money_items[]` 为 `[{name, buying, rows[]}]`，`rows[]` 字段与 `stock_items[]` 同形并额外含 `hot_money_item_net_value/hot_money_item_net_rate/amount`。
- 错误实测：非法 `board_type` → `1002`；非交易日（2026-11-01 周日）→ `1002 date must be an A-share trading day`（**不自动回退**）；超出一年（2020-01-02）→ `1003`。
- 无分页参数：`count` 即全量（当日 88 行一次性返回），首版无需翻页逻辑。

## 4. 资讯

### 4.1 快讯 flash/list + flash/refresh

- **栏目核实**：`tag_id=21103` 返回 20 条/页的实时财经快讯（A股/港股/美股/公告混合流，`tags[].name ∈ {A股, 港股, 美股, 公告}`），确认是当前财经要闻范围，可作为 `LUOOME_FUYAO_NEWS_TAG_ID` 的已核实取值。`tag_id ∈ {10000, 1, 2}` 均返回 `code=0` 但 `items=[]` —— **未知栏目返回空列表而非错误**，配置错误不会被上游报错暴露，启动期 probe 必须校验"首屏非空"而不是只看 `code=0`。
- `data` 形状：`{items[]}`，**无分页对象、无 has_more**。翻页协议实测：首屏 `seq='0'` 返回最新 20 条；取本页**最后一条的 `seq`** 作为下一页 `seq` 可连续翻页（p1 末 seq `681424565` → p2 首条 seq `681424555`，ID 无重叠，时间单调向过去延伸）。每页固定约 20 条。
- `items[]` 字段实测：`id, seq, title, encoded_url, summary, tags[{id,name}], type, create_time_ms, update_time_ms, pic_url`。
- `id`/`seq` 为十进制字符串（实测 7 位/9 位，文档示例展示过 16 位 `9007199254740993`），**必须按字符串处理**，不能转 Number（精度风险真实存在）。
- `create_time_ms`/`update_time_ms` 为毫秒时间戳且实测整除 1000；`update_time_ms >= create_time_ms`（内容修订），首次发布时间必须用 `create_time_ms`。
- `type` 实测取值 `{0, 1}`（含义文档未展开，保留原值）；`pic_url` 20/20 为 `null`（纯文本快讯流）；`summary` 当日全部非空但文档允许 null。
- `encoded_url` 为 `https://news.10jqka.com.cn/...` 公开文章地址。
- **flash/refresh 实测**：传入当前最新 `seq` + 其 `create_time_ms` 返回 `items=[]`（无增量时不报错、空列表）。`create_time_ms` 不整除 1000 → `code=1002`。刷新语义确认是"已知最新位置的增量拉取"，重复记录由调用方按 `id` 去重。
- 冷启动约束确认：没有合法 `seq` 时无法构造 page>1 请求，设计 §9.1"冷启动 page>1 返回 unsupported_capability"的方案成立。

### 4.2 个股分时新闻 stock/timeline-list

- 入参 `thscode`（完整代码）+ `offset`（首屏 `first`）+ 可选 `size`（1–100）。
- `data` 形状：`{items[], has_more, offset}`；`offset` 为不透明字符串（实测形如 `1792893707.259549`），原样回传翻页。实测 300033.SZ 翻页连续（p1 20 条 → p2 20 条，ID 无重叠，时间向过去延伸），`has_more=true`。
- `size=5` 实测生效（返回 5 条）。
- `items[]` 字段：`id, type, title, author, source, summary, publish_time_ms, jump_url, pic_url`。
- `id` 格式为 `<type>_<数字>`（如 `1_681424590`），与快讯 `id` 命名空间不同，不能混用。
- `author` 实测 10/20 为空字符串 `''`（非 null）；`source` 为媒体名（`同花顺7x24快讯`、`每日经济新闻` 等），个股时间线**有媒体来源**，与快讯列表不同——快讯列表无 `source` 字段，设计 §9.1"列表没有媒体来源时写 `同花顺快讯`"仅适用于 flash。
- `type` 实测 `{1, 2}`；`publish_time_ms` 为毫秒；`jump_url` 为公开文章地址，文档明确"不保证可用于资讯详情查询"。
- 非法代码 → `code=1002 Unknown thscode`（不是 3001）。

## 5. 板块

### 5.1 目录 catalog/ths-index-list

- 四个 tag 均授权，实测规模：`industry` 320 条、`cn_concept` 390 条、`region` 33 条、`tszs` 105 条。单 tag 一次性全量返回，**无分页**。
- `data` 形状：`{timestamp, item[{thscode, name}]}`；指数代码全部 `.TI` 后缀（如 `881101.TI 种植业与林业`、`885431.TI 新能源汽车`、`882001.TI 安徽`、`883902.TI 昨日成交前十`）。确认不暴露 `ticker`。
- `tszs`（特色）目录含"昨日成交前十"等动态榜单型指数，消费方注意它不是静态行业分类。
- 非法 tag → `code=1002`；tag 大小写不敏感（文档声明，未实测大写）。

### 5.2 快照 prices/snapshot

- **必须传 `thscodes`**：缺参返回 `code=1001 Missing required parameter`；`limit/offset` 无效（文档声明）。
- `data` 形状：`{timestamp, total, item[]}`，`total` 回显请求的代码数（4）。
- `item[]` 实测字段：`thscode, ticker, last_price, price_change, price_change_ratio_pct, open_price, high_price, low_price, prev_price, volume, turnover` —— **没有 `name` 字段**！设计 §10.1 的映射 `thscode/name/last_price/...` 中 `name` 必须来自目录接口 join，不能指望快照返回。
- `ticker` 是上游原始代码（`000001.SH` 的 `ticker='1A0001'`），不是 `000001`——不要拿它当纯数字代码用。
- `price_change_ratio_pct` 是百分数原值（`-0.822698` 表示 -0.82%），映射现有小数口径需 `/100`。
- `data.timestamp` 为采样时刻（`2026-11-03T23:19:23+08:00`），延续 retrieval 语义，不能当盘中 observedAt（对齐设计 §10.1.5）。
- `.TI` 指数与 `.SH/.SZ` 标准指数可混查，返回字段一致。

### 5.3 个股反查 constituents/ths-index-list-by-stock

- `data` 形状：`{item[{thscode, index_list[{thscode, name, type}]}]}`；按输入顺序每组保留，无匹配返回空 `index_list`（`000000.SZ` 实测为空组），确认"空列表 ≠ 股票不存在"。
- `type=industry` 单类查询正常（`000713.SZ → 881101.TI 种植业与林业`；`600519.SH → 881273.TI 白酒`）。
- 省略 `type` 返回全部四类：600519.SH 实测 25 条，`type ∈ {cn_concept, industry, region, tszs}`。
- 北交所代码（`430047.BJ`）返回 `code=0` 空 `index_list` —— 接口接受 `.BJ` 但当前无关系数据，不报错。
- 上限实测：101 个代码 → `code=1003`；非法代码（`XXXXXX`）→ `code=1002` 且整批 `data=null`；非法 `type` → `1002`。与设计 §10.2"Tool 有界分批 ≤100"一致。
- 无分页、无 `timestamp` 字段（`data` 只有 `item`）——关系快照的 fetchedAt 只能用本地获取时间。

## 6. 错误码与限流观测汇总

| 场景 | code | message 特征 |
|---|---|---|
| 成功 | 0 | `success` |
| 缺必填参数 | 1001 | `Missing required parameter: thscodes` |
| 参数格式错（枚举/thscode/非交易日/create_time_ms 不整除） | 1002 | `Invalid parameter format: ...` / `Unknown thscode: ...` / `date must be an A-share trading day` |
| 参数越界（page<1、>100 代码、日期超一年/未来） | 1003 | `Parameter value out of range` / `date must be within one year` |
| 限流 429 / 4001 | **未观测到** | 本轮 40+ 请求串行未触发；动态限流行为仍无实测证据 |
| 权限 2003 / 鉴权 2001 | **未出现** | 本 Key 对九个目标 capability 全部授权 |

注意：错误 message 为英文、含具体参数名，可直接进日志（不含凭据）；但 message 文本不应作为程序分支依据，分支只按 `code`。

## 7. 对设计文档的实测修正点

1. **天梯日期格式**：文档示例 `YYYYMMDD`，实测 `YYYY-MM-DD`。parser 以实测为准。
2. **龙虎榜 `stock_items[].amount`**：文档列出但 all/org 榜实测不返回（仅 hot_money `rows[]` 有），必须可选。
3. **龙虎榜 `thscode` 可空**：退市整理股返回 `thscode=null` + 有效 `ticker`，身份映射需要 null 分支，文档与设计均未覆盖。
4. **板块快照无 `name`**：设计 §10.1 映射表中的 `name` 需从目录 join；快照 `ticker` 是上游原始代码（`1A0001`），非纯数字。
5. **快讯未知 `tag_id` 返回空而非错误**：`LUOOME_FUYAO_NEWS_TAG_ID` 配置校验必须做"首屏非空"探测；`tag_id=21103` 已实测为当前财经要闻混合流（A股/港股/美股/公告）。
6. **炸板池超页返回空列表**：分页终止条件用 `page >= pages`，空页不是错误也不是更多数据。
7. **`limit-up-pool` 的 `open_times` 高比例 null（28/50）**：未开板即 null，schema 必填化会炸。
8. **个股时间线 `author` 用空字符串而非 null**：空值规范化要把 `''` 与 `null` 都按缺失处理。
9. **statistics `exact_boards` 不连续且降序**：消费方不得假定档位连续或升序。
10. **缺省龙虎榜日期 = 上一交易日**（交易日当天收盘后亦然）：`fetchList(date)` 缺省语义必须读 `trade_date` 回显。

## 8. 局限与未覆盖

- 限流（429/4001）、`Retry-After`、共享冷却行为未触发，Phase 1 的协调器只能按文档与防御性默认实现。
- 每个端点只观测了 1–2 个交易日的样本；空池（`total=0`）形态未实测（当日两池均非空）。
- `limit-down-pool` 不在本期七个目标域，未探测。
- 天梯历史窗口只验证了返回 30 日，未逐日与涨停池交叉核验。
- 资讯详情（`article/detail`、`notice/detail`）不在本次委托范围，未探测。
- 新闻 `type` 枚举（快讯 `{0,1}`、时间线 `{1,2}`）语义未在上游文档展开，只能原样保留。
- 原始未截断响应在探测机 `/tmp/fuyao-phase0/raw/`，重启后即失；fixture 已按形状截断脱敏入库。

## 9. Fixture 清单

| 文件 | 内容 |
|---|---|
| `packages/adapters/src/fuyao/fixtures/limit-up-pool.page1.json` / `.page2.json` | 涨停池两页（page1 截断 3 条，page2 全量 2 条），真实 pagination |
| `.../limit-break-pool.page1.json` | 炸板池（截断 3 条），真实 pagination `total=33` |
| `.../limit-up-ladder.json` | 天梯（保留前 2 天、每板位 ≤2 条，date_list 截断 5 天） |
| `.../limit-up-statistics.json` / `.2026-10-30.json` | 涨停统计当日 + 历史日全量 |
| `.../dragon-tiger-list.all.json` | all 榜（2 条正常 + 1 条 `thscode=null` 退市股样本） |
| `.../dragon-tiger-list.org.json` / `.hot-money.json` | 机构榜（2 条）、游资榜（1 游资 1 行） |
| `.../news-flash-list.seq0.json` / `.page2.json` | 快讯首屏（3 条）与 seq 翻页（2 条） |
| `.../news-flash-refresh.up-to-date.json` | refresh 无增量空列表 |
| `.../news-stock-timeline.first.json` / `.page2.json` | 个股时间线两页 + 真实 offset 形状 |
| `.../sector-catalog.industry.json` / `.cn-concept.json` | 行业/概念目录（各 3 条） |
| `.../sector-snapshot.json` | 指数快照全量 4 条（含 `.TI` 与 `1A0001` ticker 样本） |
| `.../sector-membership.industry.json` / `.all.json` | 单类反查（含空组）与四类混合（截断 6 条） |
| `.../error.1001-missing-param.json` 等 10 个 | 各错误码真实信封（`data=null`） |
