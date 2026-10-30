import type {
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationNonTerminal,
  PluginOperationProof,
  PluginOperationScope,
} from '../entity/plugin-authority.js';

export interface PluginAuthorityRepository {
  insertOperation(operation: PluginOperation): Promise<boolean>;
  findOperation(scope: PluginOperationScope): Promise<PluginOperation | null>;
  /**
   * 按账户枚举未终结 Operation（pending/executing/unknown），**不按 userId 过滤**：
   * 同一账户下其它用户的未终结操作同样属于「账户正在变动」，恢复不得越过它。
   * 只返回 id/userId/accountId/state/tool 的窄投影。
   */
  listNonTerminalOperationsByAccount(
    accountId: string,
  ): Promise<readonly PluginOperationNonTerminal[]>;
  claimOperation(
    proof: PluginOperationProof & { readonly claimToken: string },
  ): Promise<PluginOperation | null>;
  cancelOperation(proof: PluginOperationProof): Promise<boolean>;
  settleOperation(
    input: PluginOperationScope & {
      readonly claimToken: string;
      /**
       * `failed` 只用于 policy 明确声明「非 ok 结果即未提交」的情形（如导入 commit 在事务内
       * 被拒）；其余一律保守落 `unknown`，等 reconcile 核对。
       */
      readonly state: 'succeeded' | 'unknown' | 'failed';
      readonly resultJson: string | null;
      readonly now: number;
    },
  ): Promise<boolean>;
  findGrant(id: string, userId: string): Promise<PluginAutomationGrant | null>;
  saveGrant(grant: PluginAutomationGrant, expectedVersion: number | null): Promise<boolean>;
}
