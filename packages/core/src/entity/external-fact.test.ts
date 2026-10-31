import { describe, expect, it } from 'vitest';

import { checkExternalFactPersistence, externalFactIdsOf } from './analysis-context.js';
import {
  assertExternalMarketFactInvariants,
  ExternalMarketFactSchema,
  externalFactContentHash,
  externalFactId,
} from './external-fact.js';

const NOW = new Date('2026-10-31T06:00:00.000Z');

describe('REQ-M3-16 稳定 id：contentHash 不进 id，更正后 id 不变', () => {
  const base = {
    kind: 'news' as const,
    source: 'eastmoney',
    subjectKey: '20261030001',
    observedAt: new Date('2026-10-30T01:12:00.000Z'),
  };

  it('id 由 (kind, source, subjectKey, observedAt) 决定，与内容无关', () => {
    const id = externalFactId(base);
    expect(id).toBe('extfact:news:eastmoney:20261030001:2026-10-30T01:12:00.000Z');
    // 内容不同的两次抓取得到同一 id。
    const hashA = externalFactContentHash({ ...base, payload: { title: '原稿' } });
    const hashB = externalFactContentHash({ ...base, payload: { title: '更正稿' } });
    expect(hashA).not.toBe(hashB);
    expect(externalFactId(base)).toBe(id);
  });

  it('内容哈希是规范化 JSON 的 sha256：键序不影响结果', () => {
    const a = externalFactContentHash({
      ...base,
      payload: { title: 't', summary: 's' },
    });
    const b = externalFactContentHash({
      ...base,
      payload: { summary: 's', title: 't' },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('不变量：id 与业务键不一致 → 抛错；id 含 contentHash → 抛错', () => {
    const id = externalFactId(base);
    const contentHash = externalFactContentHash({ ...base, payload: { title: 't' } });
    const fact = ExternalMarketFactSchema.parse({
      id,
      ...base,
      fetchedAt: NOW,
      provenance: {
        provider: 'eastmoney',
        observedAt: base.observedAt,
        fetchedAt: NOW,
        freshness: 'fresh',
      },
      payload: { title: 't' },
      contentHash,
      recordedAt: NOW,
    });
    expect(() => assertExternalMarketFactInvariants(fact)).not.toThrow();
    expect(() =>
      assertExternalMarketFactInvariants({
        ...fact,
        id: 'extfact:news:other:1:2026-10-30T01:12:00.000Z',
      }),
    ).toThrow(/不一致/);
    // 把内容哈希塞进 id：更正一次就会断链，必须被拒。
    expect(() =>
      assertExternalMarketFactInvariants({ ...fact, id: `${id}:${contentHash}` }),
    ).toThrow(/不得包含 contentHash/);
  });
});

describe('REQ-M3-16 L2 强制点：外部事实必须可回表', () => {
  const id = externalFactId({
    kind: 'news',
    source: 'eastmoney',
    subjectKey: '20261030001',
    observedAt: new Date('2026-10-30T01:12:00.000Z'),
  });

  it('只校 extfact: 前缀，不误伤既有 fact id', () => {
    expect(externalFactIdsOf([id, 'quote:000001.SZ', 'trade:t-1', 'position:h-1'])).toEqual([id]);
    expect(externalFactIdsOf(['quote:000001.SZ'])).toEqual([]);
  });

  it('表里查不到 → persisted-fact-missing，message 点名缺哪条 + 补法', () => {
    const issues = checkExternalFactPersistence({
      evidenceFactIds: [id],
      persistedFactIds: new Set<string>(),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('persisted-fact-missing');
    expect(issues[0]?.path).toBe('evidenceFactIds[0]');
    expect(issues[0]?.message).toContain(id);
    expect(issues[0]?.message).toContain('persist_external_facts');
  });

  it('表里查得到 → 无 issue（正例）', () => {
    expect(
      checkExternalFactPersistence({ evidenceFactIds: [id], persistedFactIds: new Set([id]) }),
    ).toEqual([]);
  });

  it('非外部 fact id 永远不触发 L2（避免误伤既有引用链）', () => {
    expect(
      checkExternalFactPersistence({
        evidenceFactIds: ['quote:000001.SZ', 'trade:t-1'],
        persistedFactIds: new Set<string>(),
      }),
    ).toEqual([]);
  });
});
