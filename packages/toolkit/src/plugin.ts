import type { ManagedPluginId, SideEffect, ToolContext } from '@luoome/core';
import type { Tool } from './define-tool.js';

export type ToolDependency =
  | `market:${string}`
  | 'llm'
  | 'sectorCatalog'
  | 'limitUpLadder'
  | 'limitUpMarket'
  | 'dragonTiger'
  | 'dragonTigerFlow'
  | 'northboundFlow'
  | 'news'
  | 'forum'
  | 'sectorQuote'
  | 'ashareSentiment'
  | 'stockUniverse'
  | 'marketDump'
  | 'limitUp';
export type ToolOwner =
  | 'shared-query'
  | `platform.${'chat' | 'audit'}`
  | `business.${string}`
  | `task.${string}`;
export type ToolContribution = {
  readonly owner: ToolOwner;
  readonly execution?: 'p1' | 'p2' | 'p3';
  readonly optionalPlugins?: readonly ManagedPluginId[];
  readonly modes?: Readonly<
    Record<string, { readonly data: readonly string[]; readonly conditional?: readonly string[] }>
  >;
} & (
  | { readonly tool: Tool; readonly agent: true; readonly dependencies: readonly ToolDependency[] }
  | {
      readonly tool: Tool;
      readonly agent: false;
      readonly dependencies?: readonly ToolDependency[];
    }
);
export type ToolContributions = Readonly<Record<string, ToolContribution>>;
export interface BuiltinPluginDefinition {
  readonly kind: 'business' | 'provider' | 'task';
  readonly label: string;
  readonly baselineEnabled: boolean;
  readonly requires: readonly ManagedPluginId[];
  readonly settings?: {
    readonly requiredCapabilities?: readonly SideEffect[];
    readonly modelBlocker?: string;
    readonly credentialEnv?: string;
    readonly notes?: readonly string[];
  };
}
export interface PluginTaskActivation {
  readonly ctx: ToolContext;
  run(operation: () => Promise<void>): Promise<void>;
}
export interface PluginTaskDefinition {
  readonly id: ManagedPluginId;
  readonly requires?: readonly ManagedPluginId[];
  start(activation: PluginTaskActivation): { stop(): void };
}
export interface PluginPackage<Operations = never> {
  readonly definitions: Readonly<Partial<Record<ManagedPluginId, BuiltinPluginDefinition>>>;
  readonly tools: ToolContributions;
  readonly resources: (operations: Operations) => readonly Omit<PluginTaskDefinition, 'requires'>[];
}

type Intersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void
  ? I
  : never;
export type PluginOperations<Packages extends readonly PluginPackage[]> = Intersection<
  Parameters<Packages[number]['resources']>[0]
>;

export const assembleToolContributions = <const Maps extends readonly ToolContributions[]>(
  ...maps: Maps
): Intersection<Maps[number]> => {
  const entries = maps.flatMap((map) => Object.entries(map));
  const names = new Set<string>();
  for (const [name, entry] of entries) {
    if (names.has(name)) throw new Error(`duplicate tool contribution: ${name}`);
    if (name !== entry.tool.name) throw new Error(`tool contribution name mismatch: ${name}`);
    names.add(name);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Intersection<
    Maps[number]
  >;
};
