import { createHash } from 'node:crypto';
import type { ChatMessage, ToolContext, ToolResult } from '@luoome/core';
import {
  type DraftDisplay,
  type SummarizeDraftArgs,
  summarizeDraft,
  toolRegistry,
} from '@luoome/tools';
import { z } from 'zod';
import { appServiceTool } from './http/app-service.js';

export const DiscussionSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('holding'), id: z.string().min(1), version: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('trading-plan-version'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('advice'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('watch-trigger'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('report'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stock'), id: z.string().min(1) }).strict(),
]);
export type DiscussionSubject = z.infer<typeof DiscussionSubjectSchema>;

export const holdingDiscussionVersion = (holding: unknown): string =>
  createHash('sha256').update(JSON.stringify(holding)).digest('hex').slice(0, 24);

export const workspaceRead = async (
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult<Record<string, unknown>>> => {
  const tool = toolRegistry.get(name) ?? appServiceTool(name);
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
    } else {
      return missingSubject(ref.id);
    }
  }
  return { ok: true, data: subjects };
};

export const workspaceDraftDisplay = async (
  args: SummarizeDraftArgs,
  _ctx: ToolContext,
): Promise<DraftDisplay> => summarizeDraft(args);
