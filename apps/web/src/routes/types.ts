import type { ToolContext, ToolResult } from '@luoome/core';
import type { Context } from 'hono';

import type { AISettingsStore } from '../ai-settings.js';
import type { ChatStreamRuntime } from '../chat.js';
import type { WebSourceSet } from '../context.js';
import type { FeishuSettingsStore } from '../feishu-settings.js';
import type { MarketSettingsStore } from '../market-settings.js';
import type { ResearchVaultSettingsStore } from '../research-vault-settings.js';

export type { WebSourceSet };

export interface BatchQuoteTarget {
  name: string;
  quote: {
    close: number;
    observedAt: unknown;
    retrieval: 'live' | 'local-fallback';
    freshness: 'fresh' | 'stale';
  } | null;
  changePct: number | null;
}

/**
 * 领域路由模块的显式依赖（由 server.ts 的组装根注入）。
 * 只放 server 内部的闭包/状态；tool、repo 等直接 import，避免循环依赖。
 */
export interface WebRouteDeps {
  readonly ctxRef: { current: ToolContext };
  contextForRequest(): ToolContext;
  callTool(name: string, input: unknown): Promise<Response>;
  invokeTool(name: string, input: unknown): Promise<ToolResult<unknown>>;
  parseJsonObject: typeof import('../http/result.js').parseJsonObject;
  requireMutationCapabilities(
    request: Request,
    capabilities: readonly ('write' | 'external')[],
  ): ToolResult<never> | null;
  mutationPermission(request: Request): ToolResult<never> | null;
  targetMutation(
    request: Request,
    sideEffect: 'write' | 'external',
    toolName: string,
    fixedInput?: Readonly<Record<string, unknown>>,
  ): Promise<Response>;
  decisionMutation(
    request: Request,
    name: string,
    fixed?: Record<string, unknown>,
  ): Promise<Response>;
  bindDecisionAccount(
    request: Request,
    input: unknown,
  ): { input: Record<string, unknown> } | { denied: ToolResult<never> };
  applyBatchQuotes(
    entries: ReadonlyMap<string, BatchQuoteTarget>,
    warnings: string[],
    degradeLabel: string,
    options?: { readonly updateName?: boolean; readonly keepExistingChangePct?: boolean },
  ): Promise<void>;
  invokeIndexQuotes(): Promise<ToolResult<unknown>>;
  /** 静态 SPA shell 响应（/market/limit-up 等领域内页面路由使用）。 */
  serveFile(file: string, contentType: string): (c: Context) => Promise<Response>;
  readonly exposeWrite: boolean;
  readonly exposeExternal: boolean;
  readonly chatRuntimeRef: { current: ChatStreamRuntime | undefined };
  readonly aiSettingsStore?: AISettingsStore;
  readonly marketSettingsStore?: MarketSettingsStore;
  readonly feishuSettingsStore?: FeishuSettingsStore;
  readonly researchVaultSettingsStore?: ResearchVaultSettingsStore;
  readonly sharedSources?: WebSourceSet;
  readonly dataTransferDbPath?: string;
}
