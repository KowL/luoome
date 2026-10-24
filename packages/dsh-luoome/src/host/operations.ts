import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { PluginTaskIdentity, ToolResult } from '@luoome/core';
import type { createPluginOperationService, PluginPrincipal } from '@luoome/tools';
import { z } from 'zod';
import { denied, invalidInput } from './read-surface.js';
import { readPluginJson } from './routes.js';

type Service = ReturnType<typeof createPluginOperationService>;
export type ResolveOperationPrincipal = (
  request: Request,
) => PluginPrincipal | Response | null | Promise<PluginPrincipal | Response | null>;
const response = (result: ToolResult<unknown>, status?: number) =>
  Response.json(result, {
    status:
      status ??
      (result.ok
        ? 200
        : result.error.kind === 'permission_denied'
          ? 403
          : result.error.kind === 'invalid_input'
            ? 400
            : 503),
    headers: { 'cache-control': 'no-store' },
  });
const prepareInput = z
  .object({ id: z.uuid(), tool: z.string().min(1).max(120), input: z.unknown() })
  .strict();
const confirmationInput = z.object({ token: z.string().min(1).max(200) }).strict();

export const createOperationHandler =
  (service: Service, resolvePrincipal: ResolveOperationPrincipal) =>
  async (request: Request): Promise<Response> => {
    let principal: Awaited<ReturnType<ResolveOperationPrincipal>>;
    try {
      principal = await resolvePrincipal(request);
    } catch {
      return response(denied('host authentication'));
    }
    if (principal instanceof Response) return principal;
    if (!principal) return response(denied('host authentication'));
    const path = new URL(request.url).pathname;
    const match =
      /^\/api\/luoome\/operations\/([^/]{1,600})(?:\/(confirm|cancel|reconcile))?$/.exec(path);
    let id: string | undefined;
    try {
      id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    } catch {
      return response(invalidInput('Invalid operation id'), 400);
    }
    if (id !== undefined && !/^[a-zA-Z0-9:-]{1,200}$/.test(id))
      return response(invalidInput('Invalid operation id'), 400);
    const action = match?.[2];
    if (request.method === 'GET' && id && !action && id !== 'prepare')
      return response(await service.get(principal, id));
    const body = await readPluginJson(request);
    if (body instanceof Response) return body;
    if (path === '/api/luoome/operations/prepare') {
      const parsed = prepareInput.safeParse(body.value);
      return parsed.success
        ? response(await service.prepare(principal, parsed.data))
        : response(invalidInput('Invalid operation envelope'), 400);
    }
    if (!id || !action) return response(invalidInput('Unknown operation route'), 404);
    if (action === 'reconcile') {
      if (!z.object({}).strict().safeParse(body.value).success)
        return response(invalidInput('Empty reconcile body required'), 400);
      return response(await service.reconcile(principal, id));
    }
    const parsed = confirmationInput.safeParse(body.value);
    if (!parsed.success) return response(invalidInput('Confirmation accepts only its token'), 400);
    return response(
      await (action === 'confirm'
        ? service.confirm(principal, { id, token: parsed.data.token }, request.signal)
        : service.cancel(principal, { id, token: parsed.data.token })),
    );
  };

const scheduledInput = z
  .object({
    grantId: z.string().min(1).max(200),
    grantVersion: z.number().int().positive(),
    tool: z.string().min(1).max(120),
    accountId: z.string().min(1).max(200),
    input: z.unknown(),
  })
  .strict();
export type ScheduledOperationRequest = z.infer<typeof scheduledInput>;

// The resolver must use host-owned task metadata; tool arguments/prompt are not identity.
export const createScheduledOperationInvoker =
  (
    service: Service,
    resolve: (
      execution: ToolExecution,
      request: ScheduledOperationRequest,
    ) => Promise<{ identity: PluginTaskIdentity; occurrenceId: string } | null>,
  ) =>
  async (execution: ToolExecution, input: unknown): Promise<ToolResult<unknown>> => {
    const parsed = scheduledInput.safeParse(input);
    if (!parsed.success) return invalidInput('Invalid scheduled operation');
    let trusted: Awaited<ReturnType<typeof resolve>>;
    try {
      trusted = await resolve(execution, parsed.data);
    } catch {
      return denied('trusted scheduled identity');
    }
    if (!trusted) return denied('trusted scheduled identity');
    return service.executeScheduled(
      trusted.identity,
      { ...parsed.data, occurrenceId: trusted.occurrenceId },
      execution.signal,
    );
  };
