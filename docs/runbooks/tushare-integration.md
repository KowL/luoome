# Tushare 集成手册

luoome 与 tushare 官方 HTTP API（tushare.pro）的对接约定。本文聚焦**配置、启用、故障排查**；协议映射与字段设计见 [`docs/ddd/tushare-market-adapter-design.md`](../ddd/tushare-market-adapter-design.md)，代码在 `packages/adapters/src/tushare/`（客户端与 envelope 解析）与 `packages/adapters/src/market/tushare.ts`（行情适配器）。

> 本文替代原 adshare 集成手册（adshare 私有代理服务已整体移除，行情第三源改为直连 tushare 官方 API）。

## 1. 环境变量

仓库根目录的 `.env.example` 是 git 追踪的模板；本地开发复制为 `.env`（`.env` 已在 `.gitignore`）后填写真实值。

```ini
LUOOME_MARKET_SOURCES=eastmoney,tencent,tushare
TUSHARE_TOKEN=replace-me-with-real-token
# TUSHARE_URL=http://api.tushare.pro
```

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `TUSHARE_TOKEN` | 启用 tushare 时必填 | — | tushare.pro 账号的 API token，作为 POST body 的 `token` 字段发送。**未配置时不得在 `LUOOME_MARKET_SOURCES` 中启用 tushare**，否则启动期抛错。 |
| `TUSHARE_URL` | 否 | `http://api.tushare.pro` | API 地址覆盖，仅在走自建代理网关 / 镜像时设置；正常直连保持缺省即可。 |

超时与重试为代码内常量：单次请求 10s 超时，5xx / 网络错误指数退避重试 2 次（`200ms × 2^attempt`），4xx 不重试。见 `packages/adapters/src/tushare/client.ts`。

> 用 `LUOOME_MARKET_SOURCES` 控制启用状态和优先级，例如 `eastmoney,tencent,tushare`。
> 从左到右依次映射为 primary / fallback / finalFallback，省略即关闭；也可在 Web
> 「设置 → 行情数据源」中修改并立即应用（未配置 `TUSHARE_TOKEN` 时界面不允许启用）。
> 旧 `LUOOME_MARKET_ADSHARE` 开关与 `ADSHARE_*` 变量已删除。

## 2. 获取 token 与积分/权限要求

1. 在 [tushare.pro](https://tushare.pro) 注册账号，个人主页复制 token 填入 `TUSHARE_TOKEN`。
2. 各接口按 tushare 的积分/权限体系单独放行，luoome 用到的三个接口要求如下：

| 接口 | 用途 | 要求 |
|------|------|------|
| `daily` | 日 K 线（vol 单位=手） | 2000 积分起 |
| `adj_factor` | 复权因子 | 2000 积分起 |
| `rt_k` | 实时快照（close 即最新价，vol 单位=股） | **需单独开通权限**，见 [文档 doc_id=290](https://tushare.pro/document/1?doc_id=290) |
| `stock_basic` | 股票列表 / 搜索 | 2000 积分 |

未开通或积分不足的接口，tushare 返回 `code≠0`（常见 `2002`，msg 类似「抱歉，您没有权限访问该接口」），luoome 侧表现为 `tushare upstream_error` 日志与降级到下一数据源。`fetchDailyBars` 中 `adj_factor` 失败只降级（复权因子按 1.0 占位并打 warn），不会拖垮日线。

## 3. 启用方式

1. `.env` 填入 `TUSHARE_TOKEN`；
2. `LUOOME_MARKET_SOURCES` 的逗号列表中加入 `tushare`（位置决定优先级，可选值只有 `eastmoney,tencent,tushare`）；
3. 重启 luoome（CLI / TUI / MCP / web 任一 surface 都经 `packages/adapters/src/market/factory.ts` 装配）。

**快速失败语义**：`LUOOME_MARKET_SOURCES` 含 `tushare` 但 `TUSHARE_TOKEN` 缺失时，factory 在启动期抛 `Tushare 已启用，但 TUSHARE_TOKEN 未配置`，进程不会以“已启用但静默不可用”的状态运行。

### 3.1 验证集成链路

```bash
# 1) 直连验证 token 与权限（不经 luoome）
curl -sS -X POST http://api.tushare.pro \
  -H 'Content-Type: application/json' \
  -d '{"api_name":"daily","token":"'$TUSHARE_TOKEN'","params":{"ts_code":"600519.SH","start_date":"20260701"},"fields":"ts_code,trade_date,close,vol"}'
# 期望 {"code":0,...}；code≠0 即 token / 权限问题，先解决再起 luoome

# 2) 起 web 后搜索 smoke test
curl -sS 'http://localhost:5173/api/stocks/search?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0' | jq
```

返回数据的 `source` 字段是关键：启用 tushare 且前排源失败 / 处于抑制窗口时，行情与搜索结果应带 `source: "tushare"`；`"eastmoney"` / `"tencent"` 表示未轮到第三源；搜索回退本地股票库则为 `"local"`。

## 4. 故障排查

按 `权限 → 网络 → 配置` 的顺序收敛。所有远端错误统一为带 `tushare ...` 前缀的普通 `Error`，直接在日志中按前缀检索。

### 4.1 upstream_error：token 或接口权限（code 2002 等）

**症状**

- 日志含 `tushare upstream_error: 2002 抱歉，您没有权限访问该接口...`（或类似 msg）。
- `fetchDailyBars` 仅部分失败：`adj_factor` 打 `tushare.fetchDailyBars adj_factor request failed` warn，日线仍返回但 `adjFactor` 全为 1.0。

**原因**

1. token 错误、过期或复制时带空格 / 换行。
2. 积分不足 2000（`daily` / `adj_factor` / `stock_basic`）。
3. `rt_k` 未单独开通权限（见 §2）。

**排查命令**

```bash
# 1) 确认 .env 实际生效值（不打印完整 token，只看是否非空）
grep -c '^TUSHARE_TOKEN=.\+' .env

# 2) 用 §3.1 的 curl 直连验证每个接口的 code
#    daily / adj_factor / rt_k / stock_basic 逐个 POST，看哪个返回 code≠0

# 3) 到 tushare.pro 个人主页核对积分与各接口权限开通状态
```

**修复建议**

1. 重新复制 token（粘贴到纯文本编辑器核对，无尾随空格）。
2. 积分不足：按 tushare 规则补积分，或接受降级——行情仍由 eastmoney / tencent 提供。
3. `rt_k` 无权限：去 doc_id=290 页面开通；开通前 `fetchQuote` 会一直 `upstream_error`，但 `daily` 链路不受影响。

### 4.2 超时与网络错误（tushare timeout / network）

**症状**

- 日志 `tushare timeout: 远端请求超时（10000ms）` 或 `tushare network: 远端请求失败：...` / `tushare network: 重试耗尽：...`。
- 行情仍显示（降级到下一源），或全源失败时返回“数据不可用”。

**原因**

1. 本机到 `api.tushare.pro` 的网络不通（代理 / 防火墙 / DNS）。
2. tushare 服务端抖动或限流（tushare 按分钟/日限频，超频会先表现为延迟或失败）。
3. 使用 `TUSHARE_URL` 自定义网关时，网关本身不可用。

**排查命令**

```bash
# 1) DNS + 路由
getent hosts api.tushare.pro
ping -c 3 api.tushare.pro

# 2) 直连耗时（无 luoome 超时叠加）
time curl -sS -X POST http://api.tushare.pro \
  -H 'Content-Type: application/json' \
  -d '{"api_name":"stock_basic","token":"'$TUSHARE_TOKEN'","params":{"name":"茅台"},"fields":"ts_code,name"}'
# 期望 2s 内返回 code:0；明显更慢即网络或 tushare 端问题

# 3) 若设置了 TUSHARE_URL，对网关地址重复以上检查
```

**修复建议**

1. 网络不通：确认代理 / 防火墙放行 `api.tushare.pro:80`；企业网络可自建网关并用 `TUSHARE_URL` 指向它。
2. tushare 端抖动：客户端已带 2 次指数退避重试；若频繁触发，降低调用频率并依赖 manager 的 60s Quote / 1h DailyBar 缓存。
3. 网关不可用：恢复网关或移除 `TUSHARE_URL` 回到官方地址。

### 4.3 启动期报错：TUSHARE_TOKEN 未配置

**症状**

- 进程启动即失败，错误 `Tushare 已启用，但 TUSHARE_TOKEN 未配置`。
- Web 设置页保存 `{sources: [..., 'tushare']}` 时报 `启用 Tushare 前必须配置 TUSHARE_TOKEN`。

**原因与修复**

`LUOOME_MARKET_SOURCES` 含 `tushare`，但 `TUSHARE_TOKEN` 为空或未设置。二选一：

1. 在 `.env` 填入有效 `TUSHARE_TOKEN` 后重启；
2. 从 `LUOOME_MARKET_SOURCES` 移除 `tushare`（路由恢复为其余启用源）。

这是故意的快速失败：避免界面显示已启用、运行时却静默跳过第三源。

### 4.4 解析失败（tushare parse / not_found）

**症状**

- 日志 `tushare parse: 响应不是有效 JSON...` / `tushare parse: fields/items length mismatch` / ZodError 派生的 `tushare parse: ...`。
- `tushare not_found: 600519.SH`：envelope 正常但 `items` 为空。

**原因**

1. `TUSHARE_URL` 指向了非 tushare 协议的服务（响应不是 `{code,msg,data:{fields,items}}`）。
2. 响应被中间网关截断或改写。
3. `not_found` 多为代码本身无数据（停牌、退市或代码写错），属正常语义而非故障。

**修复建议**

1. 移除或修正 `TUSHARE_URL`，用 §3.1 的 curl 确认目标服务返回 tushare envelope。
2. `not_found` 不换代码持续出现时，到 tushare 官网确认该代码在对应接口有数据。

## 5. 验证清单

- [ ] `bun run typecheck` 通过。
- [ ] `bun test packages/adapters/src/tushare` —— 客户端与 envelope 契约测试。
- [ ] `bun test packages/adapters/src/market/tushare.test.ts` —— adapter 协议映射测试。
- [ ] `bun test packages/adapters/src/market/manager-resilience.test.ts` —— 第三源路由与抑制窗口。
- [ ] 本地起 web 后手跑 §3.1 的 curl smoke，确认 `source` 字段与日志前缀为 `tushare`。

## 6. 关联阅读

- [`docs/ddd/tushare-market-adapter-design.md`](../ddd/tushare-market-adapter-design.md) —— adapter 契约、字段映射与错误转译设计。
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §4.7 —— luoome 与外部数据源的设计分层。
- [tushare HTTP API 协议（doc_id=130）](https://tushare.pro/document/1?doc_id=130) —— `{api_name, token, params, fields}` 请求与 envelope 响应定义。
