// 告警规则面板（task-39 批次 B）。
//
// 判据与格式化**全部来自 `projection.js` 的 `alertPlanHints`** —— 这里不写第二套。
// 提示是**提示**：Pill 与可关闭提示条，**永不阻止保存**（REQ-M3-09 Q4）。
import { Fragment, createElement as h, useState } from 'react';

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

export function AlertsPanel() {
  const { results, loading, panelError, health: healthState } = usePanelState('alerts');
  const listed = dataOf(results, 'list_alert_plans');
  const watchlistsState = dataOf(results, 'list_watchlists');
  const triggers = dataOf(results, 'list_watch_triggers');
  const counts = triggerCounts(triggers);
  const [dismissed, setDismissed] = useState({});

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
  );
}
