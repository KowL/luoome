# AI SDK 接入与 LLM 实现重构详细设计

> 状态：**已实施**（2026-07-26）。Phase 1/2 已接入并完成自动化验收；Phase 3 chat v2 仍按本文非目标单独设计。本文档是 [agent-loop-tech-selection.md](./agent-loop-tech-selection.md) 路径 B 的落地设计：用 Vercel AI SDK v6 重构 `packages/adapters` 的 LLM 实现，并基于其 agent 原语实现 agent loop。
> 关联：[agent-loop-tech-selection.md](./agent-loop-tech-selection.md)（选型决策）、[ARCHITECTURE.md](../ARCHITECTURE.md)（§6.3 LLM 抽象边界）、[SECURITY.md](../SECURITY.md)（advice ≠ trade、draft-and-confirm）、[web-chat-design.md](./web-chat-design.md)（chat v1 基线）。
> 原则：**尽量使用 AI SDK 的现成能力，不重复造轮子**；凡 AI SDK 已覆盖的机制（loop、结构化输出、超时、HTTP 重试、token 统计、测试 mock）一律不手写。

## 1. 目标 / 非目标

### 目标

1. 用 `ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible` 替换 `anthropic.ts` / `openai-compatible.ts` 两个手写裸 fetch adapter，`LLMAdapter` 接口与 8 个调用点契约不变。
2. 在 adapters 内用 `ToolLoopAgent` 实现 SDK 封装的 agent runtime，由新 tool `agent_run` 通过 SDK 无关接口调用；安全门控采用显式能力白名单 + draft-and-confirm。
3. 删除 AI SDK 已覆盖的 HTTP 请求拼装、AbortController 管理和 token 汇总；保留 provider quirks 所需的显式 JSON Schema 归一化与本地 Zod 校验。
4. 以 AI SDK Provider Registry 建立唯一模型目录，彻底移除 core 的 provider / URL /
   API key / model 配置认知；普通生成与 Agent 通过独立 profile 路由。

### 非目标

- 不改变 core 的 `LLMAdapterLike` / `LLMGenerateRequest` 业务端口；provider 配置从 core
  删除。8 个业务调用点不选择 provider 或 model。
- 四个装配点（cli / tui / mcp / web）统一创建 `AIStack`，不各自解析模型环境变量。
- 不改 `LLMManager` 的 fallback 协议（重试一次 + 规则兜底）——这是领域逻辑，AI SDK 无法也不应接管。
- 不实现跨轮会话持久化（conversation 表）、不引入 LangGraph、不改 chat v1 的 `/api/chat` 契约（属于 web-chat-v2 范畴）。
- AI SDK 类型不透出 `packages/adapters`：core / tools / surface 不出现任何 `ai` 包的 import 或类型。

## 2. 现状盘点（重构前事实）

| 机制 | 现状 | AI SDK 对应能力 | 处置 |
|---|---|---|---|
| 结构化输出 | `anthropic.ts` forced tool_use；`openai-compatible.ts` `response_format.json_schema` + prompt 注入 schema | `generateText` + `Output.object({schema})`；`@ai-sdk/anthropic` `structuredOutputMode: 'auto'`（outputFormat / jsonTool 自动选择） | **替换** |
| zod → JSON Schema | `z.toJSONSchema({io:'input', unrepresentable:'any'})` + `normalizeOpenAISchema` 归一化 | SDK 可内部转换，也支持 `jsonSchema()` | **保留显式转换与归一化**，并补 `validate` 回调（见 §4.3） |
| HTTP 调用 / 错误 | 手写 `postJson`、状态码包装、自定义 Error 类 | provider 包内置 | **删除** |
| 超时 | 手写 `AbortController` + `setTimeout` | `generateText({ abortSignal })`，用 `AbortSignal.timeout(ms)` | **替换** |
| HTTP 瞬态重试 | 无 | `maxRetries`（默认 2） | **Phase 1 显式关闭**（`maxRetries: 0`，保持调用次数契约）；agent runtime 单独配置 |
| 应用层重试 + 规则 fallback | `LLMManager.generate`（retry hint + MA5/MA20 规则兜底） | 无对应物（领域逻辑） | **保留，不动** |
| prompt 截断 | `truncate(userContent, maxPromptChars)` | 无 | **保留**（构造 prompt 前截断，10 行） |
| MiniMax 等非标 provider 兼容 | `stripThinkAndFences`、schema 注入 system、`additionalProperties` 归一化 | 无 | **保留为 quirks 层**（§4.3） |
| token 统计 | 无 | `result.usage` / `result.steps[i].usage` | **采用**（agent 成本上限依赖它） |
| 测试假件 | `FakeLLMAdapter`（tool 层测试） | `ai/test` 的 `MockLanguageModelV3`（adapter 层测试） | **两者并存**（§8） |
| `raw` 审计字段 | adapter 返回原始响应 JSON，进 `AdviceDataSnapshot.llmReasoning` | `result.response.body` / `result.text` / `result.steps` | **映射**（§4.4） |

## 3. 依赖引入

`packages/adapters/package.json` 新增（**仅这一个包**）：

```json
"dependencies": {
  "ai": "6.0.x",
  "@ai-sdk/anthropic": "3.0.x",
  "@ai-sdk/openai-compatible": "2.0.x",
  "@ai-sdk/provider": "3.0.x"
}
```

- 版本对齐实际 npm dist-tag 与 provider specification：`ai@6.0.x`、`@ai-sdk/anthropic@3.0.x` 使用 LanguageModel V3；`@ai-sdk/openai-compatible` 的 AI SDK v6 兼容线为 `2.0.x`，其 `3.0.x` 已使用 LanguageModel V4，不能与 `ai@6` 混装。package.json 不使用 caret，lockfile 固定实际 patch。
- SDK 升级是显式动作；SDK 类型不透出 adapters，升级爆炸半径限定在 adapters 的 AI SDK 实现文件。
- Zod：仓库为 zod ^4，AI SDK v6 原生兼容；两个包对同一 zod 版本的解析由 Bun workspace 保证单例（POC 第 1 天验证，见 §9 Phase 0）。
- `AI_SDK_LOG_WARNINGS=false` 不进代码；警告走 logger 观察一段时间再定。

## 4. 目标架构

### 4.1 文件结构（packages/adapters/src/llm/）

```text
llm/
  types.ts              # 不动：LLMAdapter / LLMGenerateResult
  manager.ts            # 只编排 retry/fallback；构造器注入 adapter
  model-catalog.ts      # JSON schema + Provider Registry + profile 解析
  stack.ts              # 四端共用的 composition factory
  ai-sdk-adapter.ts     # 新增：AISDKAdapter implements LLMAdapter（generate 走 generateText）
  agent-runtime.ts      # Phase 2 新增：AISDKAgentRuntime implements AgentRuntimeLike
  provider-quirks.ts    # 新增：非标 provider 兼容层（§4.3）
  anthropic.ts          # 删除（含 anthropic.test.ts）
  openai-compatible.ts  # 删除（含 openai-compatible.test.ts）
  ai-sdk-adapter.test.ts    # 新增（MockLanguageModelV3）
  model-catalog.test.ts     # provider / profile / secret resolution
  provider-quirks.test.ts   # 新增
```

`manager.test.ts` 的 fallback 协议用例保留；直接注入 `LLMAdapter`，测试不需要真实 API。

### 4.2 model-catalog.ts / stack.ts

```ts
const registry = createProviderRegistry(namedProviders);
const model = wrapLanguageModel({
  model: registry.languageModel(profile.model),
  middleware: defaultSettingsMiddleware({
    settings: { temperature: profile.temperature, maxOutputTokens: profile.maxOutputTokens },
  }),
});
```

- provider 名称动态注册，profile 以 `provider:model` 引用。
- provider 支持 `openai-compatible`、`anthropic` 和 AI Gateway。
- `apiKeyEnv` 只保存环境变量名；解析时缺密钥立即失败，错误不含密钥值。
- `createAIStackFromEnv` 加载一次目录，构造 generation adapter 与 agent runtime。

### 4.3 provider-quirks.ts（非标 provider 兼容层）

现有 adapter 有三处针对 MiniMax-M3 等非标后端的兼容逻辑，AI SDK **不覆盖**，必须保留，收敛为一个文件：

1. **think 块 / 代码围栏剥离**（现 `stripThinkAndFences`）：对已启用该 quirk 的 openai-compatible 通道捕获 `NoObjectGeneratedError`，取 `error.text` 做 `stripThinkAndFences` + `JSON.parse` + 原 Zod schema `safeParse`。`Output.object` 解析失败会抛错，不以 `result.output === undefined` 表达，因此恢复逻辑必须位于异常分支；`AISDKAdapter` 与 `AISDKAgentRuntime` 共用该恢复函数。
2. **schema 注入 system**（现 `buildSystemContent`）：对已知静默忽略 `response_format` 的后端，把 JSON 输出约束 + schema 文本追加进 system。quirk 在 provider 配置中显式声明，不按 URL 或模型名猜测。
3. **`additionalProperties: {}` → `true` 归一化**（现 `normalizeOpenAISchema`）：AI SDK 内部做 zod→JSON Schema 转换，口径与 `z.toJSONSchema` 不一定一致。AISDKAdapter 统一显式转换：先 `z.toJSONSchema`（与 toolRegistry 同口径）→ 归一化 → 用 AI SDK 的 `jsonSchema(normalized, { validate })` 包装；`validate` 必须回调原 Zod schema 的 `safeParse`，不能只传裸 JSON Schema，否则会丢失本地校验契约。

### 4.4 ai-sdk-adapter.ts

```ts
export class AISDKAdapter implements LLMAdapter {
  constructor(private readonly profile: ResolvedAIModelProfile) {}

  async generate<T>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    const schema = request.schema as z.ZodType; // schema 缺失仍抛错（契约不变）
    const userContent = truncate(JSON.stringify(request.data), this.maxPromptChars);
    const quirks = this.profile.quirks;
    const outputSchema = toValidatedAISchema(schema); // jsonSchema(normalized, { validate: safeParse })
    try {
      const result = await generateText({
        model: this.profile.model,
        system: quirks.injectSchemaIntoSystem
          ? buildSystemContent(request.system, toNormalizedJsonSchema(schema))
          : request.system,
        prompt: userContent,
        output: Output.object({ schema: outputSchema }),
        abortSignal: AbortSignal.timeout(this.profile.timeoutMs),
        maxRetries: 0,                            // Phase 1 保持现有「每次 generate 一次 HTTP」契约
        providerOptions: this.profile.providerType === 'anthropic'
          ? { anthropic: { structuredOutputMode: 'auto' } }
          : undefined,
      });
      return { ...(result.output as T), raw: buildRaw(result) };
    } catch (error) {
      if (
        quirks.recoverMalformedText &&
        NoObjectGeneratedError.isInstance(error) &&
        error.text !== undefined
      ) {
        const recovered = recoverMalformedText(error.text, schema); // 清洗后仍强制 safeParse
        return { ...(recovered as T), raw: buildRawFromError(error) };
      }
      throw error;
    }
  }
}
```

要点：

- **契约不变**：正常路径由 `jsonSchema(..., { validate })` 调原 Zod schema 校验；quirks 恢复路径再次 `safeParse`。两路都只有校验成功才返回，失败抛错并由 Manager 触发 retry hint + 规则 fallback；`name` 格式不变。
- **`raw` 审计字段**：`buildRaw(result) = JSON.stringify({ text: result.text, body: result.response.body ?? null, usage: result.usage })`。`AdviceDataSnapshot.llmReasoning` 的消费者只当字符串使用，格式变化兼容；迁移测试分别固定正常与 quirks 恢复路径的最小审计字段，不承诺保留 provider 私有响应的完整形状。
- ** Anthropic 通道升级**：`structuredOutputMode: 'auto'` 让 Sonnet 4.5+ 走原生 `output_format`，老模型自动回退 jsonTool（与现 forced tool_use 等价）——这是顺手获得的稳定性升级，不是重构目标。
- **temperature / maxOutputTokens**：由 profile 经 `defaultSettingsMiddleware` 注入；
  prompt 截断与超时也是 profile 字段。

### 4.5 manager.ts 改动面

- 构造器接收已经解析好的 `LLMAdapter`；Manager 不读 env、不选择 provider。
- `describeError` 改为识别 AI SDK 错误（`NoObjectGeneratedError` → 「输出未通过 schema 校验」；`APICallError` → 带 statusCode），其余走 `Error.name` 通用分支。
- fallback 协议（首次失败 → retry hint 重试 → 规则兜底）**一行不动**。
- `AISDKAdapter` 显式 `maxRetries: 0`，因此 Manager 两轮最多对应两次 HTTP 调用，与重构前一致；引入 SDK HTTP 重试需另行设计错误分类与总预算。

### 4.6 agent loop：`agent_run` tool

AI SDK 实现位于 `packages/adapters/src/llm/agent-runtime.ts`；`packages/core` 只新增不含任何 AI SDK 类型的 `AgentRuntimeLike` / `AgentCallableTool` 投影，`ToolContext` 新增可选 `agent` 字段。四个 surface 用同一模型目录的 `agent` profile 构造 `AISDKAgentRuntime` 并注入。`packages/tools/src/tools/agent-run.ts` 只负责白名单、system instructions、ToolResult 映射和输出校验，不 import `ai`、不读 env。

```ts
// packages/adapters/src/llm/agent-runtime.ts（AI SDK 边界内）
import { Output, ToolLoopAgent, stepCountIs, tool } from 'ai';

const trace: AgentToolTrace[] = [];
const agent = new ToolLoopAgent({
  model,
  instructions: request.instructions,          // tools 层传入，含 advice ≠ trade 等 SECURITY 约束
  tools: Object.fromEntries(
    request.tools.map((t) => [t.name, tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input) => {
        const startedAt = performance.now();
        const output = await t.execute(input);
        trace.push({ toolName: t.name, input, output, durationMs: performance.now() - startedAt });
        return output;
      },
    })]),
  ),
  stopWhen: [
    stepCountIs(cfg.maxSteps),                 // 默认 8（见 §5）
    tokenBudgetExceeded(cfg.maxTotalTokens),  // 自定义 stop 条件：累计 usage 超预算即停
  ],
  output: Output.object({ schema: request.outputSchema }),
  onStepFinish: (event) => logStep(event),     // v6 稳定回调
  maxRetries: 2,                               // agent 专用策略；受总超时约束
});

const result = await agent.generate({
  prompt: request.prompt,
  timeout: { totalMs: cfg.timeoutMs },
});
return {
  output: result.output,
  trace,
  usedTools: [...new Set(trace.map((item) => item.toolName))],
  totalUsage: result.totalUsage,
};
```

`AgentRuntimeLike.run` 的 request/response 只含字符串、unknown schema、普通回调和结构化 trace；`LanguageModel`、`ToolLoopAgent`、`Output`、`tool` 等类型全部停留在 adapters。`usedTools` 从实际 trace 派生，不要求模型自报。

**安全门控（v1 决策，先严后宽）**：

- 白名单是 tools 包内显式维护的 `AGENT_V1_TOOL_NAMES`，从 `toolRegistry` 解析；启动时断言名字存在，且只允许 `read` 和逐项批准的 `external`。不能直接复用现 `CHAT_READ_TOOLS`：其中含历史别名和 `batch_quote` 等非 read 能力。
- v1 允许的 external 仅列出完成查询链路所必需的能力（初始仅 `batch_quote`）；write / trade / advice 工具**不进 tools 表**。trade 永不进（SECURITY 硬边界）。`search_stocks` 等名义为 read、实现可能回源的工具在 Phase 2 前做传递副作用复核。
- write 类意图走 `output` schema 里的 `drafts` 数组（复用 chat v1 的 draft-and-confirm 形状），由调用方（chat v2）确认后另行执行——agent 自身无落库通道。
- `toolApproval: { ... }`（AI SDK 的人在环机制）v1 **不使用**：v1 只有 read 和显式批准的 external，且外层 `agent_run` 已受 external opt-in 门控；v2 开放 write 时优先评估它，不手写审批循环。

**模型输出 schema**（`AgentModelOutputSchema`）：`{ conclusion, evidence: string[], counterEvidence: string[], risks: string[], drafts: ChatDraft[] }`——advice 呈现所需的反证 / 风险 / 免责声明由 schema 强制存在。tool 最终输出在此基础上追加 runtime 从 trace 派生的 `usedTools` / `totalUsage`，不信任模型自报审计字段。

**tool 注册**：`agent_run` 自身分类为 `external`，因为必然调用远端 LLM，且白名单可包含显式批准的行情 external tool；不得包装成 `read` 绕过副作用门控。它进入 registry、桶导出、CLI/MCP 发现按既有流程，MCP 只有在 external opt-in 时暴露。v1 不写业务表；持久审计若后续写库，需在独立设计中重新确认副作用分类和 repository 契约。

### 4.7 chat v2 流式：UI message stream 协议（Phase 3）

AI SDK UI 分两层：框架 hooks（`useChat` 等，React/Vue/Svelte/Angular）与**框架无关的 UI message stream 协议**（`ai` 核心包导出）。luoome web 是 Hono + 原生 JS，**只接协议层，不接 hooks 层**：

- 服务端（Hono）：agent 的 `stream()` 经 `toUIMessageStream` + `createUIMessageStreamResponse` 输出标准 SSE 事件流（text delta / tool-call / tool-result / data parts / finish + `messageMetadata` 携带 usage）。进度事件（第几步、调了哪个 tool）用 data parts 承载。
- 消息模型：跨轮历史用 `UIMessage` 表达，进 loop 前 `convertToModelMessages` 转换——技术选型文档待决事项 2（状态归属）的消息格式由此确定，不自造。
- draft-and-confirm 演进：协议内置 tool 审批状态（`approval-requested` / `approval-responded` / `output-denied`），与 v2 开放 write 工具时的 `toolApproval` 语义一致；v1 的 drafts 数组可映射为 data parts，前端确认交互不变。
- 客户端（原生 JS）：用 `DefaultChatTransport`（`ai` 导出的框架无关类）或手写 SSE 解析消费；渲染逻辑自写，事件分类法不自己发明。
- chat v1 `/api/chat` 的一次性 JSON 契约 → SSE 是破坏性变更，归入 Phase 3 的 web-chat-v2 设计，过渡期两契约并存。

## 5. 配置

模型配置已升级为 adapters 内唯一的 AI SDK 模型目录。默认读取
`$LUOOME_HOME/ai-models.json`，`LUOOME_AI_CONFIG` 可覆盖路径：

- `providers`：命名的 `openai-compatible`、`anthropic`、`gateway` provider；密钥只以
  `apiKeyEnv` 引用环境变量。
- `profiles.generation`：普通结构化生成使用的 `provider:model`、温度、输出 token、
  超时和 prompt 上限。
- `profiles.agent`：Agent 使用的模型和生成默认值，并包含 `maxSteps`、
  `maxTotalTokens`、总超时。
- provider quirks 显式声明，不再通过 base URL 或模型名猜测。

四个 surface 通过 `createAIStackFromEnv` 只加载一次目录，普通生成与 Agent 共享
Provider Registry。旧 `LUOOME_LLM_*` / `LUOOME_AGENT_*` 以及 core
`LLMProviderConfig` 已删除，不提供兼容读取。

Web 设置页是模型目录的主要用户入口：provider 切换会带出推荐模型与 endpoint，
保存时由服务端校验并分别原子写入模型目录和 `0600` 密钥文件，再热替换当前
`ToolContext` 的 LLM / Agent 实现。读取接口只暴露 `apiKeyConfigured`。JSON 示例
保留给自动化部署、CLI/TUI/MCP 用户和高级手工配置，不再要求普通 Web 用户编辑 JSON。

## 6. 关键风险与缓解

1. **zod → JSON Schema 口径漂移 / 本地校验丢失**：toolRegistry 用 `z.toJSONSchema`，AI SDK 内部用自己的转换。缓解：§4.3.3 统一显式转换 + `jsonSchema(normalized, { validate })`；`validate` 始终回调原 Zod schema。POC 用 `z.record(z.string(), z.unknown())` 与 discriminated union 各跑一例验证。
2. **MiniMax 等非标后端回归**：quirks 层（§4.3）三处逻辑原样搬移 + 专项测试；POC 第 1 周用 MiniMax 真实跑一次 `analyze_stock`。
3. **升级 treadmill**：pin minor + SDK 隔离在 adapters 内；`bun run typecheck` 覆盖全部边界。
4. **Bun 兼容性**：`ai` 是纯 ESM + fetch 风格，无已知 Bun 硬伤；POC 验证 `bun test` / `bun build`（`--packages external` 时 `ai` 不进 bundle，运行时解析）。
5. **`raw` 格式变化**：消费者仅当字符串处理（审计快照），无结构化解析方；grep 确认 `llmReasoning` 无字段级消费后合入。
6. **LLMManager 与 SDK 重试叠加**：现 Manager 会重试所有异常，并非只重试 schema 失败；若保留 SDK 默认 `maxRetries: 2`，两轮 Manager 调用最多放大为 6 次 HTTP 尝试。Phase 1 因此固定 `maxRetries: 0`；未来启用 SDK 重试前必须先定义可重试错误、最大尝试次数和总 wall-clock budget。
7. **副作用传递失真**：现有个别 `read` tool 内部会访问远端 adapter，不能仅按顶层 `sideEffect` 推导 agent 能力。Phase 2 对 `AGENT_V1_TOOL_NAMES` 逐项复核真实调用链，并用测试断言 write / advice / trade 永远不可达。
8. **token 预算不是硬上限**：自定义 `stopWhen` 在已有 step 后判断，至少可能多消耗最后一次模型调用。`maxTotalTokens` 只作软停止条件；硬保护由 `stepCountIs`、`timeout.totalMs`、provider 侧额度共同承担，UI/日志展示实际 `totalUsage`。

## 7. 可观测 / 审计

- 每次 `agent_run`：tool execute wrapper 收集 `{toolName, input, output摘要, durationMs}`，稳定回调 `onStepFinish` 收集 step usage / finishReason；最终返回 `trace / usedTools / totalUsage`。
- v1 只写结构化 logger，不写业务表，因此 `agent_run` 保持 `external` 且没有隐藏 write 通道。日志必须脱敏并限制 tool output 摘要长度，不记录 API key、完整持仓或私人笔记正文。
- 若产品要求持久回放，先设计 `agent_run_log` 的保留期、脱敏和访问控制，再按 AGENTS.md 同步 drizzle + in-memory 实现与 contract tests；不能在 `read`/`external` tool 内无声明地追加数据库写入。
- `usedTools` 从实际 trace 派生；`output.evidence / counterEvidence` 是模型结论说明，不能单独宣称可回放完整证据链。

## 8. 测试策略

- **adapter 层**：`ai/test` 的 `MockLanguageModelV3` 替换现 anthropic/openai-compatible 的手写 fetch mock；覆盖结构化输出成功 / `jsonSchema.validate` 拒绝非法对象 / `NoObjectGeneratedError.text` quirks 恢复 / 恢复后仍不合 schema 则抛错 / 超时 abort。
- **manager 层**：`realFactory` 注入假 adapter 的现有用例不动（fallback 协议回归保障）。
- **tool 层**：`FakeLLMAdapter` **保留不动**——它实现的是 `LLMAdapter` 接口，与底层是否走 AI SDK 无关；这正是接口薄壳的收益。
- **agent runtime**：`MockLanguageModelV3` scripted 序列（第 1 步返回 tool_call、第 2 步返回最终 output）验证 loop、`stepCountIs`、token 预算、总超时、trace 与 `usedTools` 派生。
- **agent_run tool**：验证白名单所有名字存在；仅允许声明的 read / external；write、advice、trade 不可达；tool 错误按结构化结果回灌；最终输出再过 `AgentRunOutputSchema`。

## 9. 迁移计划

- **Phase 0 — POC 验证（1–2 天）**：装依赖；验证 zod v4 兼容、Bun test/build、Anthropic `structuredOutputMode: 'auto'` 真实调用、MiniMax quirks 真实调用。任一失败回到本文档修订，不硬推。
- **Phase 1 — adapter 替换（核心重构）**：新增 3 个实现文件 + 测试，改 manager.ts，删 4 个旧文件。验收：`bun run test` / `test:web` / `typecheck` / `lint` 全绿；8 个调用点零改动；单次 adapter generate 仅一次 HTTP 尝试；用真实 API key 各跑一次 `analyze_stock`（anthropic + 一个 openai-compatible 后端）。
- **Phase 2 — agent_run**：core 新增 SDK 无关 `AgentRuntimeLike`，adapters 新增 `AISDKAgentRuntime`，四端注入，tools 新增 `agent_run` + 显式能力白名单 + 结构化 trace。验收：`ai` 依赖仍只存在于 adapters；CLI `luoome tools call agent_run` 跑通「查持仓 → 查行情 → 出结论」多步链路；MCP 未开启 external 时不可调用；trace 与实际调用一致。
- **Phase 3 — chat v2 接入**：`/api/chat` 内部从 2-pass 切到 `agent_run`，并按 §4.7 迁移到 UI message stream 协议（SSE），draft-and-confirm 语义不变。独立设计稿，不在本文档范围。

### 9.1 实施结果（2026-07-26）

- 实际锁定：`ai@6.0.235`、`@ai-sdk/anthropic@3.0.102`、`@ai-sdk/openai-compatible@2.0.62`；三者统一使用 LanguageModel V3。
- Phase 1：两个裸 fetch adapter 已替换为 `AISDKAdapter`；Manager retry/fallback 契约、prompt 截断、超时、审计 raw 和 MiniMax quirks 均有回归测试。
- Phase 2：`AgentRuntimeLike`、`AISDKAgentRuntime`、`agent_run`、显式白名单、四端装配与 Web/MCP external 门控已接入；trace 只返回输出结构摘要，不返回完整持仓或研究正文。
- 自动化验收：`bun run typecheck`、`bun run test:all`、`bun run build` 通过；LLM/Agent/MCP 专项测试通过。
- 真实 smoke：已使用配置的 MiniMax OpenAI-compatible 端点验证结构化输出，以及“模型调用本地工具 → 最终结构化输出”的 agent loop；实际 trace 为 1 次 `health_check` 且记录 token usage。Anthropic 真实端点仍需在具备 Anthropic 凭据的部署环境执行同一 smoke。

## 10. 明确不做

- Phase 1 不动 core、8 个调用点和四端装配；全阶段不动 `LLMManager` fallback 协议与 `FakeLLMAdapter`。Phase 2 只允许新增 SDK 无关的 agent runtime 投影与装配，不改变既有 LLM 接口。
- 不使用框架 hooks（`useChat` / `useCompletion` / `useObject`）、`HarnessAgent`、`@ai-sdk/tui`，不引入任何前端框架；UI message stream **协议层**（`createUIMessageStreamResponse` / `toUIMessageStream` / `UIMessage` / `DefaultChatTransport`，均在 `ai` 核心包内，零新增依赖）在 Phase 3 采用，见 §4.7。
- 不引入 `zod` 之外的 AI SDK 配套包（`@ai-sdk/react`、`@ai-sdk/rsc` 等）。
- 不在 MCP 暴露 `agent_run` 之外的 agent 能力；`trade` 永不进 agent 工具表。

## 11. 开放问题

1. 是否需要持久化 agent trace；若需要，先完成保留期、脱敏、访问控制和副作用分类设计，不能把它作为 `external` tool 的隐式数据库写入。
2. `AgentRunOutputSchema` 与 chat v1 `ChatDraft` 的复用粒度 → Phase 2 对齐 web-chat-v2-design。
3. token 预算默认值 30000 是否合适 → POC 用真实 usage 数据校准后回填 §5。
4. advice 类工具（`analyze_stock` 等）未来是否进 agent 白名单（嵌套 LLM 成本）→ 按技术选型文档待决事项 1，Phase 3 前决策。
