# Agent Loop 技术选型分析

> 状态：**草案**（待决策）。本文档是 chat/工作流升级为真 agent loop 之前的库选型与契约设计分析；不承诺实现计划，亦不替代后续具体设计稿。实现以代码为准。
> 关联：[web-chat-design.md](./web-chat-design.md)（v1 实现的「两轮 generate + draft-and-confirm」基线）、[ARCHITECTURE.md](../ARCHITECTURE.md)（LlmManager 与 tool 抽象边界）、[SECURITY.md](../SECURITY.md)（advice ≠ trade 硬边界）。
> 不关联：`apps/web/src/chat.ts` 当前实现——它是本文档要替换的对象，不是事实来源。

## 目标

把当前架构里"产品话术叫 agent、代码没有 agent loop"的落差补上：让 LLM 可以在多步推理中自主选择 read-only 与 draft-only 工具并产出结论，覆盖三个核心场景：

1. **研究 / 数据探索**：用户问开放式问题，agent 跨多数据工具交叉查证（类似 deep research）
2. **投资建议 / portfolio reasoning**：多步分析持仓、监控组、宏观事件，agent 自己组织证据链（**审计与反证必须可追溯**）
3. **工作流编排**：agent 当 orchestrator，动态决定跑 daily-advice 还是 risk-report（替换现在硬编码的命令）

文档目的：在动手写代码前，把"用哪个库"和"agent 契约长什么样"分开决策——前者是工程选型，后者是产品 / 安全决策，混在一起做必返工。

## 当前状态（为什么现在讨论）

- **没有 agent loop**：`defineWorkflow` 是严格线性 step pipeline（`packages/workflows/src/define-workflow.ts:283-329`）；MCP 是 `tools/call` → `tool.execute` 一对一（`packages/mcp/src/server.ts:93-112`）；最像 agent 的 `apps/web/src/chat.ts:246-298` 是被硬限定的 2-pass plan→execute，注释明确写"不引入多轮 tool-calling"
- **58 个 tool 全部由 CLI/MCP/workflow 直接调用**，没有任何一处把 tool 结果回灌给 LLM 让它选下一个 tool
- **LLM 调用面很窄**：单一接口 `generate({system, schema, data})`（`packages/adapters/src/llm/types.ts:17-20`），8 个调用点，always one-shot；`LLMManager` 唯一"循环"是 schema 解析失败重试一次 + 规则兜底
- **现有 adapter 已具备 Zod 直解析 + JSON Schema 注入**（`anthropic.ts:97-100`、`openai-compatible.ts:96-100`），但 Anthropic 通道靠 prompt 强约束 JSON，**不**用 `output_config.format` 原生通道

## 关键约束

- `packages/core` 是纯领域，零 IO，不能反向依赖 SDK；adapter 层封装必须保留 `LLMAdapter` 接口稳定（避免 58 个 tool 重写）
- `AGENTS.md` 明确"不加不必要抽象""不为不存在的需求付维护成本"——任何新库必须先证伪"能否不引入"
- `docs/SECURITY.md`：`advice ≠ trade`、`trade` tool 永不暴露、写操作显式 opt-in、advice 呈现保留反证 / 风险 / 免责声明 / 有效期
- Bun workspace + TypeScript strict + ESM；新库必须有可靠 ESM 支持
- 单用户本地工具，可接受合理 prompt 注入面；多用户 / 服务化前不引入

## 候选路径

不下定论。按"对当前架构的侵入性"由低到高排列。

### 路径 A：延用 `LLMAdapter` + 手写 loop

- 在 `packages/tools/src/tools/` 新增 `agent.run` 工具，内部实现消息持久化 + tool-calling 解析 + 多轮循环 + 成本上限
- Anthropic 通道改用官方 SDK 的 `output_config.format` 原生 JSON schema 约束（替换现 adapter 的 prompt trick）
- **优点**：零新依赖；与现有 adapter / manager / 5 个调用点的风格完全一致；安全审计范围可控
- **代价**：手写 tool-calling 解析、message 历史、超时/重试、token 成本统计，约 300–500 行新代码；每个新 provider 重写一遍

### 路径 B：Vercel AI SDK v6（`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai-compatible`）

- 用 `generateText({ model, output: Output.object({schema}), tools, stopWhen: stepCountIs(N), messages })` 替换现有 adapter 内部实现；`LLMAdapter` 接口保留为薄壳
- v6 起 `generateObject` 已废弃，统一走 `generateText + Output.object()`（[migration guide](https://github.com/vercel/ai/blob/main/content/docs/08-migration-guides/24-migration-guide-6-0.mdx)）
- `@ai-sdk/anthropic` 原生 `output_config.format` 自动选择 `outputFormat` / `jsonTool` / `auto`
- `createOpenAICompatible({ name, baseURL, apiKey, fetch })` 一行接新后端
- **优点**：`Output.object({schema: zod})` 内置 Zod 校验；`tools` + `stopWhen` 是 agent loop 的现成原语；多 provider 几乎零成本
- **代价**：v6 是 2026 上半年发布的新 major，仍在快速演进；升级 treadmill；调试栈深一层；`LLMManager` 的 retry/fallback 行为可能需要适配层

### 路径 C：LangGraph（`@langchain/langgraph`）

- 把 chat / workflow 设计成 state graph；节点 = LLM 调用或 tool 调用，边 = 条件路由
- 内置持久化、人在环、observability、checkpoint
- **优点**：agent 编排一等公民；复杂场景（plan/reflect/replan）表达力强；Anthropic / 任何 provider 都能接
- **代价**：概念重（state graph、checkpoint、interrupt）；与现有 strict core 边界有摩擦；体积 / 学习成本 / 长期维护显著高于 A、B

### 路径 D：Mastra / VoltAgent 等新一代 TS-native agent 框架

- **优点**：现代 TS 原生；与 Vercel AI SDK 兼容
- **代价**：成熟度与 SECURITY 边界（advice ≠ trade、人在环、audit trail）尚无可信现成实现；与 `docs/SECURITY.md` 强制要求的"advice 保留反证 / 有效期"对不上风险大

**淘汰**：路径 D（成熟度风险与 SECURITY 不匹配）。

## 待决事项（先于库选型）

这 4 件事不解决就动手选库，任何路径都会半途改方向。

### 1. Agent trust 边界

- agent 触发的 tool 范围是什么？read-only + draft-only 还是包含 write？
- write 工具触发后是 agent 直接落库还是永远 draft-and-confirm 让人批？
- advice 类工具（如 `analyze_stock`）是否允许被 agent 自调用？存在 chat→advice→chat 的递归成本与延迟
- `trade` 类硬拒、external 在何条件下允许、`sideEffect` 分类如何扩展都要在 `docs/SECURITY.md` 追加

### 2. 状态归属

- 当前 chat history 在客户端 `sessionStorage`、服务端截断；agent loop 需要 server-side 全量
- 是否新建 `conversation` 表？还是复用现有 schema 拼？
- message 保留周期、token 成本日志、上限

### 3. 可观测 / 可审计

- 每个 tool 调用的参数、返回、耗时、是否被 LLM 修改过——必须可回放
- agent 结论到 advice 的推理路径留痕，对应 `docs/SECURITY.md` 的"advice 可追溯"
- 是否落库到 `tool_call_log`？与现有 `AuditLog` 关系？

### 4. 成本与 SLA 上限

- `stopWhen: stepCountIs(N)` 还是更复杂的预算制（`maxTokenBudget`）？
- 单步超时、总超时、嵌套 LLM（chat → advice → chat）超时
- 本地首次跑通时建议默认值：总 token ≤ 8000、单步 ≤ 4 轮、单轮 LLM ≤ 30 s

## 推荐下一步

**不直接进 A/B/C 选型**。先选一个场景（建议「研究 / 数据探索」，路线最短）做端到端 POC，把上面 4 个待决事项落到代码与配置里，再根据真实 API 形状反推库选择。理由：

- 库的取舍取决于 tool 数量、message 频率、provider 切换频率——这些只有在 POC 跑通后才能量化
- SECURITY 边界在 POC 阶段先严后宽比反过来安全得多
- A 路径下的 POC 约 2–4 小时可以跑通；如果真要换 B，重构面集中在 `anthropic.ts` 一个文件，与现有 manager 解耦清晰

POC 范围建议：

- 新增 `packages/tools/src/tools/agent-run.ts`（接口骨架 + Zod 输入输出 schema）
- 用现有 `LLMAdapter` + Anthropic SDK 直调的方式实现内部循环
- 沿用 `web-chat-design.md` 的白名单 + draft-and-confirm 模式作为安全起点
- 暂不接 LangGraph、不接 Vercel AI SDK、不破坏现有 chat

## 明确不做（本文档阶段）

- 不下单引入任何 SDK（不写 `package.json`、不写 import）
- 不修改现有 `anthropic.ts` / `openai-compatible.ts` 内部
- 不修改现有 5 个 LLM 调用点的契约
- 不修改 `SECURITY.md` / `ARCHITECTURE.md`（只在本 DDD 里分析）
- 不预设对话 UI 的最终形态（属于 `web-chat-v2-design.md` 范畴）

## 已知边界 / 风险

- 如果不做 POC 直接选 B/Vercel AI SDK，可能在「Anthropic 原生 JSON schema 是否真的比 prompt 强约束稳定」这一点上赌错——目前没有真实失败率数据
- 如果坚持 A/手写，agent 复杂场景（plan → reflect → replan）后期大概率仍要换框架
- SECURITY 边界定得太松，agent 可能产出与 `docs/SECURITY.md` 冲突的 advice 措辞；定得太严，POC 跑不通
- 三个核心场景（research / portfolio reasoning / workflow 编排）的 agent 深度差异大：research 浅、portfolio reasoning 深、workflow 编排需要长期记忆——一套 SDK 不一定三场景都最优，可能后续按场景分别选
