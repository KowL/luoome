// 触发详情的**纯逻辑**（M4-10 / task-45）。
//
// 这里只放「怎么请求 / 怎么解读结果 / 怎么构造草稿」，不碰 React：
// client 的 `.js` 在本仓无法被测试加载（`react` 不在依赖里），
// 把可验证的规则抽出来，才能为「能力接了没接上」写断言。

import { requestResearch } from './research-transport.js';

/**
 * 单条触发的核对请求。
 *
 * 为什么是**按需单条**而不是面板批量读：`resolve_watch_notification` 的入参是
 * `{ triggerId }`，而面板读计划是「一次性调用 + 固定输入」。硬塞进读计划只能
 * 取到「最新一条」，其余触发永远没详情。
 *
 * **能力接了没接上**这件事本身要有证据：调用点集中在 `requestTriggerDetail`，
 * 守卫断言它真的被调用（见 `alert-trigger-model.test.js`）。
 */
export const triggerDetailRequest = (triggerId) => ({
  tool: 'resolve_watch_notification',
  input: { triggerId },
});

/**
 * 调用 `resolve_watch_notification` 并返回其 `data`。
 *
 * 失败不抛给 UI 崩：返回 `{ ok: false, reason }`，由展示层说明「为什么没有详情」。
 */
export const requestTriggerDetail = async (
  triggerId,
  { fetcher = globalThis.fetch, path = 'api/luoome/call' } = {},
) => {
  try {
    const data = await requestResearch(path, {
      body: triggerDetailRequest(triggerId),
      fetcher,
    });
    return { ok: true, detail: data };
  } catch (error) {
    return { ok: false, reason: error?.kind ?? 'client/unavailable' };
  }
};

/** 规则摘要里最关键的数值，拼成一行人话（缺失就说缺失，不编）。 */
export const ruleSummaryText = (rule) => {
  if (rule === null || rule === undefined) return '规则详情缺失';
  if (typeof rule.text === 'string' && rule.text.length > 0) return rule.text;
  return rule.kind ?? '规则详情缺失';
};

/**
 * 把 `resolve_watch_notification` 的返回值映射成**展示模型**。
 *
 * ## 三个分支必须分开，因为用户要做的事不同
 *
 * 1. **有告警计划**（watchlist 规则触发）→ 可**就地改条件**（路径一可用）
 * 2. **计划类触发**（`planSourceKind === 'trading-plan-watch'`）→ 有 `sourcePlan`
 *    （计划版本不可变，改条件等于发新版本），**不提供就地改规则**
 * 3. **`trigger-without-alert-plan`** → 路径一**不可用**，且必须**明确说明原因**，
 *    不是给一个点了报错的按钮（PRD 明文）
 *
 * 路径二（AI 草稿）在三者都可用。
 */
export const triggerDetailView = (detail) => {
  if (detail === null || detail === undefined)
    return {
      available: false,
      reasonText: '触发详情暂不可用',
      canEditInPlace: false,
      inPlaceDisabledReason: '触发详情暂不可用',
      canDraft: true,
    };

  const alertPlan = detail.alertPlan ?? null;
  const sourcePlan = detail.sourcePlan ?? null;
  const planSourceKind = detail.planSourceKind ?? 'unknown';
  const alertPlanReason = detail.alertPlanReason ?? null;

  // 计划类触发：来源是计划版本，不是告警计划。
  if (planSourceKind === 'trading-plan-watch') {
    return {
      available: true,
      triggerId: detail.trigger?.id ?? null,
      alertPlanName: null,
      alertPlanReason: 'trigger-from-trading-plan',
      alertPlanReasonText: '这条提醒来自交易计划条件，不是告警规则。',
      sourcePlan: sourcePlan
        ? {
            versionId: sourcePlan.versionId,
            stockId: sourcePlan.stockId,
            status: sourcePlan.status,
            text: `计划版本 ${sourcePlan.versionId}（${sourcePlan.status}）`,
          }
        : null,
      sourcePlanReasonText: sourcePlan === null ? '原计划版本已不可解析（可能已被删除）。' : null,
      rules: [],
      // 计划版本不可变：「就地改条件」会变成「改写历史版本」，不允许。
      canEditInPlace: false,
      inPlaceDisabledReason:
        '这条提醒来自交易计划条件，计划版本不可变；请基于最新版重新生成计划，或让 AI 起草。',
      canDraft: true,
    };
  }

  // 没有关联告警计划：路径一**不可用**，必须说清原因（不是给个会报错的按钮）。
  if (alertPlan === null || alertPlan === undefined) {
    const noPlan = alertPlanReason === 'trigger-without-alert-plan';
    return {
      available: true,
      triggerId: detail.trigger?.id ?? null,
      alertPlanName: null,
      alertPlanReason,
      alertPlanReasonText: noPlan
        ? '这条提醒没有对应的告警计划，无法就地改条件。'
        : `告警计划已不可用（${String(alertPlanReason ?? '未知原因')}）。`,
      sourcePlan: null,
      sourcePlanReasonText: null,
      rules: [],
      canEditInPlace: false,
      inPlaceDisabledReason: noPlan
        ? '这条提醒没有对应的告警计划，无法就地改条件'
        : '所属告警计划已不可用，无法就地改条件',
      canDraft: true,
    };
  }

  return {
    available: true,
    triggerId: detail.trigger?.id ?? null,
    alertPlanName: alertPlan.name ?? alertPlan.id ?? null,
    alertPlanReason: null,
    alertPlanReasonText: null,
    sourcePlan: null,
    sourcePlanReasonText: null,
    rules: (alertPlan.rules ?? []).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      text: ruleSummaryText(rule),
    })),
    canEditInPlace: true,
    inPlaceDisabledReason: null,
    canDraft: true,
  };
};

/**
 * 就地改条件的**入参形状**（路径一）。
 *
 * 只带用户改的那个字段 + `alertPlanId`；**不带**整条规则对象。
 * 理由：`update_alert_plan` 的 `rules` 是整体替换，传半个规则会把其它字段抹成默认值。
 * 调用方（UI）负责先合并出完整 `rules`，这里只表达「形状」并做守卫断言。
 */
export const updateAlertPlanInput = ({ alertPlanId, rules }) => ({
  alertPlanId,
  rules,
});

/**
 * 路径二（AI 草稿）的提示词。
 *
 * **只填进输入框，绝不自动发送**（PRD 硬要求）：
 * 草稿路径的意义是「用户还能改」，自动发送等于替用户做了决定。
 */
export const triggerEditPrompt = ({ view, rule, desired }) => {
  const planName = view?.alertPlanName ?? '（未命名告警计划）';
  const current =
    rule === null || rule === undefined
      ? '（当前规则详情缺失）'
      : `${rule.kind}：${ruleSummaryText(rule)}`;
  return [
    `我要改这条触发对应的告警规则。`,
    `所属告警计划：${planName}`,
    `当前规则：${current}`,
    `想改成：${desired ?? '（请补充目标阈值或方向）'}`,
    '',
    '请先读取当前规则与计划，再给我具体的修改方案；我确认后再写入。',
  ].join('\n');
};

/**
 * 路径一的提交器：走 **Operation**（`update_alert_plan` 是 write，必须经 policy）。
 *
 * 为什么不直接调工具：`update_alert_plan` 不在只读调用面，绕过 Operation 等于
 * 绕开授权与回执。**mutation 验证**：把这里改成直接 `api/luoome/call` 会红
 * （`alert-trigger-model.test.js` 断言请求落点是 `operations/prepare`）。
 */
export const submitAlertPlanUpdate = async (
  input,
  { fetcher = globalThis.fetch, path = 'api/luoome/operations/prepare', operationId } = {},
) => {
  const response = await fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      id: operationId,
      tool: 'update_alert_plan',
      input,
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true)
    throw new Error(result?.error?.message ?? result?.error?.kind ?? '规则更新失败');
  return result.data;
};
