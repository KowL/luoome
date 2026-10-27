import { describe, expect, it, vi } from 'vitest';
import {
  keepOperationCredential,
  operationIsUnsettled,
  operationResult,
  requestResearch,
  researchExportJson,
  researchUrl,
  unwrapResearchResult,
} from './research-transport.js';

describe('research transport and receipts', () => {
  it('keeps fixed research reads under the DSH mount and encodes filters', () => {
    const path = researchUrl('diagnostics', 'personal-strategy', {
      query: '价格 & 量',
      offset: 0,
      limit: 20,
      runId: 'run:a',
      unused: undefined,
    });
    const url = new URL(path, 'https://example.test/dsh/');
    expect(url.pathname).toBe('/dsh/api/luoome/research');
    expect(url.searchParams.get('query')).toBe('价格 & 量');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('unused')).toBe(false);
  });

  it('sends only same origin no store requests and propagates cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { state: null } }),
    }));
    await expect(
      requestResearch('api/luoome/call', {
        body: { tool: 'get_strategy', input: { strategyId: 'strategy-a' } },
        signal: controller.signal,
        fetcher,
      }),
    ).resolves.toEqual({ state: null });
    expect(fetcher).toHaveBeenCalledWith(
      'api/luoome/call',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      }),
    );
  });

  it('does not accept permission errors, invalid JSON or failed nested tool results as evidence', async () => {
    const rejected = vi.fn(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: { kind: 'permission_denied' } }),
    }));
    await expect(
      requestResearch('api/luoome/research', { fetcher: rejected }),
    ).rejects.toMatchObject({ kind: 'permission_denied' });
    const lost = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('broken response');
      },
    }));
    await expect(
      requestResearch('api/luoome/operations/prepare', { fetcher: lost }),
    ).rejects.toThrow('先核对原回执');
    expect(() => unwrapResearchResult({ ok: false, error: { kind: 'unavailable' } })).toThrow(
      '不可用',
    );
  });

  it('requires a settled successful business result, keeping unknown and tool failures blocked', () => {
    expect(
      operationResult({ state: 'unknown', result: { ok: true, data: { selectedCount: 10 } } }),
    ).toBeNull();
    expect(
      operationResult({
        state: 'succeeded',
        result: { ok: false, error: { kind: 'unavailable' } },
      }),
    ).toBeNull();
    expect(
      operationResult({ state: 'succeeded', result: { ok: true, data: { selectedCount: 0 } } }),
    ).toEqual({ selectedCount: 0 });
    expect(operationIsUnsettled({ state: 'executing' })).toBe(true);
    expect(operationIsUnsettled({ state: 'cancelled' })).toBe(false);
  });

  it('keeps a confirmation credential only for the same pending operation in memory', () => {
    const pending = {
      operationId: 'operation-a',
      state: 'pending',
      confirmationToken: 'memory-only',
    };
    expect(
      keepOperationCredential(pending, { operationId: 'operation-a', state: 'pending' })
        .confirmationToken,
    ).toBe('memory-only');
    expect(
      keepOperationCredential(pending, { operationId: 'operation-b', state: 'pending' })
        .confirmationToken,
    ).toBeUndefined();
    expect(
      keepOperationCredential(pending, { operationId: 'operation-a', state: 'succeeded' })
        .confirmationToken,
    ).toBeUndefined();
  });

  it('exports the full research envelope, preserving evidence, conclusions and reproducibility limits', () => {
    const exported = {
      manifest: { definition: { schemaVersion: 1 } },
      canonicalJson: '{"definition":{"schemaVersion":1}}',
      manifestHash: 'definition-hash',
      evidenceReferences: ['strategy-version:v2', 'strategy-evaluation:session-a'],
      researchState: {
        revision: 2,
        state: {
          question: '验证量比',
          conclusion: {
            outcome: 'inconclusive',
            summary: '缺少历史事实',
            limitations: ['PIT 不完整'],
          },
        },
      },
      reproducibility: {
        definitionPortable: true,
        marketDataIncluded: false,
        trialSnapshotsIncluded: false,
        limitations: ['供应商历史数据不随文件提供'],
      },
    };
    const downloaded = JSON.parse(researchExportJson(exported));
    expect(downloaded.manifestHash).toBe(exported.manifestHash);
    expect(downloaded.canonicalJson).toBe(exported.canonicalJson);
    expect(downloaded.evidenceReferences).toEqual(exported.evidenceReferences);
    expect(downloaded.researchState.state.conclusion).toEqual(
      exported.researchState.state.conclusion,
    );
    expect(downloaded.reproducibility).toEqual(exported.reproducibility);
  });
});
