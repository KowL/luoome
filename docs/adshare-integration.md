# Adshare 集成手册

luoome web 与 adshare 远端数据服务的对接约定。本文聚焦**部署、启动顺序、故障排查**；API / 字段定义见 [`packages/adshare-sdk/README.md`](../packages/adshare-sdk/README.md)。

## 1. 环境变量模板

仓库根目录的 `.env.example` 是 git 追踪的模板；本地开发复制为 `.env`（`.env` 已在 `.gitignore`）后填写真实值。

```ini
ADSHARE_URL=http://8.148.216.30:8888
ADSHARE_API_KEY=replace-me-with-real-key
ADSHARE_TIMEOUT_MS=10000
ADSHARE_MAX_RETRIES=2
```

| 变量 | 必填 | 默认 | SDK v0.1 读取 | 说明 |
|------|------|------|---------------|------|
| `ADSHARE_URL` | 是 | — | ✅ `fromEnv()` | adshare 服务根地址，会自动去掉末尾 `/`。**优先使用域名**（如 `https://adshare.example.internal`），不要硬编码 IP。 |
| `ADSHARE_API_KEY` | 否 | `''` | ✅ `fromEnv()` | 同时作为 `X-API-Key` 与 `Authorization: Bearer *** 头发送。远端不强制鉴权时可留空。 |
| `ADSHARE_TIMEOUT_MS` | 否 | `10000` | ✅ `fromEnv()` | 单次请求尝试的超时（毫秒），必须是正整数。 |
| `ADSHARE_MAX_RETRIES` | 否 | `2` | ✅ `fromEnv()` | 网络错误 / 5xx 时最大重试次数（不含首次尝试），必须是非负整数。 |

> ⚠️ 模板里的 `http://8.148.216.30:8888` 是临时测试地址。生产部署务必替换为域名，并把模板里的 IP 行同步更新或删除。

## 2. 本地启动顺序

**必须先起 adshare 服务（或确认可达）并通过 healthcheck，再起 luoome web。**

`/api/stocks/search` 在 adshare 不可达时会回退到真实行情搜索链，再回退本地股票库；不会生成合成股票数据。日志会记录 `adshare search fallback to local`。

### 2.1 启动 adshare 后端

adshare 是**外部服务**（不在本 monorepo 内），按对方仓库约定启动；常见三种姿势：

```bash
# 姿势 A：docker compose（最常见）
cd /path/to/adshare
docker compose up -d
curl -fsS http://localhost:8888/health        # 期望 HTTP 200

# 姿势 B：直接跑二进制 / run.sh
cd /path/to/adshare
./run.sh
curl -fsS http://localhost:8888/health

# 姿势 C：远端已部署（按 .env.example 当前 IP）
curl -fsS http://8.148.216.30:8888/health
```

**healthcheck 必须 200**，否则不要往下走——web 起来后所有搜索都会走兜底。

### 2.2 启动 luoome web

```bash
# 终端 B：luoome web
cd /Users/lijun/project/luoome
bun install                     # 第一次或切换分支后
cp -n .env.example .env         # 复制模板（已存在则跳过）
$EDITOR .env                    # 填入 ADSHARE_URL / ADSHARE_API_KEY

# 启动 web（默认端口 5173）
bun --filter '@luoome/web' src/index.ts
# 等价：cd apps/web && bun src/index.ts
```

> **注意**：本仓库是 **Bun workspaces**（见 `package.json` 的 `packageManager: bun@1.3.11`），不是 pnpm。任务示例里的 `pnpm --filter adshare dev` 不适用——adshare 不在本 monorepo。web 端用 `bun --filter '@luoome/web' src/index.ts`。

### 2.3 验证集成链路

```bash
# 终端 C：smoke test
curl -sS 'http://localhost:5173/api/stocks/search?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0' | jq
```

预期响应：

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

`source` 字段是关键：

- `"adshare"` —— 命中远端，**集成链路完整**。
- `"local"` 或 `"market"` —— adshare 未配置 / 不可达 / 响应非法，回退到真实行情搜索或本地股票库。

## 3. 故障排查

按 `错误码 → 网络 → 鉴权 → 数据` 的顺序收敛。下表覆盖最常见的三类症状。

### 3.1 401 Unauthorized

**症状**

- `curl` 直连 adshare `/stock_basic` 返回 401。
- `/api/stocks/search` 响应里 `source: "local"`，web 日志 `adshare search fallback to local`，错误对象是 `AdshareError('http_error', status=401, ...)`。
- （注：401 不会让 SDK 抛 `config_missing`，但走兜底时 web 层只 warn，看不到 401 字面量；如需看原始错误，把 `apps/web/src/server.ts` 的 `logger.warn(...)` 改成 `logger.error(...)`，或临时打开 SDK 日志。）

**原因**

`ADSHARE_API_KEY` 与 adshare 服务端白名单不匹配。SDK 对所有请求都会同时塞两个头：

```
X-API-Key: <key>
Authorization: Bearer <key>
```

网关往往会对任一缺失或不匹配的头返回 401。常见具体原因：

1. `.env` 里 `ADSHARE_API_KEY` 没填、留空、过期，或拷贝时被注释掉。
2. 复制 key 时多带空格 / 换行 / 全角字符（`replace-me-with-real-key` 占位符未替换也会拒）。
3. adshare 端白名单只允许部分 IP / 项目，本地开发 IP 不在列。

**排查命令**

```bash
# 1) 确认 .env 实际生效值
grep '^ADSHARE_API_KEY=' .env
grep '^ADSHARE_URL=' .env

# 2) 直连验证头是否被接受
curl -i -H "X-API-Key: $ADSHARE_API_KEY" \
        -H "Authorization: Bearer $ADSHARE_API_KEY" \
        "$ADSHARE_URL/stock_basic?name=test"
# 期望：HTTP/1.1 200 OK；若 401 则头被拒

# 3) 对比 adshare 控制台的「已签发 key」清单，确认本地 key 在列且未过期
```

**修复建议**

1. 重新生成 key 并同步到 `.env`；确认 `cp -n .env.example .env` 没把模板里的 `replace-me-with-real-key` 留下来。
2. 复制 key 时粘贴到纯文本编辑器核对（无尾随空格）。
3. 若 adshare 端是按 IP 白名单，把 web 主机出口 IP 加入白名单。
4. 若远端确实不鉴权，把 `ADSHARE_API_KEY=` 留空，并在 adshare 配置里关掉强制鉴权（SDK 会把空字符串作为两个头发出，需要 adshare 端容忍空 Bearer）。

### 3.2 超时（AbortError / network_error）

**症状**

- web 日志 `adshare search fallback to local`，错误对象 `AbortError: signal is aborted without reason` 或 `AdshareError('network_error')`。
- `/api/stocks/search` 响应 `source: "local"`；浏览器侧搜索仍能用但慢半秒到十几秒（取决于超时值）。
- `curl` 直连能跑通但首次请求十几秒才返回。

**原因**

1. **网络不通**：本地到 `ADSHARE_URL` 的路由失败（DNS / 防火墙 / VPN / NAT）。
2. **对端 down**：adshare 进程未启动、端口未监听、容器崩溃后未自愈。
3. **timeout 设置过短**：默认单次 10s（见 `client.ts` `timeoutMs: this.timeoutMs ?? 10_000`），冷启动首次查询或上游数据库无索引时容易踩到。
4. **偶发抖动**：公网 RTT 抖动叠加 DNS 解析慢，导致偶尔一次超时。

**排查命令**

```bash
# 1) DNS 解析 + 路由
getent hosts "$(echo $ADSHARE_URL | sed -E 's#https?://##' | cut -d/ -f1 | cut -d: -f1)"
ping -c 3  "$(echo $ADSHARE_URL | sed -E 's#https?://##' | cut -d/ -f1 | cut -d: -f1)"

# 2) TCP 端口可达
nc -zv "$(echo $ADSHARE_URL | sed -E 's#https?://##' | cut -d: -f1)" \
       "$(echo $ADSHARE_URL | sed -E 's#https?://##' | cut -d: -f2)"

# 3) 直连耗时（无 SDK 超时叠加）
time curl -fsS "$ADSHARE_URL/health"
time curl -fsS "$ADSHARE_URL/stock_basic?name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0"
# 期望：两条都在 2s 以内；若 > 5s 即视为 adshare 端慢

# 4) 看 adshare 端日志 / 监控（CPU / DB 连接池 / 上游依赖）

# 5) 临时调高 SDK 超时：在 .env 中设置
ADSHARE_TIMEOUT_MS=30000
```

**修复建议**

1. 网络不通：确认 VPN / 防火墙 / 代理。开发环境固定走内网域名而非公网 IP。
2. 对端 down：用 `docker compose ps` / `systemctl status adshare` / `pm2 list` 检查，按对方运维手册恢复；首次启动后等 5–10s 再 `curl /health`。
3. timeout 过短：把 `.env` 中 `ADSHARE_TIMEOUT_MS` 调到 30000（30s）应急；**永久方案**是在 adshare 端给 `stock_basic` 加 `name` 索引，并启用网关层读缓存（Redis / CDN）。
4. 偶发抖动：把 `ADSHARE_MAX_RETRIES` 从 2 调到 3–4；SDK 用指数退避 `200ms × 2^attempt`，3 次重试覆盖大约 1.4s 的窗口。

### 3.3 解析失败（parse_error / schema mismatch）

**症状**

- `/api/stocks/search` 响应 `source: "local"`，错误对象 `AdshareError('parse_error')` 或 `ZodError`，日志含 `expected ... received ...`。
- `curl .../stock_basic` 返回 200 + JSON，但 web 不采用。

**原因**

adshare 响应不是 SDK `StockBasicSchema` 期望的形状（见 `packages/adshare-sdk/src/schemas.ts`）。最常见三类：

1. **上游 schema 变更**：字段重命名（`ts_code` → `code`）、新增 / 删除字段、字段类型变化。
2. **JSON 截断 / 损坏**：大列表分页没接好，adshare 返回截断的 JSON；或网关把响应体按字节长度截断；或 gzip 头未声明但内容被压过。
3. **空字段类型不一致**：`industry` 本应是字符串但返回 `null`（Zod `.optional()` 允许缺失，但不允许显式 `null`，除非 `.nullable()`）。

**排查命令**

```bash
# 1) 拿到原始响应体（不要让 SDK 处理）
curl -sS -H "X-API-Key: $ADSHARE_API_KEY" \
     "$ADSHARE_URL/stock_basic?name=test" | jq

# 2) 看 schema 期望字段
cat packages/adshare-sdk/src/schemas.ts | head -20
# 当前最小集：ts_code (string), name (string), industry?, area?, list_date?, exchange?

# 3) 字段级对照
curl -sS -H "X-API-Key: $ADSHARE_API_KEY" \
     "$ADSHARE_URL/stock_basic?name=test&fields=ts_code,name,industry" \
  | jq '.data[0] | keys'
# 期望至少包含 ts_code / name

# 4) 看响应 Content-Length 与体长是否一致（防截断）
curl -sS -D - -o /tmp/body.json -H "X-API-Key: $ADSHARE_API_KEY" \
     "$ADSHARE_URL/stock_basic?name=test" | grep -i content-length
wc -c /tmp/body.json
# 两个数应近似相等；差很多说明截断

# 5) 看响应是否 JSON 合法
jq type /tmp/body.json
# 期望 "array" 或 "object"；其它即损坏
```

**修复建议**

1. schema 变更：和 adshare 维护者对齐字段命名（推荐双方都用 `ts_code` / `name` / `industry`），并在 SDK 端 `StockBasicSchema` 增加新字段（`.optional()`）。
2. JSON 截断：把请求参数 `limit` 调小（默认 SDK 透传 `fields` 数组长度作为隐含 limit）；让 adshare 端确保 gzip / content-length 头正确，分页 cursor 而不是单次返回大列表。
3. 空字段不一致：在 SDK schema 里把 `industry: z.string().optional()` 升级为 `industry: z.string().nullable().optional()`；或要求 adshare 端空字段返回空串而非 `null`。
4. **临时应急**：让 web 端走 local 兜底——功能不破（搜索仍可用），但要在下一个迭代里把 schema 对齐。

## 4. 验证清单（合并到 CI / pre-commit）

- [ ] `bun run typecheck` 通过（特别校验 `packages/adshare-sdk` 与 `apps/web`）。
- [ ] `bun run test:web` —— `apps/web/src/server.test.ts` 含 `GET /api/stocks/search` 三条用例：空 q、未配 adshare、adshare 命中。
- [ ] `bun test packages/adshare-sdk` —— SDK 自身的契约测试。
- [ ] 本地起 web 后手跑 §2.3 的 curl smoke，期望 `source: "adshare"`。

## 5. 关联阅读

- [`packages/adshare-sdk/README.md`](../packages/adshare-sdk/README.md) —— SDK API / 默认值 / 部署策略。
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) —— luoome 与外部数据源的设计分层。
- [`docs/HANDOFF.md`](./HANDOFF.md) —— 整体功能开关与版本状态。
