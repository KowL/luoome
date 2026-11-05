import {
  type ConfirmablePluginTool,
  PluginOperationScopeError,
  SyncMarketDumpInput,
  syncMarketDumpTool,
} from '@luoome/tools';

export const syncMarketDumpOperation: ConfirmablePluginTool = {
  tool: syncMarketDumpTool,
  scheduled: false,
  bind(raw, principal, _operationId, ctx) {
    if (principal.userId !== ctx.user.id || principal.accountId !== ctx.user.defaultAccountId)
      throw new PluginOperationScopeError('accountId');
    return SyncMarketDumpInput.strict().parse(raw);
  },
  // kind alone cannot identify this operation's run after an interrupted execution.
  async receipt() {
    return null;
  },
};
