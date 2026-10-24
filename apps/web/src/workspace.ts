import { createHash } from 'node:crypto';
import type { InvestmentResearch, ToolContext, ToolResult } from '@luoome/core';
import {
  AGENT_DRAFT_TOOL_KINDS,
  type AgentDraftKind,
  type DraftDisplay,
  type SaveInvestmentConsensusInput,
  type SummarizeDraftArgs,
  summarizeDraft,
  toolRegistry,
} from '@luoome/tools';
import { z } from 'zod';

export const holdingDiscussionVersion = (holding: unknown): string =>
  createHash('sha256').update(JSON.stringify(holding)).digest('hex').slice(0, 24);

export const workspaceRead = async (
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult<Record<string, unknown>>> => {
  const tool = toolRegistry.get(name);
  if (tool === undefined)
    return { ok: false, error: { kind: 'not_found', entity: 'Tool', id: name } };
  return (await tool.execute(input, ctx)) as ToolResult<Record<string, unknown>>;
};

const invalidDraft = (message: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message, issues: [] },
});
const missingTool = (id: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity: 'Tool', id },
});

export const workspaceSnapshot = async (ctx: ToolContext) => {
  const accountId = ctx.user.defaultAccountId;
  const [account, holdings, facts, plans, watch, reports, investment, candidates] =
    await Promise.all([
      workspaceRead('get_account', { accountId }, ctx),
      workspaceRead('list_holdings', { accountId }, ctx),
      workspaceRead('get_account_facts', { accountId }, ctx),
      workspaceRead(
        'list_trading_plans',
        { accountId, currentOnly: true, includeMonitoring: true, limit: 100 },
        ctx,
      ),
      workspaceRead('get_watch_status', {}, ctx),
      workspaceRead('list_reports', { scope: { kind: 'account', accountId }, limit: 1 }, ctx),
      workspaceRead('get_investment_workspace', {}, ctx),
      workspaceRead('get_investment_candidates', { limit: 30 }, ctx),
    ]);
  const holdingSection = holdings.ok
    ? {
        ...holdings,
        data: {
          ...holdings.data,
          holdings: (holdings.data.holdings as { holding: unknown }[]).map((item) => ({
            ...item,
            discussionVersion: holdingDiscussionVersion(item.holding),
          })),
        },
      }
    : holdings;
  return {
    ok: true as const,
    data: {
      readAt: ctx.clock(),
      accountId,
      summaryKind: 'facts',
      account,
      holdings: holdingSection,
      facts,
      plans,
      watch,
      reports,
      investment,
      candidates,
    },
  };
};

const WorkspaceDraftRequest = z
  .object({
    sessionId: z.string().min(1),
    tool: z.enum(['save_investment_consensus', 'set_investment_tracking']),
    userText: z.string().trim().min(1).max(2000),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

export const workspaceDraftDisplay = async (
  args: SummarizeDraftArgs,
  ctx: ToolContext,
): Promise<DraftDisplay> => {
  const display = summarizeDraft(args);
  if (args.tool !== 'save_investment_consensus') return display;
  const input = args.parsed as z.infer<typeof SaveInvestmentConsensusInput>;
  const selections: string[] = [];
  for (const selection of input.changes.selections ?? []) {
    const result = await workspaceRead(
      'get_investment_workspace',
      { researchId: selection.researchId },
      ctx,
    );
    const direction = result.ok
      ? (result.data.research as InvestmentResearch | null)?.directions.find(
          (item) => item.id === selection.directionId,
        )
      : undefined;
    selections.push(
      `${direction?.name ?? '方向已不可核验，请刷新后重新提出草案'} / ${{ primary: '主要方向', observe: '继续观察', avoid: '暂不参与' }[selection.role]} / ${selection.userReason}`,
    );
  }
  const intent = input.changes.recentIntent;
  const intentLabels = {
    balanced: '均衡研究',
    cautious: '近期谨慎',
    'holdings-first': '持仓优先',
    'pause-new-opportunities': '暂停新机会',
  };
  return {
    ...display,
    fields: [
      { name: '基于共识版本', value: input.expectedVersion, source: 'user' },
      {
        name: '方向选择',
        value:
          input.changes.selections === undefined
            ? '保留当前选择'
            : selections.length === 0
              ? '清空方向选择'
              : selections,
        source: 'user',
      },
      {
        name: '近期意愿',
        value:
          intent === undefined
            ? '保持原值'
            : intent === null
              ? '清除临时调整'
              : `${intentLabels[intent.mode]}：${intent.note}；${intent.startsAt.toISOString()} 至 ${intent.reviewAt.toISOString()}`,
        source: 'user',
      },
      { name: '约束', value: input.changes.constraints ?? '保持原值', source: 'user' },
      { name: '修改说明', value: input.changeNote, source: 'user' },
      { name: '复核时间', value: input.reviewAt.toISOString(), source: 'user' },
      { name: '有效至', value: input.validUntil.toISOString(), source: 'user' },
    ],
  };
};

export const createWorkspaceDraft = async (
  body: unknown,
  ctx: ToolContext,
): Promise<ToolResult<{ sessionId: string; messageId: string }>> => {
  const request = WorkspaceDraftRequest.safeParse(body);
  if (!request.success) return invalidDraft('请核对操作范围和具体要求后重试');
  const { sessionId, tool, userText } = request.data;
  const session = await workspaceRead('get_chat_session', { sessionId, messageLimit: 1 }, ctx);
  if (!session.ok) return session;
  const registered = toolRegistry.get(tool);
  if (registered === undefined) return missingTool(tool);
  const userMessageId = `workspace-user-${crypto.randomUUID()}`;
  const messageId = `workspace-draft-${crypto.randomUUID()}`;
  const source = {
    sessionId,
    messageId: userMessageId,
    ...(tool === 'save_investment_consensus' ? { userText } : {}),
  };
  const raw = { ...request.data.input, ...(tool === 'set_investment_tracking' ? {} : { source }) };
  const parsed = registered.inputSchema.safeParse(raw);
  if (!parsed.success) return invalidDraft('草案字段不完整或无效，请重新核对选择、时间与版本');
  const kind = AGENT_DRAFT_TOOL_KINDS[tool] as AgentDraftKind;
  const user = await workspaceRead(
    'append_chat_message',
    {
      sessionId,
      messageId: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: userText }],
    },
    ctx,
  );
  if (!user.ok) return user;
  const appended = await workspaceRead(
    'append_chat_message',
    {
      sessionId,
      messageId,
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: `tool-${tool}`,
          toolCallId: `workspace-call-${crypto.randomUUID()}`,
          state: 'output-available',
          input: parsed.data,
          output: {
            __luoomeDraft: true,
            draft: {
              kind,
              tool,
              input: parsed.data,
              summary: registered.description,
              display: await workspaceDraftDisplay(
                {
                  tool,
                  kind,
                  input: raw,
                  parsed: parsed.data as Record<string, unknown>,
                  description: registered.description,
                },
                ctx,
              ),
            },
          },
        },
      ],
    },
    ctx,
  );
  if (!appended.ok) return appended;
  return { ok: true, data: { sessionId, messageId } };
};
