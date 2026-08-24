import type {
  ResearchEmbeddingModelIdentity,
  ResearchEmbeddingUsage,
} from './entity/research-embedding.js';
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

/**
 * 外部研究资料抓取的 core 侧契约。网络策略（SSRF、重定向、大小、超时和媒体类型）
 * 必须封装在 adapter 内，Tool 只消费已校验的有限字节内容。
 */
export interface ResearchRemoteDocument {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly fetchedAt: Date;
}

export interface ResearchRemoteImportAdapterLike {
  readonly name: string;
  fetchDocument(input: {
    readonly url: string;
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly maxRedirects: number;
  }): Promise<ResearchRemoteDocument>;
}

export interface ResearchEmbeddingAdapterLike {
  readonly name: string;
  readonly defaultModel: string;
  listModels(): readonly {
    readonly name: string;
    readonly identity: ResearchEmbeddingModelIdentity;
  }[];
  embed(input: {
    readonly model?: string;
    readonly purpose: 'document' | 'query' | 'evaluation';
    readonly texts: readonly string[];
  }): Promise<{
    readonly identity: ResearchEmbeddingModelIdentity;
    readonly vectors: readonly (readonly number[])[];
    readonly usage: ResearchEmbeddingUsage;
  }>;
}

export type ResearchVaultGitPullFailureReason =
  | 'cancelled'
  | 'timeout'
  | 'git-unavailable'
  | 'not-git-repository'
  | 'dirty-worktree'
  | 'operation-in-progress'
  | 'detached-head'
  | 'missing-upstream'
  | 'unsafe-remote'
  | 'diverged'
  | 'backup-failed'
  | 'fetch-failed'
  | 'integrate-failed';

export type ResearchVaultGitPullResult =
  | {
      readonly ok: true;
      readonly status: 'updated' | 'up-to-date';
      readonly backupId?: string;
    }
  | {
      readonly ok: false;
      readonly reason: ResearchVaultGitPullFailureReason;
      readonly message: string;
      readonly recoverable: boolean;
    };

/**
 * Phase F 远端同步端口。它与 ResearchVaultAdapterLike 分离：前者只负责安全更新本地 Git
 * 工作树，后者继续只负责把本地 Vault 当作权威文件源读取和写入。
 */
export interface ResearchVaultGitSyncAdapterLike {
  readonly name: string;
  readonly provider: 'git';
  pull(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<ResearchVaultGitPullResult>;
}
export interface ResearchIndexStatus {
  readonly vaultId: string;
  readonly freshness: 'fresh' | 'stale' | 'unavailable';
  readonly lastSyncAt?: Date;
  readonly diagnostic?: string;
}
export type ResearchSearchHit = {
  readonly document: ResearchDocumentIndex;
  /** 具体 chunk ordinal；用于把检索结果变成可审计 EvidenceRef。 */
  readonly ordinal?: number;
  readonly headingPath?: string;
  readonly snippet: string;
  readonly score?: number;
};
