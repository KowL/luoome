import { type ConfirmablePluginTool, UpdateAccountInput, updateAccountTool } from '@luoome/tools';

export const updateAccountOperation: ConfirmablePluginTool = {
  tool: updateAccountTool,
  scheduled: false,
  hostBoundFields: ['accountId'],
  bind(raw, principal) {
    const input = UpdateAccountInput.parse(raw);
    if (input.accountId !== undefined && input.accountId !== principal.accountId)
      throw new Error('Operation scope mismatch');
    return { ...input, accountId: principal.accountId };
  },
  async receipt(raw, ctx) {
    const input = UpdateAccountInput.parse(raw);
    if (input.accountId === undefined) return null;
    const account = await ctx.repos.account.findById(input.accountId);
    return account?.name === input.name ? { ok: true, data: { account } } : null;
  },
};
