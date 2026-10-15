import {
  PlatformAccessDeniedError,
  PlatformLeaseLostError,
  type SideEffect,
  type ToolResult,
} from '@luoome/core';
import { defineTypedTool, type TypedTool, type TypedToolDefinition } from '../define-tool.js';
import type { PlatformActorKind, PlatformContext } from './context.js';
import { verifyCsrfToken } from './crypto.js';

export interface PlatformToolDefinition<I, O> extends TypedToolDefinition<I, O, PlatformContext> {
  readonly sideEffect: 'read' | 'write' | 'external';
  readonly requiredCapabilities?: readonly ('read' | 'write' | 'external')[];
  readonly actors: readonly PlatformActorKind[];
}

export interface PlatformTool<I = unknown, O = unknown> extends TypedTool<I, O, PlatformContext> {
  readonly actors: readonly PlatformActorKind[];
}

const permissionDenied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export const definePlatformTool = <I, O>(
  definition: PlatformToolDefinition<I, O>,
): PlatformTool<I, O> => {
  const actors = Object.freeze([...definition.actors]);
  if (actors.length === 0) throw new Error('Platform tool must declare at least one allowed actor');
  const requiredCapabilities: readonly SideEffect[] = definition.requiredCapabilities ?? [
    definition.sideEffect,
  ];
  const tool = defineTypedTool(
    {
      ...definition,
      handler: async (input, ctx: PlatformContext) => {
        if (!actors.includes(ctx.principal.kind)) {
          return permissionDenied(`actor:${actors.join('|')}`);
        }
        for (const capability of requiredCapabilities) {
          if (capability === 'write' && !ctx.capabilities.write) return permissionDenied('write');
          if (capability === 'external' && !ctx.capabilities.external)
            return permissionDenied('external');
        }
        try {
          if (ctx.principal.kind === 'user') {
            const authenticated = await ctx.repos.auth.resolveSession({
              tokenHash: ctx.principal.tokenHash,
              now: ctx.clock(),
              touch: false,
            });
            if (
              authenticated === null ||
              authenticated.user.id !== ctx.principal.userId ||
              authenticated.tenant.id !== ctx.principal.tenantId ||
              authenticated.tenant.generation !== ctx.principal.tenantGeneration ||
              authenticated.session.id !== ctx.principal.sessionId ||
              authenticated.session.createdAt.getTime() !==
                ctx.principal.authenticatedAt.getTime() ||
              !verifyCsrfToken(ctx.principal.csrfToken, authenticated.session.csrfHash)
            ) {
              return permissionDenied('auth:valid-session');
            }
          }
          return await definition.handler(input, ctx);
        } catch (error) {
          if (error instanceof PlatformAccessDeniedError) return permissionDenied(error.required);
          if (error instanceof PlatformLeaseLostError)
            return {
              ok: false,
              error: { kind: 'lease_lost_before_commit', message: error.message },
            };
          throw error;
        }
      },
    },
    (ctx) => {
      switch (ctx.principal.kind) {
        case 'user':
          return ctx.principal.userId;
        case 'worker':
          return ctx.principal.workerId;
        case 'webhook':
          return `webhook:${ctx.principal.provider}`;
        case 'admin':
          return `admin:${ctx.principal.userId}`;
        case 'anonymous':
          return 'anonymous';
      }
    },
  );
  return { ...tool, actors };
};
