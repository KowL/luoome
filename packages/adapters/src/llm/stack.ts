import type { AgentRuntimeLike, Logger } from '@luoome/core';
import { AISDKAgentRuntime } from './agent-runtime.js';
import { AISDKAdapter } from './ai-sdk-adapter.js';
import { LLMManager } from './manager.js';
import { loadAIModelCatalog } from './model-catalog.js';
import type { LLMAdapter } from './types.js';

export interface AIStack {
  readonly llm: LLMAdapter;
  readonly agent: AgentRuntimeLike;
}

export const createAIStackFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly logger: Logger;
    readonly fetchImpl?: typeof fetch;
    readonly readFile?: (path: string) => string;
  },
): AIStack => {
  const catalog = loadAIModelCatalog(env, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });
  return {
    llm: new LLMManager({
      logger: options.logger,
      adapter: new AISDKAdapter(catalog.resolve('generation')),
    }),
    agent: new AISDKAgentRuntime(catalog.resolve('agent'), { logger: options.logger }),
  };
};
