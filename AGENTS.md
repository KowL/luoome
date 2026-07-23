# AGENTS.md — 接入 luoome 作为外部 Agent

> 给 Claude Desktop / OpenClaw / Hermes 等 agent harness 看的接入文档。
> 如果你是想了解 luoome 的内部架构，请看 [ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 这是什么

luoome 通过 **MCP (Model Context Protocol)** 把个人投资管理能力暴露为标准 tool。任何支持 MCP 的 agent 都可以直接挂载并调用。

挂上之后，你的 agent 就拥有了：

- 查询 / 修改本地账户、持仓、交易、笔记
- 拉取实时行情（A 股 / 港股 / 美股，按数据源覆盖范围）
- 跑战法扫描 + 信号评分
- 算 PnL、风险指标、技术指标
- **生成结构化投资建议**（个股 / 持仓 / 大盘）
- **查询历史建议 + 复盘准确率**
- 生成日报 / 周报
- 推送通知（飞书等）

## 设计定位：织机 + 罗网

luoome 不只是数据搬运工，是 advisor agent：

- **罗**：把多源行情、财报、新闻、战法信号罗进来
- **织**：把数据织成结构化、可追溯、带理由的投资建议
- **不替你下单**：advice ≠ trade，决策权永远在人

## 快速接入

### Claude Desktop

`~/.config/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "luoome": {
      "command": "luoome",
      "args": ["mcp", "serve"],
      "env": {
        "LUOOME_HOME": "/Users/you/.luoome"
      }
    }
  }
}
```

### OpenClaw

```yaml
mcps:
  - name: luoome
    transport: stdio
    command: luoome
    args: [mcp, serve]
    allowSideEffects: [read, advice]   # 默认 read + advice 全部允许
```

### Hermes

通过 Hermes 的 MCP adapter 接入，配置同上。

## 工具清单（v0.1 基线）

完整清单由运行时提供：`luoome tools list --json` 输出当前版本暴露的工具。

### 查询类（read，默认全部暴露）

| Tool | 描述 |
|---|---|
| `list_accounts` | 列出所有账户 |
| `get_account` | 查单个账户详情 |
| `list_holdings` | 查账户下当前持仓（含 PnL 汇总） |
| `get_holding` | 查单条持仓详情 |
| `list_trades` | 查交易记录 |
| `list_alerts` | 查预警规则 |
| `list_notes` | 查笔记 |
| `search_stocks` | 按代码/名称搜股票（外部数据源：Eastmoney 主 → Tencent 备；本地库再兜底） |
| `get_quote` | 拉单只股票实时行情 |
| `batch_quote` | 批量拉行情 |
| `compute_pnl` | 算 PnL |
| `compute_risk_metrics` | 算风险指标 |
| `get_advice` | 查历史建议 |
| `get_advice_stats` | 查建议准确率统计 |
| `record_advice_outcome` | 回填建议结果（事后复盘） |
| `list_stock_pools` | 列出股票池（v0.6 起，默认仅 enabled） |
| `list_stock_groups` | 列出股票分组（分组化起，可带当前成员数） |
| `get_stock_group` | 分组详情 + 当前成员 + 最近 refresh 时间 + stale 标记 |

### 建议类（advice，默认全部暴露）

| Tool | 描述 |
|---|---|
| `analyze_stock` | 对单只股票做综合分析，输出结构化 Advice |
| `analyze_position` | 对单个持仓给出继续持有 / 加仓 / 减仓 / 清仓建议 |
| `market_outlook` | 生成大盘 / 板块观点 |
| `resolve_llm_group` | LLM 按提示词产出分组成员（分组化起，refresh-groups workflow 内部通道，不供日常调用） |

> advice 类工具会调 LLM，可能有延迟和成本。agent 应当按需触发，不要无脑循环。

### 写入类（write，默认 opt-in）

| Tool | 描述 |
|---|---|
| `create_account` | 创建真实账户（空数据库首次使用） |
| `add_holding` | 新增持仓（manual open） |
| `update_holding` | 改持仓数量/成本 |
| `close_holding` | 平仓 |
| `add_trade` | 录入交易 |
| `set_alert` | 设置预警 |
| `delete_alert` | 删除预警 |
| `add_note` | 加笔记 |
| `update_config` | 改配置 |
| `create_stock_pool` | 创建股票池（v0.6 起） |
| `update_stock_pool` | 更新股票池（v0.6 起） |
| `delete_stock_pool` | 删除股票池（v0.6 起） |
| `create_stock_group` | 创建股票分组（分组化起；resolver 引用 tactic/account/stock 需存在） |
| `update_stock_group` | 更新股票分组（分组化起） |
| `delete_stock_group` | 删除股票分组（分组化起；有 pool 引用时拒绝，需先解绑） |
| `save_watch_trigger` | 落库一次 watch 触发（workflow 内部使用） |

### 外部副作用（external，默认 opt-in）

| Tool | 描述 |
|---|---|
| `fetch_quote` | 主动刷新行情（写 PriceSnapshot） |
| `sync_quotes` | 全量同步持仓股行情 |
| `refresh_stock_group` | 手动触发单组刷新（分组化起；formula→run_tactic / llm→resolve_llm_group，失败保留旧快照） |
| `send_notification` | 推送飞书等 |
| `generate_report` | 生成并写报告文件 |

### 永不对外暴露

| Tool | 描述 |
|---|---|
| `place_order` | 真实下单 |
| `cancel_order` | 撤单 |

## 使用示例

### 例 1：算今天盈亏

> 用户："我今天持仓盈亏多少？"

Agent 推理：
1. 调 `list_holdings` 拿当前持仓
2. 调 `batch_quote` 拿最新价
3. 调 `compute_pnl` 算盈亏
4. 用自然语言汇报

### 例 2：添加一笔交易

> 用户："我今天 10:30 在 14.5 加仓 1000 股 万润科技"

Agent 推理：
1. 调 `search_stocks({ query: "万润科技" })` 拿到 stockId
2. 调 `add_trade({ stockId, side: "buy", quantity: 1000, price: 14.5, executedAt: "2026-07-17T10:30" })`
3. 系统自动同步 `Holding` 字段
4. 回报确认

### 例 3：跑战法扫描

> 用户："今天哪些持仓匹配到'放量突破'战法？"

Agent 推理：
1. 调 `list_tactics({ filter: { tag: "momentum" }, includeBuiltins: true })` 找战法
2. 调 `run_tactic({ tacticId, scope: "watchlist" })`
3. 调 `score_signals({ signals })` LLM 精排
4. 列 top 3 给用户

### 例 4：给一只股票出建议 ⭐ 核心场景

> 用户："帮我看看比亚迪现在能不能买？"

Agent 推理：
1. 调 `search_stocks({ query: "比亚迪" })` 拿 stockId
2. 调 `analyze_stock({ stockId, includeEvidence: true })`
3. 拿到结构化 `Advice`：
   ```json
   {
     "decision": "hold",
     "confidence": 65,
     "horizon": "short",
     "reasoning": {
       "premise": "短期处于箱体震荡，等待方向选择",
       "evidence": ["日线 MA5/MA10/MA20 粘合", "近 5 日成交量低于 20 日均量", "战法'放量突破'未触发"],
       "counterEvidence": ["新能源板块整体回暖", "公司 5 月销量同比 +12%"]
     },
     "risks": ["大盘系统性下行风险", "新能源补贴政策变化"],
     "disclaimers": ["本建议由 AI 生成，不构成投资建议..."],
     "validUntil": "2026-07-22T15:00:00Z"
   }
   ```
4. 用自然语言复述 + 主动提示"如果你要加仓，建议分批、控制仓位"

### 例 5：盘点所有持仓建议

> 用户："我的持仓今天哪些要减仓？"

Agent 推理：
1. 调 `list_holdings` 拿持仓
2. 对每个持仓并发调 `analyze_position({ holdingId })`
3. 过滤 `decision === 'sell'` 且 `confidence >= 70` 的建议
4. 按信心度排序，列给用户

### 例 6：复盘建议准确率

> 用户："最近一个月我对'放量突破'战法的建议跟单效果如何？"

Agent 推理：
1. 调 `get_advice({ sourceTool: "analyze_stock", since: "-30d", tactic: "放量突破" })`
2. 调 `get_advice_stats({ subjectKind: "stock", since: "-30d" })`
3. 综合：命中率、平均盈亏、最大单笔亏损
4. 给出"这个战法对你当前风格是否合适"的判断

### 例 7：生成日报

> 用户："给我今天的日报"

Agent 调内置 `daily-review` workflow（通过 CLI 触发，**不通过 MCP**）。

> 注：内置 workflow 不通过 MCP 暴露，避免循环编排。

## Advice 输出的关键字段

每条 advice 都有：

| 字段 | 含义 | agent 应当 |
|---|---|---|
| `decision` | buy / sell / hold / watch / avoid | 原样复述 |
| `confidence` | 0-100 | 告诉用户"信心度 X%"，≥70 强调"高信心" |
| `horizon` | intraday / short / medium / long | 告诉用户"建议持有周期" |
| `reasoning.premise` | 一句话核心论点 | 复述 |
| `reasoning.evidence` | 支持证据列表 | 选 1-3 条复述 |
| `reasoning.counterEvidence` | 反证列表 | **必须**复述，避免误导 |
| `risks` | 风险点列表 | **必须**告诉用户 |
| `disclaimers` | 免责声明 | **必须**原文带上 |
| `validUntil` | 过期时间 | 提醒"该建议 X 后失效" |

## 错误处理

Tool 永远不抛异常，永远返回：

```json
{
  "ok": false,
  "error": {
    "kind": "adapter_error",
    "adapter": "eastmoney",
    "cause": "timeout after 5s",
    "recoverable": true
  }
}
```

| kind | 建议处理 |
|---|---|
| `invalid_input` | 检查输入，修正后重试 |
| `not_found` | 告诉用户该 ID 不存在 |
| `invariant_violation` | 数据损坏，需要人工排查 |
| `adapter_error` (recoverable) | 重试或换源 |
| `adapter_error` (fatal) | 告诉用户暂时不可用 |
| `llm_error` (retryable) | 重试一次；仍失败 → 降级到纯数据输出 |
| `llm_error` (fatal) | 告诉用户"分析暂时不可用" |
| `permission_denied` | 检查 MCP 暴露配置 |
| `internal` | bug，上报 |

## 副作用与权限

luoome MCP server 默认暴露 **read + advice**。write / external / trade 必须 opt-in：

```json
{
  "mcpServers": {
    "luoome": {
      "command": "luoome",
      "args": ["mcp", "serve"],
      "env": {
        "LUOOME_EXPOSE_READ": "true",
        "LUOOME_EXPOSE_ADVICE": "true",
        "LUOOME_EXPOSE_WRITE": "false",
        "LUOOME_EXPOSE_EXTERNAL": "false",
        "LUOOME_EXPOSE_TRADE": "false"
      }
    }
  }
}
```

**`LUOOME_EXPOSE_TRADE` 永远是 `false`**。这是硬约束。

## Advice 与 Trade 的边界

**绝对规则**：

1. advice tool 永远不能触发 trade tool
2. agent 在收到 advice 后如果要下单，必须：
   - **重新询问用户**确认（不能自动 follow advice）
   - 调 `place_order`（如果用户确认），但 `place_order` 永不通过 MCP 暴露，只能 CLI/TUI 触发
3. advice 的 outcome 事后必须回填到 `record_advice_outcome`，让准确率可统计

agent 应当避免：

- ❌ "建议是 buy，所以自动买入" → **禁止**
- ❌ "advice 是 hold，所以什么都不做，但隐瞒了风险" → **禁止**
- ❌ "confidence 是 80，所以肯定对" → **禁止**，要诚实传达不确定

agent 应当：

- ✅ 复述 advice 时**带上 counterEvidence + risks + disclaimers**
- ✅ 用户决策时**主动指出**这是 AI 建议，不是投资顾问
- ✅ 高信心度建议**提醒**用户依然有风险
- ✅ 鼓励用户**事后回填 outcome**，帮系统持续改进

## 上下文预算

Agent 通过 MCP 调 tool 时，应当：

- **避免一次性拉全表**：用 `limit` / `since` / `until` 限定
- **优先 list 而非 get**：先 list 拿 ID，再 get 详情
- **复用 batch 接口**：`batch_quote` 优于循环 `get_quote`
- **advice 类不要无脑循环**：调一次 analyze_stock 几百 token，按需触发
- **advice stats 用 getAdviceStats 而不是逐条 get**

## 自定义 Tool

v0.3 起，luoome 支持通过 `~/.luoome/tools/*.ts` 加载自定义 tool：

```ts
import { defineTool, z } from '@luoome/tools';

export default defineTool({
  name: 'my_custom',
  description: '我的自定义工具',
  sideEffect: 'read',
  input: z.object({ foo: z.string() }),
  output: z.object({ bar: z.number() }),
  handler: async (input, ctx) => {
    return { bar: input.foo.length };
  },
});
```

重启 MCP server 后自动加载。

## 调试

```bash
luoome tools list                       # 列所有工具
luoome tools inspect analyze_stock      # 看 schema
luoome tools call analyze_stock --input '{"stockId":"002594"}'
luoome advice list --since 7d           # 看历史建议
luoome advice stats --since 30d         # 看准确率
LUOOME_LOG=debug luoome mcp serve       # MCP server 调试日志

# v0.6 起：盘中盯盘
luoome watch --once --no-notify         # 跑一轮（调试 / cron）
luoome watch --interval 60              # 长驻：盘内每 60s 一轮；非交易时段 60s 重试
luoome watch --pool holdings-watch      # 仅盯指定池
luoome tools call list_stock_pools --input '{}'  # 列池
# 分组化起：pool 通过 groupId 引用分组（阶段 A 已落地；分组 CRUD tool 属阶段 B，当前可先用默认 holdings-default 分组）
luoome tools call create_stock_pool --input '{"id":"my-pool","name":"x","groupId":"holdings-default","rules":[{"kind":"price-change","pct":0.05}]}'
# 阶段 B 起：分组 CRUD + 盘外刷新
luoome tools call list_stock_groups --input '{}'
luoome tools call create_stock_group --input '{"id":"leaders","name":"龙头","resolver":{"kind":"llm","prompt":"选出当前龙头"}}'
luoome workflow run refresh-groups                # 盘外刷新全部 enabled 动态分组（formula/llm）
luoome tools call refresh_stock_group --input '{"groupId":"leaders"}'  # 手动刷单组
```

## 已知边界

- 分组化（StockGroup，docs/stock-group-design.md）：动态分组统一「生产者 + 快照」——refresh-groups 盘外刷新写快照，盘中 watch 只读快照；llm/解析失败或空结果保留旧快照（绝不写空批），stale 状态由 `get_stock_group` 感知（refreshPolicy=daily 且最新批次非今日）。`luoome watch` 每日首个交易轮次前自动刷新 stale 的 daily 动态分组（进程内只尝试一次）。v0.6 存量 pool.source 在启动时幂等迁移为分组（id=`<poolId>-group`），tactic source 迁移后需手动跑一次 `refresh_stock_group` 落首批快照
- 行情必须显式配置 `LUOOME_MARKET_PROVIDER=real`（Eastmoney 主 → Tencent 备，A 股）；全源失败明确报错
- LLM 必须配置 `LUOOME_LLM_PROVIDER` + `LUOOME_LLM_API_KEY`（openai-compatible / anthropic，缺配置启动期报错）
- 配置可写文件而非 export：启动时自动加载 `$LUOOME_HOME/.env` 与 `<项目根>/.env`（模板见 `.env.example`；优先级：真实 env > 项目根 .env > LUOOME_HOME/.env；文件缺失/损坏静默跳过）
- v0.1 不支持多账户并发写
- v0.1 没有 Web 入口（v0.4 起）
- v0.1 没有真实券商对接（永不通过 MCP 暴露）
- v0.7 `luoome watch` 节假日历增强：内置 2026（29 天）+ 2027 best-effort placeholder（22 天，按近 5 年规律推断，每年 12 月国办通知发布后由维护者手工同步 `CN_A_SHARE_HOLIDAYS_2027`）。加载优先级（union）：**`LUOOME_A_SHARE_HOLIDAYS` env > `$LUOOME_HOME/holidays.json` 文件 > 内置**。文件存在/损坏时静默 fallback 到内置；文件路径可通过 `LUOOME_HOLIDAYS_FILE` 覆盖。修改日历后需重启 watch（不监听 mtime）。
- v0.8 起生产行情链为 Eastmoney（primary）→ Tencent（fallback）；不再配置合成行情兜底，两源都失败时返回 adapter error。测试专用第三源只通过 testing 子路径注入。
- v0.6.1 `luoome watch` 价格变动昨收：price-change 规则的 `prevClose` 由 `dailyBar.latestBefore(stockId, now, 1)` 拉到的真实昨收（v0.6 占位为 `quote.open`）。缺失 / close <= 0 / repo throw → fallback 到 `quote.open`（v0.6 兼容）。详见 [docs/intraday-watch-design.md §6](./docs/intraday-watch-design.md)。
- v0.6 `luoome watch` 盘中盯盘：A 股交易时段 9:30–11:30 / 13:00–15:00（北京时间）。**v0.6 起内置 2026 全年休市日**（29 天；详见 [packages/cli/src/holidays.ts](packages/cli/src/holidays.ts)）。通过 `LUOOME_A_SHARE_HOLIDAYS` 环境变量追加（逗号分隔 `YYYY-MM-DD`）。2027+ 需按国务院办公厅通知手工补全；不识别「调休补班」。参考 [docs/intraday-watch-design.md](./docs/intraday-watch-design.md)
- v0.6 `cost-threshold` 规则基于当前 avgCost（未做除权除息调整），长持老股可能误触发
- v0.6 `price-change` 规则的昨收已改为优先读取上一交易日 daily bar close；缺失时回退 `quote.open`

## 反馈

- GitHub Issues：标 `agent` 标签
- 安全相关：见 [SECURITY.md](./docs/SECURITY.md)
