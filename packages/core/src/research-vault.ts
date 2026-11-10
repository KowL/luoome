import type { ResearchDocumentIndex } from './entity/research-vault.js';

export interface ResearchVaultEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: Date;
  readonly contentHash: string;
}
export interface ResearchVaultAdapterLike {
  readonly name: string;
  readonly vaultId: string;
  /** POSIX path relative to the Vault root where luoome may create managed files. */
  readonly managedRoot?: string;
  scan(input?: { readonly roots?: readonly string[] }): Promise<readonly ResearchVaultEntry[]>;
  readText(input: { readonly relativePath: string; readonly maxBytes: number }): Promise<string>;
  createManagedDocument(input: {
    readonly relativePath: string;
    readonly content: string;
  }): Promise<ResearchVaultEntry>;
  updateManagedDocument?(input: {
    readonly relativePath: string;
    readonly content: string;
    readonly expectedContentHash: string;
  }): Promise<ResearchVaultEntry>;
  importAttachment(input: {
    readonly suggestedName: string;
    readonly content: Uint8Array;
    readonly mediaType: string;
  }): Promise<ResearchVaultEntry>;
  buildOpenUri(relativePath: string): string;
}

export interface ResearchIndexStatus {
  readonly vaultId: string;
  readonly freshness: 'fresh' | 'stale' | 'unavailable';
  readonly lastSyncAt?: Date;
  readonly diagnostic?: string;
}
export type ResearchSearchHit = {
  readonly document: ResearchDocumentIndex;
  readonly snippet: string;
  readonly score?: number;
};
