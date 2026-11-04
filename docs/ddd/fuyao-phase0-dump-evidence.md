# Fuyao Phase 0 Dump 契约补充证据（2026-11-03）

> 类型：验收证据（脱敏）。对应 [Fuyao 数据能力扩展与 Tushare 退役详细设计](./fuyao-data-expansion-and-tushare-retirement-design.md) §16 Phase 0 与 §5 Market dump。
> 验证时间：2026-11-03 23:26–23:40（Asia/Shanghai）；验证人：编码 Agent（dump 契约复核子任务）。
> 凭据：仓库 `.env` 中已配置的标准 `FUYAO_API_KEY`（值不进入本文档、日志或任何持久化产物）。
> 范围边界：本次只复核 dump 下载 URL 三种响应形状、以近期 10 日 artifact 做 schema 取证（不下载 10 年全量文件）、Node Parquet 读取方案、公司行动在线响应（含配股字段可见性）。原始抓取与 artifact 存于 `/tmp/fuyao-phase0-dump-evidence/`（0600，本地临时，不入库、不提交）。
> 脱敏夹具：[`packages/adapters/src/fuyao/fixtures/`](../../packages/adapters/src/fuyao/fixtures/) 下 `dump-download-url.*.json` 与 `corporate-actions.*.json`；预签名 URL 已整体脱敏为 host+路径前缀+签名参数名清单，`request_id` 归零。
> 同日已有更宽域的契约验证记录见 [fuyao-phase0-contract-verification-2026-11-03.md](./fuyao-phase0-contract-verification-2026-11-03.md)；本文是 dump/公司行动方向的独立复核与补充，两处证据一致处不再重复展开。

## 1. Dump download-url 响应形状（三种，真实响应固化）

三个端点 `GET /api/dump/market-dumps/{daily-k,daily-k-10d,adjustment-factors}/download-url` 本次实测均返回 `code=0`，`data` 键集合完全一致：

```json
{
  "code": 0,
  "data": {
    "presigned_url": "https://o.thsi.cn/<bucket>/market-dump/<data_type>/releases/<yyyymmdd>/<dump_id>_<yyyymmdd>.parquet?<签名查询参数>",
    "presigned_url_expires_at": "2026-11-03T23:26:10.979815767+08:00",
    "expires_in_seconds": 300
  }
}
```

| kind | URL 路径中的 data_type | URL 路径中的 dump_id |
|---|---|---|
| `daily-k` | `daily_k` | `a_share_daily_k_1d_none_10y` |
| `daily-k-10d` | `daily_k` | `a_share_daily_k_1d_none_10d` |
| `adjustment-factors` | `adjustment_factors` | `a_share_adjustment_factors_event_none_all` |

复核结论（与既有记录一致，本次独立复测）：

1. 字段名为 `presigned_url / presigned_url_expires_at / expires_in_seconds`；**无独立 `dumpId` 字段**，dump 身份必须从 URL 路径段 `<data_type>/releases/<date>/<dump_id>_<date>.parquet` 解析。
2. `presigned_url_expires_at` 为带纳秒（9 位小数秒）的 RFC3339，时区 `+08:00`；解析器必须容忍纳秒。
3. `expires_in_seconds=300`，与文档「通常 5 分钟」一致。
4. 签名查询参数名为 `AWSAccessKeyId / Expires / Signature`（S3 兼容签名）。
5. **HEAD 探测返回 403**（签名按 GET 签发）；文件大小探测必须用 `Range: bytes=0-0` 读 `Content-Range`。本次实测：HEAD→403，`Range: bytes=0-0`→206，`Content-Range: bytes 0-0/1057663`，`Content-Type: application/octet-stream`。
6. 预签名 URL 不落库、不落日志、不进入 ToolResult；夹具中只保留 host+路径前缀与参数名清单。

## 2. 近期 10 日 artifact schema 取证（代替全量下载）

按任务边界，本次只下载 `daily-k-10d` artifact（约 1 MB）做 schema 与不变量取证，不下载 10 年全量文件（约 182 MB，既有记录 §2.2 已固化其行数与范围，本次不重复消耗）。

| 属性 | 实测值 |
|---|---|
| 大小 | 1,057,663 B |
| SHA-256 | `01ca8636870ac8f5c0460f1f95fabf3a7902b0f14f5d1da19cbb32817ff25100` |
| 行数 | 55,689 |
| 唯一 thscode | 5,574 |
| 日期范围（Asia/Shanghai） | 2026-10-21 → 2026-11-03（恰好 10 个交易日） |
| `(thscode, date_ms)` 重复键 | 0 |
| `interval` / `adjusted` / `currency` | 全行 `1d` / `none` / `CNY` |
| volume=0 行 / null turnover 行 / 非正 OHLC 行 | 0 / 0 / 0 |
| row group | 1 个（55,689 行） |
| 压缩编码 | **ZSTD**（全部列） |
| writer | `parquet-mr version 1.15.2` |

物理 schema（11 列，与文档逐列一致）：

| 列 | Arrow 类型 |
|---|---|
| `thscode` / `currency` / `interval` / `adjusted` | Utf8 |
| `date_ms` | Int64 |
| `open_price` / `high_price` / `low_price` / `close_price` / `volume` / `turnover` | Float64 |

样本行（600519.SH，2026-11-03）：`open=1450.0 high=1480.0 low=1435.1 close=1480.0 volume=7,412,056 turnover=10,825,780,462.63`，`date_ms=1793635200000`（上海零点）。

结论：设计 §5.2 的读取前校验项（`interval=1d`、`adjusted=none`、CNY、精确列集合）在 10 日 artifact 上全部成立；schema 漂移检测按此列清单实现即可。

## 3. Node Parquet 读取方案（真实 artifact 实测）

在 Node 22（`/tmp/parquet-test` 隔离目录安装依赖）对本地下载的 10 日 artifact 实测：

| 方案 | 结果 | 证据 |
|---|---|---|
| `parquetjs-lite@0.8.7` | ❌ 不可用 | 抛 `invalid compression method: ZSTD` |
| `@dsnp/parquetjs@1.8.8` | ❌ 不可用 | 抛 `invalid compression method: ZSTD` |
| `parquet-wasm@0.9.0` + `apache-arrow@21.2.0` | ✅ 可用 | `readParquet(bytes)` + `tableFromIPC(table.intoIPCStream())` 读出 55,689 行 × 11 列，类型映射 `Utf8/Int64/Float64` 正确 |

`parquet-wasm` 的分批/流式能力（设计 §5.2「cursor 逐批读取，不整表载入内存」的落地候选）：

- `ParquetFile.fromFile(Blob)` 打开后，`metadata().numRowGroups()` 与 `rowGroup(i).numRows()` 可读元信息；
- `await pf.read({ rowGroups: [0] })` 支持按 row group 选择性读取（本 artifact 单 row group，读出 55,689 行）；
- `await pf.stream({ batchSize: 20000 })` 产出异步行批流，实测 3 批读尽 55,689 行——满足分批导入（设计 §5.4 每批 1,000 行可用更小 `batchSize`）的内存门禁。

结论：实施依赖决策为 **`parquet-wasm`（Node 入口）+ `apache-arrow`**；`parquetjs-lite` 与 `@dsnp/parquetjs` 因不支持 ZSTD 不可用。全量 182 MB 文件应走 `ParquetFile.stream({batchSize})` 分批，不整表载入。

## 4. 公司行动在线端点抽样（含配股字段可见性）

`GET /api/a-share/corporate-actions/adjustment-factors` 本次抽样 6 只股票（600519.SH 全历史 30 条、000001.SZ 窗口 7 条、000401.SZ 25 条、600030.SH 28 条、000776.SZ 24 条，另窗口复测 601166.SH / 000725.SZ / 600030.SH）：

1. **响应形状**：`data = { thscode, ticker, item[] }`；item 字段集合在全部样本中稳定为 `ticker / ex_date_ms / dividend_per_share / per_share_bonus` 四键——**确认在线端点不返回 `event_type / record_date / adjust_factor`，也不返回 `allotment_ratio / allotment_price`**。配股证据只能来自 adjustment-factors dump（其 schema 含 `allotment_ratio / allotment_price` 两列）。
2. **配股事件在线不可区分（真实证据）**：600030.SH（中信证券）2022-01-19 配股除权窗口实测返回 `{"ticker":"600030","ex_date_ms":1643212800000,"dividend_per_share":0,"per_share_bonus":0}`——配股事件在线呈现为「零分红零送股」行，与「无事件」无法区分。这强化设计 §6.1「仅凭在线响应不得声明配股覆盖完整」：在线端点甚至会**出现**配股除权日但丢失全部配股参数，导入端不得把零值行当噪声丢弃，也不得据在线数据推导配股。
3. `ex_date_ms` 为上海零点毫秒；item 按 `ex_date_ms` 降序。
4. 窗口查询语义：`from/to`（YYYY-MM-DD）按除权日过滤生效；无事件窗口返回 `code=3002`（no_data，实测 000725.SZ 2009–2010 窗口），不是空 item 列表——调用方须把 3002 当合法空结果处理。

## 5. 与既有证据的关系

- 与 [fuyao-phase0-contract-verification-2026-11-03.md](./fuyao-phase0-contract-verification-2026-11-03.md) §2/§3 的结论逐项一致（字段名、HEAD 403、ZSTD、parquet-wasm 方案、在线端点无配股字段）；本次新增证据：600030.SH 配股窗口的零值行实测、`ParquetFile.stream({batchSize})` 分批流式读取验证、3002 空窗口语义。
- 设计 §5.2「Node 运行时兼容的 Parquet cursor」落地依赖确定为 `parquet-wasm + apache-arrow`，写入实施期依赖决策。
- 设计 §6.1 配股覆盖判断维持：dump 是唯一配股证据源；在线端点用于现金/送转的补取与交叉核验，且其零值行可能对应配股除权日，不得静默丢弃。

## 6. 产物清单

- 脱敏夹具（本任务写入，入仓库）：
  - `packages/adapters/src/fuyao/fixtures/dump-download-url.daily-k.json`
  - `packages/adapters/src/fuyao/fixtures/dump-download-url.daily-k-10d.json`
  - `packages/adapters/src/fuyao/fixtures/dump-download-url.adjustment-factors.json`
  - `packages/adapters/src/fuyao/fixtures/corporate-actions.600519.sample.json`
  - `packages/adapters/src/fuyao/fixtures/corporate-actions.000001.window.json`
  - `packages/adapters/src/fuyao/fixtures/corporate-actions.600030.rights-window.json`
- 本地临时证据（0600，不入库、不提交）：`/tmp/fuyao-phase0-dump-evidence/captures.json`（脱敏响应全集）、`daily-k-10d.parquet`（真实 artifact）。
- 本文档：`docs/ddd/fuyao-phase0-dump-evidence.md`。
