import type { ToolResult } from './types/result.js';
import type { SideEffect } from './types/side-effect.js';

export const SOURCE_PLUGIN_IDS = [
  'source.eastmoney',
  'source.tencent',
  'source.sina',
  'source.tushare',
  'source.fuyao',
  'source.10jqka',
] as const;
export const TASK_PLUGIN_IDS = [
  'task.strategy-schedules',
  'task.daily-bars-sync',
  'task.sync-stock-universe',
  'task.collect-market-snapshot',
  'task.sync-quotes',
  'task.sync-market-dump',
  'task.sync-sector-catalog',
  'task.sync-limit-up-board-history',
  'task.minute-bars-sync',
] as const;
export const MANAGED_PLUGIN_IDS = [
  'strategy.ai-insight',
  'business.strategy-execution',
  ...SOURCE_PLUGIN_IDS,
  ...TASK_PLUGIN_IDS,
] as const;
export type ManagedPluginId = (typeof MANAGED_PLUGIN_IDS)[number];
export interface DataExecutionScopeLike {
  run<T>(
    operation: (validate: () => void) => Promise<T>,
    check?: (dependency?: ManagedPluginId) => void,
    key?: string,
  ): Promise<T>;
}

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

export interface PluginActivity {
  readonly id: ManagedPluginId;
  readonly inFlight: number;
  readonly revokedInFlight: number;
}
export interface ToolExecutionPolicyLike extends PluginPolicyLike {
  activity(): readonly PluginActivity[];
  runPlugin<T>(id: ManagedPluginId, operation: () => Promise<T>, guard?: () => void): Promise<T>;
  runTool<T>(name: string, operation: () => Promise<T>, guard?: () => void): Promise<T>;
  bind(): ToolExecutionPolicyLike;
  scopeKey(name: string): string;
  assertTool(name: string, dependency?: ManagedPluginId): void;
  authorizeTool(
    name: string,
    input: unknown,
    requiredCapabilities: readonly SideEffect[],
  ): ToolResult<never> | null;
}

export class PluginExecutionDenied extends Error {
  constructor(readonly required: string) {
    super('plugin execution denied');
  }
}
