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
  scan(input?: { readonly roots?: readonly string[] }): Promise<readonly ResearchVaultEntry[]>;
  readText(input: { readonly relativePath: string; readonly maxBytes: number }): Promise<string>;
  createManagedDocument(input: {
    readonly relativePath: string;
    readonly content: string;
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
  readonly headingPath?: string;
  readonly snippet: string;
  readonly score?: number;
};
