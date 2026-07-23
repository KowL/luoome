# Web 对话助手设计：`/api/chat` + draft-and-confirm

> 状态：**已实现**（2026-07-22 定稿并落地：`POST /api/chat` + `/chat` 前端页 + draft 确认卡片）。本文档是对话助手设计的唯一事实来源；实现与本文有出入处以代码为准，并在本文追记。
> 关联：[stock-group-design.md](./stock-group-design.md)（对话创建分组依赖其实现；聊天端点与交互模式可并行开发，draft schema = `create_stock_group` 的 input schema）。

## 目标

Web 端提供一个与 LLM 对话的入口（通用助手，非仅分组创建），覆盖：分组/盯盘池管理、持仓与行情查询、战法与建议查询等。写操作一律 **draft-and-confirm**：LLM 拟配置，人确认后才落库。

## 已确认决策（2026-07-22）

- **draft-and-confirm**：LLM 产出的 write 类动作不直接执行，作为 draft 返回前端；用户点「确认」后走既有 `/api/tools/:name/call` 落库
- **历史放客户端，服务端无状态**：每次请求携带 history，服务端截断；不建 session 表
- **定位通用助手**：不限于分组创建；read 类动作白名单适当放宽（见 §3）
- **顺现有 LLM 抽象**：不引入多轮 tool-calling 大改；每轮 = 单/双次 `generate({system, schema, data})`，输出 zod 校验的「reply + actions + drafts」结构

## 关键约束（现状）

- LLM adapter 是单轮结构化输出（`packages/adapters/src/llm/types.ts`）：`generate(request)` → schema parse + 稳定 fallback，无多轮消息、无原生 tool-calling
- web 端 tool 暴露面：read + advice + write 放行，external 仅白名单 `fetch_quote`（`apps/web/src/server.ts`）
- LLM 默认 mock；real 由 `LUOOME_LLM_PROVIDER` 路由。mock 模式下 chat 返回稳定 fallback 回复即可

## 设计

### 1. 端点 `POST /api/chat`（web 内部端点，不进 toolRegistry）

```ts
// 请求
interface ChatRequest {
  message: string;                    // 1-2000 字符
  history?: readonly ChatTurn[];      // 客户端持有；服务端截断最近 10 轮
}
interface ChatTurn { role: 'user' | 'assistant'; content: string }

// 响应（统一 ToolResult 形状）
interface ChatResponse {
  reply: string;                      // 最终自然语言回复
  drafts: readonly Draft[];           // 待用户确认的写操作（可空）
  usedActions: readonly UsedAction[]; // 本轮实际执行的 read 动作摘要（透明性）
}
interface Draft {
  kind: 'stock-group' | 'stock-pool'; // v1 两类；可扩展
  tool: string;                       // 'create_stock_group' 等
  input: unknown;                     // 已通过该 tool input schema 校验
  summary: string;                    // LLM 生成的一句话说明，渲染在确认卡片上
}
interface UsedAction { tool: string; ok: boolean }
```

### 2. 服务端两轮 generate 流程

```
Pass 1（规划）:
  system = 助手提示词（角色 + 可用动作清单 JSON 描述 + draft 规则 + 边界声明）
  data   = { message, history(截断), context: 当前账户/分组与战法清单摘要 }
  schema = ChatPlanSchema:
    { reply: string,                    // 无需动作时的直接回复；有动作时可为空
      actions: ActionCall[],            // ≤5 个，仅允许 read/advice 白名单
      drafts: Draft[] }                 // write 类一律进 drafts，永不执行

  actions 非空且 reply 为空 → 执行 actions（见 §3 门控）→ Pass 2
Pass 2（成文）:
  data 追加 actions 的执行结果（含失败，失败原样喂回让 LLM 解释）
  schema 只要求 { reply }；drafts 沿用 Pass 1 输出（重新校验）
硬上限：每轮最多 2 次 generate、5 个 action；超出部分截断并在 usedActions 标注
```

- **drafts 双重校验**：Pass 1 输出先过 `ChatPlanSchema`，再逐条过目标 tool 的 input schema；校验失败的 draft 丢弃并在 reply 中说明（不静默吞）
- **失败不抛**：LLM 解析失败 → fallback reply（「暂时无法处理，请换个说法」）；action 执行失败 → ToolResult 错误喂回 Pass 2

### 3. 动作白名单与门控

- **自动执行（read）**：`search_stocks` / `get_quote` / `batch_quote` / `list_holdings` / `get_holding` / `compute_pnl` / `list_tactics` / `list_stock_groups` / `get_stock_group` / `list_stock_pools` / `get_advice` / `get_advice_stats` / `list_trades` / `list_notes`
- **自动执行（advice，有 LLM 成本，v1.1 再开）**：`analyze_stock` / `analyze_position` / `market_outlook` —— v1 先不开，避免 chat→advice 嵌套 LLM 的延迟与成本失控；回复中引导用户去对应页面
- **draft（write，确认后执行）**：`create_stock_group` / `update_stock_group` / `delete_stock_group` / `create_stock_pool` / `update_stock_pool` / `delete_stock_pool`
- **拒绝**：external（含 `refresh_stock_group`）/ trade 类动作 → Pass 1 的 system prompt 中不列出；LLM 幻觉产出时服务端按白名单拦截，reply 中说明「该操作请在 CLI 执行」
- 执行门控复用 web 现有 sideEffect 规则；chat 不新增特权通道

### 4. 上下文摘要（data.context）

每轮请求服务端注入的轻量摘要（控制 token）：

- 当前账户 id + 名称
- 分组清单（id + name + resolver.kind + 成员数，不含成员明细）
- 战法清单（id + name + tag）
- 持仓 stockIds（不含行情；LLM 要行情走 `batch_quote` action）

明细一律让 LLM 通过 action 按需拉取，不预塞。

### 5. 前端

- 新路由 `/chat`（`server.ts` 加一行 serveFile）+ `public/js/chat.js`（沿用无构建模块化现状）
- 对话流 UI：history 存 `sessionStorage`（关 tab 即清，与"无服务端 session"一致）
- **draft 确认卡片**：渲染 summary + 结构化字段（分组名/resolver/rules 等），按钮「确认创建」→ `POST /api/tools/:name/call`；结果回插对话流作为系统消息
- `usedActions` 折叠展示（「查询了 batch_quote、list_holdings」），保持透明
- LLM mock / 失败时回复兜底文案，UI 不特殊处理

### 6. 测试

- `server.test.ts` 补 `/api/chat` 用例：mock LLM 下返回 fallback reply；构造 plan 含 write action → 只进 drafts 不执行；action 超白名单被拦截；history 截断生效
- draft 校验失败丢弃路径覆盖

## 明确不做（v1）

- 不做流式输出（generate 单轮，SSE 等真实需求驱动）
- 不做服务端会话持久化 / 多端同步
- 不开放 advice 类动作（v1.1 评估成本后开）
- 不做 LLM 直接执行 write / external / trade（draft-and-confirm 是硬边界，对齐 advice ≠ trade）
- 不做语音、附件、富媒体输入

## 已知边界

- 单轮 generate 规划多个 action 的可靠性随白名单长度下降；action 失败靠 Pass 2 解释兜底，不做自动重试规划（ReAct 循环）
- 历史在客户端 → 用户可篡改 history 内容；本地单用户工具风险可接受，但 system prompt 不依赖 history 中的"助手承诺"做任何权限判断
- prompt 注入面：用户消息与 history 都会进 prompt；写操作有确认卡兜底，read 动作无副作用，残余风险是 LLM 回复被诱导说错话——靠 reply 中保留 disclaimers 与 usedActions 透明展示缓解
- mock LLM 下 chat 体验为固定 fallback，属预期（与 analyze_stock 等现状一致）
