import { createHash, randomUUID } from 'node:crypto';
import {
  type AnalysisContext,
  AnalysisContextSchema,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  dateInShanghai,
  isPublishableOperationalRun,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import { collectStrategyInsightFacts } from '../tools/strategy-insight.js';

export const canonicalAnalysisJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalAnalysisJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalAnalysisJson(item)}`)
    .join(',')}}`;
};
export const analysisHash = (value: unknown): string =>
  createHash('sha256').update(canonicalAnalysisJson(value)).digest('hex');
export const AnalysisContextRequest = z.object({
  kind: AnalysisKindSchema,
  subject: AnalysisSubjectSchema,
  accountId: z.string().min(1).optional(),
  options: z.record(z.string(), z.json()).default({}),
});

export const assembleAnalysisContext = async (
  input: z.infer<typeof AnalysisContextRequest>,
  ctx: ToolContext,
): Promise<AnalysisContext | null> => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  if (!(await ctx.repos.account.findById(accountId))) return null;
  const now = ctx.clock();
  const facts: AnalysisContext['facts'] = [];
  const limitations: string[] = [];
  const times: number[] = [];
  let stockId: string | undefined;
  if (input.subject.kind === 'stock') stockId = input.subject.id;
  if (input.subject.kind === 'position') {
    const holding = await ctx.repos.holding.findById(input.subject.id);
    if (!holding || holding.accountId !== accountId) return null;
    stockId = holding.stockId;
    facts.push({
      id: `position:${holding.id}`,
      label: '当前持仓',
      value: {
        stockId: holding.stockId,
        quantity: holding.quantity,
        availableQuantity: holding.availableQuantity,
        avgCost: holding.avgCost,
        closedAt: holding.closedAt?.toISOString() ?? null,
      },
      evidenceIds: [],
    });
  }
  if (stockId) {
    const quote = await ctx.repos.quote.latestByStock(stockId);
    if (quote) {
      facts.push({
        id: `quote:${stockId}`,
        label: '已保存行情',
        value: JSON.parse(JSON.stringify(quote)),
        evidenceIds: [],
      });
      times.push(quote.ts.getTime());
    } else limitations.push('缺少已保存行情；请先显式刷新行情，当前事实包不能写回建议。');
  }
  if (input.subject.kind === 'strategy') {
    const strategy = await ctx.repos.strategy.findById(input.subject.id);
    if (!strategy) return null;
    facts.push({
      id: `strategy:${strategy.id}`,
      label: '策略定义',
      value: JSON.parse(JSON.stringify(strategy)),
      evidenceIds: [],
    });
  }
  if (input.subject.kind === 'strategy') {
    const insight = await collectStrategyInsightFacts(input.subject.id, 30, ctx);
    if (insight) {
      for (const fact of insight.facts) facts.push({ ...fact });
      if (insight.dataAsOf) times.push(insight.dataAsOf.getTime());
      if (insight.observationAsOf) times.push(insight.observationAsOf.getTime());
    }
    if (input.kind === 'strategy_insight_narrative' && typeof input.options.actionId === 'string') {
      const action = await ctx.repos.strategyAutonomyAction.findById(input.options.actionId);
      if (!action || action.strategyId !== input.subject.id) return null;
      facts.push({
        id: `action:${action.id}`,
        label: '叙述目标版本',
        value: { id: action.id, updatedAt: action.updatedAt.toISOString() },
        evidenceIds: [],
      });
    }
  }
  if (input.kind === 'research_directions') {
    for (const strategy of await ctx.repos.strategy.list({ status: 'active' })) {
      const run = await ctx.repos.strategyRun.findLatestPublishedRun(strategy.id);
      if (
        !run ||
        !isPublishableOperationalRun(run) ||
        run.strategyVersionId !== strategy.currentVersionId
      )
        continue;
      const evidence = {
        id: `run:${run.id}:coverage`,
        strategyId: strategy.id,
        strategyVersionId: run.strategyVersionId,
        runId: run.id,
        dataAsOf: run.dataAsOf.toISOString(),
        kind: 'coverage',
        text: JSON.stringify({ coverage: run.coverage, summary: run.summary }),
      };
      facts.push({
        id: evidence.id,
        label: '已发布策略运行事实',
        value: evidence,
        evidenceIds: [],
      });
      times.push(run.dataAsOf.getTime());
    }
  }
  limitations.push(
    '仅使用已持久化事实，未刷新外部数据；不包含实时盘口、完整财报或未经核验的模型结论。',
  );
  if (times.length === 0) limitations.push('缺少可验证的数据截止时点，不具备生成投资建议的条件。');
  const dataAsOf = new Date(times.length ? Math.min(...times) : 0);
  const close = new Date(`${dateInShanghai(now)}T15:00:00+08:00`);
  const writeUntil = new Date(Math.min(now.getTime() + 30 * 60000, close.getTime()));
  return AnalysisContextSchema.parse({
    id: randomUUID(),
    jobId: null,
    kind: input.kind,
    accountId,
    subject: input.subject,
    dataAsOf,
    facts,
    factIds: facts.map((fact) => fact.id),
    limitations,
    contextHash: analysisHash({ facts, dataAsOf }),
    writeUntil,
    expiresAt: new Date(now.getTime() + 180 * 86400000),
    createdAt: now,
  });
};

export const getAnalysisContextTool = defineTool({
  name: 'get_analysis_context',
  description: '装配并保存确定性分析事实，或按 ID 读取审计快照；不调用模型。',
  sideEffect: 'read',
  input: AnalysisContextRequest.partial({ kind: true, subject: true })
    .extend({
      contextId: z.string().min(1).optional(),
    })
    .superRefine((input, ctx) => {
      if (
        input.contextId
          ? input.kind !== undefined || input.subject !== undefined
          : !input.kind || !input.subject
      ) {
        ctx.addIssue({ code: 'custom', message: 'Provide contextId or both kind and subject' });
      }
    }),
  output: AnalysisContextSchema,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (input.contextId !== undefined)
      return (
        (await ctx.repos.analysis.findContext(accountId, input.contextId)) ??
        errNotFound('AnalysisContext', input.contextId)
      );
    const request = AnalysisContextRequest.parse(input);
    const context = await assembleAnalysisContext(request, ctx);
    if (!context) return errNotFound('AnalysisSubject', request.subject.id);
    await ctx.repos.analysis.saveContext(context);
    return context;
  },
});
