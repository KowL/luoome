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
