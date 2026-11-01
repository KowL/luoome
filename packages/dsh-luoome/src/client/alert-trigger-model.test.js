import { describe, expect, it, vi } from 'vitest';

import {
  applyThresholdEdits,
  canEditThresholds,
  requestTriggerDetail,
  ruleEditorView,
  ruleSummaryText,
  submitAlertPlanUpdate,
  triggerDetailRequest,
  triggerDetailView,
  triggerEditPrompt,
  updateAlertPlanInput,
} from './alert-trigger-model.js';

/**
 * M4-10 (task-45) 的纯逻辑。
 *
 * 本会话已经在**同一个地方**栽过三次：「能力有了但没接上」——
 * `list_trading_plans` 在 registry 不在 allowlist、`plans.js` 打不存在的 `/execute`、
 * `data-plan-history-count` 渲染了但没测试触发。
 *
 * 所以这里的重点不是「视图映射对不对」，而是**证明 `resolve_watch_notification` 真的被调用**、
 * 且**草稿路径真的不发送**。
 */
describe('触发详情：请求构造与真实调用', () => {
  it('请求名与入参就是 resolve_watch_notification + triggerId', () => {
    expect(triggerDetailRequest('tr-1')).toEqual({
      tool: 'resolve_watch_notification',
      input: { triggerId: 'tr-1' },
    });
  });

  it('**真的发出了请求**（不是只在界面上拼计划名）', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: { trigger: { id: 'tr-1' }, planSourceKind: 'alert-plan' },
      }),
    }));
    const result = await requestTriggerDetail('tr-1', { fetcher });
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 断言实际发出的 body 里带的是这个工具名——「界面上出现计划名」可能来自 client 自己拼，
    // 只有请求体能证明能力真的接上了。
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      tool: 'resolve_watch_notification',
      input: { triggerId: 'tr-1' },
    });
  });

  it('请求失败时返回原因，不让 UI 崩', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: { kind: 'permission_denied' } }),
    }));
    const result = await requestTriggerDetail('tr-1', { fetcher });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('permission_denied');
  });
});

describe('触发详情：三个分支必须分开', () => {
  const watchlistTrigger = {
    trigger: { id: 'tr-1' },
    planSourceKind: 'alert-plan',
    alertPlan: {
      id: 'plan-1',
      name: '默认规则',
      rules: [{ id: 'r1', kind: 'price-level', text: '价格 上穿 100' }],
    },
  };

  it('有告警计划 → 可**就地改条件**（路径一可用）', () => {
    const view = triggerDetailView(watchlistTrigger);
    expect(view.canEditInPlace).toBe(true);
    expect(view.alertPlanName).toBe('默认规则');
    expect(view.rules[0]?.text).toBe('价格 上穿 100');
    expect(view.canDraft).toBe(true);
  });

  it('计划类触发 → 有 sourcePlan，但**不提供就地改规则**（版本不可变）', () => {
    const view = triggerDetailView({
      trigger: { id: 'tr-2' },
      planSourceKind: 'trading-plan-watch',
      sourcePlan: { versionId: 'plan-1:v2', stockId: '600519.SH', status: 'active' },
    });
    expect(view.sourcePlan?.versionId).toBe('plan-1:v2');
    expect(view.canEditInPlace).toBe(false);
    // 必须说清原因，不是给一个点了报错的按钮
    expect(view.inPlaceDisabledReason).toMatch(/计划版本不可变/);
    expect(view.canDraft).toBe(true);
  });

  it('trigger-without-alert-plan → 路径一不可用且**明确说明原因**', () => {
    const view = triggerDetailView({
      trigger: { id: 'tr-3' },
      planSourceKind: 'unknown',
      alertPlanReason: 'trigger-without-alert-plan',
    });
    expect(view.canEditInPlace).toBe(false);
    expect(view.inPlaceDisabledReason).toBe('这条提醒没有对应的告警计划，无法就地改条件');
    // 路径二仍可用
    expect(view.canDraft).toBe(true);
  });

  it('规则摘要缺失时如实说缺失，不编', () => {
    expect(ruleSummaryText(null)).toBe('规则详情缺失');
    expect(ruleSummaryText({ id: 'r', kind: 'price-level' })).toBe('price-level');
  });
});

describe('两条路径的入参与草稿', () => {
  it('路径一只带 alertPlanId + 完整 rules（不带半个规则）', () => {
    const input = updateAlertPlanInput({
      alertPlanId: 'plan-1',
      rules: [{ id: 'r1', kind: 'price-level', level: 110, side: 'above' }],
    });
    expect(input).toEqual({
      alertPlanId: 'plan-1',
      rules: [{ id: 'r1', kind: 'price-level', level: 110, side: 'above' }],
    });
  });

  it('路径二草稿带上当前阈值与目标，且**不含任何发送动作**', () => {
    const view = triggerDetailView({
      trigger: { id: 'tr-1' },
      planSourceKind: 'alert-plan',
      alertPlan: {
        id: 'plan-1',
        name: '默认规则',
        rules: [{ id: 'r1', kind: 'price-level', text: '价格 上穿 100' }],
      },
    });
    const prompt = triggerEditPrompt({ view, rule: view.rules[0], desired: '改成 110' });
    expect(prompt).toContain('默认规则');
    expect(prompt).toContain('价格 上穿 100');
    expect(prompt).toContain('改成 110');
    // 草稿是「请先读取…我确认后再写入」，不是「帮我改」——不能诱导自动写入。
    expect(prompt).toContain('我确认后再写入');
  });
});

describe('路径一必须走 Operation（不许绕过 policy）', () => {
  it('提交落点是 operations/prepare，工具名是 update_alert_plan', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { operationId: 'op-1', state: 'succeeded' } }),
    }));
    const input = updateAlertPlanInput({ alertPlanId: 'plan-1', rules: [] });
    await submitAlertPlanUpdate(input, { fetcher, operationId: 'op-1' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    // **mutation 判据**：改成直接打 `api/luoome/call` 会在这里红。
    expect(url).toBe('api/luoome/operations/prepare');
    const body = JSON.parse(init.body);
    expect(body.tool).toBe('update_alert_plan');
    expect(body.input).toEqual(input);
    // 写路径必须带 operationId（Operation 的身份）
    expect(body.id).toBe('op-1');
  });

  it('失败时抛错而不是静默成功', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: { kind: 'invalid_input', message: '规则不合法' } }),
    }));
    await expect(
      submitAlertPlanUpdate({ alertPlanId: 'p', rules: [] }, { fetcher, operationId: 'o' }),
    ).rejects.toThrow('规则不合法');
  });
});

describe('就地改阈值（最小可用范围）', () => {
  it('三种 kind 可编辑，其余不可编辑并给出原因', () => {
    expect(canEditThresholds('price-level')).toBe(true);
    expect(canEditThresholds('price-change')).toBe(true);
    expect(canEditThresholds('cost-threshold')).toBe(true);
    expect(canEditThresholds('strategy-signal')).toBe(false);
    expect(canEditThresholds('event-date')).toBe(false);
    const view = ruleEditorView({ id: 'r', kind: 'strategy-signal' });
    expect(view.editable).toBe(false);
    expect(view.reason).toBe('该规则类型暂不支持就地编辑');
  });

  it('`cost-threshold` 对应**两个**输入框（没有单个 percent 字段）', () => {
    // 真实 schema 是 stopLossPct / takeProfitPct 两个可选比例（`watch-trigger.ts:94-105`），
    // 不是 Lead 口述的 `percent`。按 schema 实现。
    const view = ruleEditorView({
      id: 'r1',
      kind: 'cost-threshold',
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
    });
    expect(view.fields.map((item) => item.field)).toEqual(['stopLossPct', 'takeProfitPct']);
    // 界面值是百分比：0.05 → 5
    expect(view.fields[0].value).toBe(5);
    expect(view.fields[1].value).toBe(12);
  });

  it('`price-change` 的界面值是百分比，存储是 0–1', () => {
    const view = ruleEditorView({ id: 'r2', kind: 'price-change', pct: 0.03 });
    expect(view.fields[0].value).toBe(3);
    expect(view.fields[0].scale).toBe(0.01);
  });

  it('**其余规则原样带回**（整体替换语义，不能只传被改的那条）', () => {
    const rules = [
      { id: 'r1', kind: 'price-level', level: 100, side: 'above' },
      { id: 'r2', kind: 'price-change', pct: 0.03, direction: 'any' },
      { id: 'r3', kind: 'event-date', eventKinds: ['dividend'] },
    ];
    const next = applyThresholdEdits(rules, [{ ruleId: 'r1', values: { level: '110' } }]);
    // 被改的那条变了
    expect(next[0]).toEqual({ id: 'r1', kind: 'price-level', level: 110, side: 'above' });
    // 其余两条**逐字段相同**
    expect(next[1]).toEqual(rules[1]);
    expect(next[2]).toEqual(rules[2]);
    // 入参没被就地修改
    expect(rules[0].level).toBe(100);
  });

  it('百分比输入换算成存储值（5 → 0.05），只换算一次', () => {
    const rules = [{ id: 'r2', kind: 'price-change', pct: 0.03, direction: 'any' }];
    const next = applyThresholdEdits(rules, [{ ruleId: 'r2', values: { pct: '5' } }]);
    expect(next[0].pct).toBe(0.05);
  });

  it('空值不覆盖原值（用户没填的字段保持原样）', () => {
    const rules = [{ id: 'r1', kind: 'price-level', level: 100, side: 'above' }];
    const next = applyThresholdEdits(rules, [{ ruleId: 'r1', values: { level: '' } }]);
    expect(next[0].level).toBe(100);
  });
});
