import type {
  ManagedPluginId,
  PluginPolicyLike,
  SideEffect,
  ToolExecutionPolicyLike,
} from '@luoome/core';
import { MANAGED_PLUGIN_IDS, PluginExecutionDenied, resolveExposure } from '@luoome/core';
import { toolCatalog } from './catalog.js';

const managedOwners = new Set<string>(MANAGED_PLUGIN_IDS);
const controlledTools = new Map(
  Object.entries(toolCatalog)
    .filter(([, entry]) => 'execution' in entry)
    .map(([name, entry]) => [name, entry]),
);

/** 执行期只剩两件事：插件是否启用、工具所需能力是否已曝光。 */
export const createPluginExecutionPolicy = (
  plugins: PluginPolicyLike,
  allowed: ReadonlySet<SideEffect>,
): ToolExecutionPolicyLike => {
  const scoped = (): ToolExecutionPolicyLike => {
    const pluginOf = (name: string): ManagedPluginId | undefined => {
      const owner = controlledTools.get(name)?.owner;
      return owner !== undefined && managedOwners.has(owner)
        ? (owner as ManagedPluginId)
        : undefined;
    };
    const assertTool = (name: string, dependency?: ManagedPluginId) => {
      for (const id of [pluginOf(name), dependency]) {
        if (id !== undefined && !plugins.isEnabled(id))
          throw new PluginExecutionDenied(`plugin:${id}`);
      }
    };
    return {
      isEnabled: (id) => plugins.isEnabled(id),
      snapshot: () => plugins.snapshot?.(),
      runPlugin: (_id, operation) => operation(),
      runTool: (name, operation, guard) => {
        const owner = pluginOf(name);
        if (owner !== undefined && !plugins.isEnabled(owner))
          throw new PluginExecutionDenied(`plugin:${owner}`);
        if (guard !== undefined) guard();
        return operation();
      },
      bind: () => scoped(),
      scopeKey: (name) => {
        const owner = pluginOf(name);
        return owner === undefined ? '' : JSON.stringify([owner, plugins.isEnabled(owner)]);
      },
      assertTool,
      authorizeTool: (name, input, required) => {
        if (!controlledTools.has(name)) return null;
        assertTool(name);
        const capabilities =
          name === 'run_strategy' && (input as { persist?: boolean }).persist === false
            ? required.filter((cap) => cap !== 'write')
            : required;
        const missing = capabilities.find((capability) => !allowed.has(capability));
        return missing === undefined
          ? null
          : {
              ok: false,
              error: { kind: 'permission_denied', required: missing },
            };
      },
    };
  };
  return scoped();
};

export const pluginAllowedSideEffects = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<SideEffect> => resolveExposure(env).sideEffects;
