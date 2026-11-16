import { defineTool, errInvalidInput, errNotFound } from '@luoome/toolkit';
import {
  collectStrategyInsightFacts,
  GetStrategyInsightFactsInput,
  type StrategyInsightFacts,
  StrategyInsightFactsSchema,
} from '@luoome/toolkit/tools/strategy-insight.js';
import { z } from 'zod';
import { createStrategyExplainer } from '../internal/strategy-explainer.js';

export const StrategyInsightNarrativeSchema = z.object({
  headline: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  findings: z
    .array(
      z.object({
        kind: z.enum(['trend', 'risk', 'limitation']),
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(600),
        factRefs: z.array(z.string().min(1)).min(1).max(8),
      }),
    )
    .max(8),
  risks: z.array(z.string().min(1).max(300)).max(8),
  limitations: z.array(z.string().min(1).max(300)).max(8),
  disclaimer: z.string().min(1).max(300),
});

export const GenerateStrategyInsightInput = GetStrategyInsightFactsInput.safeExtend({
  runId: z.string().min(1).optional(),
});
export const GenerateStrategyInsightOutput = z.object({
  facts: StrategyInsightFactsSchema,
  insight: StrategyInsightNarrativeSchema,
  provider: z.string().min(1),
  degradation: z
    .object({
      reason: z.enum([
        'plugin_disabled',
        'dependency_not_ready',
        'activation_revoked',
        'provider_failed',
      ]),
    })
    .optional(),
});

const factsOnlyNarrative = (
  facts: StrategyInsightFacts,
): z.infer<typeof StrategyInsightNarrativeSchema> => {
  const primary = facts.facts[0] ?? {
    id: 'runs:window',
    label: '运行事实',
    value: `${facts.runs.total} 次运行`,
    evidenceIds: [],
  };
  return {
    headline: `${facts.strategy.name} 事实摘要`,
    summary: `${facts.window.from.toISOString()} 至 ${facts.window.to.toISOString()} 共 ${facts.runs.total} 次 ${facts.scope} 运行，当前选择 ${facts.currentSelection.selectedCount} 只。`,
    findings: [
      {
        kind: 'trend',
        title: primary.label,
        detail: primary.value,
        factRefs: [primary.id],
      },
    ],
    risks: facts.limitations.slice(0, 8),
    limitations: facts.limitations.slice(0, 8),
    disclaimer: '这是基于已记录事实的降级摘要，不构成投资建议，也不替代人工复核。',
  };
};

export const generateStrategyInsightTool = defineTool({
  name: 'generate_strategy_insight',
  description: '仅基于确定性事实生成 Strategy 解释性洞察；不得生成交易建议或虚构引用',
  sideEffect: 'external',
  input: GenerateStrategyInsightInput,
  output: GenerateStrategyInsightOutput,
  handler: async (input, ctx) => {
    if (ctx.executionPolicy === undefined)
      return {
        ok: false as const,
        error: { kind: 'permission_denied' as const, required: 'execution-policy' },
      };
    const explainer = createStrategyExplainer(ctx);
    const facts = await collectStrategyInsightFacts(input.strategyId, input.windowDays, ctx, {
      scope: input.scope,
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.evaluationSessionId === undefined
        ? {}
        : { evaluationSessionId: input.evaluationSessionId }),
    });
    if (facts === null) return errNotFound('Strategy', input.strategyId);
    if (input.runId !== undefined && input.runId !== facts.currentSelection.runId)
      return errInvalidInput('洞察运行身份与当前已发布结果不一致');
    const allowed = new Set(facts.facts.map((fact) => fact.id));
    let lastError = 'AI 洞察生成失败';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await explainer.generate<z.infer<typeof StrategyInsightNarrativeSchema>>({
          system:
            attempt === 0
              ? 'strategy_insight。只能解释 data.facts 中的事实；每条 finding 必须引用存在的 fact id。不得给出买卖建议、收益承诺、概率预测或把事实观察称为回测。必须保留缺失数据与小样本限制。'
              : 'strategy_insight 修复重试。严格输出 schema，所有 factRefs 必须来自 data.facts 的 id；不得补写事实、建议、概率或收益承诺。',
          schema: StrategyInsightNarrativeSchema,
          data: {
            strategy: facts.strategy,
            window: facts.window,
            facts: facts.facts,
            limitations: facts.limitations,
            ...(attempt === 0 ? {} : { repair: lastError }),
          },
        });
        if (!generated.ok)
          return {
            facts,
            insight: factsOnlyNarrative(facts),
            provider: 'facts-only',
            degradation: { reason: generated.reason },
          };
        const parsed = StrategyInsightNarrativeSchema.safeParse(generated.value);
        if (
          parsed.success &&
          parsed.data.findings.every((finding) => finding.factRefs.every((ref) => allowed.has(ref)))
        ) {
          return { facts, insight: parsed.data, provider: ctx.adapters.llm.name };
        }
        lastError = 'AI 洞察结构无效或引用了不存在的事实';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    ctx.logger.warn('generate_strategy_insight: LLM 两次尝试均失败，降级 facts-only', {
      strategyId: input.strategyId,
      error: lastError,
    });
    return {
      facts,
      insight: factsOnlyNarrative(facts),
      provider: 'facts-only',
      degradation: { reason: 'provider_failed' as const },
    };
  },
});
