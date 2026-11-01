// 告警规则面板（task-39 批次 B）。
//
// 判据与格式化**全部来自 `projection.js` 的 `alertPlanHints`** —— 这里不写第二套。
// 提示是**提示**：Pill 与可关闭提示条，**永不阻止保存**（REQ-M3-09 Q4）。
import { Fragment, createElement as h, useState } from 'react';

import {
  applyThresholdEdits,
  requestTriggerDetail,
  ruleEditorView,
  submitAlertPlanUpdate,
  triggerDetailView,
  triggerEditPrompt,
  updateAlertPlanInput,
} from './alert-trigger-model.js';
import { usePanelState } from './data.js';
import { int, when } from './format.js';
import { Card, ErrorNote, Head, PanelHealthBadge, Pill, Section } from './primitives.js';
import { alertPlanHints, dataOf, WATCH_NOTIFICATION_DISCLOSURE } from './projection.js';

const triggerCounts = (triggers) => {
  const counts = new Map();
  for (const trigger of triggers?.triggers ?? triggers?.items ?? []) {
    const id = trigger?.alertPlanId;
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const PlanCard = ({ plan, hints, triggerCount, dismissed, onDismiss }) => {
  const shown = hints.filter((hint) => dismissed[hint.code] !== true);
  return h(
    Card,
    {
      title: plan.name ?? plan.id,
      meta: `${plan.watchlistId ?? '—'} · ${plan.enabled === true ? '已启用' : '已停用'}`,
      'data-alert-plan': plan.id,
    },
    h(
      'p',
      { className: 'luo-fine' },
      `${String((plan.rules ?? []).length)} 条规则 · 逻辑 ${plan.logic ?? 'ANY'} · 冷却 ${int(plan.cooldownMinutes)} 分钟 · 日上限 ${int(plan.dailyNotificationLimit)} · 最近触发 ${int(triggerCount)} 次`,
    ),
    shown.length === 0
      ? null
      : h(
          'div',
          { role: 'note', 'data-alert-hints': shown.length },
          h(
            'div',
            { className: 'luo-actions' },
            shown.map((hint) =>
              h(Pill, { key: hint.code, tone: hint.level === 'P0' ? 'warn' : 'quiet' }, hint.text),
            ),
            h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                'aria-label': `忽略 ${String(plan.id)} 的配置提示`,
                onClick: () => onDismiss(plan.id, shown),
              },
              '忽略提示',
            ),
          ),
        ),
    h(
      'p',
      { className: 'luo-fine' },
      '这些只是配置提示，**不会阻止保存**——保存判断在工具层，面板不重复实现。',
    ),
  );
};

/**
 * 单条触发的详情（M4-10 task-45 ①）。
 *
 * ## 为什么点开才请求
 *
 * `resolve_watch_notification` 的入参是 `{ triggerId }`，而面板读计划是
 * 「一次性调用 + 固定输入」。塞进读计划只能解析「最新一条」，
 * 其余触发永远没有详情。所以这里按需单条请求——**也正因此，「它真被调用」
 * 必须由测试证明**（见 `alert-trigger-model.test.js` 与浏览器证据）。
 */
const TriggerDetail = ({ trigger, detail, onLoad, onEditInPlace, onDraft }) => {
  const view = detail === null ? null : triggerDetailView(detail);
  return h(
    'div',
    { className: 'luo-fine', 'data-trigger-detail': trigger.id },
    h(
      'div',
      { className: 'luo-actions' },
      h(
        'button',
        {
          className: 'luo-btn',
          type: 'button',
          'data-trigger-load': trigger.id,
          onClick: () => onLoad(trigger.id),
        },
        view === null ? '查看这条提醒' : '重新读取',
      ),
      // 路径一：就地改条件。**不可用时给出原因，而不是给一个点了报错的按钮**。
      view === null
        ? null
        : view.canEditInPlace
          ? h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                'data-trigger-edit-in-place': trigger.id,
                onClick: () => onEditInPlace(view),
              },
              '就地改条件',
            )
          : h('span', { 'data-trigger-edit-unavailable': trigger.id }, view.inPlaceDisabledReason),
      // 路径二：AI 草稿（任何情况都可用）。
      view === null
        ? null
        : h(
            'button',
            {
              className: 'luo-btn',
              type: 'button',
              'data-trigger-draft': trigger.id,
              onClick: () => onDraft(view),
            },
            '让 AI 起草修改',
          ),
    ),
    view === null
      ? null
      : h(
          'div',
          { 'data-trigger-view': trigger.id },
          h(
            'p',
            null,
            `告警计划：${view.alertPlanName ?? '（无）'}`,
            view.alertPlanReasonText === null ? '' : ` · ${view.alertPlanReasonText}`,
          ),
          view.sourcePlan === null ? null : h('p', null, `计划来源：${view.sourcePlan.text}`),
          view.sourcePlanReasonText === null ? null : h('p', null, view.sourcePlanReasonText),
          view.rules.length === 0
            ? null
            : h(
                'ul',
                { className: 'luo-setting-list' },
                view.rules.map((rule) =>
                  h(
                    'li',
                    { key: rule.id, 'data-trigger-rule': rule.id },
                    `${rule.kind}：${rule.text}`,
                  ),
                ),
              ),
        ),
  );
};

export function AlertsPanel({ onDraftTriggerEdit } = {}) {
  const { results, loading, panelError, health: healthState, refresh } = usePanelState('alerts');
  const listed = dataOf(results, 'list_alert_plans');
  const watchlistsState = dataOf(results, 'list_watchlists');
  const triggers = dataOf(results, 'list_watch_triggers');
  const counts = triggerCounts(triggers);
  const [dismissed, setDismissed] = useState({});

  // ── 触发详情（M4-10 ①）：按需单条请求 ──
  const [details, setDetails] = useState({});
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const loadDetail = (triggerId) => {
    requestTriggerDetail(triggerId)
      .then((result) =>
        setDetails((current) => ({
          ...current,
          [triggerId]: result.ok ? result.detail : null,
        })),
      )
      .catch(() => setDetails((current) => ({ ...current, [triggerId]: null })));
  };

  /** 路径一：就地改条件 —— 打开 `update_alert_plan` 的 Operation 表单。 */
  const editInPlace = (view) => {
    const plan = plans.find((item) => item.name === view.alertPlanName) ?? null;
    if (plan === null) return;
    setEditing({
      // 形状由 `updateAlertPlanInput` 表达（只带 alertPlanId + 完整 rules）。
      input: updateAlertPlanInput({ alertPlanId: plan.id, rules: plan.rules ?? [] }),
      planName: plan.name,
      // 编辑态：`{ [ruleId]: { [field]: 界面值 } }`。初始为空 = 全部保持原值。
      values: {},
    });
  };
  /**
   * 路径二：AI 草稿 —— **只填输入框，不发送**。
   *
   * 复用「交给 AI 管理」同款机制（`openPromptInConversation`：写 composer 即返回，
   * 不触发发送）。**这里绝不调用任何 send**：草稿的意义是用户还能改，
   * 自动发送等于替用户做了决定（PRD 硬要求）。
   */
  const draft = (view) => {
    const rule = view.rules[0] ?? null;
    const prompt = triggerEditPrompt({ view, rule, desired: '' });
    if (typeof onDraftTriggerEdit === 'function') {
      onDraftTriggerEdit({ prompt, triggerId: view.triggerId ?? null });
      setNotice('修改需求已填入对话输入框，发送后继续。');
      return;
    }
    // 没有注入时**不静默失败**：明确告诉用户路径不可用。
    setNotice('无法打开对话输入框，请手动在对话里描述要改的规则。');
  };

  const plans = listed?.alertPlans ?? listed?.plans ?? listed?.items ?? [];
  const dismiss = (planId, hints) =>
    setDismissed((current) => ({
      ...current,
      ...Object.fromEntries(hints.map((hint) => [`${planId}:${hint.code}`, true])),
    }));

  return h(
    Fragment,
    null,
    h(PanelHealthBadge, { key: 'health', health: healthState }),
    h(Head, {
      eyebrow: 'LUOOME / 告警规则',
      title: '告警规则',
      subtitle: 'Watchlist 级规则集 · 冷却与日上限 · 配置提示',
      side: h('span', { className: 'luo-fine' }, `更新 ${when(Date.now())}`),
    }),
    panelError ? h(ErrorNote, { label: '规则读取', error: panelError }) : null,
    h(
      Section,
      { title: '规则集' },
      // 通知目标的**降级版披露**：用户必须能看见「为什么这里只有这么点信息」。
      h(
        'p',
        { className: 'luo-fine', 'data-watch-notification-disclosure': 'true' },
        WATCH_NOTIFICATION_DISCLOSURE,
      ),
      plans.length === 0
        ? h('p', { className: 'luo-fine' }, loading ? '读取中…' : '还没有告警规则。')
        : h(
            'div',
            { className: 'luo-grid', 'data-alert-list': plans.length },
            plans.map((plan) =>
              h(PlanCard, {
                key: plan.id,
                plan,
                hints: alertPlanHints(plan, watchlistsState).map((hint) => ({
                  ...hint,
                  code: `${String(plan.id)}:${hint.code}`,
                })),
                triggerCount: counts.get(plan.id) ?? 0,
                dismissed,
                onDismiss: dismiss,
              }),
            ),
          ),
    ),
    // ── 就地改条件（M4-10 ②）：走 Operation，提交后回读断言新值 ──
    editing === null
      ? null
      : h(
          Section,
          { title: `改规则 · ${editing.planName ?? ''}`, id: 'edit-alert-plan' },
          h(
            'p',
            { className: 'luo-fine', 'data-alert-edit-target': editing.input.alertPlanId },
            // 整体替换语义必须让用户看见：改一条实际提交的是**整个 rules 数组**。
            `将保存该计划的全部 ${String((editing.input.rules ?? []).length)} 条规则（整体替换）。`,
          ),
          // 每条规则一个编辑块：可编辑的渲染数字框，不可编辑的标为只读 + 说明原因。
          ...(editing.input.rules ?? []).map((rule) => {
            const view = ruleEditorView(rule);
            return h(
              'div',
              { key: rule.id, className: 'luo-fine', 'data-alert-rule-editor': rule.id },
              h('strong', null, `${rule.kind ?? '未知类型'} · ${rule.id ?? ''}`),
              view.editable
                ? h(
                    'div',
                    null,
                    ...view.fields.map((item) =>
                      h(
                        'label',
                        { key: item.field, className: 'luo-field' },
                        `${item.label}${item.unit === 'percent' ? '（%）' : ''}`,
                        h('input', {
                          type: 'number',
                          step: 'any',
                          // 界面值：比例类已由 `ruleEditorView` 换成百分比。
                          value: editing.values[rule.id]?.[item.field] ?? item.value ?? '',
                          'data-alert-rule-field': `${String(rule.id)}:${item.field}`,
                          onChange: (event) =>
                            setEditing((current) =>
                              current === null
                                ? current
                                : {
                                    ...current,
                                    values: {
                                      ...current.values,
                                      [rule.id]: {
                                        ...(current.values[rule.id] ?? {}),
                                        [item.field]: event.target.value,
                                      },
                                    },
                                  },
                            ),
                        }),
                      ),
                    ),
                  )
                : h('span', { 'data-alert-rule-readonly': rule.id }, `${view.reason}（保持原值）`),
            );
          }),
          h(
            'div',
            { className: 'luo-actions' },
            h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                'data-alert-edit-submit': editing.input.alertPlanId,
                onClick: () => {
                  // 把界面编辑结果合并回**完整 rules**（其余规则原样带回）。
                  const edits = Object.entries(editing.values).map(([ruleId, values]) => ({
                    ruleId,
                    values,
                  }));
                  const rules = applyThresholdEdits(editing.input.rules ?? [], edits);
                  submitAlertPlanUpdate(
                    updateAlertPlanInput({ alertPlanId: editing.input.alertPlanId, rules }),
                    { operationId: crypto.randomUUID() },
                  )
                    .then(() => {
                      setNotice(`规则已更新：${String(editing.planName ?? '')}`);
                      setEditing(null);
                      refresh();
                    })
                    .catch((failure) => setNotice(String(failure?.message ?? failure)));
                },
              },
              '提交修改',
            ),
            h(
              'button',
              { className: 'luo-btn', type: 'button', onClick: () => setEditing(null) },
              '取消',
            ),
          ),
        ),
    // ── 最近触发（M4-10 ①）：点开才按需解析 ──
    h(
      Section,
      { title: '最近触发', id: 'recent-triggers' },
      notice === ''
        ? null
        : h('p', { role: 'status', className: 'luo-fine', 'data-trigger-notice': 'true' }, notice),
      (triggers?.triggers ?? triggers?.items ?? []).length === 0
        ? h('p', { className: 'luo-fine' }, '当前没有触发的提醒。')
        : h(
            'ul',
            { className: 'luo-setting-list', 'data-trigger-list': 'true' },
            (triggers?.triggers ?? triggers?.items ?? []).slice(0, 8).map((trigger) =>
              h(
                'li',
                { key: trigger.id, 'data-trigger-row': trigger.id },
                h(
                  'span',
                  null,
                  `${when(trigger.createdAt)} · ${trigger.ruleKind ?? ''} · ${trigger.reason ?? ''}`,
                ),
                h(TriggerDetail, {
                  trigger,
                  detail: details[trigger.id] ?? null,
                  onLoad: loadDetail,
                  onEditInPlace: editInPlace,
                  onDraft: draft,
                }),
              ),
            ),
          ),
    ),
  );
}
