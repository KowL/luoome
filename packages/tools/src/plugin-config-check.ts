import { type PluginConfig, PluginConfigStore, resolvePluginConfigPath } from '@luoome/adapters';
import { MANAGED_PLUGIN_IDS, type ManagedPluginId } from '@luoome/core';
import type { BuiltinPluginDefinition } from '@luoome/toolkit';
import { BUILTIN_PLUGINS } from './builtin-plugins.js';

export type PluginConfigFileState = 'ok' | 'missing' | 'invalid';
export type PluginEnablementStatus = 'enabled' | 'disabled' | 'missing' | 'dependency_not_ready';

export interface PluginDependencyStatus {
  readonly id: ManagedPluginId;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly ready: boolean;
}

export interface PluginConfigCheckRow {
  readonly id: ManagedPluginId;
  readonly label: string;
  readonly kind: 'business' | 'provider' | 'task';
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly requires: readonly ManagedPluginId[];
  readonly dependencies: readonly PluginDependencyStatus[];
  readonly dependenciesReady: boolean;
  readonly status: PluginEnablementStatus;
}

export interface UnknownPluginConfigEntry {
  readonly id: string;
  readonly suggestions: readonly ManagedPluginId[];
}

export interface PluginConfigCheck {
  readonly path: string;
  readonly file: PluginConfigFileState;
  readonly plugins: readonly PluginConfigCheckRow[];
  readonly unknown: readonly UnknownPluginConfigEntry[];
  readonly missing: readonly ManagedPluginId[];
  readonly summary: {
    readonly total: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly missing: number;
    readonly dependencyNotReady: number;
    readonly unknown: number;
  };
}

export interface PluginConfigCheckOptions {
  readonly path?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly definitions?: Readonly<Record<ManagedPluginId, BuiltinPluginDefinition>>;
}

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(
        (previous[j - 1] ?? 0) + 1,
        above + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? right.length;
};

const suggestionsFor = (id: string): readonly ManagedPluginId[] => {
  const normalized = id.trim().toLowerCase();
  if (normalized.length === 0) return [];
  return MANAGED_PLUGIN_IDS.map((candidate) => ({
    candidate,
    distance: editDistance(normalized, candidate.toLowerCase()),
  }))
    .filter(({ candidate, distance }) => distance <= Math.max(2, Math.ceil(candidate.length / 4)))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
};

const configEntries = (config: PluginConfig | undefined) => config?.entries ?? {};

export const inspectPluginConfig = (options: PluginConfigCheckOptions = {}): PluginConfigCheck => {
  const path = options.path ?? resolvePluginConfigPath(options.env);
  const definitions = options.definitions ?? BUILTIN_PLUGINS;
  const inspected = new PluginConfigStore(path).inspect();
  const entries = configEntries(inspected.ok ? inspected.config : undefined);
  const enabledById = new Map<ManagedPluginId, boolean>(
    MANAGED_PLUGIN_IDS.map((id) => [id, entries[id]?.enabled === true]),
  );
  const readyCache = new Map<ManagedPluginId, boolean>();
  const dependenciesReady = (id: ManagedPluginId): boolean => {
    const cached = readyCache.get(id);
    if (cached !== undefined) return cached;
    const ready = definitions[id].requires.every(
      (required) => enabledById.get(required) === true && dependenciesReady(required),
    );
    readyCache.set(id, ready);
    return ready;
  };

  const plugins = MANAGED_PLUGIN_IDS.map((id): PluginConfigCheckRow => {
    const definition = definitions[id];
    const configured = entries[id] !== undefined;
    const enabled = enabledById.get(id) === true;
    const ready = dependenciesReady(id);
    const status: PluginEnablementStatus = !configured
      ? 'missing'
      : !enabled
        ? 'disabled'
        : ready
          ? 'enabled'
          : 'dependency_not_ready';
    return {
      id,
      label: definition.label,
      kind: definition.kind,
      configured,
      enabled,
      requires: definition.requires,
      dependencies: definition.requires.map((required) => ({
        id: required,
        configured: entries[required] !== undefined,
        enabled: enabledById.get(required) === true,
        ready: enabledById.get(required) === true && dependenciesReady(required),
      })),
      dependenciesReady: ready,
      status,
    };
  });

  const unknownIds = inspected.ok ? (inspected.unknownIds ?? []) : [];
  const unknown = unknownIds.map((id) => ({ id, suggestions: suggestionsFor(id) }));
  const missing = plugins
    .filter((plugin) => plugin.status === 'missing')
    .map((plugin) => plugin.id);
  return {
    path,
    file: inspected.ok ? 'ok' : inspected.reason,
    plugins,
    unknown,
    missing,
    summary: {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.status === 'enabled').length,
      disabled: plugins.filter((plugin) => plugin.status === 'disabled').length,
      missing: missing.length,
      dependencyNotReady: plugins.filter((plugin) => plugin.status === 'dependency_not_ready')
        .length,
      unknown: unknown.length,
    },
  };
};

export const checkPluginConfig = inspectPluginConfig;

/** 启动日志用：只返回需要开发者关注的缺项/未知/损坏提示，正常时不吵。 */
export const pluginConfigWarnings = (check: PluginConfigCheck): readonly string[] => {
  const warnings: string[] = [];
  if (check.file === 'missing') {
    warnings.push(`plugins.json 缺失（${check.path}），全部插件按关闭处理`);
  } else if (check.file === 'invalid') {
    warnings.push(`plugins.json 无法解析（${check.path}），全部插件按关闭处理`);
  } else if (check.missing.length > 0) {
    warnings.push(`plugins.json 缺少配置项，按关闭处理：${check.missing.join(', ')}`);
  }
  if (check.unknown.length > 0) {
    warnings.push(
      `plugins.json 包含未知 key：${check.unknown.map((entry) => entry.id).join(', ')}`,
    );
  }
  return warnings;
};
