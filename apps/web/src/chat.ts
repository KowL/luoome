// apps/web/src/chat.ts —— POST /api/chat：web 对话助手（docs/web-chat-design.md）。
//
// 两轮 generate（顺现有 LLM 抽象，不引入多轮 tool-calling）：
//   Pass 1（规划）：system = 助手提示词；schema = ChatPlanSchema { reply, actions, drafts }
//   Pass 2（成文）：actions 执行结果（含失败原样）喂回；schema 只要求 { reply }
// 硬边界：
//   - 每轮 ≤ 2 次 generate、≤ 5 个 action（超出截断并在 usedActions 标注 rejected）
//   - read 白名单自动执行；advice / external / trade / write 出现在 actions 一律拦截
//   - write 类只进 drafts 永不执行；draft 逐条过目标 tool input schema 二次校验，
//     失败的丢弃并在 reply 中说明（不静默吞）
//   - LLM 失败 / parse 失败 → 兜底 reply，不抛 500

import type { ToolContext, ToolResult } from '@luoome/core';
import { toolRegistry } from '@luoome/tools';
import { z } from 'zod';

/** 服务端截断：history 只保留最近 N 轮（spec §1：历史在客户端，服务端无状态）。 */
const MAX_HISTORY_TURNS = 10;
/** 每轮最多执行的 read 动作数（spec §2 硬上限）。 */
const MAX_ACTIONS = 5;
/** 每轮最多保留的 draft 数（超出按丢弃计）。 */
const MAX_DRAFTS = 5;

/** 自动执行的 read 白名单（spec §3；advice 类 v1 不开，幻觉产出按 rejected 拦截）。 */
const CHAT_READ_TOOLS: ReadonlySet<string> = new Set([
  'search_stocks',
  'get_quote',
  'batch_quote',
  'list_holdings',
  'get_holding',
  'compute_pnl',
  'list_tactics',
  'list_stock_groups',
  'get_stock_group',
  'list_stock_pools',
  'get_advice',
  'get_advice_stats',
  'list_trades',
  'list_notes',
]);

/** write 类 draft 白名单：tool → draft.kind（kind 与 tool 不匹配同样丢弃）。 */
const CHAT_DRAFT_TOOLS: Readonly<Record<string, 'stock-group' | 'stock-pool'>> = {
  create_stock_group: 'stock-group',
  update_stock_group: 'stock-group',
  delete_stock_group: 'stock-group',
  create_stock_pool: 'stock-pool',
  update_stock_pool: 'stock-pool',
  delete_stock_pool: 'stock-pool',
};

const FALLBACK_REPLY = '暂时无法处理，请换个说法，或使用左侧导航的页面功能。';
const FALLBACK_REPLY_AFTER_ACTIONS = '查询已执行，但暂时无法整理结果，请换个说法重试。';

const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

/** POST /api/chat 请求体（spec §1）。 */
export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(ChatTurnSchema).max(100).optional(),
});

const ChatActionSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

const ChatDraftSchema = z.object({
  kind: z.enum(['stock-group', 'stock-pool']),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  summary: z.string().min(1).max(500),
});

/** Pass 1 规划输出（spec §2）。数组上限放宽，超硬上限部分由服务端截断标注。 */
const ChatPlanSchema = z.object({
  reply: z.string().max(8000).default(''),
  actions: z.array(ChatActionSchema).max(20).default([]),
  drafts: z.array(ChatDraftSchema).max(20).default([]),
});

/** Pass 2 成文输出。 */
const ChatReplySchema = z.object({ reply: z.string().min(1).max(8000) });

export interface ChatDraft {
  readonly kind: 'stock-group' | 'stock-pool';
  readonly tool: string;
  readonly input: unknown;
  readonly summary: string;
}

export interface ChatUsedAction {
  readonly tool: string;
  readonly ok: boolean;
  /** true = 未执行（超白名单 / advice 未开放 / 超上限截断）。 */
  readonly rejected?: boolean;
}

export interface ChatResponseData {
  readonly reply: string;
  readonly drafts: readonly ChatDraft[];
  readonly usedActions: readonly ChatUsedAction[];
}

/**
 * Pass 1 system prompt。结构要点：
 * 1. 角色 + 输出契约（只输出 JSON plan）
 * 2. 可用 read 动作清单（含入参提示）——与 CHAT_READ_TOOLS 一一对应
 * 3. draft 规则：write 一律只出 drafts、input 必须符合目标 tool schema、永不自动执行
 * 4. 边界声明：不复述未查到的数据；advice/刷新/推送类不在对话范围，引导到页面或 CLI
 * `chat_plan` 是对模型的任务类型提示。
 */
const CHAT_PLAN_SYSTEM = `chat_plan
你是 luoome 的个人投资助手（web 对话）。结合对话历史与当前上下文（账户 / 分组 / 战法 / 持仓 stockIds）回答用户。

你可以使用以下只读查询动作（actions，最多 5 个；执行结果会在下一轮给你）：
- search_stocks：按代码/名称搜股票 {query}
- get_quote：单只股票实时行情 {stockId}
- batch_quote：批量实时行情 {stockIds: []}
- list_holdings：当前账户持仓（含盈亏汇总）{}
- get_holding：单条持仓详情 {holdingId}
- compute_pnl：盈亏计算 {}
- list_tactics：战法清单 {includeBuiltins?: boolean}
- list_stock_groups：股票分组清单 {}
- get_stock_group：分组详情 + 当前成员 {groupId}
- list_stock_pools：盯盘池清单 {}
- get_advice：历史建议 {subjectId?, limit?}
- get_advice_stats：建议准确率统计 {}
- list_trades：交易记录 {}
- list_notes：笔记 {}

写操作（创建/更新/删除 股票分组或盯盘池）只允许产出配置草案 drafts，每条形如
{"kind": "stock-group" | "stock-pool", "tool": "create_stock_group" | "update_stock_group" | "delete_stock_group" | "create_stock_pool" | "update_stock_pool" | "delete_stock_pool", "input": {...}, "summary": "一句话说明"}。
drafts 不会自动执行，需用户在界面上确认后才生效；input 必须严格符合对应工具的入参要求。

规则：
- 不复述你没有通过 actions 查询到的具体数据（价格、盈亏、成员明细等）；需要数据就先放 actions，reply 留空。
- 写操作一律只出 drafts，绝不出现在 actions。
- 个股深度分析（analyze_stock 等）、刷新行情 / 推送通知等操作不在对话范围内；用户提出时在 reply 中引导其去对应页面或使用 CLI。
- 涉及投资判断时保持审慎，提醒「不构成投资建议」。
- 只输出 JSON：{"reply": "...", "actions": [{"tool": "...", "input": {...}}], "drafts": [...]}；没有动作或草案时给空数组。`;

/**
 * Pass 2 system prompt（`chat_reply` 是任务类型提示）。
 */
const CHAT_REPLY_SYSTEM = `chat_reply
你是 luoome 的个人投资助手。data 中包含用户问题、对话历史与本轮查询动作的执行结果（含失败，原样给出）。
请基于结果用中文简洁回答用户问题；失败的查询要如实说明原因；不要编造结果中不存在的数据；
涉及投资判断时提醒「不构成投资建议」。只输出 JSON：{"reply": "..."}。`;

interface ChatContextSummary {
  readonly account: { readonly id: string; readonly name: string } | null;
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly resolverKind: string;
    readonly memberCount: number;
  }[];
  readonly tactics: readonly { readonly id: string; readonly name: string; readonly tag: string }[];
  readonly holdingStockIds: readonly string[];
}

/**
 * 轻量上下文摘要（spec §4，控制 token）：当前账户 + 分组清单（无成员明细）+
 * 战法清单 + 持仓 stockIds。明细一律让 LLM 通过 action 按需拉取。
 * 单项拉取失败降级为空，不阻塞对话。
 */
const buildContextSummary = async (ctx: ToolContext): Promise<ChatContextSummary> => {
  const accountId = ctx.user.defaultAccountId;
  const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      ctx.logger.warn('[chat] 上下文摘要拉取失败，降级为空', { err: String(e) });
      return fallback;
    }
  };

  const account = await safe(async () => {
    if (accountId.length === 0) return null;
    const a = await ctx.repos.account.findById(accountId);
    return a === null ? null : { id: a.id, name: a.name };
  }, null);

  const groups = await safe(async () => {
    const list = await ctx.repos.stockGroup.list();
    return Promise.all(
      list.slice(0, 50).map(async (g) => ({
        id: g.id,
        name: g.name,
        resolverKind: g.resolver.kind,
        memberCount: (await ctx.repos.groupMember.currentMembers(g.id)).length,
      })),
    );
  }, []);

  const tactics = await safe(
    async () =>
      (await ctx.repos.tactic.list()).map((t) => ({ id: t.id, name: t.name, tag: t.tag })),
    [],
  );

  const holdingStockIds = await safe(async () => {
    if (accountId.length === 0) return [];
    return (await ctx.repos.holding.listByAccount(accountId))
      .filter((h) => h.closedAt === null)
      .map((h) => h.stockId);
  }, []);

  return { account, groups, tactics, holdingStockIds };
};

const okChat = (data: ChatResponseData): ToolResult<ChatResponseData> => ({ ok: true, data });

/**
 * /api/chat 处理器（web 内部端点，不进 toolRegistry）。
 * invokeTool 由 server.ts 注入（复用现有 sideEffect 门控语境；chat 自身另按
 * CHAT_READ_TOOLS 白名单二次门控，不新增特权通道）。
 */
export const handleChat = async (
  body: unknown,
  ctx: ToolContext,
  invokeTool: (name: string, input: unknown) => Promise<ToolResult<unknown>>,
): Promise<ToolResult<ChatResponseData>> => {
  const parsedReq = ChatRequestSchema.safeParse(body);
  if (!parsedReq.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_input',
        message: `chat 请求校验失败: ${parsedReq.error.issues.map((i) => i.message).join('; ')}`,
        issues: parsedReq.error.issues,
      },
    };
  }
  const { message } = parsedReq.data;
  const history = (parsedReq.data.history ?? []).slice(-MAX_HISTORY_TURNS);
  const context = await buildContextSummary(ctx);

  // —— Pass 1（规划）——
  let plan: z.infer<typeof ChatPlanSchema>;
  try {
    const out = await ctx.adapters.llm.generate({
      system: CHAT_PLAN_SYSTEM,
      schema: ChatPlanSchema,
      data: { message, history, context },
    });
    // adapter 契约是「先 parse 再返回」，自定义 adapter 仍可能返回未校验输出，兜底再 parse
    const parsed = ChatPlanSchema.safeParse(out);
    if (!parsed.success) {
      ctx.logger.warn('[chat] Pass 1 输出未通过 schema 校验，走兜底 reply');
      return okChat({ reply: FALLBACK_REPLY, drafts: [], usedActions: [] });
    }
    plan = parsed.data;
  } catch (e) {
    ctx.logger.warn('[chat] Pass 1 LLM 调用失败，走兜底 reply', { err: String(e) });
    return okChat({ reply: FALLBACK_REPLY, drafts: [], usedActions: [] });
  }

  // —— actions 门控 + 执行（read 白名单自动执行；其余拦截标 rejected）——
  const usedActions: ChatUsedAction[] = [];
  const actionResults: Array<{ tool: string; ok: boolean; result: ToolResult<unknown> }> = [];
  for (const action of plan.actions.slice(MAX_ACTIONS)) {
    usedActions.push({ tool: action.tool, ok: false, rejected: true });
  }
  for (const action of plan.actions.slice(0, MAX_ACTIONS)) {
    if (!CHAT_READ_TOOLS.has(action.tool)) {
      // advice（v1 未开放）/ write / external / trade / 未知 tool 一律拦截
      usedActions.push({ tool: action.tool, ok: false, rejected: true });
      continue;
    }
    const result = await invokeTool(action.tool, action.input);
    usedActions.push({ tool: action.tool, ok: result.ok });
    actionResults.push({ tool: action.tool, ok: result.ok, result });
  }

  // —— Pass 2（成文）：仅当执行了动作且 Pass 1 未给直接回复 ——
  let reply = plan.reply.trim();
  if (actionResults.length > 0 && reply.length === 0) {
    try {
      const out = await ctx.adapters.llm.generate({
        system: CHAT_REPLY_SYSTEM,
        schema: ChatReplySchema,
        data: { message, history, actionResults },
      });
      const parsed = ChatReplySchema.safeParse(out);
      reply = parsed.success ? parsed.data.reply.trim() : FALLBACK_REPLY_AFTER_ACTIONS;
    } catch (e) {
      ctx.logger.warn('[chat] Pass 2 LLM 调用失败，走兜底 reply', { err: String(e) });
      reply = FALLBACK_REPLY_AFTER_ACTIONS;
    }
  }
  if (reply.length === 0) reply = FALLBACK_REPLY;

  // —— drafts 二次校验：逐条过目标 tool 的 input schema；失败丢弃并在 reply 说明 ——
  const drafts: ChatDraft[] = [];
  let droppedDrafts = Math.max(0, plan.drafts.length - MAX_DRAFTS);
  for (const draft of plan.drafts.slice(0, MAX_DRAFTS)) {
    const kind = CHAT_DRAFT_TOOLS[draft.tool];
    const tool = kind === undefined ? undefined : toolRegistry.get(draft.tool);
    if (kind === undefined || kind !== draft.kind || tool === undefined) {
      droppedDrafts += 1;
      continue;
    }
    const parsedInput = tool.inputSchema.safeParse(draft.input);
    if (!parsedInput.success) {
      droppedDrafts += 1;
      continue;
    }
    // 用 parse 后的 input（落默认值），保证「确认」调用与校验口径一致
    drafts.push({
      kind: draft.kind,
      tool: draft.tool,
      input: parsedInput.data,
      summary: draft.summary,
    });
  }

  // 拦截 / 丢弃的透明说明（spec §2：不静默吞；§3：引导到 CLI）
  const rejectedTools = usedActions.filter((a) => a.rejected === true).map((a) => a.tool);
  if (rejectedTools.length > 0) {
    reply += `\n\n（注：${rejectedTools.join('、')} 不在对话可用范围内，已跳过；请在对应页面或 CLI 操作。）`;
  }
  if (droppedDrafts > 0) {
    reply += `\n\n（另：有 ${droppedDrafts} 条配置草案未通过校验或不支持，已丢弃。）`;
  }

  return okChat({ reply, drafts, usedActions });
};
