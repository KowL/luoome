import { type AnalysisSubject, RiskVetoSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createInMemoryRepos } from './memory/index.js';

/**
 * REQ-M5-04：**否决绑定 `accountId + subject`，不是 `contextId`**。
 *
 * ## 这条测试要证明什么
 *
 * 「重新取一个 context 绕过否决」在 `contextId` 绑定时是**必然发生**的：
 * 新 context 是新 id，旧 veto 不跟过去。
 * 所以这里**故意用两个不同的 contextId**，断言否决仍然生效。
 */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SUBJECT: AnalysisSubject = { kind: 'stock', id: '600519.SH' };

const veto = (id: string, contextId: string) =>
  RiskVetoSchema.parse({
    id,
    accountId: ACCOUNT,
    subject: SUBJECT,
    reason: '数据显示趋势已破坏，不支持继续加仓',
    factIds: ['fact-1'],
    contextId,
    createdAt: new Date('2026-07-29T08:00:00Z'),
  });

describe('否决绑定键：accountId + subject', () => {
  it('**换 contextId 仍能查到否决**（这就是「重取 context 绕过」被挡住的原因）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(veto('v1', 'context-A'));
    // 用**完全不同的** contextId 去查 —— 若绑定键是 contextId，这里会是 null
    const found = await repos.riskVeto.findActiveBySubject({
      accountId: ACCOUNT,
      subject: SUBJECT,
    });
    expect(found).not.toBeNull();
    expect(found?.veto.id).toBe('v1');
    // 绑定键不含 contextId：记录的 contextId 只是审计信息
    expect(found?.veto.contextId).toBe('context-A');
  });

  it('**同 accountId 不同 subject → 查不到**（不能过度封锁）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(veto('v1', 'context-A'));
    const other = await repos.riskVeto.findActiveBySubject({
      accountId: ACCOUNT,
      subject: { kind: 'stock', id: '000001.SZ' },
    });
    expect(other).toBeNull();
  });

  it('**不同 accountId 同 subject → 查不到**（不跨账户泄漏）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(veto('v1', 'context-A'));
    const other = await repos.riskVeto.findActiveBySubject({
      accountId: '00000000-0000-4000-8000-000000000000',
      subject: SUBJECT,
    });
    expect(other).toBeNull();
  });

  it('override 之后 → 不再返回（放行）', async () => {
    const repos = createInMemoryRepos();
    await repos.riskVeto.save(veto('v1', 'context-A'));
    await repos.riskVeto.saveOverride({
      id: 'o1',
      vetoId: 'v1',
      overriddenBy: 'user',
      reason: '已看到新的产量数据',
      newFactIds: ['fact-2'],
      overriddenAt: new Date('2026-07-29T09:00:00Z'),
    });
    const found = await repos.riskVeto.findActiveBySubject({
      accountId: ACCOUNT,
      subject: SUBJECT,
    });
    // **有 override ⇒ 判定为放行**（返回 null 表示「没有仍在生效的否决」）
    expect(found).toBeNull();
  });
});
