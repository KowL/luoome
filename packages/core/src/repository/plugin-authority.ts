import type {
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
  PluginOperationScope,
} from '../entity/plugin-authority.js';

export interface PluginAuthorityRepository {
  insertOperation(operation: PluginOperation): Promise<boolean>;
  findOperation(scope: PluginOperationScope): Promise<PluginOperation | null>;
  claimOperation(
    proof: PluginOperationProof & { readonly claimToken: string },
  ): Promise<PluginOperation | null>;
  cancelOperation(proof: PluginOperationProof): Promise<boolean>;
  settleOperation(
    input: PluginOperationScope & {
      readonly claimToken: string;
      readonly state: 'succeeded' | 'unknown';
      readonly resultJson: string | null;
      readonly now: number;
    },
  ): Promise<boolean>;
  findGrant(id: string, userId: string): Promise<PluginAutomationGrant | null>;
  saveGrant(grant: PluginAutomationGrant, expectedVersion: number | null): Promise<boolean>;
}
