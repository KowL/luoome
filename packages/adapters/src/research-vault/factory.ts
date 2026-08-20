import { GitResearchVaultSyncAdapter } from './git-sync.js';
import { ObsidianVaultAdapter } from './obsidian.js';
import { ResearchRemoteDocumentAdapter } from './remote.js';

export const createResearchVaultAdapterFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ObsidianVaultAdapter | undefined => {
  const vaultPath = env.LUOOME_RESEARCH_VAULT;
  if (!vaultPath) return undefined;
  return new ObsidianVaultAdapter({
    vaultPath,
    ...(env.LUOOME_RESEARCH_ROOT ? { researchRoot: env.LUOOME_RESEARCH_ROOT } : {}),
    ...(env.LUOOME_RESEARCH_MANAGED_ROOT ? { managedRoot: env.LUOOME_RESEARCH_MANAGED_ROOT } : {}),
    ...(env.LUOOME_RESEARCH_VAULT_ID ? { vaultId: env.LUOOME_RESEARCH_VAULT_ID } : {}),
    ...(env.LUOOME_RESEARCH_MAX_TEXT_MB
      ? { maxTextBytes: Number(env.LUOOME_RESEARCH_MAX_TEXT_MB) * 1024 * 1024 }
      : {}),
    ...(env.LUOOME_RESEARCH_MAX_ATTACHMENT_MB
      ? { maxAttachmentBytes: Number(env.LUOOME_RESEARCH_MAX_ATTACHMENT_MB) * 1024 * 1024 }
      : {}),
  });
};

export const createResearchRemoteDocumentAdapter = (): ResearchRemoteDocumentAdapter =>
  new ResearchRemoteDocumentAdapter();

export const createResearchVaultGitSyncAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly backupRoot: string },
): GitResearchVaultSyncAdapter | undefined => {
  const provider = env.LUOOME_RESEARCH_REMOTE_SYNC?.trim();
  if (!provider) return undefined;
  if (provider !== 'git') {
    throw new Error('LUOOME_RESEARCH_REMOTE_SYNC 仅支持 git');
  }
  const vaultPath = env.LUOOME_RESEARCH_VAULT?.trim();
  if (!vaultPath) throw new Error('Git Research Vault 同步需要 LUOOME_RESEARCH_VAULT');
  return new GitResearchVaultSyncAdapter({
    vaultPath,
    backupRoot: options.backupRoot,
  });
};
