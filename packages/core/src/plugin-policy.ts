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
  'task.snapshot-account-performance',
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
  'business.analysis',
  'business.forum',
  'business.watch-monitoring',
  'business.report',
  'business.notification',
  ...SOURCE_PLUGIN_IDS,
  ...TASK_PLUGIN_IDS,
] as const;
export type ManagedPluginId = (typeof MANAGED_PLUGIN_IDS)[number];
export type PluginConfigurationDefaults = Readonly<Record<ManagedPluginId, boolean>>;

/** 唯一的启停判定：读 `plugins.json` 里该插件是否 enabled。没有许可令牌、纪元或撤销语义。 */
export interface PluginConfigSnapshot {
  readonly file: 'ok' | 'missing' | 'invalid';
  /** 文件中显式配置过的已知插件 id（enabled 与否都算 configured）。 */
  readonly configured: readonly ManagedPluginId[];
  readonly unknown: readonly string[];
}

export interface PluginPolicyLike {
  isEnabled(id: ManagedPluginId): boolean;
  /** 只读诊断快照；未接入文件策略的调用方可以不提供。 */
  snapshot?(): PluginConfigSnapshot | undefined;
}

export interface DataExecutionScopeLike {
  run<T>(
    operation: (validate: () => void) => Promise<T>,
    check?: (dependency?: ManagedPluginId) => void,
    key?: string,
  ): Promise<T>;
}

export interface ToolExecutionPolicyLike extends PluginPolicyLike {
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
