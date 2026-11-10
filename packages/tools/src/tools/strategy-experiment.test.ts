import { STRATEGY_FIELD_REGISTRY } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStrategyDslCatalogTool } from './strategy-experiment.js';

describe('strategy experiment read tools', () => {
  it('projects the Field Registry into a DSL catalog without a second field allowlist', async () => {
    const ctx = await buildTestContext();
    const result = await getStrategyDslCatalogTool.execute({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { schemaVersion: 1 } });
    if (!result.ok) return;
    expect(result.data.fields.map((field) => field.path)).toEqual(
      STRATEGY_FIELD_REGISTRY.map((field) => field.path),
    );
    expect(result.data.fields.find((field) => field.path === 'quote.close')).toMatchObject({
      type: 'number',
      unit: 'CNY',
      dataSource: 'quote',
      coverage: ['CN_A_SHARES_SH_SZ'],
      operators: expect.arrayContaining(['>', '+', '*']),
    });
    expect(result.data.fields.find((field) => field.path === 'meta.recentLimitUp')).toMatchObject({
      type: 'boolean',
      operators: expect.arrayContaining(['&&', '!', '==']),
    });
    expect(result.data.limits).toEqual({
      selectionRules: null,
      scoringComponents: null,
      signalRulesPerScope: null,
    });
  });
});
