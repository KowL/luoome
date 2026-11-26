import { createHash } from 'node:crypto';
import { MANAGED_PLUGIN_IDS } from '@luoome/core';
import { analysisPlugin } from '@luoome/plugin-analysis';
import { reportPlugin } from '@luoome/plugin-report';
import { assembleToolContributions } from '@luoome/toolkit';
import { describe, expect, it, vi } from 'vitest';
import {
  assemblePluginDefinitions,
  BUILTIN_PLUGIN_DEFAULTS,
  BUILTIN_PLUGINS,
  type BuiltinPluginOperations,
  builtinPluginPackages,
  createBuiltinPluginResources,
} from './builtin-plugins.js';

const forbidden = async (): Promise<never> => {
  throw new Error('resource discovery must not execute operations');
};
const operations: BuiltinPluginOperations = {
  report: { run: forbidden },
  performance: { run: forbidden },
  watch: { runAccount: forbidden },
};

describe('builtin plugin assembly', () => {
  it('retains the previous definitions, initialization defaults and dependency metadata exactly', () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toEqual([...MANAGED_PLUGIN_IDS]);
    expect(
      createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(BUILTIN_PLUGINS).map(
                ([id, { kind, label, baselineEnabled, requires }]) => [
                  id,
                  { kind, label, baselineEnabled, requires },
                ],
              ),
            ),
          ),
        )
        .digest('hex'),
    ).toBe('2688dae3f1336dada393e084e9e0edb74392727dd9c3b67e86c631db1c2b6af5');
    expect(Object.entries(BUILTIN_PLUGIN_DEFAULTS).filter(([, enabled]) => enabled)).toEqual([
      ['strategy.ai-insight', true],
    ]);
  });

  it('rejects missing, duplicate and cyclic plugin definitions before activation', () => {
    expect(() => assemblePluginDefinitions(builtinPluginPackages.slice(1))).toThrow(
      'missing plugin definition',
    );
    expect(() => assemblePluginDefinitions([...builtinPluginPackages, analysisPlugin])).toThrow(
      'duplicate plugin definition',
    );
    const cyclic = builtinPluginPackages.map((plugin) =>
      plugin === analysisPlugin
        ? {
            ...plugin,
            definitions: {
              'business.analysis': {
                ...plugin.definitions['business.analysis'],
                requires: ['business.report'] as const,
              },
            },
          }
        : plugin === reportPlugin
          ? {
              ...plugin,
              definitions: {
                'business.report': {
                  ...plugin.definitions['business.report'],
                  requires: ['business.analysis'] as const,
                },
              },
            }
          : plugin,
    );
    expect(() => assemblePluginDefinitions(cyclic)).toThrow('plugin dependency cycle');
  });

  it('rejects duplicate tool contributions and aliases that differ from the executable name', () => {
    expect(() => assembleToolContributions(analysisPlugin.tools, analysisPlugin.tools)).toThrow(
      'duplicate tool contribution',
    );
    expect(() =>
      assembleToolContributions({ wrong_name: analysisPlugin.tools.analyze_stock }),
    ).toThrow('tool contribution name mismatch');
  });

  it('declares controlled ownership inside the same package as the contributing tool', () => {
    const managed = new Set<string>(MANAGED_PLUGIN_IDS);
    for (const plugin of builtinPluginPackages)
      for (const entry of Object.values(plugin.tools))
        if ('execution' in entry && managed.has(entry.owner))
          expect(plugin.definitions).toHaveProperty(entry.owner);
  });

  it('collects lazy resources from their owners and derives requires without registering timers', () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      const resources = createBuiltinPluginResources(operations);
      expect(new Set(resources.map((resource) => resource.id))).toEqual(
        new Set([
          'task.collect-market-snapshot',
          'task.snapshot-account-performance',
          'business.report',
          'business.watch-monitoring',
        ]),
      );
      for (const resource of resources)
        expect(resource.requires).toEqual(BUILTIN_PLUGINS[resource.id].requires);
      expect(timer).not.toHaveBeenCalled();
      expect(createBuiltinPluginResources(operations).map((resource) => resource.id)).toEqual(
        resources.map((resource) => resource.id),
      );
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
});
