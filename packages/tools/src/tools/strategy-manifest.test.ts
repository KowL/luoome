import type { StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { createStrategyTool, createStrategyVersionTool } from './strategy-lifecycle.js';
import {
  exportStrategyManifestTool,
  importStrategyManifestTool,
  validateStrategyManifestTool,
} from './strategy-manifest.js';

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'positive-close',
        name: '价格有效',
        when: 'quote.close > 0',
        evidence: ['close={{quote.close}}'],
      },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const createVersion = async () => {
  const ctx = await buildTestContext();
  const strategy = await createStrategyTool.execute(
    { id: 'portable-tool-strategy', name: 'Portable tool', description: 'manifest test' },
    ctx,
  );
  expect(strategy.ok).toBe(true);
  const created = await createStrategyVersionTool.execute(
    { strategyId: 'portable-tool-strategy', definition },
    ctx,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('test StrategyVersion was not created');
  return { ctx, version: created.data.version };
};

describe('strategy manifest tools', () => {
  it('exports a version without writing, then validates and imports JSON', async () => {
    const { ctx, version } = await createVersion();
    const before = await ctx.repos.strategy.listVersions('portable-tool-strategy');

    const exported = await exportStrategyManifestTool.execute({ versionId: version.id }, ctx);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.manifest.strategy.strategyVersionId).toBe(version.id);
    expect(exported.data.manifest.dependencies.fields).toEqual([
      expect.objectContaining({ path: 'quote.close', dataSource: 'quote' }),
    ]);
    expect(exported.data.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const validated = await validateStrategyManifestTool.execute(
      { manifest: exported.data.canonicalJson },
      ctx,
    );
    expect(validated).toMatchObject({ ok: true, data: { status: 'supported' } });

    const imported = await importStrategyManifestTool.execute(
      { manifest: exported.data.manifest },
      ctx,
    );
    expect(imported).toMatchObject({
      ok: true,
      data: { status: 'supported', manifestHash: exported.data.manifestHash },
    });
    expect(await ctx.repos.strategy.listVersions('portable-tool-strategy')).toHaveLength(
      before.length,
    );
  });

  it('returns explicit unsupported or invalid results and never publishes', async () => {
    const { ctx, version } = await createVersion();
    const exported = await exportStrategyManifestTool.execute({ versionId: version.id }, ctx);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const unsupported = await validateStrategyManifestTool.execute(
      {
        manifest: {
          ...exported.data.manifest,
          dependencies: {
            ...exported.data.manifest.dependencies,
            capabilities: [
              ...exported.data.manifest.dependencies.capabilities,
              'market.vendor-proprietary',
            ],
          },
        },
      },
      ctx,
    );
    expect(unsupported).toMatchObject({
      ok: true,
      data: {
        status: 'unsupported',
        unsupported: { capabilities: ['market.vendor-proprietary'] },
      },
    });

    const invalid = await importStrategyManifestTool.execute(
      {
        manifest: {
          ...exported.data.manifest,
          strategy: { ...exported.data.manifest.strategy, definitionHash: '0'.repeat(64) },
        },
      },
      ctx,
    );
    expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const malformedJson = await validateStrategyManifestTool.execute({ manifest: '{' }, ctx);
    expect(malformedJson).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect((await ctx.repos.strategy.findById('portable-tool-strategy'))?.status).toBe('draft');
  });
});
