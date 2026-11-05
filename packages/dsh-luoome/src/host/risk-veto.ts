import type { ToolContext } from '@luoome/core';
import { overrideRiskVetoTool, type PluginPrincipal } from '@luoome/tools';
import { z } from 'zod';
import { type RequestAdmission, readPluginJson } from './routes.js';

const Input = z
  .object({
    vetoId: z.string().min(1),
    evidenceContextId: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
    newFactIds: z.array(z.string().min(1)).min(1),
    confirmed: z.literal(true),
  })
  .strict();

/** Called only through the owner-authenticated HTTP carrier, never registered as a model tool. */
export const createRiskVetoOverrideHandler =
  (options: {
    admit: RequestAdmission;
    principal: () => PluginPrincipal | null;
    context: () => ToolContext | Promise<ToolContext>;
  }) =>
  async (request: Request): Promise<Response> => {
    const rejection = await options.admit(request);
    if (rejection) return rejection;
    const principal = options.principal();
    if (principal === null) return new Response(null, { status: 403 });
    const transport = await readPluginJson(request);
    if (transport instanceof Response) return transport;
    const input = Input.safeParse(transport.value);
    if (!input.success)
      return Response.json(
        { ok: false, error: { kind: 'invalid_input', message: 'Invalid confirmed veto override' } },
        { status: 400 },
      );
    const ctx = await options.context();
    if (ctx.user.id !== principal.userId || ctx.user.defaultAccountId !== principal.accountId)
      return new Response(null, { status: 403 });
    const { confirmed: _confirmed, ...fields } = input.data;
    const result = await overrideRiskVetoTool.execute(
      {
        ...fields,
        accountId: principal.accountId,
        overriddenBy: 'user',
      },
      {
        ...ctx,
        riskVetoOverrideAuthorization: {
          userId: principal.userId,
          accountId: principal.accountId,
          vetoId: fields.vetoId,
        },
      },
    );
    return Response.json(result, {
      status: result.ok ? 200 : result.error.kind === 'permission_denied' ? 403 : 400,
      headers: { 'cache-control': 'no-store' },
    });
  };
