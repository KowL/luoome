import type {
  ManagedPluginId,
  PluginAdmission,
  PluginPermit,
  PluginPolicyLike,
  SideEffect,
  ToolExecutionPolicyLike,
} from '@luoome/core';
import { MANAGED_PLUGIN_IDS, PluginExecutionDenied } from '@luoome/core';
import { toolCatalog } from './catalog.js';

const managedOwners = new Set<string>(MANAGED_PLUGIN_IDS);
const controlledTools = new Map(
  Object.entries(toolCatalog)
    .filter(([, entry]) => 'execution' in entry)
    .map(([name, entry]) => [name, entry]),
);
export const createPluginExecutionPolicy = (
  plugins: PluginPolicyLike,
  allowed: ReadonlySet<SideEffect>,
): ToolExecutionPolicyLike => {
  const active = new Map<
    ManagedPluginId,
    Set<{ permit: PluginPermit; guard: (() => void) | undefined }>
  >();
  const scoped = (
    admissions?: ReadonlyMap<ManagedPluginId, PluginAdmission>,
  ): ToolExecutionPolicyLike => {
    const admission = (id: ManagedPluginId) => admissions?.get(id) ?? plugins.acquire(id);
    const assertTool = (name: string, dependency?: ManagedPluginId) => {
      const owner = controlledTools.get(name)?.owner;
      const ids = [
        ...(owner !== undefined && managedOwners.has(owner) ? [owner as ManagedPluginId] : []),
        ...(dependency === undefined ? [] : [dependency]),
      ];
      for (const id of ids) {
        const granted = admission(id);
        if (!granted.ok || !plugins.valid(granted.permit))
          throw new PluginExecutionDenied(`plugin:${id}`);
      }
    };
    const runPlugin = async <T>(
      id: ManagedPluginId,
      operation: () => Promise<T>,
      guard?: () => void,
    ): Promise<T> => {
      const grant = admission(id);
      if (!grant.ok) return operation();
      const record = { permit: { ...grant.permit }, guard };
      const current =
        active.get(id) ?? new Set<{ permit: PluginPermit; guard: (() => void) | undefined }>();
      active.set(id, current);
      current.add(record);
      try {
        return await operation();
      } finally {
        current.delete(record);
        if (current.size === 0) active.delete(id);
      }
    };
    return {
      activity: () =>
        [...active].map(([id, permits]) => ({
          id,
          inFlight: permits.size,
          revokedInFlight: [...permits].filter((record) => {
            try {
              record.guard?.();
              return !plugins.valid(record.permit);
            } catch {
              return true;
            }
          }).length,
        })),
      runPlugin,
      runTool: (name, operation, guard) => {
        const owner = controlledTools.get(name)?.owner;
        return owner !== undefined && managedOwners.has(owner)
          ? runPlugin(owner as ManagedPluginId, operation, guard)
          : operation();
      },
      bind: () =>
        admissions === undefined
          ? scoped(new Map(MANAGED_PLUGIN_IDS.map((id) => [id, plugins.acquire(id)])))
          : scoped(admissions),
      acquire: (id) => admissions?.get(id) ?? plugins.acquire(id),
      valid: (permit: PluginPermit) => plugins.valid(permit),
      scopeKey: (name) => {
        const owner = controlledTools.get(name)?.owner;
        return owner !== undefined && managedOwners.has(owner)
          ? JSON.stringify([owner, admission(owner as ManagedPluginId)])
          : '';
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
): ReadonlySet<SideEffect> =>
  new Set<SideEffect>([
    ...(env.LUOOME_EXPOSE_READ === 'false' ? [] : ['read' as const]),
    ...(env.LUOOME_EXPOSE_ADVICE === 'false' ? [] : ['advice' as const]),
    ...(env.LUOOME_EXPOSE_WRITE === 'true' ? ['write' as const] : []),
    ...(env.LUOOME_EXPOSE_EXTERNAL === 'true' ? ['external' as const] : []),
  ]);
