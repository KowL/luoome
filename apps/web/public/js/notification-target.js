import { callApi, getAccountId, getSessionEpoch } from './api.js';
import { openDecisionReview } from './decision-review-ui.js';
import { stockIdentityLink } from './stock-link.js';
import {
  openTradingPlanDetailByVersionId,
  planStatusLabel,
  planVersionId,
} from './trading-plan-panel.js';
import { $, el, fmtDateTime, mount, resultErrorText } from './ui.js';
import { openWorkspaceDiscussion } from './workspace.js';

let requestVersion = 0;
const button = (label, onClick) => {
  const node = el('button', 'btn btn-outline btn-sm', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
};
export const notificationTriggerId = (hash) =>
  new URLSearchParams(hash.split('?')[1] ?? '').get('triggerId');

export const renderNotificationTarget = async () => {
  const triggerId = notificationTriggerId(location.hash);
  let host = $('#notification-target');
  if (host === null) {
    host = el('section', 'workspace-card notification-target');
    host.id = 'notification-target';
    $('#route-alerts')?.prepend(host);
  }
  const version = ++requestVersion;
  host.hidden = !triggerId;
  if (!triggerId) return;
  const accountId = getAccountId();
  const epoch = getSessionEpoch();
  mount(host, el('p', null, '正在核对这条提醒的原始快照与最新状态…'));
  const result = await callApi(`/api/watch/notifications/${encodeURIComponent(triggerId)}`);
  if (version !== requestVersion || accountId !== getAccountId() || epoch !== getSessionEpoch())
    return;
  if (!result.ok) {
    mount(host, [
      el('h2', null, '这条提醒暂不可用'),
      el(
        'p',
        null,
        `${resultErrorText(result)}。它可能已删除或不属于当前登录用户；请核对账号，不沿用旧缓存判断。`,
      ),
    ]);
    return;
  }
  const value = result.data;
  const trigger = value.trigger;
  mount(host, [
    el('span', 'section-kicker', 'EXACT NOTIFICATION'),
    el('h2', null, '提醒到了，先核对现在'),
    stockIdentityLink({ stockId: trigger.stockId, stockName: trigger.stockName }),
    el(
      'p',
      'workspace-state',
      {
        'requires-recheck': '需要用当前行情重新检查',
        changed: '原条件或账户状态已变化',
        unavailable: '当前依据不可用',
      }[value.state],
    ),
    ...value.changes.map((text) => el('p', null, text)),
    el('p', 'workspace-risk', '这条历史触发不代表现在仍满足行动条件。请先复核；系统没有自动下单。'),
    el('p', 'workspace-caption', `本次核对 ${fmtDateTime(value.checkedAt)}`),
  ]);
  const snapshot = el('details', 'workspace-evidence', el('summary', null, '触发当时的事实快照'));
  snapshot.open = true;
  snapshot.append(
    el('p', null, trigger.reason ?? '请核对原条件与证据'),
    el(
      'p',
      'workspace-caption',
      `触发时间 ${fmtDateTime(trigger.createdAt)} / 行情时间 ${fmtDateTime(trigger.quote?.ts)}`,
    ),
  );
  for (const evidence of trigger.evidence ?? [])
    snapshot.append(
      el(
        'p',
        'workspace-caption',
        typeof evidence === 'string' ? evidence : JSON.stringify(evidence),
      ),
    );
  if (value.sourcePlan)
    snapshot.append(
      button(
        `查看原计划 v${value.sourcePlan.version}`,
        () => void openTradingPlanDetailByVersionId(planVersionId(value.sourcePlan)),
      ),
    );
  host.append(snapshot);
  if (value.latestVersion)
    host.append(
      el(
        'p',
        null,
        `最新计划版本 v${value.latestVersion.version} / ${planStatusLabel(value.latestVersion.status)}。新草案不代表原生效版已被替代。`,
      ),
      button(
        '查看最新计划与资格',
        () => void openTradingPlanDetailByVersionId(planVersionId(value.latestVersion)),
      ),
    );
  const subject = { kind: 'watch-trigger', id: trigger.id };
  host.append(
    el('div', 'row-actions', [
      button(
        '围绕这条提醒讨论',
        () =>
          void openWorkspaceDiscussion(
            [{ ref: subject, label: `${trigger.stockId} · 此次提醒` }],
            '请比较触发当时与当前计划的区别，保留风险、反证、有效期和未知项。',
          ),
      ),
      button('登记 / 关联实际成交', () => void openDecisionReview(subject)),
    ]),
    el(
      'p',
      'workspace-caption',
      '尚未记录的实际行动保持未知。渠道受理不能证明手机已送达或用户已交易。',
    ),
  );
  host.scrollIntoView({ block: 'start', behavior: 'instant' });
};

globalThis.document?.addEventListener?.('luoome:identity-cleared', () => {
  requestVersion += 1;
  $('#notification-target')?.replaceChildren();
});
