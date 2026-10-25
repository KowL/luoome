# Security

> luoome 的安全模型。围绕"agent-first + local-first + 副作用分级 + advisor ≠ trade"展开。

## 威胁模型

luoome 是本地工具 + MCP server + advisor agent。五类潜在威胁：

1. **恶意 prompt injection**：agent 上层被攻击者注入指令，agent 通过 MCP 调 luoome 执行未授权操作
2. **MCP server 被未授权方连接**：远程 MCP 暴露、token 泄露
3. **本地密钥泄露**：API key、券商密码写入日志 / git / 报告
4. **advice 误导用户**：模型幻觉 / 数据源错误 / 推理偏差，让用户做出错误决策
5. **advice → trade 链失控**：advice 自动触发下单，资金风险

下面所有设计都针对这五类威胁。

## 核心原则：副作用分级

每个 tool 必须显式声明 `sideEffect`：

| 等级 | 含义 | 默认暴露 |
|---|---|---|
| `read` | 只读本地 | ✅ MCP / Web / CLI / TUI |
| `write` | 写本地状态 | ⚠️ opt-in |
| `external` | 触发第三方副作用 | ⚠️ opt-in |
| `trade` | 成交记账（影响现金与持仓）或真实资金动作 | ❌ MCP / 通用 Web 工具路由永不暴露 |

> DSH 瘦身后内置 AI 下线，原 `advice` 副作用等级已删除；存量 Advice 数据的展示与
> 复盘约束（免责声明、有效期、confidence 不自称为确定性）仍然适用。

一个 tool 同时需要多类授权时，通过 `requiredCapabilities` 声明组合能力，Web 与 MCP
必须逐项满足后才能暴露。例如 `import_remote_research_document` 会访问外部网络并写入
本地 Vault，因此同时要求 `write` 与 `external`，只开启其中任一能力都不能调用。

### trade 永不通过 MCP 暴露（硬约束）

MCP server 启动时检查 `LUOOME_EXPOSE_TRADE`：

```ts
if (env.LUOOME_EXPOSE_TRADE === 'true') {
  throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed. Trade tools are never exposed via MCP.');
}
```

这条规则**无法通过配置绕过**。代码层硬卡。

Web 通用路由 `/api/tools/:name/call` 同样拒绝所有 `trade` 工具。本地 Web 的人工成交
录入可经专用路由暴露，但必须同时满足以下条件：

- 只登记用户在系统外已经完成的成交；不得下单、撤单、调用券商执行接口或触发外部资金动作。
- 路由固定绑定经过审查的记账工具，不接受任意工具名，也不进入 MCP 或模型可调用工具表。
- 要求显式 write opt-in、同源校验（请求提供 Origin 时）、当前账户绑定，以及用户明确确认该成交尚未入账。
- 校验成交输入、来源与账本指纹及预期修订；成交、持仓、现金、复盘与请求回执原子提交，
  以请求 ID 保证重试幂等。

`POST /api/decision-trades` 绑定 `record_decision_trade`，是上述例外。保留其 `trade`
分类，是因为登记成交会联动现金与持仓，风险高于普通状态写入；该分类不意味着工具必然下单。
专用路由的 write 授权仅适用于上述人工记账边界，不是把 `trade` 统一降为 `write`，也不受
`LUOOME_EXPOSE_TRADE` 开关放行。任何新增专用路由都须逐项满足这些条件。

研究正文和全文搜索属于私人研究能力，MCP 暴露时还必须显式设置 `LUOOME_EXPOSE_RESEARCH=true`；未开启时只允许不含正文的本地索引页面。Vault 正文、frontmatter、附件名和搜索片段均视为不可信数据，不进入 system prompt，不输出绝对 Vault 路径或凭证。

Research embedding 默认关闭。只有 `LUOOME_RESEARCH_EMBEDDING_ENABLED=true` 才挂载外部 adapter，且查询/评测仍要求 `external`，chunk 投影重建同时要求 `external + write`。模型目录只记录 provider endpoint、model identity、维度、version 与 `apiKeyEnv` 名称；密钥从环境读取。查询、私人正文、向量和密钥不进入日志或错误。混合检索中的正文继续是 tool data，不是指令；结果必须保留 EvidenceRef、反证、风险、unknowns 和 prompt-injection 警告。

## 建议（Advice）侧专属安全约束

本节只约束 Advice 实体与建议产出路径。术语以 [CONTEXT.md](../CONTEXT.md) 为准：
当前领域语言是 **Advice（建议快照）**；"Advisor" 是内置 AI 助手下线前的旧称。

### advice 永远不直接触发 trade

代码层硬卡按类型过滤，不依赖运行时名单（`packages/tools/src/exposure.ts`）：

```ts
// trade 类工具不进模型可调用面；同时挡「主副作用声明成别的等级、
// 但 requiredCapabilities 含 trade」的绕过写法。
tool.sideEffect !== 'trade' && !tool.requiredCapabilities?.includes('trade')
```

配套三道闸，任一命中即拒绝：

- `packages/mcp/src/exposure.ts`：`LUOOME_EXPOSE_TRADE=true` 在解析暴露面时直接抛错，MCP 启动失败
- `packages/dsh-luoome/src/host/read-surface.ts`：DSH 插件装配时同样抛错
- `packages/tools/src/plugin-operations.ts`：确认门策略不接受 `trade` / `queue` 能力，人工确认通道也到不了 trade

因此 trade 只能由人经专用人工入口触发。`record_decision_trade` 另走 Web 的
`POST /api/decision-trades`（write opt-in + 同源校验 + 账户绑定 + 明确的未入账确认）。

### disclaimers 必填

```ts
export const STANDARD_DISCLAIMERS = [
  '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
  '投资有风险，决策需自行承担。',
  '市场有不可预测性，过往表现不代表未来收益。',
] as const;

// packages/core/src/entity/invariants.ts：Advice 不变量校验
for (const required of STANDARD_DISCLAIMERS) {
  if (!a.disclaimers.includes(required)) {
    throw new InvariantError(`missing disclaimer: ${required}`);
  }
}
```

建议写入前由仓储层强制该不变量（`assertAdviceInvariants`），缺任一条直接拒绝写入；分析队列的写入路径直接填入 `STANDARD_DISCLAIMERS`，调用方无法省略。

### confidence 校准

luoome 跟踪每个 advice 的 outcome，统计 `confidence` vs 实际命中率的偏差。`get_confidence_calibration`
返回 `schemaVersion: 2` 的账户口径结果：

```ts
interface GetConfidenceCalibrationOutput {
  schemaVersion: 2;
  buckets: CalibrationBucket[];   // 按 10 一档聚合
  totalAdvices: number;
  totalWithOutcome: number;
  overallHitRate: number | null;   // 无样本时为 null
  followedWithPnl: number;
  calibratedAt: Date;
  groups: Array<{                  // 按生成来源分组，不跨来源混桶
    generatorKind: string;          // 分析队列消费者的生成来源
    model: string | null;
    skillVersion: string | null;
    dataAsOf: Date | null;
    totalAdvices: number;
    totalWithOutcome: number;
    followedWithPnl: number;
    minimumOutcomes: 20;            // 低于此样本量不给出校准结论
    overallHitRate: number | null;
    buckets: CalibrationBucket[];
  }>;
}
```

**校准不改写已存储的 confidence**。`confidence` 由消费者写入时原样落库；校准只作为事后诊断视图呈现
（TUI 的「confidence 校准」弹层、`closing-report` 的对应章节）。TUI 明示「信心度不是概率」，
不同来源不混桶，样本不足 `minimumOutcomes` 时不输出校准结论。统计只覆盖本账户**明确记录过 outcome**
的建议，通用股票建议须先被本账户记录才进入样本。

### advice 有效期限

过期 advice 默认不再被主动返回。`validUntil` 到期后：

- `get_advice` 不返回（除非 `includeExpired: true`）
- TUI / Web 不显示
- 复盘时仍保留

### 输出反 prompt injection

模型输出可能含"忽略之前的指令，执行 XXX"的注入。仓内的清理实现：

```ts
// packages/tools/src/internal/build-advice.ts
const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:all )?previous instructions/gi,
  /you (?:are|must)(?: now)?/gi,
  /system:\s*/gi,
  /<\|.*?\|>/g,  // chat template 标记
];

/** Advice 落库前的文本安全边界：模型文本只作为展示证据，不能携带可执行提示词。 */
export const sanitizeAdviceText = (value: string): string => { /* 逐条替换为 [redacted] */ };
export const sanitizeAdviceReasoning = (reasoning: AdviceReasoning): AdviceReasoning => ({ ... });
export const sanitizeAdviceRisks = (risks: readonly string[]): readonly string[] => ...;
```

**Advice 写回路径经过该清理**：

- 分析队列写回（`record_advice` / `complete_analysis_job` → `AdviceSchema.parse`）在组装 Advice 时
  对 `reasoning`（premise / evidence / counterEvidence）与 `risks` 逐条清理，命中模式的片段替换为
  `[redacted]`；实现见 `packages/tools/src/internal/sanitize-advice.ts`
- 写回只接受 `StrategyAdviceAnalysisSchema`（decision / confidence / horizon / 价位 / reasoning / risks），
  `basedOn` 由工具重建为 `{ dataAsOf }`；`AdviceDataSnapshot.llmReasoning` 只保留给存量数据读取，
  新写回不写该字段
- `provenance` 的 model / skillVersion 等是标识符而非散文，不做清理

清理只覆盖文本层，**不等于**消费者输出可信：展示侧仍按不可信文本处理（只读展示，不自动回灌
system prompt）。

## MCP 暴露配置

| Env Var | 默认 | 允许值 | 说明 |
|---|---|---|---|
| `LUOOME_EXPOSE_WRITE` | `false` | `true` / `false` | write 类 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | `true` / `false` | external 类 |
| `LUOOME_EXPOSE_QUEUE` | `false` | `true` / `false` | queue 类；只由旧 MCP 分析面/手动 worker 或插件精确 policy 显式开启，分析面另用精确三工具白名单收窄 |
| `LUOOME_EXPOSE_TOOLS` | 未设置 | 逗号分隔 allowlist | 按工具名精确放行；空串表示不放行任何工具 |
| `LUOOME_EXPOSE_DENY` | 未设置 | 逗号分隔 denylist | deny 优先于 allowlist |
| `LUOOME_EXPOSE_RESEARCH` | `false` | `true` / `false` | 放行私人研究正文与检索工具 |
| `LUOOME_EXPOSE_TRADE` | `false` | 必须 `false` | trade 类，恒为 false |

read 类恒定暴露，没有对应的 env var（`LUOOME_EXPOSE_READ` 不存在）。
（`LUOOME_EXPOSE_ADVICE` 已随 advice 副作用等级一并删除。）

启动时校验：trade 必须 false，否则启动失败。allowlist / denylist 的判定顺序是
「能力满足 ∧ 名字在 allowlist 内（allowlist 为空则不限）∧ 名字不在 denylist 内」。

默认纯插件部署不读取 `LUOOME_EXPOSE_*`：暴露面由受信任部署配置（read allowlist、market
allowlist、确认写 policy）固定，HTTP/模型参数不能提升。旧 MCP 过渡形态的暴露面由 profile 补丁
固定：部署传入的环境变量里出现 `LUOOME_EXPOSE_*` 一律丢弃，避免一次配置失误把只读实例变成
写面实例。暴露面划分见[单机形态的入口与暴露面](#单机形态的入口与暴露面)。

Web 进程内后台任务不经过 HTTP Tool 路由的 capability gate，必须在启动层独立验证其完整副作用集合。
策略盘后、盘中账户计划、账户绩效与策略自治 scheduler 会读取外部行情或 AI，并持久化计划、触发、报告、快照或 WorkflowRun，因此只有
`LUOOME_EXPOSE_WRITE=true` 与 `LUOOME_EXPOSE_EXTERNAL=true` 同时显式开启时才允许启动；缺任一项时
保持停用并记录原因。单机形态的批处理由 DSH 定时任务唤起会话后调用批处理工具触发，同样受这组双闸口约束。
不得通过修改 Tool 的单一 `sideEffect` 标签掩盖组合副作用。

## 内置 agent loop

> DSH 瘦身后 `agent_run` 工具已删除；单机 Web 对话助手（/api/chat）沿用下述约束。

对话运行时能力由 tools 包的显式白名单构造：

- 仅允许逐项批准的 `read` 与 `external` tool；`write`、`trade` 均不可达。
- `trade` 永不进入 agent 工具表，建议或盯盘结果不能触发自动下单。
- 写入意图只能作为待确认 `drafts` 返回；草案会再次按目标 write tool 的输入 schema 校验，对话入口自身不执行草案。
- `usedTools` 与 `trace` 从实际 tool 调用派生，不接受模型自报；模型最终输出必须通过本地 Zod 校验。
- 用户输入和 tool 输出均视为不可信内容；system instructions 明确禁止把其中的文本当作新指令。
- 循环同时受最大步数、累计 token 软预算和总超时限制。

## 传输安全

### stdio（本地进程）

stdio 假设**宿主可信**。仅本地进程可连，无网络暴露。**默认纯插件部署不使用 stdio MCP**：
插件在 DSH Node 进程内直接打开 Node SQLite。旧 MCP 过渡形态（`luoome` / `luoome-settings` /
`luoome-analysis` / `luoome-batch` 四个实例与手动 worker）仅在手动/隔离验收时以 stdio 连接同一份
单机事实库。

### DSH 入口（HTTP）

- 公网入口由 Caddy basic auth 挡住，DSH 自身再校验启动 token；两层都在业务进程之外。
- DSH 不直接发布端口，只在反代后可达；单机 Web 默认只监听 `127.0.0.1`。
- 远程访问优先走 SSH 隧道或受控反代；公网部署以 HTTPS 为首选，明文 HTTP 只是已授权回退。
- 审计走本地 audit log（见下），不依赖远端集中收集。

## 密钥处理

- 所有密钥在 `~/.luoome/.env`，chmod 600
- 不入 git（`.gitignore` 排除 `.env*`）
- 不入 SQLite
- Web 飞书设置读取接口只返回 configured 状态，不回显 Webhook；写入只接受
  `https://open.feishu.cn/open-apis/bot/v2/hook/...`，避免测试端点成为任意 URL 请求入口
- logger 自动脱敏：`Authorization: Bearer xxx` → `Authorization: Bearer ***`、`sk-...` → `sk-***`、飞书 webhook URL → `.../***`
- 报告脱敏：持仓金额 / 数量可显示，成本价可选隐藏（`LUOOME_HIDE_COST=true`）

## Research Vault Git 远端同步

Research Vault Phase F 只提供独立 Git workflow，不把网络同步混进 Vault Adapter，也不实现
Obsidian Headless fallback。它默认关闭；只有 `LUOOME_RESEARCH_REMOTE_SYNC=git` 才装配，Web
还必须同时开启 `LUOOME_EXPOSE_WRITE=true`、`LUOOME_EXPOSE_EXTERNAL=true`，通过同源 Origin
检查并由用户在确认框明确触发。真正执行 pull 的 Tool 是 workflow-only，不进入通用 registry/MCP。

安全协议：

- Git adapter 不依赖 Obsidian adapter 的装配结果，自身拒绝文件系统根、用户 home、当前项目根和
  `.obsidian` 保留目录；设置热更新撤销 Git opt-in 时立即清除旧 adapter；
- pull 前和 fetch 后都要求 tracked/untracked 工作树完全干净；detached HEAD、缺 upstream、未完成
  merge/rebase/cherry-pick/revert/bisect、分叉或冲突均停止；
- ignored 文件不作为普通 dirty 状态一刀切；fast-forward 前用 NUL 分隔路径比较 incoming 变更与
  ignored-untracked 文件，只有同路径或文件/目录祖先冲突才停止，且不改变 HEAD；
- 只执行显式 remote fetch 和本地 `merge --ff-only`；禁止自动 clone、commit、push、reset、rebase、
  选边或冲突解决；hooks、submodule recurse、tags 和交互式凭证提示关闭；
- remote 只接受 HTTPS、SSH 或本地路径；拒绝 HTTP、remote helper `ext::`、自定义 uploadpack 和
  HTTPS URL 内嵌认证信息；
- Git 凭证必须由本机 credential helper/SSH agent 管理。remote URL、stderr、路径和凭证不进入
  Tool 输出、WorkflowRun 或日志；状态接口只返回是否配置和 provider；
- fetch 支持超时与取消，并终止整个 Git 子进程组。进入本地 fast-forward 后不响应取消或强制
  超时，以免工作树停在半更新状态；
- fast-forward 前创建 Git bundle；backupRoot 按最近存在祖先解析真实路径且必须位于 Vault 外，
  防止备份本身污染工作树。目录权限 `0700`、文件 `0600`。备份失败则不更新，备份不自动删除。
  恢复必须先 `git bundle verify`，在新的恢复目录检查后由用户人工决定，不自动 reset；
- Web POST 只接受合法 JSON 对象；畸形或空请求体在进入 external workflow 前返回 `invalid_input`；
- Git 成功后仍以 Vault 文件为权威来源，通过既有 `sync_research_vault` 重建索引。索引失败记
  `partial`；Git 安全边界、取消或超时失败记 `failed`；成功记 `succeeded`。WorkflowRun 只保留
  provider 状态、计数和 opaque backupId。

远端仓库是否公开无法由 luoome 判断。Web 固定提示用户只使用私有仓库，并把 bundle 备份按私人
投资资料保护。

## 写入类工具的二次确认

Web 对话和草案确认要求 write + external 双 opt-in 和同源 Origin。浏览器只能提交用户文本与
`approved` 决定，不能补写 assistant/control parts 或替换草案输入；该限制在 Web 通用 tool 路由层
强制，经 MCP 暴露的 write 面属于本机可信调用方，不在此限制内。`settle_chat_draft` 校验会话账户、
消息与 toolCallId、草案工具白名单和当前输入 schema；它仅由 Web 专用确认端点调用，不进入通用 registry、MCP 或模型可调用工具表。
执行前以 repository 比较更新认领草案，执行结果按同一调用 ID 持久化。终态不可重放，进程中断遗留的
executing 状态不自动重试，需先核对实际业务数据；核对后可显式取消该草案（终态，不会补执行）。
模型下一轮读取真实 ToolResult，用户伪造的文本处理记录不能作为成功凭据。

`record_decision_trade` 是 trade 类工具（登记成交会联动现金与持仓，风险高于普通状态写入），永不通过 MCP 暴露；`confirm: true` 不能绕过这一边界。设置 `LUOOME_EXPOSE_TRADE=true` 会触发 MCP 启动硬卡。`add_trade` 是普通人工记账，副作用为 write，在 `LUOOME_EXPOSE_WRITE=true` 时可经 MCP 暴露。Web 的实际成交录入只登记用户已在系统外完成的成交，要求 write opt-in、同源校验、当前账户绑定与明确的尚未入账确认，不调用券商下单。

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

`defineTool` 在统一出口清理 input issues、InvariantError、adapter / llm_error / lease / internal 错误、handler
异常和 output schema 校验错误；审计事件只记录调用元数据，不接收 Tool 的业务输入或输出。

## Audit Log

所有非 read 类（write / external / queue / trade）工具调用记录到 `~/.luoome/logs/audit.log`：

```json
{
  "ts": "2026-07-17T10:30:00Z",
  "tool": "add_trade",
  "sideEffect": "write",
  "result": "ok",
  "caller": "mcp"
}
```

队列工具也记录：

```json
{
  "ts": "...",
  "tool": "complete_analysis_job",
  "sideEffect": "queue",
  "result": "ok",
  "caller": "mcp"
}
```

Tool 的业务输入、业务输出和错误详情不写入 audit log；失败事件只保留 `errorKind`。

当前实现（2026-08-14）：`defineTool` 对所有非 read 调用记录
成功、业务失败、输入校验失败和异常结果；CLI、MCP、TUI、Web 生产入口分别把日志写入
`$LUOOME_HOME/logs/audit.log`（Web 为数据库目录同级的 `logs/audit.log`）。文件按 JSONL 追加，
目录权限为 `0700`、文件权限为 `0600`。审计契约只包含时间、工具名、sideEffect、结果、
可选错误类别和调用方，从源头避免私人投资数据进入 sink。
Advice 的 `reasoning` / `risks` 在写回前过 prompt-injection 文本清理（见「输出反 prompt injection」）；
`basedOn.llmReasoning` 只保留给存量数据读取。
审计 sink 故障只产生 warning，不改变 ToolResult 协议或伪造业务成功。

## 上游信任

- **数据源**：Eastmoney / Tencent 等外部 API 返回的数据视为不可信，输入 db 前校验
- **模型输出**：写回时经 Zod 校验（`AdviceSchema.parse`）+ prompt-injection 文本清理，不直接执行；
  见「输出反 prompt injection」
- **研究 embedding 模型目录**：`LUOOME_RESEARCH_EMBEDDING_CONFIG` 只允许用 `apiKeyEnv` 引用凭证
  环境变量，不保存 API key；配置解析错误和日志不得输出凭证值
- **advice 回填**：`record_advice_outcome` 调用记录到 audit，但 outcome 数据本身不强制校验（用户主观回填）

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
- [x] Advice 与 trade 边界仍在（`trade` 不进入 MCP / 模型可调用工具表）
- [x] advice 必含 disclaimers（不变量测试覆盖）
- [x] advice 有效期限逻辑正确
- [x] Advice 写回路径对 reasoning / risks 做 prompt-injection 文本清理
- [x] 错误信息不含密钥 / 路径细节
- [x] 用户界面顶部固定免责声明
- [x] 默认纯插件部署的 read / market / 确认写面互不重叠；旧 MCP 四个实例白名单不重叠，且部署传入的 `LUOOME_EXPOSE_*` 一律丢弃

## 单机形态的入口与暴露面

luoome 现在是**单机版**：没有多租户、没有订阅计费、没有托管站点，也没有内嵌 DSH Host。
DSH 是唯一入口；**默认部署已完成纯插件切换**：DSH（Node）加载 `dsh-luoome` 插件，
`$LUOOME_HOME/luoome.db` 是唯一事实库（Node SQLite），插件与旧 MCP 手动验收面共享同一份事实库。
多租户托管形态（登录、订阅、支付、托管站点、用量计量）已随 D9–D12 下线，历史设计见
[DSH 改造详细设计](./ddd/luoome-dsh-transformation-detailed-design.md)。

### 两层鉴权

| 层 | 位置 | 作用 |
|---|---|---|
| 公网入口 basic auth | Caddy（`deploy/dsh/Caddyfile`） | DSH 不直接发布端口，只经反代对外；未配置 `DSH_AUTH_USER` / `DSH_AUTH_HASH` 时校验失败（fail closed），不会放开 `/dsh/` |
| DSH 启动 token | DSH Web 自身 | 入口 URL 带 token 才能建立会话，token 不进入业务进程；DSH 自带 Host/Origin 栅栏 |

- 两层都在 luoome 业务进程之外：luoome 不实现账号、密码或会话。
- 单机 Web（`luoome web serve`）默认只监听 `127.0.0.1`，不对局域网暴露；远程访问走 SSH 隧道或反向代理。
- 反向代理必须保留原始 Host 与端口；不信任客户端自带的 `X-Forwarded-Host` / `X-Forwarded-Proto` 放行请求。
- 部署以 HTTPS 为首选；当前公网入口若只能使用已授权的明文 HTTP 回退，basic auth 与 DSH token 仍会校验，
  但没有传输加密，不在不可信网络上传输凭据。

### 默认部署暴露面：纯插件（Node）

| 面 | 位置 | 暴露内容 | 能力 |
|---|---|---|---|
| read surface | `dsh-luoome` 插件（DSH Node 进程内） | 45 个纯 read 工具：账户/持仓/交易、Advice/复盘、Strategy、关注/触发、本地市场事实 | read |
| market external surface | 同上 | 精确 6 个 `sideEffect==='external'` 工具（指数/情绪/行情/新闻/试跑） | external（精确白名单） |
| 确认写操作 | 同上 | 8 条 policy：DecisionReview、`record_advice`、`record_analysis_result`、策略 create/version/validate/publish、`record_advice_outcome` | write/queue（逐次 allowed-once） |

- 插件的 read / market / 写操作面互相隔离；通用 `/api/luoome/call` 只读，写工具按名返回 403。
- 部署配置只由进程环境或受信任代码解析；HTTP 请求、模型参数与 skill 内容不能扩大 allowlist、
  提升账户或打开 automations/trade。
- 默认不启用自动任务；`trade` 永不注册，`LUOOME_EXPOSE_TRADE=true` 在打开数据库前即失败。

### 旧 MCP 过渡形态的暴露面（手动/隔离验收，默认部署不启动）

| 实例 | 挂载位置 | 暴露内容 | 能力 |
|---|---|---|---|
| `luoome` | DSH 交互面 profile（Web） | 事实、建议、策略、盯盘等只读工具 | read |
| `luoome-settings` | DSH 交互面 profile（Web） | 配置类写工具白名单（含研究结构工具） | write（精确白名单） |
| `luoome-analysis` | DSH 交互面 profile（Web） | 精确三个工具：`get_analysis_context`、`record_advice`、`record_analysis_result`；交互分析直接写回，不创建 `analysis_job` | read + queue（精确三工具白名单） |
| `luoome-batch` | DSH 交互面 profile（Web） | 五个批处理入口，供 DSH 定时任务调用 | write（精确白名单） |
| `luoome-worker` | 手动/隔离验收 profile（headless；默认部署不运行） | 队列消费白名单（claim / complete / fail 等） | queue（精确白名单） |

- 白名单按工具名精确匹配：读面严格只读，设置面只放配置类写工具，分析面只放三个交互分析工具，
  批处理面只放五个批处理入口。设置面放行研究结构工具不会连带放行研究正文读取。
- 暴露面开关由 profile 补丁决定：部署传入的环境变量里出现 `LUOOME_EXPOSE_*` 一律丢弃，
  一次配置失误不能把读面变成写面，也不能放出 trade。
- `queue` 是独立能力，不因开启 `write` 或 `external` 自动开放；分析面固定暴露三个交互工具，
  不含 claim / complete / fail / metrics / job 查询，手动 worker 实例才开放明确的队列消费白名单。
- 分析面由 profile 显式设置 `LUOOME_MCP_SERVER_NAME=luoome-analysis`；缺少分析面白名单时默认
  不挂载该实例，显式空数组表示零工具，不得退化成全量暴露。
- 私有研究能力（Vault 正文、frontmatter、附件名、搜索片段）视为不可信数据，不进入 system prompt，
  不输出绝对 Vault 路径或凭证。

### trade 永不暴露

- `LUOOME_EXPOSE_TRADE=true` 时 MCP server 启动即抛错退出（代码层硬卡，无配置绕过路径）。
- Web 通用工具路由拒绝所有 trade 工具；人工成交录入只经专用路由，条件见上文「trade 永不通过 MCP 暴露」。
- 建议与交易继续分离：Advice、盯盘结果与报告都不会自动下单。

### 单机事实库

- `$LUOOME_HOME/luoome.db` 是唯一事实源；默认部署由插件在 DSH Node 进程内直接打开，
  旧 MCP 交互面、分析面与手动 worker 实例在做手动验收时指向同一份文件。
- 历史托管租户库已下线，不会再同步；不要把旧租户库挂回单机部署。
- 面板与聊天读同一份数据：面板只做投影，不自己算数，数值必须与工具输出逐位一致。
- 面板走 harness 的 `/api` 路由，继承浏览器认证与 Origin 栅栏，不自建裸端口。
- 技能（`.dsh/skills`）本身不授予权限：它只决定 agent 怎么做事，能调哪些工具仍由实例白名单决定。

### 调度与批处理

- 单机形态没有常驻调度进程：批处理由 **DSH 定时任务**唤起会话，agent 再调用插件或旧
  `luoome-batch` 实例的批处理工具（默认部署不使用 MCP 实例）。
- 门槛判定（交易日、盘中时段、盘后小时、周几）随工具走，不满足时返回 `skipped`，不会写库；
  调度时间点错了也不会写坏事实。
- 交互式分析不经过队列：插件 read surface 取得持久化 context 后由 DSH 推理，再经原生确认操作
  `record_*` 校验写回，不创建 `analysis_job`；`record_*` 不能伪造已 claim 的 job 结果。
- 队列能力保留，但默认部署不运行 MCP/worker：没有生产者、没有常驻消费者，空队列不产生任何
  模型请求，避免空转的真实模型成本。需要验证消费链路时，用旧入口脚本在手动/隔离环境显式拉起
  legacy worker；租约先到先得，与插件共享同一份事实库。

### DSH 集成面的安全边界

默认纯插件部署的 DSH 集成面是 `dsh-luoome` 插件：host（Node SQLite + 真实 adapters + read/market
surface + 确认写 policy）、client（三面板 slots）、随包 skills（四技能）。旧 MCP 过渡形态的
profile 装配、只读面板插件与纪律提示词插件源码保留，仅用于手动验收。

- 插件 profile 由镜像管理：`deploy/dsh/profile-seed.mjs` 每次启动把构建产物安装进 DSH profile，
  只重写插件文件与补丁层，不改会话目录与业务事实库。
- 面板只做只读投影：client 经宿主认证的 `/api/luoome/state` 取固定 panel→工具映射的 ToolResult，
  继承 DSH 认证与 Host/Origin 校验，不自己算数、不把授权写进 localStorage。
- 随包技能只向 system prompt 追加约束（先取事实再下结论、advice ≠ trade、保留反证与有效期等），
  不授予任何工具权限；用户自改的同名技能优先于插件默认技能。
- 真实供应商成功路径、生产网络/进程隔离与真实生产切换仍待后续验收（本仓库只做隔离切换/回退演练）；
  对应研发计划已归档，见 [文档归档清单](./README.md#历史归档)。

## 纯插件迁移中的执行边界

插件的模型人工操作须经持久 prepare 与真实 DSH 审批；allowed-once 只对应当前冻结参数及 execution token，凭据不返回模型，后续权限 listener 的 allow 不能替代它。缺审批渠道、never 策略、取消、账户变化和子 Agent 均不能触发写入。浏览器人工表单使用独立 prepare/confirm 凭据，绑定相同账户与冻结输入。

新 Web 路由每次经真实 Connection.admit 和 owner 检查，POST 仍要求真实监听器同源 Origin；不用内部 Fetch URL 或 X-Forwarded 头替代它。输入上限 64 KiB，超限先回 413 再关闭未读流。确认凭据仅保存在页面内存，刷新后只可查询操作，不从存储或服务端重建确认凭据。临时 profile 的官方审批 UI、登录、Host/Origin、取消和冷恢复已有本地验收；验收使用合成事实及脚本模型。

定时授权同时核对真实投递历史、当前 turn、任务定义指纹、授权版本/有效期、账户、精确输入及组合能力；拒绝 force 和客户端自报任务身份。自动执行默认关闭。Node SQLite 只读/写回与默认部署切换已在隔离环境验收（含一致性备份与回退合并演练），但**不代表真实生产服务器已完成切换**，也不等同真实供应商/真实模型质量验收。unknown 结果先核对既有业务回执，禁止自动重复外部副作用。详细契约与隔离证据见[纯插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md)。
