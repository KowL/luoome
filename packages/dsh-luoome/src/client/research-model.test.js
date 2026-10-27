import { StrategyResearchSettingsSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { researchRequestFor, stockResearchRequestFor } from './projection.js';
import {
  buildCondition,
  draftRule,
  evidenceValue,
  parseCondition,
  replaceRules,
  researchFormOf,
  researchSettingsOf,
  stockIdsFromText,
} from './research-model.js';

const number = {
  path: 'indicators.volRatio5_20',
  type: 'number',
  operators: ['>', '>=', '<', '=='],
  unit: 'ratio',
};
const boolean = { path: 'meta.priceUp', type: 'boolean', operators: ['==', '!='] };
const catalog = { fields: [number, boolean] };
const definition = {
  metadata: {},
  selection: { logic: 'all', rules: [{ id: 'selection-1' }] },
  signals: { entry: [{ id: 'selection-2' }], exit: [], risk: [] },
};

describe('catalog based research editing', () => {
  it('only constructs registered comparisons with valid literals and does not execute expressions', () => {
    expect(buildCondition(number, '>=', '-1.5')).toBe('indicators.volRatio5_20 >= -1.5');
    expect(buildCondition(number, '+', '2')).toBeNull();
    expect(buildCondition(number, '>', '0 || true')).toBeNull();
    expect(buildCondition(number, '>', '')).toBeNull();
    expect(buildCondition(boolean, '==', 'unknown')).toBeNull();
    expect(buildCondition(boolean, '==', 'false')).toBe('meta.priceUp == false');
  });

  it('keeps compound or unknown expressions out of the structured editor', () => {
    expect(parseCondition('indicators.volRatio5_20 >= 1.8', catalog)).toMatchObject({
      operator: '>=',
      value: '1.8',
    });
    expect(parseCondition('meta.priceUp == true', catalog)).toMatchObject({ value: 'true' });
    expect(parseCondition('meta.priceUp == 1', catalog)).toBeNull();
    expect(parseCondition('indicators.volRatio5_20 > 1 && meta.priceUp', catalog)).toBeNull();
    expect(parseCondition('meta.privateField > 1', catalog)).toBeNull();
  });

  it('creates collision free draft identities and preserves other rule groups', () => {
    const rule = draftRule(definition, 'selection', catalog);
    expect(rule.id).toBe('selection-3');
    expect(rule.evidence[0]).toContain(`\${indicators.volRatio5_20}`);
    const next = replaceRules(definition, 'selection', [...definition.selection.rules, rule]);
    expect(next.signals).toBe(definition.signals);
    expect(definition.selection.rules).toHaveLength(1);
  });
});

describe('research recovery and fact semantics', () => {
  it('restores pinned versions, dates and inconclusive work without following a newly published version', () => {
    const restored = researchFormOf(
      {
        revision: 4,
        state: {
          question: '提高门槛是否降低缺失率',
          baseVersionId: 'version-old',
          candidateVersionId: 'version-draft',
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-30T00:00:00.000Z',
          stockIds: ['600519.SH'],
          benchmarkStockId: '000300.SH',
          validationSessionId: 'session-incomplete',
          nextStep: '补齐历史事实',
          conclusion: {
            summary: '数据不足',
            outcome: 'inconclusive',
            limitations: ['缺公司行动'],
            evidenceReferences: ['strategy-evaluation:session-incomplete'],
          },
        },
      },
      [{ id: 'version-new' }],
      'version-new',
    );
    expect(restored).toMatchObject({
      baseVersionId: 'version-old',
      candidateVersionId: 'version-draft',
      from: '2026-09-01',
      to: '2026-09-30',
      stockText: '600519.SH',
      validationSessionId: 'session-incomplete',
      nextStep: '补齐历史事实',
      outcome: 'inconclusive',
    });
    expect(restored.evidenceReferences).toEqual(['strategy-evaluation:session-incomplete']);
    expect(researchSettingsOf(restored)).toMatchObject({
      baseVersionId: 'version-old',
      question: '提高门槛是否降低缺失率',
      stockIds: ['600519.SH'],
      conclusion: { outcome: 'inconclusive' },
    });
    expect(StrategyResearchSettingsSchema.safeParse(researchSettingsOf(restored)).success).toBe(
      true,
    );
  });

  it('retains zero and false facts and leaves missing facts unknown', () => {
    expect(evidenceValue(0)).toBe('0');
    expect(evidenceValue(false)).toBe('否');
    expect(evidenceValue(undefined)).toBe('未提供');
    expect(evidenceValue(null)).toBe('未提供');
    expect(stockIdsFromText('600519.SH，000001.SZ\n600519.SH')).toEqual(['600519.SH', '000001.SZ']);
  });

  it('round-trips the complete comparison and failed candidates through the domain save contract', () => {
    const comparison = {
      origin: 'user-recorded',
      snapshotHash: 'a'.repeat(64),
      stockIdChecksum: 'b'.repeat(64),
      dataAsOf: '2026-10-19T07:00:00.000Z',
      mode: 'replay',
      baseVersionId: 'version-old',
      candidates: [
        {
          candidateVersionId: 'v2',
          status: 'complete',
          dataHealth: 'partial',
          selectedCount: 0,
          missingCount: 2,
        },
        { candidateVersionId: 'v3', status: 'failed', error: '缺少该候选所需的历史字段' },
      ],
      limitations: ['仅规则敏感性对照，不包含原始行情或收益验证'],
    };
    const form = researchFormOf(
      { state: { question: '调整门槛', baseVersionId: 'version-old', comparison } },
      [],
      'version-new',
    );
    const payload = researchSettingsOf(form);
    expect(StrategyResearchSettingsSchema.safeParse(payload).success).toBe(true);
    expect(payload.comparison).toEqual(comparison);
    expect(payload.comparison.candidates[1].error).toBe('缺少该候选所需的历史字段');
  });

  it('binds the conversation to the saved account, immutable versions and unfinished research', () => {
    const request = researchRequestFor('strategy-a', null, {
      accountId: 'account-a',
      strategyName: '量价研究',
      baseVersionId: 'v1',
      candidateVersionId: 'v2',
      baseVersion: 1,
      candidateVersion: 2,
      question: '量比门槛',
      researchRevision: 4,
      validationSessionId: 'session-a',
      stockIds: ['600519.SH'],
      from: '2026-09-01',
      to: '2026-09-30',
      nextStep: '补数据',
    });
    expect(request.researchContext).toMatchObject({
      accountId: 'account-a',
      strategyId: 'strategy-a',
      baseVersionId: 'v1',
      candidateVersionId: 'v2',
      researchRevision: 4,
      validationSessionId: 'session-a',
    });
    expect(request.prompt).toContain('量比门槛');
    expect(request.prompt).toContain('不自动替换为最新发布版本');
    expect(request.prompt).toContain('不代表写授权');
    expect(request.prompt).toContain('缺失数据不计为零');
  });

  it('does not describe a trial diagnosis as a published match or imply write approval', () => {
    const request = stockResearchRequestFor({
      stockId: '600519.SH',
      stockName: '贵州茅台',
      strategyId: 'strategy-a',
      strategyName: '量价研究',
      version: 2,
      runId: 'memory-run',
      sourceKind: 'trial',
      selected: false,
      dataAsOf: '2026-10-27T07:00:00.000Z',
      ruleEvaluations: [{ status: 'unknown' }],
    });
    expect(request.prompt).toContain('本次内存试跑，运行未持久化');
    expect(request.prompt).toContain('未入选或数据不完整');
    expect(request.prompt).toContain('原生审批确认');
    expect(request.prompt).not.toContain('来自策略“量价研究”第 2 版的已发布匹配结果');
  });
});
