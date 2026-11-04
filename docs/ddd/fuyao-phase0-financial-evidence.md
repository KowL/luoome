# Fuyao Phase 0 财务域真实契约取证

> 日期：2026-11-03（Asia/Shanghai）
> 范围：三大报表、财务指标、估值快照的权限、响应形状、错误码与 revision 证据探测；对应 [Fuyao 扩展设计](./fuyao-data-expansion-and-tushare-retirement-design.md) §16 Phase 0 与 §11 财务双轨。
> 凭据：使用仓库既有标准 `FUYAO_API_KEY`（`.env`），未打印、未落盘、未写入任何文件；所有探测为幂等 GET。
> 脱敏：本文与 fixtures 不含 API Key、完整请求 URL、`request_id` 与私人数据；fixtures 保留公开财务样本数值。

## 1. 探测方法与样本

- 端点 Base：`FUYAO_BASE_URL` 默认值（生产域名），请求头 `X-api-key` 鉴权。
- 样本标的：`600519.SH`（三大报表、估值）、`300033.SZ`（指标，2025-1 与 2020-4）、`000001.SZ`（估值第二标的）、`688981.SH`（季报 null 字段探测）、`999999.SH`（不存在标的）、`430047.BJ`（北交所文档示例）。
- 夹具：`packages/adapters/src/fuyao/fixtures/{income-statements,balance-sheets,cash-flow-statements,indicators,valuations-snapshot}.json`，已剥离 `request_id`，内容与实时响应逐项一致（内容 hash 见 §5）。

## 2. 权限矩阵（真实响应）

| 探测 | HTTP | code | 设计映射 | 实测 message（摘要） |
|---|---:|---:|---|---|
| 三大报表 ×3（有效 Key） | 200 | 0 | 成功 | success |
| 财务指标（有效 Key） | 200 | 0 | 成功 | success |
| 估值快照（有效 Key） | 200 | 0 | 成功 | success |
| 缺失 `X-api-key` | 200 | 2003 | permission | Missing X-api-key |
| 无效/伪造 Key | 200 | 2003 | permission | Invalid or revoked API key |
| 缺 `thscode` | 200 | 1001 | 参数缺失（upstream_error） | Missing required parameter: thscode |
| 指标缺 `report` | 200 | 1001 | 参数缺失 | Missing required parameter: report |
| 估值空 `thscodes` | 200 | 1001 | 参数缺失 | Missing required parameter: thscodes |
| `limit` 与 `start/end` 同传 | 200 | 1004 | 参数冲突 | limit must not be set together with start/end |
| 半开区间（仅 `start`） | 200 | 1004 | 参数冲突 | start and end must be provided together |
| 非法 `period` 枚举（monthly） | 200 | 1002 | 参数格式错 | Invalid parameter format: period |
| 不存在标的 `999999.SH` | 200 | 1002 | 参数格式错（实测） | Unknown thscode: 999999.SH |
| 估值不存在标的 | 200 | 3001 | no_data（标的不存在） | Target not found |
| 指标远期报告期 `2099-1` | 200 | 5003 | upstream_error | Data source unavailable |
| 北交所 `430047.BJ` 利润表 | 200 | 1002 | 参数格式错（实测） | Unknown thscode: 430047.BJ |

关键结论：

1. **当前 Key 对五个财务 capability 均已授权**（code=0），不存在 2003 能力级拒绝。
2. **未认证与无效 Key 均返回 2003**，与文档「2001 未认证」不一致：实测无 Key/假 Key 都是 `code=2003`。现有 `fuyaoErrorKindOf` 把 2001/2003 同映射 `permission`，行为兼容；但 2001 在财务域未观测到，不得断言其存在。
3. **不存在标的表现不统一**：报表/指标路径返回 `1002 Unknown thscode`，估值路径返回 `3001 Target not found`。实现侧不得假定「标的不存在」恒为 3001。
4. 北交所文档示例 `430047.BJ` 实测 `1002 Unknown thscode`：当前 Key/服务对该代码表无覆盖，板块后缀支持范围需以真实响应为准，不能照抄文档示例。
5. 20 并发突发估值请求全部 `200/0`，未触发 429/4001；限流阈值本次未观测到，动态限流设计（§4.2）仍按文档保守实现。

## 3. 响应契约实测

### 3.1 三大报表（income/balance/cash-flow）

- 信封：`{code, message, request_id, data:{timestamp, item[]}}`，HTTP 恒 200。
- `item[]` 元数据字段全集（三张表一致）：`thscode, ticker, period, fiscal_year, fiscal_period, report_date_ms, period_end_ms, currency`。
- 业务字段与文档一致：利润表 13 个（含 `basic_eps` number、元/股）；资产负债表 7 个；现金流量表 6 个。金额字段均为 number、原币元。
- `data.timestamp` 实测等于响应内最大 `period_end_ms`（annual limit=3 时 = 2025 年报期末 1767110400000；quarterly limit=4 时 = 最近季末 1790697600000），证实设计 §11.1「不得作为 fetch/披露/revision 时间」的判断。
- 区间模式（2023Q1–2024Q4 quarterly）返回 8 期，按 `period_end_ms` 严格降序；`report_date_ms` 与 `period_end_ms` 不同值（如 2024-Q4：`period_end=1735574400000`、`report_date=1776355200000`），披露日字段真实存在且可用。
- null 透传实证：`688981.SH` 季报 8 期中 `interest_expenses` 存在 null 期；其余字段未见 null。未观测到补零行为。
- `currency` 恒 `CNY`。

### 3.2 财务指标 `/financials/indicators`

- 信封 `data` **不是** `item[]`，而是 `{thscode, report, abilities[]}`——证实设计 §4.1「新增端点存在非列表数据，不能用 `parseFuyaoEnvelope` 的 item[] 假设」。
- `abilities` 固定 5 块，实测顺序 `growth → profitability → solvency → operation → cash-flow`，与文档一致。
- 实测 `index_id` 全集（2025-1，300033.SZ，共 23 项）：
  - growth：`calculate_operating_income_yoy_growth_ratio`、`calculate_operating_profit_yoy_growth_ratio`、`total_assets_growth_ratio`、`calculate_parent_holder_net_profit_yoy_growth_ratio`
  - profitability：`total_assets_net_ratio`、`index_deduct_weighted_avg_roe`、`sale_gross_margin`、`sale_net_interest_ratio`、`index_weighted_avg_roe`
  - solvency：`current_ratio`、`cash_ratio`、`quick_ratio`、`earned_interest_multiple`、`assets_debt_ratio`
  - operation：`total_assets_turnover_ratio`、`inventory_turnover_ratio`、`long_term_debt_equity_ratio`、`current_assets_turnover_ratio`、`receive_account_turnover_ratio`
  - cash-flow：`net_profit_cash_content`、`cash_operating_index`、`operating_cash_flow_net_divide_income`、`cash_meet_invest_ratio`
- **文档指标表与实测不一致**：文档 growth 示例列 `net_profit_yoy_growth_ratio` 等，实测返回 `calculate_*` 前缀变体。指标 registry 必须按实测枚举建模，并把未识别 `index_id` 作为 schema 漂移处理，不能按文档清单硬编码白名单。
- `value` 为字符串或 null（实测 23 项中 2 项 null：`earned_interest_multiple` 等）；百分比类按百分数值字符串（如 `"84.2978"` 表示 84.2978%）；小数位不固定（`"-16.0031"` vs `"20.90499000"`），证实「不承诺固定小数位」。
- 历史报告期 `2020-4` 可查（code=0，5 块齐全），指标具备多年历史可得性；远期 `2099-1` 返回 5003 而非 3002，「无数据」与「上游不可用」在指标域混用，实现需把 5003 归为 upstream_error 而非空数据。

### 3.3 估值快照 `/valuations/snapshot`

- `data:{timestamp, total, item[]}`；`item[]` 固定 5 指标 `pe_ttm/pe_mrq/pb_mrq/ps_ttm/pcf_ttm` + `thscode/ticker/name`。
- 实测 `total=2`、按请求顺序返回；`name` 返回中文名。
- `data.timestamp` 漂移实证：同一标的间隔 2s 两次请求，`timestamp` 从 1793719226000 变为 1793719228000 而 `pe_ttm` 不变——证实文档「上游指标元数据最大有效时间」语义，**该值随请求波动，既不是估值计算时间也不是五个指标同刻更新时间**，实现不得将其持久化为 observedAt。
- 负值/高精度原样返回（如 `pb_mrq: 0.479142`、`pcf_ttm: 0.433168`），无取整。

## 4. Revision 身份与时间探测（§11.2 双轨判定）

探测方式：同一端点、同一标的、同一参数，间隔 1.5–2s 重复请求，比较 `data.item`（或 `abilities`）内容 SHA-256 与字段集合；并扫描全部 item 字段名中是否存在 revision/restate/retract/version/publish/announce/update/amend/correct 类键。

| 探测 | 两次内容 hash | 字段集合变化 | revision 类字段 |
|---|---|---|---|
| 利润表 annual limit=3 | 相同（`930bcb2ffdd6a815`） | 无 | 无 |
| 利润表 quarterly limit=4 | 相同（`f75f7f0f7b5ef350`） | 无 | 无 |
| 财务指标 2025-1 | 相同（`74234e98afe7498f`） | 无 | 无（data 无 item，无时间字段） |
| 估值快照 | 相同（`4470fe5da5352f7c`） | 无 | 无 |

结论：

1. **未观测到任何 revision identity / revision time 字段**。三大报表 item 只有 `report_date_ms`（披露日）与 `period_end_ms`（报告期末）；指标 `data` 连时间字段都没有；估值仅有会漂移的元数据 `timestamp`。
2. 同一报告期的「当前值」在重复查询下内容一致，但这只证明短期幂等，**不证明重述可见性**：接口没有任何字段能区分「原始披露版」与「重述版」，也无撤回关系。
3. 按设计 §11.2：`recordedAt` 不得复制为 `revisionPublishedAt`，内容 hash 不得命名为 `sourceRevision`，多期当前值序列不得当作历史 vintage。本次实测支持该结论——**严格 PIT 财务门禁维持 not-ready**，`REAL_FINANCIAL_FACT_SOURCES` 继续不包含 Fuyao。
4. 局限：本次为单时点探测，未捕获真实重述事件（需要跨披露窗口的长期观测）。若未来要做 PIT 升级评审，需按 §11.2 补「公告版本发现 + 重述/撤回样本 + 两次以上真实同步审计」证据。

## 5. 夹具清单与内容指纹

| 文件 | 端点 | 样本 | data.item/abilities 内容 SHA-256（前 16） |
|---|---|---|---|
| `packages/adapters/src/fuyao/fixtures/income-statements.json` | 利润表 | 600519.SH annual ×3 | `930bcb2ffdd6a815` |
| `packages/adapters/src/fuyao/fixtures/balance-sheets.json` | 资产负债表 | 600519.SH annual ×3 | `eb01387508fa4b50` |
| `packages/adapters/src/fuyao/fixtures/cash-flow-statements.json` | 现金流量表 | 600519.SH annual ×3 | `9d038484850edcc5` |
| `packages/adapters/src/fuyao/fixtures/indicators.json` | 财务指标 | 300033.SZ 2025-1（5 块 23 项） | `609c726131f79af6` |
| `packages/adapters/src/fuyao/fixtures/valuations-snapshot.json` | 估值快照 | 600519.SH + 000001.SZ | `2d1f86de3b79486f` |

夹具已剥离 `request_id`；估值 `data.timestamp` 为易漂移元数据，消费夹具的测试不得对其做精确断言。

## 6. 对实施清单的反馈（Phase 5 前置）

1. 财务报表三端点可共用一个 item schema 基座 + 各领域业务字段；`report_date_ms → reportDate`、`period_end_ms → periodEnd` 映射可行。
2. 指标端点需要独立 envelope 分支（`data.abilities`），`parseFuyaoEnvelope` 的 `item[]` 假设必须泛化（设计 §4.1 已覆盖，实测确认必要）。
3. 指标 registry 按 §3.2 实测 23 项建模，单位映射：`growth/profitability` 中含 ratio/margin/roe 的按 percent-points；`current_ratio/quick_ratio/cash_ratio` 为比率；`earned_interest_multiple` 为倍数；`*_turnover_ratio` 为次；cash-flow 块按字段定义逐项确认，禁止按中文名猜单位。
4. 错误模型：财务域「不存在标的」按路径分化为 1002/3001；`fuyaoErrorKindOf` 现有映射可覆盖，但适配器文档需注明 1002 在此域也承担 unknown-thscode 语义。
5. 估值 `data.timestamp` 只作展示元数据，不进 `observedAt`；快照时间延续 `timestampSource='retrieval'` 口径。
6. 北交所覆盖未验证通过，股票目录兼容矩阵需以真实探测为准。

## 7. 边界与未覆盖项

- 未探测 dump、公司行动、天梯、龙虎榜、资讯、板块端点（属其它 Phase 0 任务边界）。
- 未触发 429/4001；动态限流行为仅有文档依据，无实测证据。
- 未验证季度累计值口径（本期不单季化，设计 §11.1 已禁止）；TTM 拼接未做。
- 重述/撤回长期观测未做（见 §4 局限）。
