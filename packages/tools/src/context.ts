import type { Logger, RepositoryRegistry, ToolContext } from '@luoome/core';
import { createPluginExecutionPolicy } from './plugin-policy.js';

export interface BuildContextDependencies {
  readonly repos: RepositoryRegistry;
  readonly adapters: ToolContext['adapters'];
  readonly executionPolicy?: ToolContext['executionPolicy'];
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly auditLog?: ToolContext['auditLog'];
  readonly auditCaller?: string;
  readonly user?: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly portfolioBenchmark?: ToolContext['portfolioBenchmark'];
}

export type BuildContextInput = BuildContextDependencies;

/** Production composition root used by CLI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const user = input.user ?? { id: 'local-user', defaultAccountId: '' };
  return {
    repos: input.repos,
    adapters: input.adapters,
    user,
    executionPolicy:
      input.executionPolicy ??
      createPluginExecutionPolicy(
        {
          acquire: () => ({ ok: false, reason: 'dependency_not_ready' }),
          valid: () => false,
        },
        new Set(),
      ),
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
    ...(input.auditCaller === undefined ? {} : { auditCaller: input.auditCaller }),
    ...(input.portfolioBenchmark === undefined
      ? {}
      : { portfolioBenchmark: input.portfolioBenchmark }),
  };
};
