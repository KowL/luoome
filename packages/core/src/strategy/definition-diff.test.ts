import { describe, expect, it } from 'vitest';
import { strategyDefinitionHash } from '../entity/strategy.js';
import { diffStrategyDefinitions } from './definition-diff.js';

const definition = () => ({
  schemaVersion: 1 as const,
  metadata: { style: 'trend', horizon: 'short' as const },
  universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] },
  selection: { logic: 'all' as const, rules: [] },
  signals: { entry: [], exit: [], risk: [] },
});

describe('diffStrategyDefinitions', () => {
  it('returns stable nested changes and summary', () => {
    const from = definition();
    const to = { ...from, metadata: { ...from.metadata, style: 'value' } };
    const diff = diffStrategyDefinitions(
      from,
      to,
      strategyDefinitionHash(from),
      strategyDefinitionHash(to),
    );
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([
      { path: 'metadata.style', kind: 'changed', before: 'trend', after: 'value' },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it('treats reordered object keys as equal', () => {
    const from = definition();
    const to = {
      signals: from.signals,
      selection: from.selection,
      universe: from.universe,
      metadata: from.metadata,
      schemaVersion: from.schemaVersion,
    };
    const diff = diffStrategyDefinitions(
      from,
      to,
      strategyDefinitionHash(from),
      strategyDefinitionHash(to),
    );
    expect(diff.changed).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });
});
