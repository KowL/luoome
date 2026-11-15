import type { LLMGenerateRequest, PluginBlockReason, ToolContext } from '@luoome/core';

export const createStrategyExplainer = (ctx: ToolContext) => {
  const admission = ctx.executionPolicy?.acquire('strategy.ai-insight') ?? {
    ok: false as const,
    reason: 'dependency_not_ready' as const,
  };
  const blocked = (): PluginBlockReason | undefined => {
    if (!admission.ok) return admission.reason;
    if (!ctx.executionPolicy?.valid(admission.permit)) return 'activation_revoked';
    if (ctx.adapters.llm.configurationReady === false) return 'dependency_not_ready';
    return undefined;
  };
  return {
    async generate<T>(
      request: LLMGenerateRequest,
    ): Promise<
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly reason: PluginBlockReason }
    > {
      const reason = blocked();
      if (reason !== undefined) return { ok: false, reason };
      let value: T;
      try {
        value = await ctx.adapters.llm.generate<T>(request);
      } catch (error) {
        const revoked = blocked();
        if (revoked !== undefined) return { ok: false, reason: revoked };
        throw error;
      }
      const revoked = blocked();
      return revoked === undefined ? { ok: true, value } : { ok: false, reason: revoked };
    },
  };
};
