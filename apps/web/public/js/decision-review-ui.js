import { callApi, getAccountId } from './api.js';
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

const PENDING_KEY = 'luoome.decisionPending';
let volatilePending = null;
let pendingBusy = false;
let redrawPending = () => {};
const rejectedKinds = new Set([
  'invalid_input',
  'not_found',
  'invariant_violation',
  'permission_denied',
]);
const subjectLabel = {
  advice: 'Advice',
  'trading-plan-version': '交易计划版本',
  'watch-trigger': '盯盘提醒',
};
const emptyContent = () => ({
  tradeIds: [],
  adviceFeedback: null,
  triggerFeedback: null,
  note: null,
});
const pendingRead = () => {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') ?? volatilePending;
  } catch {
    return volatilePending;
  }
};
const pendingWrite = (value) => {
  volatilePending = value;
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
    return true;
  } catch {
    volatilePending = null;
    return false;
  }
};
const pendingClear = () => {
  volatilePending = null;
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* 无可清理 */
  }
};
const shanghaiLocalNow = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
};

const sourceSummary = (source) => {
  if (!source) return '原始来源已删除；以下内容来自首次记录时保存的快照。';
  const bits = [
    source.reasoning?.premise,
    source.explanation?.summary,
    source.reason,
    source.action ? `计划动作：${source.action}` : null,
    source.evidence?.length ? `证据：${source.evidence.join('；')}` : null,
    source.reasoning?.counterEvidence?.length
      ? `反证：${source.reasoning.counterEvidence.join('；')}`
      : null,
    source.risks?.length ? `风险：${source.risks.join('；')}` : null,
    source.disclaimers?.length ? `免责声明：${source.disclaimers.join('；')}` : null,
  ].filter(Boolean);
  return bits.join('\n') || '原始依据已保存，可展开查看完整快照。';
};

const labelCheckbox = (text, checked) => {
  const label = el('label', 'field');
  const checkbox = makeInput(undefined, { type: 'checkbox' });
  checkbox.checked = checked;
  label.append(checkbox, el('span', null, text));
  return { label, checkbox };
};

export const openDecisionReview = async (subject, { onSaved = async () => {}, revision } = {}) => {
  const accountAtOpen = getAccountId();
  const query = new URLSearchParams({ subjectKind: subject.kind, subjectId: subject.id });
  if (revision !== undefined) query.set('revision', String(revision));
  const response = await callApi(`/api/decision-reviews/context?${query}`, {
    headers: { 'x-luoome-account-id': accountAtOpen },
  });
  if (getAccountId() !== accountAtOpen) return;
  if (!response.ok) {
    openModal('决策与复盘', el('p', 'status error', toolErrorText(response.error)));
    return;
  }
  const context = response.data;
  const old = context.selected?.revision.content ?? emptyContent();
  const body = el('div', 'decision-review-modal');
  const error = el('p', 'status error');
  error.hidden = true;
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  body.append(
    el(
      'p',
      'muted',
      `账户：${context.accountId} · ${subjectLabel[subject.kind]} · 股票：${context.stockId ?? '组合'} · 依据生成：${context.sourceOccurredAt ? fmtDateTime(context.sourceOccurredAt) : '未知'}`,
    ),
  );
  if (context.sourceStatus === 'unavailable')
    body.append(el('p', 'status warning', '原来源已删除；可查看冻结快照和修改记录。'));
  if (context.validUntil && new Date(context.validUntil) <= new Date())
    body.append(
      el('p', 'status warning', '历史依据当前已过期；关联真实成交仍会保留“发生时已过期”状态。'),
    );
  const source = context.context?.source;
  body.append(el('h3', null, '当时依据'), el('p', 'review-source-summary', sourceSummary(source)));
  const raw = el('details', null, [
    el('summary', null, '查看原始快照'),
    el('pre', 'mono', JSON.stringify(source ?? {}, null, 2)),
  ]);
  body.append(raw);
  const observationBox = el('div', 'decision-observations');
  observationBox.append(el('h3', null, '来源明确关联的观察'));
  if (context.observationStatus === 'unavailable')
    observationBox.append(el('p', 'muted', '没有可核验的明确观察来源；不按同股同日推断收益。'));
  else
    for (const observation of context.observations)
      observationBox.append(
        el(
          'p',
          'muted',
          `${observation.horizon.toUpperCase()} · ${observation.status} · ${observation.id}`,
        ),
      );
  body.append(observationBox);

  const feedback =
    subject.kind === 'advice'
      ? makeSelect(undefined, [
          ['', '尚未记录'],
          ['followed', '跟随'],
          ['partially_followed', '部分跟随'],
          ['ignored', '忽略'],
        ])
      : subject.kind === 'watch-trigger'
        ? makeSelect(undefined, [
            ['', '尚未记录'],
            ['handled', '已处理'],
            ['useful', '有用'],
            ['useless', '无用'],
            ['ignored', '忽略'],
          ])
        : null;
  if (feedback !== null) {
    feedback.value =
      subject.kind === 'advice' ? (old.adviceFeedback?.outcome ?? '') : (old.triggerFeedback ?? '');
    body.append(fieldWrap('我的反馈（由我明确选择）', feedback));
  }
  const note = makeTextarea(undefined, {
    rows: 3,
    value: old.note ?? '',
    placeholder: '我当时怎样判断、后来有什么变化',
  });
  body.append(fieldWrap('我的备注', note));
  const pnl =
    subject.kind === 'advice'
      ? makeNumberInput(undefined, {
          value: old.adviceFeedback?.pnl,
          step: '0.01',
          placeholder: '未知或未平仓时留空',
        })
      : null;
  if (pnl !== null) body.append(fieldWrap('用户填报盈亏（留空表示未知）', pnl));

  body.append(el('h3', null, '实际成交'));
  const selectedIds = new Set(old.tradeIds);
  const trades = new Map([...context.candidateTrades.map((trade) => [trade.id, trade])]);
  for (const id of selectedIds) if (!trades.has(id)) trades.set(id, null);
  const choices = new Map();
  const choiceBox = el('div', 'decision-trade-choices');
  const appendTradeChoice = (id, trade) => {
    if (choices.has(id)) return;
    const caption = trade
      ? `${fmtDateTime(trade.executedAt)} · ${trade.side === 'buy' ? '买' : '卖'} ${trade.quantity} 股 × ${trade.price} · ${id}`
      : `关联成交 ${id}（当前选择器范围外或已缺失）`;
    const item = labelCheckbox(caption, selectedIds.has(id));
    if (trade === null) item.checkbox.disabled = true;
    choices.set(id, item.checkbox);
    choiceBox.append(item.label);
  };
  for (const [id, trade] of trades) appendTradeChoice(id, trade);
  if (trades.size === 0)
    choiceBox.append(
      el(
        'p',
        'placeholder',
        '当前范围未找到已有成交，可调整流水查询范围；这不证明实际成交尚未登记。',
      ),
    );
  body.append(choiceBox);
  const changeNote = makeInput(undefined, { placeholder: '解除关联或更正盈亏时必填' });
  body.append(fieldWrap('更正原因', changeNote));
  body.append(
    el('p', 'muted', '选择已有成交只建立明确关联，不改变现金或持仓。提醒反馈不等于成交。'),
  );
  body.append(error);

  const accountRequest = (path, init = {}) =>
    callApi(path, {
      ...init,
      headers: { ...init.headers, 'x-luoome-account-id': accountAtOpen },
    });
  if (context.stockId !== null) {
    const moreTrades = el('button', 'btn btn-outline btn-sm', '查看更多已有成交');
    moreTrades.type = 'button';
    let nextCursor = null;
    let asOf = null;
    moreTrades.addEventListener('click', async () => {
      if (getAccountId() !== accountAtOpen) return showError('账户已切换，请重新打开。');
      const query = new URLSearchParams({ stockId: context.stockId, limit: '50' });
      if (context.sourceOccurredAt) query.set('since', context.sourceOccurredAt);
      if (nextCursor) query.set('cursor', nextCursor);
      if (asOf) query.set('asOf', asOf);
      moreTrades.disabled = true;
      const result = await accountRequest(`/api/trades?${query}`);
      moreTrades.disabled = false;
      if (getAccountId() !== accountAtOpen) return;
      if (!result.ok) return showError(`${toolErrorText(result.error)}。请刷新选择器。`);
      asOf = result.data.asOf;
      for (const trade of result.data.trades) appendTradeChoice(trade.id, trade);
      nextCursor = result.data.nextCursor;
      if (!nextCursor) moreTrades.remove();
    });
    choiceBox.after(moreTrades);
  }
  const pendingPanel = el('div', 'decision-pending-panel');
  const setPendingBusy = (busy) => {
    pendingBusy = busy;
    redrawPending();
  };
  const sendPending = async (pending, canConfirmRejection) => {
    setPendingBusy(true);
    // Persist uncertainty before sending so reloading cannot discard an in-flight write.
    if (!pendingWrite({ ...pending, outcome: 'unknown' })) {
      setPendingBusy(false);
      return { ok: false, error: { kind: 'internal', cause: '无法保存未决请求' } };
    }
    const path =
      pending.command === 'record_decision_trade'
        ? '/api/decision-trades'
        : '/api/decision-reviews';
    const result = await accountRequest(path, {
      method: 'POST',
      body: JSON.stringify(pending.input),
    });
    if (!result.ok && canConfirmRejection && rejectedKinds.has(result.error?.kind))
      pendingWrite({ ...pending, outcome: 'rejected' });
    setPendingBusy(false);
    return result;
  };
  const showPending = () => {
    const pending = pendingRead();
    pendingPanel.replaceChildren();
    if (!pending || pending.accountId !== accountAtOpen) return;
    pendingPanel.append(
      el(
        'p',
        'status warning',
        pending.outcome === 'rejected'
          ? '上次提交已被拒绝。可确认尚未提交后重新加载，再修改内容提交。'
          : '上次提交结果尚未确认。请先查询回执，必要时复用同一请求；暂不能创建新提交。',
      ),
    );
    const queryReceipt = el('button', 'btn btn-outline btn-sm', '查询上次未决提交');
    queryReceipt.type = 'button';
    const retry = el('button', 'btn btn-outline btn-sm', '复用原请求重试');
    retry.type = 'button';
    queryReceipt.disabled = pendingBusy;
    retry.disabled = pendingBusy;
    queryReceipt.addEventListener('click', async () => {
      if (pendingBusy) return;
      if (getAccountId() !== pending.accountId) return showError('账户已切换，请切回原账户。');
      setPendingBusy(true);
      const receipt = await accountRequest(`/api/decision-writes/${pending.input.requestId}`);
      setPendingBusy(false);
      if (getAccountId() !== pending.accountId) return;
      if (receipt.ok) {
        pendingClear();
        await saved();
        return;
      }
      showError(
        receipt.error?.kind === 'not_found'
          ? '尚无成功回执。请核对交易流水；如需重试，必须复用原请求。'
          : toolErrorText(receipt.error),
      );
    });
    retry.addEventListener('click', async () => {
      if (pendingBusy) return;
      if (getAccountId() !== pending.accountId) return showError('账户已切换，请切回原账户。');
      const result = await sendPending(pending, pending.outcome === 'rejected');
      if (getAccountId() !== pending.accountId) return;
      if (!result.ok) return showError(toolErrorText(result.error));
      pendingClear();
      await saved();
    });
    pendingPanel.append(queryReceipt, retry);
    if (pending.outcome === 'rejected') {
      const reload = el('button', 'btn btn-outline btn-sm', '确认未提交并重新加载');
      reload.type = 'button';
      reload.disabled = pendingBusy;
      reload.addEventListener('click', async () => {
        if (pendingBusy) return;
        if (getAccountId() !== pending.accountId) return showError('账户已切换，请切回原账户。');
        setPendingBusy(true);
        const receipt = await accountRequest(`/api/decision-writes/${pending.input.requestId}`);
        setPendingBusy(false);
        if (getAccountId() !== pending.accountId) return;
        if (receipt.ok) {
          pendingClear();
          await saved();
        } else if (receipt.error?.kind === 'not_found') {
          pendingClear();
          await openDecisionReview(subject, { onSaved });
        } else showError(toolErrorText(receipt.error));
      });
      pendingPanel.append(reload);
    }
  };
  redrawPending = showPending;
  const saved = async () => {
    if (getAccountId() === accountAtOpen) {
      closeModal();
      await onSaved();
    }
  };
  const saveActions = actionsRow('保存复盘', {
    onConfirm: async (button) => {
      if (getAccountId() !== accountAtOpen) return showError('账户已切换，请重新打开。');
      if (pendingRead()) return showError('仍有未决请求，请先查询回执或复用原请求。');
      if (
        context.selectedRevision !== null &&
        context.selectedRevision !== context.current?.review.currentRevision
      )
        return showError('当前查看历史修订，请先切回最新版本再编辑。');
      const tradeIds = [...choices.entries()]
        .filter(([, box]) => box.checked)
        .map(([id]) => id)
        .sort();
      const pnlRaw = pnl?.value.trim() ?? '';
      const pnlValue = pnlRaw ? Number(pnlRaw) : undefined;
      if (pnlRaw && !Number.isFinite(pnlValue)) return showError('盈亏必须是有效数字。');
      const content = {
        tradeIds,
        adviceFeedback:
          subject.kind === 'advice' && feedback.value
            ? { outcome: feedback.value, ...(pnlValue === undefined ? {} : { pnl: pnlValue }) }
            : null,
        triggerFeedback: subject.kind === 'watch-trigger' && feedback.value ? feedback.value : null,
        note: note.value.trim() || null,
      };
      const input = {
        requestId: crypto.randomUUID(),
        subject,
        contextHash: context.context?.contextHash,
        expectedRevision: context.current?.review.currentRevision ?? 0,
        content,
        changeNote: changeNote.value.trim() || null,
      };
      if (!pendingWrite({ accountId: accountAtOpen, command: 'save_decision_review', input }))
        return showError('浏览器无法保存未决请求，请开启此标签页的会话存储后重试。');
      button.disabled = true;
      showPending();
      const result = await sendPending(pendingRead(), true);
      button.disabled = false;
      if (getAccountId() !== accountAtOpen) return;
      if (!result.ok)
        return showError(
          `${toolErrorText(result.error)}。草稿已保留；冲突时请刷新上下文后重新确认。`,
        );
      pendingClear();
      await saved();
    },
  });
  body.append(saveActions);

  if (context.stockId !== null) {
    const form = el('details', null, el('summary', null, '登记尚未入账的实际成交'));
    form.append(
      el(
        'p',
        'muted',
        '仅登记已在系统外发生、且未通过交易或持仓调整入账的成交。相似成交不会自动合并；如不确定，请先核对流水。',
      ),
    );
    const side = makeSelect(undefined, [
      ['buy', '买入'],
      ['sell', '卖出'],
    ]);
    const quantity = makeNumberInput(undefined, { min: 1, step: 1 });
    const price = makeNumberInput(undefined, { min: 0.01, step: 0.01 });
    const fee = makeNumberInput(undefined, { min: 0, step: 0.01, value: 0 });
    const executedAt = makeInput(undefined, { type: 'datetime-local', value: shanghaiLocalNow() });
    const confirm = labelCheckbox('我确认这笔成交尚未登记，也未通过持仓调整体现', false);
    form.append(
      fieldWrap('方向', side),
      fieldWrap('数量（股）', quantity),
      fieldWrap('实际成交价', price),
      fieldWrap('费用（仅记录，不从现金余额重复扣除）', fee),
      fieldWrap('成交时间（上海时间）', executedAt),
      confirm.label,
    );
    const register = el('button', 'btn btn-primary', '确认登记并关联此依据');
    register.type = 'button';
    register.addEventListener('click', async () => {
      if (getAccountId() !== accountAtOpen) return showError('账户已切换，请重新打开。');
      const amount = Number(quantity.value);
      const actualPrice = Number(price.value);
      const actualFee = Number(fee.value);
      if (
        !Number.isInteger(amount) ||
        amount <= 0 ||
        !Number.isFinite(actualPrice) ||
        actualPrice <= 0 ||
        !Number.isFinite(actualFee) ||
        actualFee < 0 ||
        !executedAt.value ||
        !confirm.checkbox.checked
      )
        return showError('请填写有效的实际成交，并勾选尚未登记确认。');
      if (pendingRead()) return showError('仍有未决请求，请先查询回执或复用原请求。');
      if (context.ledgerState?.appendEligibility !== 'eligible')
        return showError(
          `账本暂不可顺序追加：${context.ledgerState?.reasons.join('；') ?? '状态缺失'}`,
        );
      const input = {
        requestId: crypto.randomUUID(),
        expectedLedgerStateHash: context.ledgerState.hash,
        confirmedNotRecorded: true,
        stockId: context.stockId,
        side: side.value,
        quantity: amount,
        price: actualPrice,
        fee: actualFee,
        executedAt: new Date(`${executedAt.value}+08:00`).toISOString(),
        sources: [
          {
            subject,
            contextHash: context.context.contextHash,
            expectedRevision: context.current?.review.currentRevision ?? 0,
          },
        ],
      };
      if (!pendingWrite({ accountId: accountAtOpen, command: 'record_decision_trade', input }))
        return showError('浏览器无法保存未决请求，请开启此标签页的会话存储后重试。');
      register.disabled = true;
      showPending();
      const result = await sendPending(pendingRead(), true);
      register.disabled = false;
      if (getAccountId() !== accountAtOpen) return;
      if (!result.ok)
        return showError(
          `${toolErrorText(result.error)}。请先查同键回执或刷新账本，不要生成新请求重复登记。`,
        );
      pendingClear();
      await saved();
    });
    form.append(register);
    body.append(form);
  }

  body.append(el('h3', null, '修改记录'));
  if (context.revisions.length === 0) body.append(el('p', 'placeholder', '尚未记录。'));
  else
    for (const item of context.revisions) {
      const button = el(
        'button',
        'btn btn-outline btn-sm',
        `v${item.revision} · ${fmtDateTime(item.recordedAt)}${item.changeNote ? ` · ${item.changeNote}` : ''}`,
      );
      button.type = 'button';
      button.addEventListener(
        'click',
        () => void openDecisionReview(subject, { onSaved, revision: item.revision }),
      );
      body.append(button);
    }
  if (
    context.selectedRevision !== null &&
    context.selectedRevision !== context.current?.review.currentRevision
  ) {
    body.append(
      el(
        'p',
        'status warning',
        `正在查看历史版本 v${context.selectedRevision}，编辑请打开最新版本。`,
      ),
    );
  }
  showPending();
  body.prepend(pendingPanel);
  openModal(`决策与复盘 · ${subjectLabel[subject.kind]}`, body);
};
