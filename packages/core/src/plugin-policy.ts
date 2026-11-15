import type { ToolResult } from './types/result.js';
import type { SideEffect } from './types/side-effect.js';

export type ManagedPluginId = 'strategy.ai-insight';
export type PluginBlockReason = 'plugin_disabled' | 'dependency_not_ready' | 'activation_revoked';

export interface PluginPermit {
  readonly id: ManagedPluginId;
  readonly incarnation: string;
  readonly epoch: number;
}

export type PluginAdmission =
  | { readonly ok: true; readonly permit: PluginPermit }
  | { readonly ok: false; readonly reason: PluginBlockReason };

export interface PluginPolicyLike {
  acquire(id: ManagedPluginId): PluginAdmission;
  valid(permit: PluginPermit): boolean;
}

export interface ToolExecutionPolicyLike extends PluginPolicyLike {
  bind(): ToolExecutionPolicyLike;
  authorizeTool(
    name: string,
    input: unknown,
    requiredCapabilities: readonly SideEffect[],
  ): ToolResult<never> | null;
}
