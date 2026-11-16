import {
  assembleToolContributions,
  sharedToolContributions,
  type Tool,
  type ToolDependency,
} from '@luoome/toolkit';
import { applicationToolContributions } from './application-contributions.js';
import { builtinToolContributions } from './builtin-plugins.js';

export type { ToolDependency, ToolOwner } from '@luoome/toolkit';

// Inventory is assembled from each owner; membership never grants execution permission.
export const toolCatalog = assembleToolContributions(
  sharedToolContributions,
  applicationToolContributions,
  builtinToolContributions,
);

export type CatalogToolName = keyof typeof toolCatalog;
export type AgentToolName = {
  [K in CatalogToolName]: (typeof toolCatalog)[K]['agent'] extends true ? K : never;
}[CatalogToolName];

export type CatalogToolMap = {
  readonly [K in CatalogToolName]: (typeof toolCatalog)[K]['tool'];
};

export const catalogTools: CatalogToolMap = Object.fromEntries(
  Object.entries(toolCatalog).map(([name, entry]) => [name, entry.tool]),
) as CatalogToolMap;

export const agentTools: readonly Tool[] = Object.values(toolCatalog)
  .filter((entry) => entry.agent)
  .map((entry) => entry.tool);

export const agentToolDependencies: Readonly<Record<AgentToolName, readonly ToolDependency[]>> =
  Object.fromEntries(
    Object.entries(toolCatalog).flatMap(([name, entry]): [string, readonly ToolDependency[]][] =>
      entry.agent ? [[name, entry.dependencies]] : [],
    ),
  ) as Record<AgentToolName, readonly ToolDependency[]>;
