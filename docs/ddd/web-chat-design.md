# Web 对话助手设计：`/api/chat` + draft-and-confirm

> 状态：**已实现**（AI SDK `ToolLoopAgent` + UI Message Stream、账户会话、服务端草案确认与投资管理闭环）。本文档描述当前对话契约。
> 关联：[Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)（聊天只生成目标模型 draft）。

## 目标

Web 端提供个人投资助手，覆盖账户与现金、持仓、行情研究、Strategy、Watchlist、AlertPlan 和建议。写操作一律 **draft-and-confirm**：AI 拟定操作，用户确认后执行，真实结果进入下一轮对话。

## 已确认决策

- **draft-and-confirm**：LLM 产出的 write / advice / 策略执行动作不直接执行；用户通过会话草案端点确认，`settle_chat_draft` 只执行持久化的输入
- **历史归服务端**：会话和 UI message parts 按账户写入项目 SQLite；客户端只提交 `sessionId` 和本轮 user message，服务端读取最近 20 条可信历史
- **账户隔离**：所有会话读写都通过 tools 校验当前 `defaultAccountId`，切换账户后前端重新加载对应会话列表
- **场景工具**：研究、持仓、盯盘、复盘和通用场景共享事实查询，并按场景限定草案类型
- **原生 agent tool loop**：由 adapters 内的 AI SDK `ToolLoopAgent.stream()` 完成推理、工具调用和文本流；Web 不再维护另一套动作 JSON 协议
- **标准 UI Message Stream**：`POST /api/chat` 返回 `text/event-stream` 与 `x-vercel-ai-ui-message-stream: v1`；原生 JS 前端消费协议，不要求 React

## 关键约束（现状）

- generation 仍使用结构化 `LLMAdapterLike.generate`；聊天使用 `AISDKAgentRuntime.createUIMessageStreamResponse`，AI SDK 类型不进入 core
- 对话和草案确认要求 `write + external` 显式开启，并执行同源 Origin 检查；trade 始终不可达
- 普通结构化分析使用模型目录的 `generation` profile，对话使用 `agent` profile；未配置或调用失败均明确报错，不伪造成功回答

## 设计

### 1. 端点 `POST /api/chat`（web 内部端点，不进 toolRegistry）

```ts
// 请求
interface ChatRequest {
  sessionId: string;
  messages: Array<{
    id: string;
    role: 'user';
    parts: Array<{ type: 'text'; text: string }>;
  }>; // 当前版本只接受一条本轮 user message
}
```

成功响应是 AI SDK UI Message SSE，包含 `text-start/delta/end`、`tool-input-available`、
`tool-output-available`、step 与 finish parts。请求校验失败仍返回 400 ToolResult JSON；
模型未配置返回 503 `llm_error` JSON。

会话管理端点为：

- `GET /api/chat/sessions`：当前账户会话列表
- `POST /api/chat/sessions`：创建会话
- `GET /api/chat/sessions/:id`：读取会话及消息
- `PATCH /api/chat/sessions/:id`：重命名
- `DELETE /api/chat/sessions/:id`：删除会话和消息
- `POST /api/chat/sessions/:id/drafts/:messageId/:toolCallId`：提交 `{ approved: boolean }`，确认或取消一个已保存的草案；禁止携带替代输入

所有写端点沿用 Web 同源 Origin 闸口；流请求和确认请求携带 `X-Luoome-Account-Id`，避免非默认账户错位。

### 2. 服务端 agent 流程

```
sessionId + 本轮 user message
  → append_chat_message 持久化
  → get_chat_session 读取最近 20 条历史
  → UI messages + 本地上下文摘要
  → Web 从 toolRegistry 构造显式聊天白名单
  → AISDKAgentRuntime 构造 ToolLoopAgent
  → agent.stream() 多步调用 read / 受控 external 工具
  → createAgentUIStreamResponse 输出 UI Message SSE
  → onFinish 持久化完整 assistant UI message parts
```

- 工具输入直接使用 registry 中的 Zod schema；名称、描述和输入契约不再复制到 prompt。
- tool 返回失败时作为 `{ error: ToolError }` 交还模型，并通过 UI stream 展示失败状态。
- agent 受 profile 的 timeout / retry 与 runtime 的最大步数约束。
- 服务端不采信客户端提供的旧历史；工具调用 parts 与草案输出一并落库，以便重新打开会话后恢复动作轨迹。
- 下一轮保留已完成的 tool parts 和 step 边界；已确认草案的模型侧 output 携带 `draftStatus` 和真实 `ToolResult`，包括新对象 ID。用户输入的“已执行”文本不构成执行凭据。
- SDK 在服务端消费流；取消时仍保存已收到的部分及取消标记。前端不再补写 assistant 消息。完成时发送 usage metadata，并持久化 `data-luoome-usage`。
- 流错误统一脱敏，不输出 provider 响应正文、URL、密钥或内部推理。

### 3. 会话领域与仓储

- core 定义 `ChatSession`、`ChatMessage`、`ChatRepository`，不依赖 AI SDK。
- `ChatMessage.parts` 保存 AI SDK UI message 的 SDK 无关 JSON 投影，当前角色限定为 user / assistant。
- db 同时提供 memory 与 drizzle 实现，共享 contract 验证最近消息截取、账户隔离、排序、级联删除、消息原子插入与 parts 比较更新。
- tools 提供 create/list/get/rename/delete/append 和 `settle_chat_draft`；会话消息不可通过 append 覆盖，重复相同输入幂等返回。
- 每个草案按 `messageId + toolCallId` 记录 `executing / succeeded / failed / cancelled`。执行前原子认领，完成后替换该标记；重复请求返回已保存状态，同一消息的草案串行处理。
- 若进程在认领后中断，保留 `executing`，不自动重试；用户需核对账本后再决定下一步。这保证不会重复执行，但不把中断后的结果冒充确定成功。
- 旧版文本处理记录没有调用 ID，不能推断同一工具的多个草案是否分别执行；检测到此类记录时要求核对数据并重新生成，避免升级后重复执行旧草案。

### 4. 动作白名单与门控

- 清单以 `packages/tools/src/agent/scenarios.ts` 与 `agent-whitelist.ts` 为准；同时校验 `sideEffect` 与全部 `requiredCapabilities`，只有查询及逐项批准的 external 能力自动执行。
- 账户、持仓、现金对账、交易计划和研究等查询返回事实；行情缺失或账本不平时必须披露 unavailable，不估算成精确可用资产。
- `portfolio/general` 可拟定 `create_account`、`add_holding`、`update_holding`、`close_holding`、`create_portfolio_cash_flow` 草案。现金变动按已有 core 账本规则展示；数量、成本、金额及时间不得猜测。它们维护本地记录，不向券商发单。
- Strategy / Watchlist / AlertPlan / 研究写入沿用场景草案。多个 Watchlist 成员合并为 `add_watchlist_members` 一条确认。
- `analyze_stock`、`analyze_position`、`market_outlook` 作为待确认 Advice 草案；确认后展示正式建议卡及反证、风险、免责声明、有效期。
- `settle_chat_draft` 是 tools 层的 Web 内部能力，不进入通用 registry、MCP 或模型的工具表；其 write + external 组合能力仅供专用用户确认端点调用，避免外部 Agent 借此绕过目标工具的暴露配置。所有 trade 工具均拒绝。

### 5. 上下文摘要（data.context）

每轮请求服务端注入的轻量摘要（控制 token）：

- 当前账户 id + 名称
- Watchlist 清单（id + name + kind + membershipPolicy）
- Strategy 清单（id + name + status）与 AlertPlan 清单
- 持仓 stockIds（不含行情；LLM 要行情走 `batch_quote` action）
- 数据健康降级摘要

明细一律让 LLM 通过 action 按需拉取，不预塞。

### 6. 前端

- 新路由 `/chat`（`server.ts` 加一行 serveFile）+ `public/js/chat.js`（沿用无构建模块化现状）
- 对话页面采用“会话侧栏 + 当前消息流”布局：支持新建、切换、重命名和删除，会话按最近更新时间排序
- 会话与消息存项目数据库，不使用 `sessionStorage`；首次用户消息自动生成会话标题
- `fetch` + `ReadableStream` 手工消费 AI SDK UI SSE（当前静态前端无 bundler，不引入 React hook）
- `text-delta` 增量更新助手气泡；step / tool parts 驱动“推理中、执行中、成功/失败”状态
- draft tool 的 `tool-output-available` 渲染确认卡片；回复保存后才允许确认，调用会话草案端点，不发送模型输入副本
- 卡片绑定创建时的账户、会话、消息与调用 ID。刷新后恢复每项独立执行状态与 Advice；全部草案处理完成且有成功执行时，助手自动继续总结真实结果
- 同步展示模型实际 token 用量；执行期间阻止切换会话造成错写，账户切换丢弃旧视图的异步结果
- 网络、HTTP 和 stream error 都落为明确的助手错误气泡

### 7. 测试

- adapter 测试验证真实 `createAgentUIStreamResponse` 产出 v1 SSE
- repository contract 覆盖账户隔离、最近消息顺序、并发插入、原子认领和会话级联删除
- server 测试验证 UIMessage 边界、服务端最近 20 条历史、assistant 落库、会话 API、canonical tool 白名单和 draft 不写库
- 服务端测试覆盖不可替换输入、重复确认、取消、失败、账户 header、同源闸口与跨轮真实结果；浏览器流消费器测试覆盖跨 chunk SSE、用量、流截断与非 2xx 错误

## 明确不做（v1）

- 不做云端同步、跨项目同步和会话分享
- 不做 LLM 自主写账本、执行策略或下单（draft-and-confirm 是硬边界，对齐 advice ≠ trade）
- 不做语音、附件、富媒体输入

## 已知边界

- 模型必须支持 tool calling；不兼容的 OpenAI-compatible 服务会以 stream error 明确失败
- 项目数据库中的历史会进入 prompt；system prompt 不依赖历史中的“助手承诺”做任何权限判断
- prompt 注入面：用户消息与持久化历史都会进 prompt；写操作有确认卡兜底，read 动作无副作用，残余风险是 LLM 回复被诱导说错话——靠 reply 中保留 disclaimers 与 usedActions 透明展示缓解
- 真实 LLM 不可用时 chat 返回明确错误，不伪造分析结果
