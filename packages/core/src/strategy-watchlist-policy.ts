import { z } from 'zod';

import { InvariantError } from './error/index.js';

/** Strategy 运行时只接受 canonical JSON；YAML 仅能作为导入/导出载体。 */
export const StrategyDefinitionRuntimeSourceSchema = z.literal('canonical-json');
export type StrategyDefinitionRuntimeSource = z.infer<typeof StrategyDefinitionRuntimeSourceSchema>;

/** 零 selection rule 的受信来源。普通用户 Strategy 不在此集合中。 */
export const EmptySelectionTrustedOriginSchema = z.enum(['builtin', 'migration']);
export type EmptySelectionTrustedOrigin = z.infer<typeof EmptySelectionTrustedOriginSchema>;

export const assertStrategySelectionPolicy = (input: {
  readonly origin: 'builtin' | 'migration' | 'user';
  readonly selectionRuleCount: number;
}): void => {
  if (!Number.isInteger(input.selectionRuleCount) || input.selectionRuleCount < 0) {
    throw new InvariantError('selectionRuleCount 必须是非负整数');
  }
  if (input.origin === 'user' && input.selectionRuleCount === 0) {
    throw new InvariantError('普通用户 Strategy 至少需要一条 selection rule');
  }
};

export const AutomaticWatchlistSourceKindSchema = z.enum(['strategy', 'ai', 'portfolio', 'import']);
export type AutomaticWatchlistSourceKind = z.infer<typeof AutomaticWatchlistSourceKindSchema>;

/** archived Member 被新的自动来源重新发现时统一回到 discovered。 */
export const stageAfterAutomaticSourceEntry = (
  currentStage: 'discovered' | 'watching' | 'researching' | 'confirmed' | 'archived',
): 'discovered' | 'watching' | 'researching' | 'confirmed' =>
  currentStage === 'archived' ? 'discovered' : currentStage;

/**
 * 首期 AI 来源只关联现有聊天消息或 tool trace，不建立永久 AgentRun 身份。
 * 至少一个 trace id 必须存在，避免无法审计的 AI source。
 */
export const AiSourceTraceSchema = z
  .object({
    chatMessageId: z.string().min(1).optional(),
    toolTraceId: z.string().min(1).optional(),
  })
  .refine((trace) => trace.chatMessageId !== undefined || trace.toolTraceId !== undefined, {
    message: 'AI source 必须关联 chatMessageId 或 toolTraceId',
  });
export type AiSourceTrace = z.infer<typeof AiSourceTraceSchema>;

/** legacy surface 的固定兼容窗口；写入切换后只转译到目标模型，不双写旧表。 */
export const STRATEGY_WATCHLIST_LEGACY_POLICY = {
  deprecatedRelease: 'N',
  removedByDefaultRelease: 'N+1',
  legacyTablesReadOnlyUntil: 'N+2',
  writeModeAfterSwitch: 'translate-to-target',
} as const;
