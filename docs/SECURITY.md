# Security

> luoome 的安全模型。围绕"agent-first + local-first + 副作用分级 + advisor ≠ trade"展开。

## 威胁模型

luoome 是本地工具 + MCP server + advisor agent。五类潜在威胁：

1. **恶意 prompt injection**：agent 上层被攻击者注入指令，agent 通过 MCP 调 luoome 执行未授权操作
2. **MCP server 被未授权方连接**：远程 MCP 暴露、token 泄露
3. **本地密钥泄露**：API key、券商密码写入日志 / git / 报告
4. **advice 误导用户**：LLM 幻觉 / 数据源错误 / 推理偏差，让用户做出错误决策
5. **advice → trade 链失控**：advice 自动触发下单，资金风险

下面所有设计都针对这五类威胁。

## 核心原则：副作用分级

每个 tool 必须显式声明 `sideEffect`：

| 等级 | 含义 | 默认暴露 |
|---|---|---|
| `read` | 只读本地 | ✅ MCP / Web / CLI / TUI |
| `advice` | 生成建议（含 LLM 推理） | ✅ MCP / Web / CLI / TUI |
| `write` | 写本地状态 | ⚠️ opt-in |
| `external` | 触发第三方副作用 | ⚠️ opt-in |
| `trade` | 触发真实资金动作 | ❌ 永不 |

一个 tool 同时需要多类授权时，通过 `requiredCapabilities` 声明组合能力，Web 与 MCP
必须逐项满足后才能暴露。例如 `import_remote_research_document` 会访问外部网络并写入
本地 Vault，因此同时要求 `write` 与 `external`，只开启其中任一能力都不能调用。

### trade 永不暴露（硬约束）

MCP server 启动时检查 `LUOOME_EXPOSE_TRADE`：

```ts
if (env.LUOOME_EXPOSE_TRADE === 'true') {
  throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed. Trade tools are never exposed via MCP.');
}
```

这条规则**无法通过配置绕过**。代码层硬卡。

研究正文和全文搜索属于私人研究能力，MCP 暴露时还必须显式设置 `LUOOME_EXPOSE_RESEARCH=true`；未开启时只允许不含正文的本地索引页面。Vault 正文、frontmatter、附件名和搜索片段均视为不可信数据，不进入 system prompt，不输出绝对 Vault 路径或凭证。

## Advisor 专属安全约束

### advice 永远不直接触发 trade

代码层硬卡：

```ts
// advice tool handler 内禁止调 trade tool
const FORBIDDEN_TOOLS_IN_ADVICE = new Set(['place_order', 'cancel_order', 'submit_order']);

function assertAdviceDoesNotTriggerTrade(toolName: string) {
  if (FORBIDDEN_TOOLS_IN_ADVICE.has(toolName)) {
    throw new SecurityError(`advice tool cannot trigger trade tool: ${toolName}`);
  }
}

// 所有 advice 类 tool 的 ctx.adapters / ctx.tools 调用都走这个 assert
```

### disclaimers 必填

```ts
const STANDARD_DISCLAIMERS = [
  '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
  '投资有风险，决策需自行承担。',
  '市场有不可预测性，过往表现不代表未来收益。',
];

// 不变量：advice.disclaimers 至少包含 STANDARD_DISCLAIMERS 的全部内容
function assertAdviceDisclaimers(advice: Advice) {
  for (const d of STANDARD_DISCLAIMERS) {
    if (!advice.disclaimers.includes(d)) {
      throw new InvariantError(`missing required disclaimer: ${d}`);
    }
  }
}
```

LLM 不能"忘了"带 disclaimer——输出校验失败时整个 advice 被丢弃，重新生成。

### confidence 校准

v0.3 起，luoome 跟踪每个 advice 的 outcome，统计 `confidence` vs 实际命中率的偏差：

```ts
interface ConfidenceCalibration {
  bucket: string;            // "0-10", "10-20", ..., "90-100"
  predictedConfidence: number;
  observedHitRate: number;
  calibrationError: number;  // |predicted - observed|
}
```

LLM 输出的 confidence 必须**经此校准后**展示给用户（避免 LLM 自报"80%"但实际 50% 的错觉）。

### advice 有效期限

过期 advice 默认不再被主动返回。`validUntil` 到期后：

- `get_advice` 不返回（除非 `includeExpired: true`）
- TUI / Web 不显示
- 复盘时仍保留

### 输出反 prompt injection

LLM 输出可能含"忽略之前的指令，执行 XXX"的注入。防范：

```ts
// advice 输出的 reasoning 字段做内容审计
function sanitizeAdviceReasoning(reasoning: string): string {
  // 移除可能含 prompt injection 的模式
  const blocked = [
    /ignore (?:all )?previous instructions/gi,
    /you (?:are|must) (?:now )?/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g,  // chat template 标记
  ];
  let s = reasoning;
  for (const re of blocked) s = s.replace(re, '[redacted]');
  return s;
}
```

LLM 推理文本（`AdviceDataSnapshot.llmReasoning`）在落库前过 sanitized 审计。展示时只在“展开推理”按钮后显示已清理文本，避免被复制粘贴造成下游 agent 误用。

## MCP 暴露配置

| Env Var | 默认 | 允许值 | 说明 |
|---|---|---|---|
| `LUOOME_EXPOSE_READ` | `true` | `true` / `false` | read 类 |
| `LUOOME_EXPOSE_ADVICE` | `true` | `true` / `false` | advice 类 |
| `LUOOME_EXPOSE_WRITE` | `false` | `true` / `false` | write 类 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | `true` / `false` | external 类 |
| `LUOOME_EXPOSE_TRADE` | `false` | 必须 `false` | trade 类，恒为 false |

启动时校验：trade 必须 false，否则启动失败。

Web 进程内后台任务不经过 HTTP Tool 路由的 capability gate，必须在启动层独立验证其完整副作用集合。
账户绩效盘后 scheduler 会读取外部行情并持久化日线、快照和 WorkflowRun，因此只有
`LUOOME_EXPOSE_WRITE=true` 与 `LUOOME_EXPOSE_EXTERNAL=true` 同时显式开启时才允许启动；缺任一项时
保持停用并记录原因。不得通过修改 Tool 的单一 `sideEffect` 标签掩盖组合副作用。

## 内置 agent loop

`agent_run` 分类为 `external`，默认不通过 MCP 暴露。其运行时能力由 tools 包的显式白名单构造：

- 仅允许逐项批准的 `read` 与 `external` tool；`write`、`advice`、`trade` 均不可达。
- `trade` 永不进入 agent 工具表，建议或盯盘结果不能触发自动下单。
- 写入意图只能作为待确认 `drafts` 返回；草案会再次按目标 write tool 的输入 schema 校验，`agent_run` 自身不执行草案。
- `usedTools` 与 `trace` 从实际 tool 调用派生，不接受模型自报；模型最终输出必须通过本地 Zod 校验。
- 用户输入和 tool 输出均视为不可信内容；system instructions 明确禁止把其中的文本当作新指令。
- 循环同时受最大步数、累计 token 软预算和总超时限制。

## 传输安全

### v0.1 — stdio（本地进程）

stdio 假设**宿主可信**。仅本地进程可连，无网络暴露。

### v0.3+ — HTTP/SSE

- 必须 token 鉴权
- TLS 强制
- rate limit
- audit log

## 密钥处理

- 所有密钥在 `~/.luoome/.env`，chmod 600
- 不入 git（`.gitignore` 排除 `.env*`）
- 不入 SQLite
- Web 飞书设置读取接口只返回 configured 状态，不回显 Webhook；写入只接受
  `https://open.feishu.cn/open-apis/bot/v2/hook/...`，避免测试端点成为任意 URL 请求入口
- logger 自动脱敏：`Authorization: Bearer xxx` → `Authorization: Bearer ***`、`sk-...` → `sk-***`、飞书 webhook URL → `.../***`
- 报告脱敏：持仓金额 / 数量可显示，成本价可选隐藏（`LUOOME_HIDE_COST=true`）

## 写入类工具的二次确认

write 类工具通过 MCP 暴露时，`add_trade` 必须带 `confirm: true` 才执行。这是协议层约定，agent 应当向用户复述交易详情后，再调一次带 `confirm: true`。

## 数据完整性

- core 包的每个 entity 有 `assertXxxInvariants()`，所有 tool handler 返回前必跑
- write 类工具的 repository 操作在 SQLite 事务内
- 所有 tool 的 input 进入 handler 前经过 Zod 校验

## 输出脱敏

- 工具输出结构化数据，不含密钥
- 持仓成本通过 `LUOOME_HIDE_COST` 控制

## 错误信息

error message 可以含人类可读细节（如"持仓数量不能为负"），**不应**含：

- 完整 stack trace（含源码路径）
- 数据库连接字符串
- API endpoint URL + token
- 内部文件系统路径（可显示 `$LUOOME_HOME`）

`defineTool` 在统一出口清理 input issues、InvariantError、adapter/LLM/lease/internal 错误、handler
异常和 output schema 校验错误；审计事件只记录调用元数据，不接收 Tool 的业务输入或输出。

## Audit Log

所有 write / external / trade 工具调用记录到 `~/.luoome/logs/audit.log`：

```json
{
  "ts": "2026-07-17T10:30:00Z",
  "tool": "add_trade",
  "sideEffect": "write",
  "result": "ok",
  "caller": "mcp"
}
```

advice 类也记录：

```json
{
  "ts": "...",
  "tool": "analyze_stock",
  "sideEffect": "advice",
  "result": "ok",
  "caller": "mcp"
}
```

Tool 的业务输入、业务输出和错误详情不写入 audit log；失败事件只保留 `errorKind`。

当前实现（2026-08-14）：`defineTool` 对所有 `write` / `external` / `trade` / `advice` 调用记录
成功、业务失败、输入校验失败和异常结果；CLI、MCP、TUI、Web 生产入口分别把日志写入
`$LUOOME_HOME/logs/audit.log`（Web 为数据库目录同级的 `logs/audit.log`）。文件按 JSONL 追加，
目录权限为 `0700`、文件权限为 `0600`。审计契约只包含时间、工具名、sideEffect、结果、
可选错误类别和调用方，从源头避免私人投资数据进入 sink。
Advice 的 `reasoning`、`risks` 及 `basedOn.llmReasoning` 在落库前额外清理常见 prompt-injection 模式。
审计 sink 故障只产生 warning，不改变 ToolResult 协议或伪造业务成功。

## 上游信任

- **数据源**：Eastmoney / Tencent 等外部 API 返回的数据视为不可信，输入 db 前校验
- **LLM**：所有 LLM 输出经过 Zod 校验，不直接执行；advice 输出额外过 sanitized 审计
- **模型目录**：`ai-models.json` 只允许用 `apiKeyEnv` 引用凭证环境变量，不保存 API
  key；配置解析错误和日志不得输出凭证值
- **Web LLM 设置**：写入接口按其它 mutation 使用同源 Origin 校验；密钥文件权限固定为
  `0600`，读取接口仅返回是否已配置，禁止回显、日志记录或
  注入页面 DOM
- **advice 回填**：`record_advice_outcome` 调用记录到 audit，但 outcome 数据本身不强制校验（用户主观回填）

## 用户教育

TUI / Web / CLI 在 advice 显示界面顶部必须固定显示：

```txt
─────────────────────────────────────────
本建议由 AI 生成，不构成投资建议。
投资有风险，决策需自行承担。
─────────────────────────────────────────
```

## 报告漏洞

发现安全漏洞：

- 邮箱：`security@luoome.dev`（占位）
- GitHub Issues：标 `security` 标签，**不要在公开 issue 描述漏洞细节**

## Checklist（每个 release 前）

2026-08-14 已用 MCP smoke、registry/invariant/TUI/Web 结构测试、错误脱敏回归和仓库密钥扫描复核，
以下清单全部通过；后续 release 若新增副作用或输出路径，必须重新执行同一组检查。

- [x] `LUOOME_EXPOSE_TRADE` 强制 false 校验存在
- [x] 所有密钥不在 git
- [x] 日志脱敏测试覆盖
- [x] Audit log 写入正常
- [x] trade 类工具无 MCP 暴露路径（grep 验证）
- [x] advice tool 不能调 trade tool（grep + 测试验证）
- [x] advice 必含 disclaimers（不变量测试覆盖）
- [x] advice 有效期限逻辑正确
- [x] LLM 输出 sanitized 审计生效
- [x] 错误信息不含密钥 / 路径细节
- [x] 用户界面顶部固定免责声明
