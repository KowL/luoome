# @luoome/adshare-sdk

Adshare 数据服务轻量 SDK。封装远端 HTTP API，提供股票基本信息、K 线（日线/周线）、实时行情查询能力。

## 功能

- 从环境变量读取 URL、API key、超时和重试配置。
- 双认证头：`X-API-Key` + `Authorization: Bearer <key>`。
- 统一错误类型 `AdshareError`，便于调用方降级。
- Zod schema 校验响应字段。

## 安装

本包是 luoome monorepo workspace 成员，无需单独发布：

```bash
cd /path/to/luoome
bun install
```

## 本地开发示例

```typescript
import { AdshareClient } from '@luoome/adshare-sdk';

// 需要 .env 或环境变量：
// ADSHARE_URL=http://8.148.216.30:8888
// ADSHARE_API_KEY=your-key
const client = AdshareClient.fromEnv();

// 股票基本信息搜索
const stocks = await client.searchStocks({
  name: '贵州茅台',
  fields: ['ts_code', 'name', 'industry'],
});
console.log(stocks);

// K 线
const daily = await client.getKLine({
  ts_code: '600519.SH',
  period: 'D',
  start_date: '20250101',
  end_date: '20250131',
});
console.log(daily);

// 实时行情
const quote = await client.getQuote('600519.SH');
console.log(quote);
```

## 远端接口映射

| SDK 方法 | 远端端点 | 说明 |
|----------|----------|------|
| `searchStocks({ name, ts_code, fields, limit })` | `GET /stock_basic` | 按名称或代码搜索，返回股票基本信息 |
| `getKLine({ ts_code, period, start_date, end_date })` | `GET /daily` 或 `GET /weekly` | `period: 'D'` 走日线，`'W'` 走周线 |
| `getQuote(ts_code)` | `GET /quote` | 实时行情快照 |

## 在 luoome apps/web 中集成

apps/web 已提供 `GET /api/stocks/search?q=<关键词>&limit=<数量>`：

- 优先调用 adshare `/stock_basic`；命中结果则返回 `source: 'adshare'`。
- adshare 未配置或请求失败时，自动回退到本地 `search_stocks` tool，返回 `source: 'market'` 或 `'local'`。
- 响应遵循 `ToolResult` 形状：

```bash
curl 'http://localhost:5173/api/stocks/search?q=贵州茅台'
```

```json
{
  "ok": true,
  "data": {
    "stocks": [
      { "id": "600519.SH", "code": "600519", "exchange": "SH", "name": "贵州茅台", "industry": "白酒" }
    ],
    "total": 1,
    "source": "adshare"
  }
}
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ADSHARE_URL` | 是 | - | 远端根地址，如 `http://8.148.216.30:8888` |
| `ADSHARE_API_KEY` | 否 | `''` | 用于双认证头；远端不强制鉴权时可留空 |
| `ADSHARE_TIMEOUT_MS` | 否 | `10000` | 单次请求尝试的超时（毫秒） |
| `ADSHARE_MAX_RETRIES` | 否 | `2` | 网络错误 / 5xx 的最大重试次数 |

## 错误码

| 错误码 | 场景 |
|--------|------|
| `CONFIG_MISSING` | 环境变量缺失或格式无效 |
| `NETWORK_ERROR` | 请求远端失败 |
| `HTTP_ERROR` | 远端返回非 2xx |
| `TIMEOUT` | 单次请求尝试超时 |
| `PARSE_ERROR` | 响应解析 / Zod 校验失败 |
| `NOT_FOUND` | 无 K 线或行情数据 |
| `INVALID_INPUT` | 调用参数无效 |

## 默认值来源

| 参数 | 默认值 | 出处 |
|------|--------|------|
| `timeoutMs` | `10_000` ms（10 s） | `ADSHARE_TIMEOUT_MS` 或 `client.ts` 构造参数 |
| `retries` | `2`（即初始请求失败后最多再试 2 次，共 3 次） | `client.ts`：`options.retries ?? 2`，退避 200 ms × `2^attempt` |
| `apiKey` | `''`（空串） | `config.ts`：Zod 默认 |
| 鉴权头 | `X-API-Key` 和 `Authorization: Bearer <apiKey>` | `client.ts#headers()` |
| `Content-Type` | `application/json` | `headers()` |

调用方可通过环境变量或 `new AdshareClient({ timeoutMs, retries, ... })` 覆盖；构造参数优先用于显式创建的客户端。

## 部署

### 生产环境 `ADSHARE_URL`

- **使用域名，不要硬编码 IP**。SDK 对 URL 仅做尾斜杠剥离，不解析主机名；硬编码 IP 在迁移、灰度、CDN 接入时全部失效。
- 推荐形态：`https://adshare.example.com/v1`（或内网域名 `https://adshare.internal`），由反向代理（TLS 终止、限流、鉴权）在网关层封装上游 IP `8.148.216.30:8888`。
- 例子：把 `ADSHARE_URL=https://adshare.example.com/v1` 写入 `.env` / K8s Secret，DNS 解析 `adshare.example.com` → 反代 → 上游 `8.148.216.30:8888`。
- 若临时直接使用 IP 也可（`http://8.148.216.30:8888`），但仅限**测试环境**且需在 `.env` 注释中标明到期日，避免被新部署沿用。

### `ADSHARE_API_KEY` 轮换流程

轮换实质上是「**先灰度切流量，再撤销旧 key**」。建议轮换周期：**90 天**（合规基线），发生疑似泄露时立即触发。

1. **生成新 key**：在 adshare 服务端生成新 key，作为候选，**不立即吊销旧 key**。
2. **灰度切流量**：部署一个新实例（或在蓝绿集群中切一部分流量），其 `ADSHARE_API_KEY` 已指向新 key；与旧实例并行运行 10–30 分钟（双发）。
3. **观察验证**：双发期确认新实例的搜索 / K 线接口无 5xx、错误率不上升。
4. **全量切流**：旧实例下架，全部流量走新 key。
5. **撤销旧 key**：远端服务端吊销旧 key。SDK 内失败处理无副作用，无需改代码。
6. **应急**：若新 key 泄露或被吊销，立即将环境变量回滚到上一个已知良好 key（蓝绿切换），不需要发版。

> ⚠️ 注意：luoome SDK 当前未实现双 key 热切换（不会同时读 `*_NEXT` 自动 fallback），所以轮换是「先双发再切流量」而不是「热切」。后续若升级 SDK 可加入 `Authorization-Previous-Key` 或客户端侧 fallback 链。

### 超时 / 重试默认值依据

SDK 暴露两个运行期参数：

| 参数 | 默认值 | 取值依据 |
|------|--------|----------|
| `timeoutMs` | `10_000` ms（10 s） | 每次请求尝试的超时上限（连接 + 读响应头）。生产到 adshare 服务的 RTT 通常 < 50 ms（内网）或 < 200 ms（同城专线），10 s 留出足够余量。 |
| `retries` | `2`（即初始失败后最多再试 2 次，共 3 次） | 仅对网络错误与 5xx 生效；指数退避 `200 ms × 2^attempt`（约 200 ms → 400 ms）。3 次请求 + 2 次退避合计最坏耗时 ≈ 30 s。覆盖单次抖动，不掩盖持续故障。 |

> 说明：任务 body 写的是 `connectTimeout / readTimeout / maxRetries` 三个名字，但当前 SDK 实际只导出 `timeoutMs` 和 `retries`（见 `client.ts`）。后续若需要 connect / read 分开计时，可拆成 `connectTimeoutMs` + `readTimeoutMs`；`maxRetries` 是 `retries` 的同义词。两套命名等价，本文按 SDK 实际导出为准。

生产建议覆盖：

- **搜索接口**（`/stock_basic`）：保持默认。单次超时会回退到真实行情搜索，再回退本地股票库。
- **行情接口**（`/quote`）：保持默认，重试能在亚秒抖动时救场。
- **K 线接口**（`/daily`、`/weekly`）：数据量大时可放宽到 `new AdshareClient({ timeoutMs: 30_000, retries: 1 })`。`retries` 不建议调到 ≥5 —— 5xx 已经过网关上抛，SDK 重试解决不了上游故障，只会放慢 failover。

### 健康检查

`client.ping()` 调用 `GET /health`，任意非 5xx 即视为可达。可作为 K8s readinessProbe：

```yaml
livenessProbe:
  exec: ["node", "-e", "fetch(process.env.ADSHARE_URL+'/health').then(r=>process.exit(r.ok?0:1))"]
  initialDelaySeconds: 5
  periodSeconds: 30
```

### 网络与权限

- 出站：luoome web → 远端 `ADSHARE_URL` 必需放通（默认 `http(s)://<host>:8888` 的 443 / 8888）。
- 入站：无需暴露本服务端口。
- 密钥管理：`ADSHARE_API_KEY` 通过 K8s Secret / Vault 注入，**禁止**入库或日志打印。SDK 错误对象会把异常 cause 透传，但不会把 header / key 序列化进字符串。

## 测试

```bash
bun test packages/adshare-sdk
```
