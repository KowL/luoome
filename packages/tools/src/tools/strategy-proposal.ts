import { STRATEGY_FIELD_REGISTRY, StrategyDslV1Schema, strategyDefinitionHash } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
import { sanitizeAdviceText } from '../internal/build-advice.js';
import { collectStrategyInsightFacts } from './strategy-insight.js';

/**
 * LLM system prompt 标识：FakeLLMAdapter 据此识别本场景（同 strategy_insight 约定）。
 */
export const STRATEGY_VERSION_PROPOSAL_SYSTEM = 'strategy_version_proposal';

export const GenerateStrategyVersionProposalInput = z.object({
  strategyId: z.string().min(1),
  /** 事实观察窗口，与 get_strategy_insight_facts 默认口径一致。 */
  windowDays: z.number().int().min(7).max(180).default(30),
});

/**
 * AI 提议的结构化输出（DDD §9.2）：definition 必须过 StrategyDslV1Schema，未知字段在
 * validate 阶段拒绝。kind=parameter-tuning 为对基线的调参提议；kind=new-strategy 为
 * 全新策略提议（附 name/description/完整 definition，每周全局限额由 workflow 执行）。
 */
export const StrategyVersionProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('parameter-tuning'),
    definition: StrategyDslV1Schema,
    changeSummary: z.string().min(1).max(500),
    factReferences: z.array(z.string().min(1).max(200)).min(1).max(50),
  }),
  z.object({
    kind: z.literal('new-strategy'),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(1000),
    definition: StrategyDslV1Schema,
    changeSummary: z.string().min(1).max(500),
    factReferences: z.array(z.string().min(1).max(200)).min(1).max(50),
  }),
]);

export const GenerateStrategyVersionProposalOutput = z.discriminatedUnion('proposed', [
  z.object({
    proposed: z.literal(true),
    provider: z.string().min(1),
    proposal: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('parameter-tuning'),
        definition: StrategyDslV1Schema,
        definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        changeSummary: z.string().min(1).max(500),
        factReferences: z.array(z.string().min(1).max(200)).min(1).max(50),
      }),
      z.object({
        kind: z.literal('new-strategy'),
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(1000),
        definition: StrategyDslV1Schema,
        definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        changeSummary: z.string().min(1).max(500),
        factReferences: z.array(z.string().min(1).max(200)).min(1).max(50),
      }),
    ]),
  }),
  z.object({
    proposed: z.literal(false),
    provider: z.string().min(1),
    /** unchanged（与基线一致）由 workflow 跳过；invalid-output（输出不合规）落 failed 动作。 */
    reasonCode: z.enum(['unchanged', 'invalid-output']),
    reason: z.string().min(1),
  }),
]);

const PROPOSAL_RULES =
  '默认基于 data.baseVersion.definition 做调参式修改（kind=parameter-tuning：调整阈值/增删规则），' +
  'definition 必须与基线有实质差异；' +
  '只有当事实证据指向与基线无关的全新机会时才返回 kind=new-strategy（附 name/description/完整 definition）；' +
  'expression 只能使用 data.dslFields 列出的白名单字段路径与比较/逻辑运算符；' +
  'factReferences 只能引用 data.facts 中存在的 fact id；changeSummary 用一句话说明假设与风险，不得给出买卖建议或收益承诺。';

/**
 * workflow-only（M2-S2，docs/ddd/strategy-ai-lifecycle-detailed-design.md §3.2）：
 * 唯一职责是把「基线版本 + 确定性事实 + DSL 白名单」交给 LLM 产出受 schema 约束的
 * 版本提议，不落库、不建 session；持久化与验证由 workflow 经既有 tool 编排。
 * LLM 调用抛错（含未配置）→ adapter_error；输出不合规（重试后仍不过 schema 或
 * 引用未知事实）→ proposed=false + reasonCode=invalid-output，由 workflow 落 failed action。
 */
export const generateStrategyVersionProposalTool = defineTool({
  name: 'generate_strategy_version_proposal',
  description: '基于实验事实由 AI 生成 StrategyVersion 提议（workflow-only，不持久化）',
  sideEffect: 'external',
  input: GenerateStrategyVersionProposalInput,
  output: GenerateStrategyVersionProposalOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (strategy.owner === 'builtin')
      return errInvalidInput('builtin Strategy 不可由 AI 提议新版本');
    const baseVersionId = strategy.currentVersionId;
    if (baseVersionId === undefined) {
      return errInvalidInput('Strategy 缺少 currentVersion 基线版本');
    }
    const baseVersion = await ctx.repos.strategy.findVersionById(baseVersionId);
    if (baseVersion === null) return errNotFound('StrategyVersion', baseVersionId);
    const facts = await collectStrategyInsightFacts(strategy.id, input.windowDays, ctx);
    if (facts === null) return errNotFound('Strategy', strategy.id);
    const allowed = new Set([
      ...facts.facts.map((fact) => fact.id),
      ...facts.facts.flatMap((fact) => fact.evidenceIds),
    ]);
    const data = {
      strategy: { id: strategy.id, name: strategy.name, description: strategy.description },
      baseVersion: {
        id: baseVersion.id,
        version: baseVersion.version,
        definition: baseVersion.definition,
        ...(baseVersion.changeSummary === undefined
          ? {}
          : { changeSummary: baseVersion.changeSummary }),
      },
      dslFields: STRATEGY_FIELD_REGISTRY.map((field) => ({
        path: field.path,
        type: field.type,
        ...(field.unit === undefined ? {} : { unit: field.unit }),
        ...(field.requiredLookback === undefined
          ? {}
          : { requiredLookback: field.requiredLookback }),
      })),
      facts: facts.facts,
      limitations: facts.limitations,
    };

    let lastInvalidReason = 'AI 提议未通过 DSL schema 或事实引用校验';
    let lastThrown: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let generated: unknown;
      try {
        generated = await ctx.adapters.llm.generate<z.infer<typeof StrategyVersionProposalSchema>>({
          system:
            attempt === 0
              ? `${STRATEGY_VERSION_PROPOSAL_SYSTEM}。${PROPOSAL_RULES}`
              : `${STRATEGY_VERSION_PROPOSAL_SYSTEM} 修复重试。严格输出 schema；${PROPOSAL_RULES} 上次失败原因：${lastInvalidReason}`,
          schema: StrategyVersionProposalSchema,
          data,
        });
      } catch (error) {
        lastThrown = error instanceof Error ? error.message : String(error);
        continue;
      }
      const parsed = StrategyVersionProposalSchema.safeParse(generated);
      if (!parsed.success) {
        lastThrown = undefined;
        lastInvalidReason = 'AI 提议未通过 StrategyDslV1Schema 校验';
        continue;
      }
      const unknownRefs = parsed.data.factReferences.filter((ref) => !allowed.has(ref));
      if (unknownRefs.length > 0) {
        lastThrown = undefined;
        lastInvalidReason = `AI 提议引用了不存在的事实: ${unknownRefs.join(', ')}`;
        continue;
      }
      const proposal = parsed.data;
      const definitionHash = strategyDefinitionHash(proposal.definition);
      if (proposal.kind === 'parameter-tuning' && definitionHash === baseVersion.definitionHash) {
        return {
          proposed: false as const,
          provider: ctx.adapters.llm.name,
          reasonCode: 'unchanged' as const,
          reason: 'AI 提议与当前基线版本定义一致，无实质变更',
        };
      }
      // AI 文本落库前过既有 prompt-injection 清理（DDD §6）
      const shared = {
        definition: proposal.definition,
        definitionHash,
        changeSummary: sanitizeAdviceText(proposal.changeSummary),
        factReferences: proposal.factReferences,
      };
      return {
        proposed: true as const,
        provider: ctx.adapters.llm.name,
        proposal:
          proposal.kind === 'new-strategy'
            ? {
                kind: 'new-strategy' as const,
                name: sanitizeAdviceText(proposal.name),
                description: sanitizeAdviceText(proposal.description),
                ...shared,
              }
            : { kind: 'parameter-tuning' as const, ...shared },
      };
    }
    if (lastThrown !== undefined) {
      ctx.logger.warn('generate_strategy_version_proposal: LLM 调用失败', {
        strategyId: input.strategyId,
        error: lastThrown,
      });
      return errAdapterError(ctx.adapters.llm.name, lastThrown, true);
    }
    ctx.logger.warn('generate_strategy_version_proposal: LLM 两次输出均不合规', {
      strategyId: input.strategyId,
      error: lastInvalidReason,
    });
    return {
      proposed: false as const,
      provider: ctx.adapters.llm.name,
      reasonCode: 'invalid-output' as const,
      reason: lastInvalidReason,
    };
  },
});
