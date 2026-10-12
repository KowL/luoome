import type { ToolContext } from '@luoome/core';
import { ensureDefaultAccountTool } from '@luoome/tools';

/** Provisioning 与旧租户升级共用；唯一账户的确定和更新规则仍由 Tool 负责。 */
export const bindHostedDefaultAccount = async (
  base: ToolContext,
  createTenantContext?: (base: ToolContext) => ToolContext,
): Promise<ToolContext> => {
  if (base.identity?.mode !== 'hosted') throw new Error('hosted identity required');
  const initialized = await ensureDefaultAccountTool.execute(
    {},
    {
      ...base,
      identity: Object.freeze({ ...base.identity, actor: 'worker' }),
      hostedAuthorization: (name) =>
        name === ensureDefaultAccountTool.name
          ? null
          : {
              ok: false,
              error: { kind: 'permission_denied', required: 'hosted:provisioning' },
            },
    },
  );
  if (!initialized.ok) throw new Error('tenant default account unavailable');
  const bound = {
    ...base,
    user: Object.freeze({
      id: base.identity.userId,
      defaultAccountId: initialized.data.account.id,
    }),
  };
  const { hostedAuthorization: _providerAuthorization, ...business } =
    createTenantContext?.(bound) ?? bound;
  return {
    ...business,
    repos: bound.repos,
    identity: base.identity,
    user: bound.user,
    clock: bound.clock,
    logger: bound.logger,
    ...(base.hostedAuthorization === undefined
      ? {}
      : { hostedAuthorization: base.hostedAuthorization }),
  };
};
