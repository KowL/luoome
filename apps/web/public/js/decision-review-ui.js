import { callApi, getAccountId, getSessionEpoch } from './api.js';
import {
  actionsRow,
  fieldWrap,
  makeInput,
  makeNumberInput,
  makeSelect,
  makeTextarea,
} from './form-kit.js';
import { closeModal, openModal } from './modal.js';
import { el, fmtDateTime, toolErrorText } from './ui.js';

const subjectLabel = {
  advice: 'Advice',
  'trading-plan': '交易计划',
  trade: '成交',
};
const feedbackOptions = [
  ['handled', '已处理'],
  ['useful', '有用'],
  ['useless', '无用'],
  ['ignored', '忽略'],
];
const splitList = (value) =>
  String(value ?? '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** 前端仍沿用「计划版本」对象；复盘单表把交易计划统一记为 subject.kind='trading-plan'。 */
const normalizeSubject = (subject) =>
  subject.kind === 'trading-plan-version' ? { kind: 'trading-plan', id: subject.id } : subject;

const currentLine = (current) => {
  if (current === null) return '尚未记录复盘。';
  const bits = [`最近更新 ${fmtDateTime(current.updatedAt)}`];
  const tags = current.content.lessonTags ?? [];
  if (tags.length > 0) bits.push(`标签：${tags.join('、')}`);
  const trades = current.content.tradeIds ?? [];
  if (trades.length > 0) bits.push(`关联成交：${trades.join('、')}`);
  return bits.join(' · ');
};

const contentSummary = (current) => {
  if (current === null) return null;
  const rows = [];
  if (current.content.note !== null && current.content.note !== undefined)
    rows.push(el('p', 'review-source-summary', current.content.note));
  const feedback = current.content.adviceFeedback;
  if (feedback !== null && feedback !== undefined) {
    const bits = [`建议结果：${feedback.outcome}`];
    if (feedback.pnl !== undefined) bits.push(`盈亏：${feedback.pnl}`);
    if (feedback.holdingHours !== undefined) bits.push(`持仓小时：${feedback.holdingHours}`);
    rows.push(el('p', 'muted', bits.join(' · ')));
  }
  return rows.length === 0 ? null : el('div', 'decision-review-summary', rows);
};

const setBusy = (button, busy) => {
  button.disabled = busy;
};

const openDecisionReview = async (rawSubject, { onSaved = async () => {} } = {}) => {
  const subject = normalizeSubject(rawSubject);
  const accountAtOpen = getAccountId();
  const epochAtOpen = getSessionEpoch();
  const isCurrent = () => getAccountId() === accountAtOpen && getSessionEpoch() === epochAtOpen;

  if (rawSubject.kind === 'watch-trigger') {
    openTriggerFeedback(rawSubject, { onSaved, isCurrent });
    return;
  }

  const body = el('div', 'decision-review-modal');
  openModal(`决策与复盘 · ${subjectLabel[subject.kind] ?? subject.kind}`, body);
  body.append(
    el('p', 'muted', `账户：${accountAtOpen || '未选择'} · 对象：${subject.kind} / ${subject.id}`),
  );
  const status = el('p', 'muted', '正在读取最近复盘…');
  body.append(status);

  const query = new URLSearchParams({
    subjectKind: subject.kind,
    subjectId: subject.id,
    limit: '1',
  });
  const loaded = await callApi(`/api/decision-reviews?${query}`, {
    headers: { 'x-luoome-account-id': accountAtOpen },
  });
  if (!isCurrent()) return;
  if (!loaded.ok) {
    status.textContent = toolErrorText(loaded.error, '读取复盘失败');
    return;
  }
  const current = loaded.data.records?.[0] ?? null;
  status.textContent = currentLine(current);
  const summary = contentSummary(current);
  if (summary !== null) body.append(summary);

  const note = makeTextarea('decision-review-note', {
    rows: 4,
    value: current?.content.note ?? '',
    placeholder: '复盘结论：这次判断、执行与结果分别验证了什么？',
  });
  const tags = makeInput('decision-review-tags', {
    value: (current?.content.lessonTags ?? []).join(','),
    placeholder: '教训标签，逗号分隔',
  });
  const tradeIds = makeInput('decision-review-trades', {
    value: (current?.content.tradeIds ?? []).join(','),
    placeholder: '关联成交 id，逗号分隔',
  });
  body.append(
    fieldWrap('复盘结论', note),
    fieldWrap('教训标签', tags),
    fieldWrap('关联成交', tradeIds),
  );

  const feedback = current?.content.adviceFeedback ?? null;
  let outcome = null;
  let pnl = null;
  if (subject.kind === 'advice') {
    outcome = makeSelect('decision-review-outcome', [
      ['', '不填写'],
      ['followed', '跟随'],
      ['partially_followed', '部分跟随'],
      ['ignored', '忽略'],
    ]);
    outcome.value = feedback?.outcome ?? '';
    pnl = makeNumberInput('decision-review-pnl', {
      value: feedback?.pnl,
      step: '0.01',
      placeholder: '实际盈亏（未知留空）',
    });
    body.append(fieldWrap('建议结果', outcome), fieldWrap('实际盈亏', pnl));
  }

  const message = el('p', 'muted', '');
  body.append(message);
  body.append(
    actionsRow('保存复盘', {
      onConfirm: async (button) => {
        if (!isCurrent()) return;
        const chosenOutcome = subject.kind === 'advice' ? outcome.value : '';
        const pnlText = subject.kind === 'advice' ? String(pnl.value ?? '').trim() : '';
        const content = {
          tradeIds: splitList(tradeIds.value),
          adviceFeedback:
            chosenOutcome === ''
              ? null
              : {
                  outcome: chosenOutcome,
                  ...(pnlText === '' || !Number.isFinite(Number(pnlText))
                    ? {}
                    : { pnl: Number(pnlText) }),
                },
          lessonTags: splitList(tags.value),
          note: String(note.value ?? '').trim() === '' ? null : String(note.value).trim(),
        };
        if (
          content.tradeIds.length === 0 &&
          content.adviceFeedback === null &&
          content.lessonTags.length === 0 &&
          content.note === null
        ) {
          message.textContent = '复盘内容不能全部为空';
          return;
        }
        setBusy(button, true);
        const result = await callApi('/api/decision-reviews', {
          method: 'POST',
          headers: { 'x-luoome-account-id': accountAtOpen },
          body: JSON.stringify({ subject, content }),
        });
        setBusy(button, false);
        if (!isCurrent()) return;
        if (!result.ok) {
          message.textContent = toolErrorText(result.error, '保存复盘失败');
          return;
        }
        closeModal();
        await onSaved();
      },
    }),
  );
};

const openTriggerFeedback = (trigger, { onSaved, isCurrent }) => {
  const body = el('div', 'decision-review-modal');
  openModal('盯盘提醒反馈', body);
  body.append(el('p', 'muted', `反馈只记录你是否处理过这条提醒，不代表已成交或已下单。`));
  const select = makeSelect('watch-trigger-feedback', feedbackOptions);
  select.value = feedbackOptions[0][0];
  body.append(fieldWrap('处理结果', select));
  const message = el('p', 'muted', '');
  body.append(message);
  body.append(
    actionsRow('保存反馈', {
      onConfirm: async (button) => {
        if (!isCurrent()) return;
        setBusy(button, true);
        const result = await callApi(`/api/watch/triggers/${trigger.id}/feedback`, {
          method: 'POST',
          body: JSON.stringify({ feedback: select.value }),
        });
        setBusy(button, false);
        if (!isCurrent()) return;
        if (!result.ok) {
          message.textContent = toolErrorText(result.error, '保存反馈失败');
          return;
        }
        closeModal();
        await onSaved();
      },
    }),
  );
};

export { openDecisionReview };
