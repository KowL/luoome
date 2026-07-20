# luoome

> **织机 + 罗网 — 汇聚网罗有价值的信息数据，在面对变化的市场时提供准确的建议。**

luoome 是一个本地优先的个人投资管理 **advisor agent**。它把"账户、持仓、交易、行情、战法、风控、笔记、建议"这些能力**全部以 tool 的形式**暴露出来，同时把多源数据织成结构化的、可追溯的投资建议。

- 作为 **TUI** 在终端盯盘、看建议
- 作为 **Web** 在浏览器查看仪表盘（后续）
- 作为 **MCP server** 被 Claude Desktop / OpenClaw / Hermes 等 agent 直接调用，并让它们替你做"分析 → 建议 → 行动"的推理

## 名字

**luoome = 织机 + 罗网**

- **织**：把分散的行情、财报、新闻、战法信号、历史持仓织成一张连贯的认知
- **罗**：把市场里有价值的信息数据罗（网）进来，不漏关键信号
- **me**：me，你（用户）是这一切的中心，不是旁观者

面对不断变化的市场，luoome 不替你下单，但**会主动告诉你**：哪里有机会、哪里有风险、哪些决策需要你确认。

## 设计原则

- **Advisor-first**：每一份数据最终都服务于"可执行的投资建议"，不是堆数据。
- **Agent-first**：所有能力都是 tool，没有"只能人用、agent 用不了"的功能。
- **Local-first**：数据在本地 SQLite，默认无云同步。
- **Schema-driven**：Zod schema 是 tool I/O 的事实来源，自动生成 TypeScript 类型、MCP tool 定义、OpenAI function calling schema。
- **Workflow ≠ Tool**：tool 是原子能力，workflow 是组合；workflow 内置编排，tool 暴露给上层 agent。
- **No magic**：每个数据源 / 适配器 / LLM 都显式可插拔，运行时可见。
- **Human-in-the-loop**：建议 ≠ 行动。advice 永远不直接触发交易；下单始终需要人确认。

## 它做什么

### 数据维度（读 + 写）
- 账户（多账户、真实/模拟）
- 持仓、交易、笔记、预警
- 行情快照、日线、技术指标
- 战法规则 + 战法信号
- 风控指标（VaR、Sharpe、最大回撤、集中度）

### 分析维度（只读）
- PnL、风险敞口、行业暴露
- 战法扫描 + 信号评分
- 多源行情交叉验证
- LLM 推理总结（每日复盘、个股分析）

### 建议维度（核心）
- **个股建议**：基于技术面 + 基本面 + 战法信号 + LLM 综合判断，输出 buy / sell / hold / watch / avoid 决策
- **持仓建议**：每个持仓的继续持有 / 加仓 / 减仓 / 清仓建议
- **市场观点**：每日大盘观点、行业轮动、热点板块
- **风险预警**：跌破止损位、触发风控规则、异常波动

每条建议都带：**理由 + 证据 + 反证 + 风险 + 信心度 + 有效期限 + 免责声明**。

## 仓库结构

Bun workspace monorepo：

```txt
packages/
  core/        纯领域类型 + 不变量（无 IO）
  db/          Drizzle schema + repository 实现
  tools/       Tool 注册表 + Zod → TS/MCP/OpenAI 自动生成
  adapters/    行情 / LLM / 通知 / 券商 等外部依赖适配
  workflows/   内置编排：review / scan / diagnose / advise
  mcp/         MCP server，把 tool registry 暴露给外部
  cli/         命令行入口
  tui/         opentui 应用
apps/
  web/         （后续）Web 端
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据目录（`luoome.db` + `tactics/`） |
| `LUOOME_MARKET_PROVIDER` | `mock` | 行情源：`mock` 确定性假数据；`real` 真实行情（Eastmoney 主 → Tencent 备 → Mock 兜底，A 股） |
| `LUOOME_LLM_PROVIDER` | `mock` | LLM 源：`mock` / `openai-compatible` / `anthropic` |
| `LUOOME_LLM_API_KEY` | — | `openai-compatible` / `anthropic` 必填 |
| `LUOOME_LLM_BASE_URL` | 按 provider | 覆盖 LLM base URL |
| `LUOOME_LLM_MODEL` | 按 provider | 覆盖 LLM 模型 |
| `LUOOME_EXPOSE_WRITE` | 关 | `=true`：MCP 追加 write 类 tool；Web 挂载 outcome 回填 endpoint |
| `LUOOME_EXPOSE_EXTERNAL` | 关 | `=true`：MCP 追加 external 类 tool |
| `LUOOME_EXPOSE_TRADE` | 关（硬卡） | `=true` 时 MCP server 启动即抛错退出（trade 永不暴露） |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；缺失时通知降级为 log，不抛错 |

## 文档

| 文档 | 用途 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构核心，模块、概念、数据流、安全模型、advisor 模型 |
| [AGENTS.md](./AGENTS.md) | 接入文档，给 Claude Desktop / OpenClaw / Hermes 用 |
| [ROADMAP.md](./ROADMAP.md) | v0.1 → v0.5 演进路线 |
| [SECURITY.md](./SECURITY.md) | 副作用分级、advice 安全、密钥、audit |

## 状态

**v0.1 — 骨架阶段**。仓库刚建立，尚未实现任何代码。文档先行。
