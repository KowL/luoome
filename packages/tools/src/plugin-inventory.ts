import type { ManagedPluginId } from '@luoome/core';
import { toolCatalog } from './catalog.js';

export interface PluginRouteInventory {
  readonly route: string;
  readonly candidates: readonly string[];
  readonly dependencies: readonly string[];
  readonly ready: boolean;
}
export const pluginRouteDependency = (route: string): string =>
  route.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export const pluginContributions = (
  id: ManagedPluginId,
  routes: readonly PluginRouteInventory[] = [],
) => {
  const paths = routes.filter((route) =>
    [...route.candidates, ...route.dependencies].some((source) => id === `source.${source}`),
  );
  return Object.entries(toolCatalog).flatMap(([name, entry]) => {
    const dependencies: readonly string[] = 'dependencies' in entry ? entry.dependencies : [];
    const effect =
      'execution' in entry && entry.owner === id
        ? 'owned'
        : 'optionalPlugins' in entry && entry.optionalPlugins.some((plugin) => plugin === id)
          ? 'optional'
          : paths.some(
                (path) =>
                  dependencies.some((dependency) =>
                    path.route === 'market'
                      ? dependency.startsWith('market:')
                      : dependency === pluginRouteDependency(path.route),
                  ) ||
                  (path.route === 'market' &&
                    'modes' in entry &&
                    Object.values(entry.modes).some((mode) =>
                      [...mode.data, ...(mode.conditional ?? [])].some((dependency) =>
                        dependency.startsWith('live:'),
                      ),
                    )),
              )
            ? 'provider-route'
            : undefined;
    return effect === undefined
      ? []
      : [
          {
            name,
            description: entry.tool.description,
            effect,
            capabilities: entry.tool.requiredCapabilities,
            dependencies,
            modes: 'modes' in entry ? entry.modes : {},
          },
        ];
  });
};
