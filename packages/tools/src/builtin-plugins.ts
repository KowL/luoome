import {
  MANAGED_PLUGIN_IDS,
  type ManagedPluginId,
  type PluginConfigurationDefaults,
} from '@luoome/core';
import { analysisPlugin } from '@luoome/plugin-analysis';
import { marketProvidersPlugin } from '@luoome/plugin-market-providers';
import { marketTasksPlugin } from '@luoome/plugin-market-tasks';
import { notificationPlugin } from '@luoome/plugin-notification';
import { performanceTaskPlugin } from '@luoome/plugin-performance-task';
import { reportPlugin } from '@luoome/plugin-report';
import { strategyPlugin } from '@luoome/plugin-strategy';
import { watchPlugin } from '@luoome/plugin-watch';
import {
  assembleToolContributions,
  type BuiltinPluginDefinition,
  type PluginOperations,
  type PluginPackage,
  type PluginTaskDefinition,
} from '@luoome/toolkit';

export const builtinPluginPackages = [
  analysisPlugin,
  strategyPlugin,
  watchPlugin,
  reportPlugin,
  notificationPlugin,
  performanceTaskPlugin,
  marketTasksPlugin,
  marketProvidersPlugin,
] as const;

export const assemblePluginDefinitions = (
  packages: readonly PluginPackage[],
): Readonly<Record<ManagedPluginId, BuiltinPluginDefinition>> => {
  const entries = new Map<ManagedPluginId, BuiltinPluginDefinition>();
  for (const plugin of packages)
    for (const [key, definition] of Object.entries(plugin.definitions)) {
      const id = key as ManagedPluginId;
      if (!MANAGED_PLUGIN_IDS.includes(id)) throw new Error(`unknown plugin definition: ${id}`);
      if (entries.has(id)) throw new Error(`duplicate plugin definition: ${id}`);
      entries.set(id, definition);
    }
  const visit = (id: ManagedPluginId, chain: readonly ManagedPluginId[]) => {
    if (chain.includes(id)) throw new Error(`plugin dependency cycle: ${id}`);
    const definition = entries.get(id);
    if (definition === undefined) throw new Error(`missing plugin definition: ${id}`);
    for (const required of definition.requires) visit(required, [...chain, id]);
  };
  for (const id of MANAGED_PLUGIN_IDS) visit(id, []);
  return Object.fromEntries(MANAGED_PLUGIN_IDS.map((id) => [id, entries.get(id)])) as Record<
    ManagedPluginId,
    BuiltinPluginDefinition
  >;
};

export const BUILTIN_PLUGINS = assemblePluginDefinitions(builtinPluginPackages);
export const BUILTIN_PLUGIN_DEFAULTS: PluginConfigurationDefaults = Object.fromEntries(
  MANAGED_PLUGIN_IDS.map((id) => [id, BUILTIN_PLUGINS[id].baselineEnabled]),
) as Record<ManagedPluginId, boolean>;
export const builtinToolContributions = assembleToolContributions(
  ...builtinPluginPackages.map((plugin) => plugin.tools),
);
export type BuiltinPluginOperations = PluginOperations<typeof builtinPluginPackages>;

export const createBuiltinPluginResources = (
  operations: BuiltinPluginOperations,
): readonly PluginTaskDefinition[] => {
  const registered = new Set<ManagedPluginId>();
  return builtinPluginPackages.flatMap((plugin) =>
    plugin.resources(operations).map((resource) => {
      if (!(resource.id in plugin.definitions))
        throw new Error(`resource must belong to its declaring package: ${resource.id}`);
      if (registered.has(resource.id)) throw new Error(`duplicate plugin resource: ${resource.id}`);
      registered.add(resource.id);
      return { ...resource, requires: BUILTIN_PLUGINS[resource.id].requires };
    }),
  );
};
