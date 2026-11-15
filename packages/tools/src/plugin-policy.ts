import type {
  ManagedPluginId,
  PluginAdmission,
  PluginPermit,
  PluginPolicyLike,
  SideEffect,
  ToolExecutionPolicyLike,
} from '@luoome/core';
import { toolCatalog } from './catalog.js';

const managedPlugins = [
  ...new Set(
    Object.values(toolCatalog).flatMap((entry) =>
      'optionalPlugins' in entry ? entry.optionalPlugins : [],
    ),
  ),
];
const controlledTools = new Set(
  Object.entries(toolCatalog).flatMap(([name, entry]) =>
    'execution' in entry && entry.execution === 'p1' ? [name] : [],
  ),
);

export const createPluginExecutionPolicy = (
  plugins: PluginPolicyLike,
  allowed: ReadonlySet<SideEffect>,
): ToolExecutionPolicyLike => {
  const scoped = (
    admissions?: ReadonlyMap<ManagedPluginId, PluginAdmission>,
  ): ToolExecutionPolicyLike => ({
    bind: () =>
      admissions === undefined
        ? scoped(new Map(managedPlugins.map((id) => [id, plugins.acquire(id)])))
        : scoped(admissions),
    acquire: (id) => admissions?.get(id) ?? plugins.acquire(id),
    valid: (permit: PluginPermit) => plugins.valid(permit),
    authorizeTool: (name, _input, required) => {
      if (!controlledTools.has(name)) return null;
      const missing = required.find((capability) => !allowed.has(capability));
      return missing === undefined
        ? null
        : {
            ok: false,
            error: { kind: 'permission_denied', required: missing },
          };
    },
  });
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
