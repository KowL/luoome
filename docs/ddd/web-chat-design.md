# Web 对话助手设计：`/api/chat` + draft-and-confirm

> 状态：**已实现**（2026-07-26 迁移为 AI SDK `ToolLoopAgent` + UI Message Stream，并加入项目数据库持久化会话；保留 draft 确认卡片）。本文档是对话助手设计的唯一事实来源。
> 关联：[Strategy 与统一 Watchlist 详细设计](./strategy-watchlist-unification-detailed-design.md)（聊天只生成目标模型 draft）。

## 目标

Web 端提供一个与 LLM 对话的入口（通用助手，非仅分组创建），覆盖：分组/盯盘池管理、持仓与行情查询、战法与建议查询等。写操作一律 **draft-and-confirm**：LLM 拟配置，人确认后才落库。

## 已确认决策（2026-07-26）

- **draft-and-confirm**：LLM 产出的 write 类动作不直接执行，作为 draft 返回前端；用户点「确认」后走既有 `/api/tools/:name/call` 落库
- **历史归服务端**：会话和 UI message parts 按账户写入项目 SQLite；客户端只提交 `sessionId` 和本轮 user message，服务端读取最近 20 条可信历史
- **账户隔离**：所有会话读写都通过 tools 校验当前 `defaultAccountId`，切换账户后前端重新加载对应会话列表
- **定位通用助手**：不限于分组创建；read 类动作白名单适当放宽（见 §3）
- **原生 agent tool loop**：由 adapters 内的 AI SDK `ToolLoopAgent.stream()` 完成推理、工具调用和文本流；Web 不再维护另一套动作 JSON 协议
- **标准 UI Message Stream**：`POST /api/chat` 返回 `text/event-stream` 与 `x-vercel-ai-ui-message-stream: v1`；原生 JS 前端消费协议，不要求 React

## 关键约束（现状）

- generation 仍使用结构化 `LLMAdapterLike.generate`；聊天使用 `AISDKAgentRuntime.createUIMessageStreamResponse`，AI SDK 类型不进入 core
- web 端 tool 暴露面：read + advice + write 放行，external 仅白名单 `fetch_quote`（`apps/web/src/server.ts`）
- LLM 必须由 AI SDK 模型目录的 `generation` profile 配置真实模型；调用失败时返回明确的保守 fallback

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

创建、重命名和删除沿用 Web mutation token 与同源 Origin 闸口。

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

### 3. 会话领域与仓储

- core 定义 `ChatSession`、`ChatMessage`、`ChatRepository`，不依赖 AI SDK。
- `ChatMessage.parts` 保存 AI SDK UI message 的 SDK 无关 JSON 投影，当前角色限定为 user / assistant。
- db 同时提供 memory 与 drizzle 实现，并用共享 repository contract 验证账户隔离、排序和级联删除。
- tools 提供 create/list/get/rename/delete/append 六个会话能力；Web API 只做协议适配，不直接访问 repository。

### 4. 动作白名单与门控

- **自动执行**：`search_stocks` / `fetch_quote` / `batch_quote` / `list_holdings` / `get_holding` / `list_tactics` / `list_stock_groups` / `get_stock_group` / `list_stock_pools` / `get_advice` / `get_advice_stats` / `list_trades` / `list_research_notes`
- **自动执行（advice，有 LLM 成本，v1.1 再开）**：`analyze_stock` / `analyze_position` / `market_outlook` —— v1 先不开，避免 chat→advice 嵌套 LLM 的延迟与成本失控；回复中引导用户去对应页面
- **draft（write，确认后执行）**：`create_stock_group` / `update_stock_group` / `delete_stock_group` / `create_stock_pool` / `update_stock_pool` / `delete_stock_pool`
- **拒绝**：除 `fetch_quote` / `batch_quote` 外的 external、advice 与所有 trade 工具不传给 agent，模型无法调用
- 执行门控复用 web 现有 sideEffect 规则；chat 不新增特权通道

### 5. 上下文摘要（data.context）

每轮请求服务端注入的轻量摘要（控制 token）：

- 当前账户 id + 名称
- 分组清单（id + name + resolver.kind + 成员数，不含成员明细）
- 战法清单（id + name + tag）
- 持仓 stockIds（不含行情；LLM 要行情走 `batch_quote` action）

明细一律让 LLM 通过 action 按需拉取，不预塞。

### 6. 前端

- 新路由 `/chat`（`server.ts` 加一行 serveFile）+ `public/js/chat.js`（沿用无构建模块化现状）
- 对话页面采用“会话侧栏 + 当前消息流”布局：支持新建、切换、重命名和删除，会话按最近更新时间排序
- 会话与消息存项目数据库，不使用 `sessionStorage`；首次用户消息自动生成会话标题
- `fetch` + `ReadableStream` 手工消费 AI SDK UI SSE（当前静态前端无 bundler，不引入 React hook）
- `text-delta` 增量更新助手气泡；step / tool parts 驱动“推理中、执行中、成功/失败”状态
- draft tool 的 `tool-output-available` 渲染确认卡片；点击确认后才调用 `/api/tools/:name/call`
- 网络、HTTP 和 stream error 都落为明确的助手错误气泡

### 7. 测试

- adapter 测试验证真实 `createAgentUIStreamResponse` 产出 v1 SSE
- repository contract 覆盖账户隔离、消息顺序和会话级联删除
- server 测试验证 UIMessage 边界、服务端最近 20 条历史、assistant 落库、会话 API、canonical tool 白名单和 draft 不写库
- 浏览器流消费器测试覆盖跨 chunk SSE 与非 2xx ToolResult 错误

## 明确不做（v1）

- 不做云端同步、跨项目同步和会话分享
- 不开放 advice 类动作（v1.1 评估成本后开）
- 不做 LLM 直接执行 write / external / trade（draft-and-confirm 是硬边界，对齐 advice ≠ trade）
- 不做语音、附件、富媒体输入

## 已知边界

- 模型必须支持 tool calling；不兼容的 OpenAI-compatible 服务会以 stream error 明确失败
- 项目数据库中的历史会进入 prompt；system prompt 不依赖历史中的“助手承诺”做任何权限判断
- prompt 注入面：用户消息与持久化历史都会进 prompt；写操作有确认卡兜底，read 动作无副作用，残余风险是 LLM 回复被诱导说错话——靠 reply 中保留 disclaimers 与 usedActions 透明展示缓解
- 真实 LLM 不可用时 chat 返回明确 fallback，不伪造分析结果
