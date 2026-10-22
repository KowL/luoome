import { createHash } from 'node:crypto';
import type { ChatMessage, InvestmentResearch, ToolContext, ToolResult } from '@luoome/core';
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

export const DiscussionSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('holding'), id: z.string().min(1), version: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('trading-plan-version'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('advice'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('watch-trigger'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('report'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stock'), id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('investment-direction'),
      id: z.string().min(1),
      researchId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('investment-consensus'),
      id: z.string().min(1),
      version: z.number().int().positive(),
    })
    .strict(),
]);
export type DiscussionSubject = z.infer<typeof DiscussionSubjectSchema>;

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

const invalidSubject = (message: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message, issues: [] },
});
const missingSubject = (id: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity: 'DiscussionSubject', id },
});

export interface ResolvedDiscussionSubject {
  readonly ref: DiscussionSubject;
  readonly label: string;
  readonly snapshot: Record<string, unknown>;
}

export const savedDiscussionSubjects = (messages: readonly ChatMessage[]): DiscussionSubject[] => {
  for (const message of [...messages].reverse()) {
    for (const part of message.parts) {
      if (part.type !== 'data-luoome-subjects') continue;
      const parsed = z
        .object({ refs: z.array(DiscussionSubjectSchema).max(4) })
        .safeParse(part.data);
      if (parsed.success) return parsed.data.refs;
    }
  }
  return [];
};

export const resolveDiscussionSubjects = async (
  refs: readonly DiscussionSubject[],
  ctx: ToolContext,
): Promise<ToolResult<ResolvedDiscussionSubject[]>> => {
  const accountId = ctx.user.defaultAccountId;
  const subjects: ResolvedDiscussionSubject[] = [];
  for (const ref of refs) {
    if (ref.kind === 'holding') {
      const result = await workspaceRead('list_holdings', { accountId }, ctx);
      if (!result.ok) return result;
      const items = result.data.holdings as {
        holding: Record<string, unknown>;
        stockName: string;
      }[];
      const item = items.find((value) => value.holding.id === ref.id);
      if (item === undefined || item.holding.accountId !== accountId) return missingSubject(ref.id);
      if (holdingDiscussionVersion(item.holding) !== ref.version)
        return invalidSubject('持仓已变化，请刷新卡片后继续讨论');
      const facts = await workspaceRead('get_account_facts', { accountId }, ctx);
      subjects.push({
        ref,
        label: `${item.stockName} · ${String(item.holding.stockId)}`,
        snapshot: { holding: item.holding, accountFacts: facts, readAt: ctx.clock() },
      });
    } else if (
      ref.kind === 'trading-plan-version' ||
      ref.kind === 'advice' ||
      ref.kind === 'watch-trigger'
    ) {
      const result = await workspaceRead(
        'get_decision_review_context',
        { accountId, subject: ref },
        ctx,
      );
      if (!result.ok) return result;
      const plan =
        ref.kind === 'trading-plan-version'
          ? await workspaceRead('get_trading_plan', { versionId: ref.id }, ctx)
          : null;
      if (plan !== null && !plan.ok) return plan;
      const latest =
        result.data.stockId === null
          ? null
          : await workspaceRead(
              'list_trading_plans',
              {
                accountId,
                stockId: result.data.stockId,
                currentOnly: true,
                includeMonitoring: true,
                limit: 20,
              },
              ctx,
            );
      subjects.push({
        ref,
        label: `${ref.kind === 'trading-plan-version' ? '计划版本' : ref.kind === 'advice' ? '建议' : '提醒'} · ${String(result.data.stockId ?? ref.id)}`,
        snapshot: {
          ...result.data,
          exactPlan: plan,
          latestPlans: latest,
          readAt: ctx.clock(),
          limitation:
            '触发快照与当前计划分别核验；历史或过期依据不可沿用为当前行动授权。资格不代表后台已检查或通知已送达。',
        },
      });
    } else if (ref.kind === 'report') {
      const result = await workspaceRead('get_report', { id: ref.id }, ctx);
      if (!result.ok) return result;
      const report = result.data.report as {
        scope: { kind: string; accountId?: string };
        title: string;
      };
      if (report.scope.kind !== 'account' || report.scope.accountId !== accountId)
        return missingSubject(ref.id);
      subjects.push({ ref, label: report.title, snapshot: result.data });
    } else if (ref.kind === 'investment-direction' || ref.kind === 'investment-consensus') {
      const result = await workspaceRead(
        'get_investment_workspace',
        {
          ...(ref.kind === 'investment-direction' ? { researchId: ref.researchId } : {}),
          historyLimit: 50,
        },
        ctx,
      );
      if (!result.ok) return result;
      if (ref.kind === 'investment-direction') {
        const research = result.data.research as {
          id: string;
          directions: { id: string; name: string }[];
          evidence: unknown[];
          limitations: string[];
          disclaimers: string[];
        } | null;
        const direction = research?.directions.find((item) => item.id === ref.id);
        if (direction === undefined || research === null) return missingSubject(ref.id);
        subjects.push({
          ref,
          label: direction.name,
          snapshot: {
            direction,
            evidence: research.evidence,
            limitations: research.limitations,
            disclaimers: research.disclaimers,
            readAt: ctx.clock(),
            currentWorkspace: result.data,
          },
        });
      } else {
        const consensus = (result.data.history as { id: string; version: number }[]).find(
          (item) => item.id === ref.id && item.version === ref.version,
        );
        if (consensus === undefined) return missingSubject(ref.id);
        subjects.push({
          ref,
          label: `参与共识 v${consensus.version}`,
          snapshot: { selected: consensus, currentWorkspace: result.data, readAt: ctx.clock() },
        });
      }
    } else {
      const result = await workspaceRead('search_stocks', { query: ref.id, limit: 20 }, ctx);
      if (!result.ok) return result;
      const stock = (result.data.stocks as { id: string; name: string }[]).find(
        (item) => item.id === ref.id,
      );
      if (stock === undefined) return missingSubject(ref.id);
      subjects.push({
        ref,
        label: `${stock.name} · ${stock.id}`,
        snapshot: { stock, limitation: '股票身份不构成行情或研究结论；需要工具补充可用证据。' },
      });
    }
  }
  return { ok: true, data: subjects };
};

export const workspaceSnapshot = async (ctx: ToolContext) => {
  const accountId = ctx.user.defaultAccountId;
  const [account, holdings, facts, plans, watch, reports, investment, candidates, planChecks] =
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
      workspaceRead(
        'list_workflow_runs',
        { workflowName: 'hosted-alerts', includeWatch: false, limit: 1 },
        ctx,
      ),
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
      planChecks,
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
  if (!request.success) return invalidSubject('请核对讨论、操作范围和具体要求后重试');
  const { sessionId, tool, userText } = request.data;
  const session = await workspaceRead('get_chat_session', { sessionId, messageLimit: 1 }, ctx);
  if (!session.ok) return session;
  const registered = toolRegistry.get(tool);
  if (registered === undefined) return missingSubject(tool);
  const userMessageId = `workspace-user-${crypto.randomUUID()}`;
  const messageId = `workspace-draft-${crypto.randomUUID()}`;
  const source = {
    sessionId,
    messageId: userMessageId,
    ...(tool === 'save_investment_consensus' ? { userText } : {}),
  };
  const raw = { ...request.data.input, ...(tool === 'set_investment_tracking' ? {} : { source }) };
  const parsed = registered.inputSchema.safeParse(raw);
  if (!parsed.success) return invalidSubject('草案字段不完整或无效，请重新核对选择、时间与版本');
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
