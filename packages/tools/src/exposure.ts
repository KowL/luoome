import type { SideEffect } from '@luoome/core';

export interface ToolExposureNames {
  readonly allowlist?: ReadonlySet<string> | undefined;
  readonly denylist?: ReadonlySet<string>;
}

// Preserve the private research boundary while removing substring-based classification.
export const privateResearchTools = [
  'run_local_selector_research',
  'list_research_topics',
  'create_research_hypothesis_version',
  'list_research_hypothesis_versions',
  'get_research_topic',
  'create_research_topic',
  'create_research_document',
  'import_local_research_document',
  'import_remote_research_document',
  'link_research_document',
  'archive_research_topic',
  'build_research_brief',
  'list_research_documents',
  'get_research_document',
  'search_research_documents',
  'get_research_embedding_status',
  'search_research_documents_hybrid',
  'rebuild_research_embeddings',
  'evaluate_research_embeddings',
  'get_stock_research_view',
  'get_research_vault_remote_sync_status',
  'sync_research_vault',
] as const;

export const selectExposedTools = <
  T extends {
    readonly name: string;
    readonly sideEffect: SideEffect;
    readonly requiredCapabilities?: readonly SideEffect[];
  },
>(
  tools: readonly T[],
  allowedSideEffects: ReadonlySet<SideEffect>,
  names: ToolExposureNames = {},
): readonly T[] =>
  tools.filter(
    (tool) =>
      tool.sideEffect !== 'trade' &&
      !tool.requiredCapabilities?.includes('trade') &&
      (names.allowlist === undefined || names.allowlist.has(tool.name)) &&
      !names.denylist?.has(tool.name) &&
      (tool.requiredCapabilities ?? [tool.sideEffect]).every((capability) =>
        allowedSideEffects.has(capability),
      ),
  );
