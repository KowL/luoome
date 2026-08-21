import { type AgentCallableTool, ChatMessageSchema, type ToolContext } from '@luoome/core';
import {
  AGENT_SCENARIOS,
  type AgentScenario,
  BASE_INSTRUCTIONS,
  routeAgentMessage,
  summarizeDraft,
  toolRegistry,
} from '@luoome/tools';
import { z } from 'zod';

const MAX_MESSAGES = 20;

const ChatTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(8_000),
});

const ChatUIMessageSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(['user', 'assistant']),
  parts: z.array(ChatTextPartSchema).min(1).max(20),
});

export const ChatStreamRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  messages: z.array(ChatUIMessageSchema).min(1).max(100),
});

export interface ChatStreamRuntime {
  createUIMessageStreamResponse(request: {
    readonly instructions: string;
    readonly uiMessages: readonly unknown[];
    readonly tools: readonly AgentCallableTool[];
    readonly abortSignal?: AbortSignal;
    readonly onFinish?: (message: {
      readonly id: string;
      readonly parts: readonly Record<string, unknown>[];
      /** 流被中断（客户端取消/断开）时为 true；parts 为已收到的部分。 */
      readonly cancelled: boolean;
    }) => Promise<void> | void;
  }): Promise<Response>;
}

interface ChatContextSummary {
  readonly account: { readonly id: string; readonly name: string } | null;
  readonly watchlists: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly membershipPolicy: string;
  }[];
  readonly strategies: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  }[];
  readonly alertPlans: readonly { readonly id: string; readonly name: string }[];
  readonly holdingStockIds: readonly string[];
  /** 数据健康降级摘要；全部正常时缺省，不占上下文 token。 */
  readonly dataHealth?: { readonly degraded: true; readonly issues: readonly string[] };
}

const buildContextSummary = async (ctx: ToolContext): Promise<ChatContextSummary> => {
  const accountId = ctx.user.defaultAccountId;
  const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      ctx.logger.warn('[chat] 上下文摘要拉取失败，降级为空', { err: String(error) });
      return fallback;
    }
  };

  const account = await safe(async () => {
    if (accountId.length === 0) return null;
    const value = await ctx.repos.account.findById(accountId);
    return value === null ? null : { id: value.id, name: value.name };
  }, null);
  const executeRead = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const tool = toolRegistry.get(name);
    if (tool === undefined) throw new Error(`chat 上下文 tool 未注册: ${name}`);
    const result = await tool.execute(input, ctx);
    if (!result.ok) throw new Error(`${name}: ${result.error.kind}`);
    return result.data as Record<string, unknown>;
  };
  const watchlists = await safe(async () => {
    const data = await executeRead('list_watchlists', {});
    return z
      .array(
        z.object({
          watchlist: z.object({
            id: z.string(),
            name: z.string(),
            kind: z.string(),
            membershipPolicy: z.string(),
          }),
        }),
      )
      .parse(data.items)
      .slice(0, 50)
      .map(({ watchlist }) => watchlist);
  }, []);
  const strategies = await safe(async () => {
    const data = await executeRead('list_strategies', {});
    return z
      .array(z.object({ id: z.string(), name: z.string(), status: z.string() }))
      .parse(data.strategies)
      .slice(0, 50);
  }, []);
  const alertPlans = await safe(async () => {
    const data = await executeRead('list_alert_plans', {});
    return z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(data.plans)
      .slice(0, 50);
  }, []);
  const holdingStockIds = await safe(async () => {
    if (accountId.length === 0) return [];
    return (await ctx.repos.holding.listByAccount(accountId))
      .filter((holding) => holding.closedAt === null)
      .map((holding) => holding.stockId);
  }, []);
  const dataHealth = await safe(async () => {
    const data = await executeRead('get_market_data_status', {});
    const status = z
      .object({
        providers: z.array(z.object({ provider: z.string(), freshness: z.string() })),
        datasets: z.array(
          z.object({ dataset: z.string(), source: z.string(), freshness: z.string() }),
        ),
        watchHealth: z.object({ state: z.string() }).nullable(),
        watchlistStale: z.array(z.object({ name: z.string() })),
      })
      .parse(data);
    const issues: string[] = [];
    for (const provider of status.providers) {
      if (provider.freshness === 'stale' || provider.freshness === 'unavailable') {
        issues.push(`行情源 ${provider.provider} ${provider.freshness}`);
      }
    }
    for (const dataset of status.datasets) {
      if (dataset.freshness === 'stale' || dataset.freshness === 'unavailable') {
        issues.push(`数据集 ${dataset.dataset}/${dataset.source} ${dataset.freshness}`);
      }
    }
    if (status.watchHealth?.state === 'failed') issues.push('watch 最近一次运行失败');
    for (const item of status.watchlistStale) {
      issues.push(`Watchlist「${item.name}」存在 stale 成员来源`);
    }
    return issues.length === 0 ? undefined : { degraded: true as const, issues };
  }, undefined);

  return {
    account,
    watchlists,
    strategies,
    alertPlans,
    holdingStockIds,
    ...(dataHealth === undefined ? {} : { dataHealth }),
  };
};

const buildChatTools = (ctx: ToolContext, scenario: AgentScenario): AgentCallableTool[] => {
  const reads = scenario.readToolNames.map((name): AgentCallableTool => {
    const registered = toolRegistry.get(name);
    if (registered === undefined) throw new Error(`chat 白名单引用未注册 tool: ${name}`);
    return {
      name,
      description: registered.description,
      inputSchema: registered.inputSchema,
      execute: async (input) => {
        const result = await registered.execute(input, ctx);
        return {
          ok: result.ok,
          output: result.ok ? result.data : { error: result.error },
        };
      },
    };
  });

  const drafts = Object.entries(scenario.draftToolKinds).map(([name, kind]): AgentCallableTool => {
    const registered = toolRegistry.get(name);
    if (registered === undefined) throw new Error(`chat 草案白名单引用未注册 tool: ${name}`);
    const draftNote =
      kind === 'advice'
        ? '这里只生成待确认草案，不会执行分析。'
        : '这里只生成待确认草案，不会执行写入。';
    return {
      name,
      description: `${registered.description}。${draftNote}`,
      inputSchema: registered.inputSchema,
      execute: async (input) => {
        const parsed = registered.inputSchema.safeParse(input);
        if (!parsed.success) {
          return {
            ok: false,
            output: {
              error: {
                kind: 'invalid_input',
                message: `${name} 草案校验失败`,
                issues: parsed.error.issues,
              },
            },
          };
        }
        return {
          ok: true,
          output: {
            __luoomeDraft: true,
            draft: {
              kind,
              tool: name,
              input: parsed.data,
              summary: registered.description,
              display: summarizeDraft({
                tool: name,
                kind,
                input,
                parsed: parsed.data as Record<string, unknown>,
                description: registered.description,
              }),
            },
          },
        };
      },
    };
  });

  return [...reads, ...drafts];
};

const buildInstructions = (context: ChatContextSummary, scenario: AgentScenario): string =>
  [
    BASE_INSTRUCTIONS,
    scenario.instructionOverlay,
    // chat 入口特有规则：草案处理记录前缀语义与聊天气泡纯文本约束
    '历史消息中以「[草案处理记录]」开头的是用户在确认面板中的真实处理结果（ok 表示写入已执行，fail 表示已取消或执行失败）；已处理的草案不要再次提议。',
    '输出适合聊天气泡的纯文本，不使用 Markdown 表格、标题符号或加粗标记。',
    `当前本地上下文：${JSON.stringify(context)}`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');

const invalidRequest = (message: string, issues: unknown[] = []): Response =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { kind: 'invalid_input', message, issues },
    }),
    {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );

export const createChatStreamResponse = async (
  body: unknown,
  ctx: ToolContext,
  runtime: ChatStreamRuntime,
  abortSignal?: AbortSignal,
): Promise<Response> => {
  const parsed = ChatStreamRequestSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest('chat 请求校验失败', parsed.error.issues);
  }
  const messages = parsed.data.messages.slice(-MAX_MESSAGES);
  if (messages.at(-1)?.role !== 'user') {
    return invalidRequest('最后一条消息必须来自 user');
  }
  const lastUser = messages.at(-1);
  if (lastUser === undefined) return invalidRequest('缺少 user 消息');
  const context = await buildContextSummary(ctx);
  const lastUserText = lastUser.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const route = routeAgentMessage(lastUserText, {
    accountName: context.account?.name ?? null,
    watchlistNames: context.watchlists.map((item) => item.name),
    strategyNames: context.strategies.map((item) => item.name),
    alertPlanNames: context.alertPlans.map((item) => item.name),
    holdingStockIds: context.holdingStockIds,
  });
  if (route.missingIdentifiers.length > 0) {
    return invalidRequest(
      `缺少必要标识：${route.missingIdentifiers.join('、')}，请补充股票代码或名称后再问`,
    );
  }
  const scenario = AGENT_SCENARIOS[route.scenario];
  const appendTool = toolRegistry.get('append_chat_message');
  const getTool = toolRegistry.get('get_chat_session');
  if (appendTool === undefined || getTool === undefined) {
    throw new Error('chat session tools 未注册');
  }
  const appended = await appendTool.execute(
    {
      sessionId: parsed.data.sessionId,
      messageId: lastUser.id,
      role: 'user',
      parts: lastUser.parts,
    },
    ctx,
  );
  if (!appended.ok) {
    return new Response(JSON.stringify(appended), {
      status: appended.error.kind === 'not_found' ? 404 : 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const loaded = await getTool.execute(
    { sessionId: parsed.data.sessionId, messageLimit: MAX_MESSAGES },
    ctx,
  );
  if (!loaded.ok) {
    return new Response(JSON.stringify(loaded), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const loadedMessages = z
    .object({ messages: z.array(ChatMessageSchema) })
    .parse(loaded.data).messages;
  const uiMessages = loadedMessages
    .map((message) => {
      const text = message.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('');
      return {
        id: message.id,
        role: message.role,
        parts: [{ type: 'text' as const, text }],
      };
    })
    .filter((message) => (message.parts[0]?.text.trim().length ?? 0) > 0);
  const response = await runtime.createUIMessageStreamResponse({
    instructions: buildInstructions(context, scenario),
    uiMessages,
    tools: buildChatTools(ctx, scenario),
    ...(abortSignal === undefined ? {} : { abortSignal }),
    onFinish: async (message) => {
      // AI SDK 在 abort 时仍回调 onFinish（isAborted=true，parts 为已收到的部分）：
      // 按实际 parts 落库并追加 cancelled 标记 part，不伪造完整回答。
      // 注意：实测 Bun 下客户端断开时响应流被先行 cancel，onFinish 不会回调；
      // 该场景由前端在 abort 后通过 append_chat_message 兜底落库（同 messageId upsert，幂等）。
      const parts = message.cancelled
        ? [...message.parts, { type: 'data-luoome-cancelled', data: { cancelled: true } }]
        : message.parts;
      const result = await appendTool.execute(
        {
          sessionId: parsed.data.sessionId,
          ...(message.id.trim().length === 0 ? {} : { messageId: message.id }),
          role: 'assistant',
          parts,
        },
        ctx,
      );
      if (!result.ok) {
        ctx.logger.warn('[chat] assistant message 持久化失败', {
          sessionId: parsed.data.sessionId,
          errorKind: result.error.kind,
          error:
            result.error.kind === 'invalid_input'
              ? result.error.message
              : result.error.kind === 'internal'
                ? result.error.cause
                : undefined,
          messageIdLength: message.id.length,
          partTypes: parts.map((part) => part.type),
        });
      }
    },
  });
  response.headers.set('x-luoome-chat-session-id', parsed.data.sessionId);
  // header 只能是 ASCII：路由 JSON 含中文维度名，URL-encode 后由前端 decodeURIComponent 还原。
  response.headers.set(
    'x-luoome-chat-route',
    encodeURIComponent(
      JSON.stringify({
        scenario: route.scenario,
        subjects: route.subjects,
        needsAdvice: route.needsAdvice,
        involvesWrite: route.involvesWrite,
        plannedDimensions: scenario.plannedDimensions,
      }),
    ),
  );
  return response;
};
