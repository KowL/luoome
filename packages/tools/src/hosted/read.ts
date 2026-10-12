import { ReportSchema, reportScopeKey, type WatchTrigger } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';

const PersonalTriggerSchema = z.object({
  id: z.string(),
  alertPlanId: z.string(),
  stockId: z.string(),
  ruleKind: z.enum(['price-level', 'price-change']),
  ruleId: z.string(),
  triggerType: z.enum(['triggered', 'recovered']),
  reason: z.string(),
  evidence: z.array(z.string()),
  quoteClose: z.number().optional(),
  quoteTs: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  deliveryStatus: z.string(),
});

const permittedTrigger = (trigger: WatchTrigger): boolean =>
  (trigger.ruleKind === 'price-level' || trigger.ruleKind === 'price-change') &&
  trigger.direction === 'watch';

const triggerDto = (trigger: WatchTrigger) =>
  PersonalTriggerSchema.parse({
    id: trigger.id,
    alertPlanId: trigger.alertPlanId ?? trigger.poolId,
    stockId: trigger.stockId,
    ruleKind: trigger.ruleKind,
    ruleId: trigger.ruleId,
    triggerType: trigger.triggerType,
    reason: trigger.reason,
    evidence: trigger.evidence,
    ...(trigger.quote === undefined
      ? {}
      : { quoteClose: trigger.quote.close, quoteTs: trigger.quote.ts }),
    createdAt: trigger.createdAt,
    deliveryStatus: trigger.deliveryStatus,
  });

export const listPersonalWatchTriggersTool = defineTool({
  name: 'list_personal_watch_triggers',
  description: '读取本租户已保存的本人价格条件提醒，不要求投资账户',
  sideEffect: 'read',
  input: z
    .object({
      alertPlanId: z.string().min(1).optional(),
      since: z.coerce.date().optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  output: z.object({ triggers: z.array(PersonalTriggerSchema) }),
  handler: async (input, ctx) => {
    const triggers = await ctx.repos.watchTrigger.listRecent({
      ...(input.alertPlanId === undefined ? {} : { poolId: input.alertPlanId }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: 100,
    });
    return { triggers: triggers.filter(permittedTrigger).slice(0, input.limit).map(triggerDto) };
  },
});

export const getPersonalWatchTriggerTool = defineTool({
  name: 'get_personal_watch_trigger',
  description: '读取本人价格条件提醒的事实，排除账户金额与建议',
  sideEffect: 'read',
  input: z.object({ triggerId: z.string().min(1) }).strict(),
  output: z.object({ trigger: PersonalTriggerSchema }),
  handler: async (input, ctx) => {
    const trigger = await ctx.repos.watchTrigger.findById(input.triggerId);
    if (trigger === null || !permittedTrigger(trigger)) {
      return errNotFound('WatchTrigger', input.triggerId);
    }
    return { trigger: triggerDto(trigger) };
  },
});

export const selectHostedAccountTool = defineTool({
  name: 'select_hosted_account',
  description: '验证本租户的投资账户选择，不修改共享运行上下文',
  sideEffect: 'read',
  input: z.object({ accountId: z.string().min(1) }).strict(),
  output: z.object({ accountId: z.string() }),
  handler: async (input, ctx) => {
    const account = await ctx.repos.account.findById(input.accountId);
    return account === null ? errNotFound('Account', input.accountId) : { accountId: account.id };
  },
});

const isFactsReport = (report: z.infer<typeof ReportSchema>): boolean =>
  report.kind === 'watchlist-facts' &&
  report.scope.kind === 'watchlist' &&
  report.sections.every((section) =>
    section.blocks.every(
      (block) =>
        block.kind !== 'list' ||
        block.items.every(
          (item) => item.entityKind !== 'advice' && item.entityKind !== 'trading-plan',
        ),
    ),
  );

export const getHostedFactsReportTool = defineTool({
  name: 'get_hosted_facts_report',
  description: '仅返回本租户持久化的自选事实报告，不隐式刷新数据',
  sideEffect: 'read',
  input: z.object({ id: z.string().min(1) }).strict(),
  output: z.object({ report: ReportSchema }),
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.id);
    if (report === null || !isFactsReport(report)) return errNotFound('Report', input.id);
    return { report };
  },
});

export const listHostedFactsReportsTool = defineTool({
  name: 'list_hosted_facts_reports',
  description: '列出本租户已经保存的自选事实摘要，包含可核对的时间与缺口',
  sideEffect: 'read',
  input: z
    .object({
      watchlistId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  output: z.object({ reports: z.array(ReportSchema) }),
  handler: async (input, ctx) => {
    const reports = await ctx.repos.report.list({
      kind: 'watchlist-facts',
      latestOnly: true,
      ...(input.watchlistId === undefined
        ? {}
        : {
            scopeKey: reportScopeKey({ kind: 'watchlist', watchlistId: input.watchlistId }),
          }),
      limit: input.limit,
    });
    return { reports: reports.filter(isFactsReport) };
  },
});
