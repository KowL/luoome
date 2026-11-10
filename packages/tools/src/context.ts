import type { Logger, RepositoryRegistry, ToolContext } from '@luoome/core';

export interface BuildContextDependencies {
  readonly repos: RepositoryRegistry;
  readonly adapters: ToolContext['adapters'];
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

/** Production composition root used by CLI, TUI, Web, and MCP surfaces. */
export const buildContext = (input: BuildContextInput): ToolContext => {
  const user = input.user ?? { id: 'local-user', defaultAccountId: '' };
  return {
    repos: input.repos,
    adapters: input.adapters,
    user,
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    ...(input.auditLog === undefined ? {} : { auditLog: input.auditLog }),
    ...(input.auditCaller === undefined ? {} : { auditCaller: input.auditCaller }),
    ...(input.portfolioBenchmark === undefined
      ? {}
      : { portfolioBenchmark: input.portfolioBenchmark }),
  };
};
