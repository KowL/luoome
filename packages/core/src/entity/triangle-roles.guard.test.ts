import { describe, expect, it } from 'vitest';

import {
  BearRationaleSchema,
  BullRationaleSchema,
  JudgeVerdictSchema,
  RiskOfficerVerdictSchema,
} from './triangle-roles.js';

/**
 * REQ-M4-02 的**结构性**保证。
 *
 * ## 为什么这些必须是 schema 级而不是文档约定
 *
 * 本会话已经十次「schema/能力定义对了，但没人用 / 用错了」。
 * 而这组约束的性质更硬：**它必须让错误「写不出来」**，而不是「写出来被 review 抓住」。
 *
 * 1. 证据只能是 fact id → 若允许自由文本，四角色就不再共享上下文
 * 2. 裁决官无 buy/sell → 若 schema 里有 `action`，下游一定会有人填
 */
const bull = {
  role: 'bull' as const,
  factIds: ['fact-1'],
  thesis: '多头论点',
  falsifiable: [
    { statement: 'a', factIds: ['f1'], checkBy: null },
    { statement: 'b', factIds: ['f2'], checkBy: null },
    { statement: 'c', factIds: ['f3'], checkBy: null },
  ],
};

describe('多头：≥3 条可证伪条件（PRD 明文）', () => {
  it('3 条通过', () => {
    expect(BullRationaleSchema.safeParse(bull).success).toBe(true);
  });

  it('2 条被拒', () => {
    expect(
      BullRationaleSchema.safeParse({ ...bull, falsifiable: bull.falsifiable.slice(0, 2) }).success,
    ).toBe(false);
  });

  it('证据必须是 fact id 数组——**传自由文本被拒**', () => {
    // 这就是「角色间只传 fact 引用」的结构性保证。
    const asText = BullRationaleSchema.safeParse({ ...bull, factIds: '价格突破了均线' });
    expect(asText.success).toBe(false);
  });
});

describe('空头：专职证伪，每条反驳都指向 fact', () => {
  it('合法形态通过', () => {
    const ok = BearRationaleSchema.safeParse({
      role: 'bear',
      factIds: ['fact-1'],
      thesis: '空头论点',
      refutations: [{ targetIndex: 0, factIds: ['f9'], statement: '这条证伪不成立' }],
    });
    expect(ok.success).toBe(true);
  });

  it('反驳**没有 fact 依据**被拒', () => {
    const bad = BearRationaleSchema.safeParse({
      role: 'bear',
      factIds: ['fact-1'],
      thesis: 't',
      refutations: [{ targetIndex: 0, factIds: [], statement: '空口反驳' }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('裁决官：**无 buy/sell 权限**（红线）', () => {
  const verdict = {
    role: 'judge' as const,
    disagreementPoints: [
      {
        factIds: ['fact-1'],
        description: '双方对这条事实的解读不同',
        bullReading: '偏多',
        bearReading: '偏空',
      },
    ],
    agreements: [],
    status: 'concluded' as const,
    blockers: [],
  };

  it('合法形态通过', () => {
    expect(JudgeVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  it('schema **不含** action / side / direction / recommendation 字段', () => {
    // 逐个尝试注入，**全部必须被 strict 拒绝**。
    // 这不是「约定不填」，是「根本没有这个位置」。
    for (const field of ['action', 'side', 'direction', 'recommendation', 'signal']) {
      const injected = JudgeVerdictSchema.safeParse({ ...verdict, [field]: 'buy' });
      expect(injected.success, `裁决官不应接受 ${field} 字段`).toBe(false);
    }
  });

  it('**need-more-data 是正常输出，不是 error 路径**', () => {
    // PRD：因事实缺口而不下结论是一等公民。
    const need = JudgeVerdictSchema.safeParse({
      ...verdict,
      status: 'need-more-data',
      blockers: [{ factId: 'fact-x', reason: '该 fact 缺失' }],
    });
    expect(need.success).toBe(true);
    // status 是**正常字段**，不是 error。
    if (need.success) expect(need.data.status).toBe('need-more-data');
  });

  it('分歧点必须定位到具体 fact id（不能只有文字描述）', () => {
    const vague = JudgeVerdictSchema.safeParse({
      ...verdict,
      disagreementPoints: [
        { factIds: [], description: '就是感觉不对', bullReading: '多', bearReading: '空' },
      ],
    });
    expect(vague.success).toBe(false);
  });
});

describe('风险官：pass / veto(reason+evidence) / need-more-data', () => {
  it('pass 通过', () => {
    expect(
      RiskOfficerVerdictSchema.safeParse({ role: 'risk-officer', status: 'pass' }).success,
    ).toBe(true);
  });

  it('veto **必须带 fact 依据**（只有理由不算）', () => {
    expect(
      RiskOfficerVerdictSchema.safeParse({
        role: 'risk-officer',
        status: 'veto',
        reason: '风险过高',
        factIds: ['f1'],
      }).success,
    ).toBe(true);
    expect(
      RiskOfficerVerdictSchema.safeParse({
        role: 'risk-officer',
        status: 'veto',
        reason: '风险过高',
        factIds: [],
      }).success,
    ).toBe(false);
  });

  it('need-more-data 通过', () => {
    expect(
      RiskOfficerVerdictSchema.safeParse({
        role: 'risk-officer',
        status: 'need-more-data',
        factIds: ['f1'],
        reason: '缺持仓成本',
      }).success,
    ).toBe(true);
  });
});
