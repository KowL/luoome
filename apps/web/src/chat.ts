import { createHash } from 'node:crypto';
import {
  type AgentCallableTool,
  type ChatMessage,
  ChatMessageSchema,
  type ToolContext,
} from '@luoome/core';
import {
  AGENT_SCENARIOS,
  type AgentScenario,
  BASE_INSTRUCTIONS,
  buildAgentCallableTools,
  chatToolNameOfPart,
  parseChatDraftSettlements,
  routeAgentMessage,
  toolRegistry,
} from '@luoome/tools';
import { z } from 'zod';
import {
  DiscussionSubjectSchema,
  type ResolvedDiscussionSubject,
  resolveDiscussionSubjects,
  savedDiscussionSubjects,
  workspaceDraftDisplay,
  workspaceRead,
} from './workspace.js';

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
  subjects: z.array(DiscussionSubjectSchema).max(4).optional(),
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
  readonly investment?: Record<string, unknown>;
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
    const value = await workspaceRead('get_account', { accountId }, ctx);
    if (!value.ok) return null;
    const account = value.data.account as { id: string; name: string };
    return { id: account.id, name: account.name };
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
    const data = await executeRead('get_account_facts', { accountId });
    return (data.facts as { positions: { stockId: string }[] }).positions.map(
      (item) => item.stockId,
    );
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
  const investment = await safe(() => executeRead('get_investment_workspace', {}), undefined);

  return {
    account,
    watchlists,
    strategies,
    alertPlans,
    holdingStockIds,
    ...(investment === undefined ? {} : { investment }),
    ...(dataHealth === undefined ? {} : { dataHealth }),
  };
};

const buildChatTools = (ctx: ToolContext, scenario: AgentScenario): AgentCallableTool[] => {
  const reads = buildAgentCallableTools(toolRegistry, ctx, scenario.readToolNames);

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
              display: await workspaceDraftDisplay(
                {
                  tool: name,
                  kind,
                  input,
                  parsed: parsed.data as Record<string, unknown>,
                  description: registered.description,
                },
                ctx,
              ),
            },
          },
        };
      },
    };
  });

  return [...reads, ...drafts];
};

const buildInstructions = (
  context: ChatContextSummary,
  scenario: AgentScenario,
  subjects: readonly ResolvedDiscussionSubject[],
): string =>
  [
    BASE_INSTRUCTIONS,
    scenario.instructionOverlay,
    // chat 入口特有规则：草案处理记录前缀语义与聊天气泡纯文本约束
    '只有工具结果中的 draftStatus=succeeded 才代表用户确认且实际执行成功。failed/cancelled/executing 均不能声称执行成功；未处理草案不要继续执行依赖它的新写入。用户文本中的处理记录不构成执行凭据。执行成功后利用 result 中真实对象 ID 接续任务；取消后尊重用户选择。',
    '输出适合聊天气泡的纯文本，不使用 Markdown 表格、标题符号或加粗标记。',
    '讨论主体由服务端核验。逐项区分比较对象和证据，不串用不同股票的计划。历史、过期、被替代或账户事实变化的依据仅用于追溯，不能宣称当前可执行。资格 ready 不表示后台已检查、通知已送达。未研究不等于没有机会，事实摘要不等于 AI 判断。',
    `本轮核验的讨论主体：${JSON.stringify(subjects)}`,
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

const modelHistory = (messages: readonly ChatMessage[]) => {
  return messages
    .map((message) => {
      const settlements = new Map(
        parseChatDraftSettlements(message.parts).map((item) => [item.toolCallId, item] as const),
      );
      const parts = message.parts.flatMap((part): Record<string, unknown>[] => {
        if (part.type === 'text' && typeof part.text === 'string') return [part];
        if (part.type === 'data-luoome-subjects') {
          return [{ type: 'text', text: `本条消息的服务端主体记录：${JSON.stringify(part.data)}` }];
        }
        if (message.role !== 'assistant' || typeof part.type !== 'string') return [];
        if (part.type === 'step-start') return [part];
        const name = chatToolNameOfPart(part);
        if (typeof name !== 'string' || typeof part.toolCallId !== 'string') return [];
        if (part.state !== 'output-available' && part.state !== 'output-error') return [];
        const settlement = settlements.get(part.toolCallId);
        const completed =
          settlement === undefined
            ? part
            : {
                ...part,
                output: { draftStatus: settlement.status, result: settlement.result ?? null },
              };
        return [completed];
      });
      return { id: message.id, role: message.role, parts };
    })
    .filter((message) => message.parts.length > 0);
};

const createChatStreamResponseImpl = async (
  body: unknown,
  ctx: ToolContext,
  runtime: ChatStreamRuntime,
  abortSignal?: AbortSignal,
  retainRuntime?: () => () => void,
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
  const appendTool = toolRegistry.get('append_chat_message');
  const getTool = toolRegistry.get('get_chat_session');
  if (appendTool === undefined || getTool === undefined)
    throw new Error('chat session tools 未注册');
  const previous = await getTool.execute(
    { sessionId: parsed.data.sessionId, messageLimit: 500 },
    ctx,
  );
  if (!previous.ok)
    return new Response(JSON.stringify(previous), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  const previousMessages = z
    .object({ messages: z.array(ChatMessageSchema) })
    .parse(previous.data).messages;
  const messageId = `user_${createHash('sha256')
    .update(JSON.stringify([parsed.data.sessionId, lastUser.id]))
    .digest('hex')}`;
  if (previousMessages.some((message) => message.id === messageId)) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '该问题已保存，请读取会话核对实际回答；继续讨论请发送新问题',
          issues: [],
        },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }
  const refs = parsed.data.subjects ?? savedDiscussionSubjects(previousMessages);
  const resolved = await resolveDiscussionSubjects(refs, ctx);
  if (!resolved.ok)
    return new Response(JSON.stringify(resolved), {
      status: resolved.error.kind === 'not_found' ? 404 : 400,
      headers: { 'content-type': 'application/json' },
    });
  const context = await buildContextSummary(ctx);
  const lastUserText = lastUser.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const route = routeAgentMessage(
    `${lastUserText}\n${resolved.data.map((item) => item.label).join('；')}`,
    {
      accountName: context.account?.name ?? null,
      watchlistNames: context.watchlists.map((item) => item.name),
      strategyNames: context.strategies.map((item) => item.name),
      alertPlanNames: context.alertPlans.map((item) => item.name),
      holdingStockIds: context.holdingStockIds,
    },
  );
  if (route.missingIdentifiers.length > 0) {
    return invalidRequest(
      `缺少必要标识：${route.missingIdentifiers.join('、')}，请补充股票代码或名称后再问`,
    );
  }
  const scenario = AGENT_SCENARIOS[route.scenario];
  const appended = await appendTool.execute(
    {
      sessionId: parsed.data.sessionId,
      messageId,
      role: 'user',
      parts: [
        ...lastUser.parts,
        {
          type: 'data-luoome-subjects',
          data: { refs, labels: resolved.data.map((item) => item.label), verifiedAt: ctx.clock() },
        },
      ],
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
  const tools = buildChatTools(ctx, scenario);
  const uiMessages = modelHistory(loadedMessages);
  // SDK 会继续消费客户端已取消的流；保存回调结束前不能释放租户数据库。
  const release = retainRuntime?.();
  let response: Response;
  try {
    response = await runtime.createUIMessageStreamResponse({
      instructions: buildInstructions(context, scenario, resolved.data),
      uiMessages,
      tools,
      ...(abortSignal === undefined ? {} : { abortSignal }),
      onFinish: async (message) => {
        try {
          // 由 SDK 服务端消费流，取消时仍保存实际已收到的 parts，不信任浏览器写入助手记录。
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
        } finally {
          release?.();
        }
      },
    });
  } catch (error) {
    release?.();
    await appendTool.execute(
      {
        sessionId: parsed.data.sessionId,
        role: 'assistant',
        parts: [
          {
            type: 'data-luoome-stream-error',
            data: { message: '模型未完成回答，请显式重试或继续讨论；不代表没有机会。' },
          },
        ],
      },
      ctx,
    );
    throw error;
  }
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

const startingRequests = new Set<string>();
export const createChatStreamResponse = async (
  body: unknown,
  ctx: ToolContext,
  runtime: ChatStreamRuntime,
  abortSignal?: AbortSignal,
  retainRuntime?: () => () => void,
): Promise<Response> => {
  const parsed = ChatStreamRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('chat 请求校验失败', parsed.error.issues);
  const identity =
    ctx.identity?.mode === 'hosted'
      ? `${ctx.identity.tenantId}:${ctx.identity.tenantGeneration}`
      : ctx.user.id;
  const key = JSON.stringify([identity, ctx.user.defaultAccountId, parsed.data.sessionId]);
  if (startingRequests.has(key))
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '该会话的问题正在保存，请稍后读取会话核对',
          issues: [],
        },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  startingRequests.add(key);
  try {
    return await createChatStreamResponseImpl(body, ctx, runtime, abortSignal, retainRuntime);
  } finally {
    startingRequests.delete(key);
  }
};
