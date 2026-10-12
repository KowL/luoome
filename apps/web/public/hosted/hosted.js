const $ = (selector) => document.querySelector(selector);
const state = {
  csrf: '',
  challengeId: '',
  me: null,
  watchlists: [],
  selected: null,
  detail: null,
  preview: null,
  importFormat: 'text',
  job: null,
  epoch: 0,
  deletionChallengeId: '',
};
const sessionChannel = new BroadcastChannel('luoome-hosted-session');
const fmtTime = (value) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const clear = (selector) => {
  const element = $(selector);
  element.replaceChildren();
  return element;
};
const notice = (message, error = false) => {
  const element = $('#notice');
  element.textContent = message;
  element.hidden = false;
  element.className = error ? 'error' : 'success';
};
const friendly = (error) => {
  if (error.kind === 'permission_denied') {
    if (error.required === 'auth:rate-limit') return '发送过于频繁，请稍后再试。';
    if (error.required?.startsWith('entitlement:'))
      return '当前服务额度不可用。已保存的记录仍可查看和导出。';
    if (error.required === 'hosted:maintenance') return '服务正在维护，请稍后重试。';
    return '当前操作不可用，请刷新后重试。';
  }
  if (error.kind === 'not_found') return '这项记录不存在，或已被移除。';
  if (error.kind === 'invariant_violation') return error.message;
  if (error.kind === 'invalid_input') return error.message;
  if (error.kind === 'lease_lost_before_commit') return '任务已停止，未重复提交。';
  return '服务暂时未能完成操作，请稍后重试。';
};
const api = async (path, method = 'GET', input) => {
  const epoch = state.epoch;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(method === 'GET'
        ? {}
        : { 'content-type': 'application/json', 'x-csrf-token': state.csrf }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('服务响应暂时不可用，请稍后重试。');
  }
  if (state.epoch !== epoch) throw new Error('工作区已切换，请刷新当前内容。');
  if (!result.ok) {
    if (response.status === 401) showLogin();
    throw new Error(friendly(result.error));
  }
  return result.data;
};
const action = (handler) => async (event) => {
  event?.preventDefault();
  $('#notice').hidden = true;
  const target = event?.currentTarget;
  if (target instanceof HTMLButtonElement) target.disabled = true;
  try {
    await handler(event);
  } catch (error) {
    notice(error instanceof TypeError ? '连接中断，请检查网络后重试。' : error.message, true);
  } finally {
    if (target instanceof HTMLButtonElement)
      target.disabled =
        target.id === 'generate-report' &&
        ['preparing', 'queued', 'running'].includes(state.job?.state);
  }
};
const button = (text, handler, className = 'secondary') => {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', action(handler));
  return element;
};
const showLogin = () => {
  state.epoch += 1;
  state.me = null;
  state.csrf = '';
  state.challengeId = '';
  state.selected = null;
  state.watchlists = [];
  state.detail = null;
  state.preview = null;
  state.job = null;
  state.deletionChallengeId = '';
  for (const selector of [
    '#reports',
    '#members',
    '#watchlist-list',
    '#triggers',
    '#alerts-list',
    '#alert-preview',
    '#subscription',
    '#usage',
    '#purchase-plans',
    '#orders',
    '#notification-preferences',
    '#deliveries',
    '#exports',
    '#import-preview',
  ])
    clear(selector);
  $('#generate-report').disabled = false;
  $('#job-status').hidden = true;
  $('#code').value = '';
  $('#notice').hidden = true;
  $('#login-message').textContent = '';
  $('#selected-watchlist-name').textContent = '';
  $('#watchlist-count').textContent = '0';
  for (const form of document.querySelectorAll('#workspace form, dialog form')) form.reset();
  for (const dialog of document.querySelectorAll('dialog')) if (dialog.open) dialog.close();
  $('#workspace').hidden = true;
  $('#initializing').hidden = true;
  $('#login').hidden = false;
  $('#logout').hidden = true;
  $('#user-label').textContent = '';
};
const loadMe = async () => {
  const me = await api('/api/me');
  if (state.me && state.me.user.id !== me.user.id) showLogin();
  state.me = me;
  state.csrf = me.csrfToken;
  $('#fixture-banner').hidden = !me.fixture;
  $('#login').hidden = true;
  $('#logout').hidden = false;
  $('#user-label').textContent = me.user.email ?? '';
  if (me.tenant.status === 'provisioning') {
    $('#workspace').hidden = true;
    $('#initializing').hidden = false;
    $('#initializing-detail').textContent = me.tenant.provisioningErrorKind
      ? '初始化正在重试，尚未建立业务账户。'
      : '正在建立私有数据库。可以关闭页面，稍后继续。';
    setTimeout(
      () =>
        loadMe().catch((error) =>
          notice(error instanceof TypeError ? '连接中断，请检查网络后重试。' : error.message, true),
        ),
      2_000,
    );
    return;
  }
  if (!['active', 'suspended'].includes(me.tenant.status)) throw new Error('工作区当前不可用。');
  $('#initializing').hidden = true;
  $('#workspace').hidden = false;
  $('#workspace-date').textContent = `${fmtTime(new Date())} · 已保存的事实`;
  await refreshWorkspace();
};
const selectList = async (id) => {
  state.selected = id;
  state.detail = await api(`/api/watchlists/${encodeURIComponent(id)}`);
  renderWatchlists();
  renderMembers();
  await renderReports();
};
const renderWatchlists = () => {
  const container = clear('#watchlist-list');
  $('#watchlist-count').textContent = String(state.watchlists.length);
  for (const watchlist of state.watchlists) {
    const item = button(
      watchlist.name,
      () => selectList(watchlist.id),
      `watchlist-item ${watchlist.id === state.selected ? 'selected' : ''}`,
    );
    item.setAttribute('aria-pressed', String(watchlist.id === state.selected));
    container.append(item);
  }
};
const renderMembers = () => {
  $('#no-watchlist').hidden = Boolean(state.detail);
  $('#watchlist-detail').hidden = !state.detail;
  if (!state.detail) return;
  $('#selected-watchlist-name').textContent = state.detail.watchlist.name;
  const container = clear('#members');
  for (const { member, sources } of state.detail.members) {
    if (!sources.some((source) => source.status !== 'ended')) continue;
    const row = node('div', undefined, 'member');
    const label = node('div');
    label.append(
      node('strong', member.stockId),
      node(
        'span',
        sources
          .filter((source) => source.status !== 'ended')
          .map((source) => (source.kind === 'import' ? '导入' : '手动关注'))
          .join(' · '),
        'muted',
      ),
    );
    row.append(
      label,
      button(
        '移除',
        async () => {
          await api(
            `/api/watchlists/${encodeURIComponent(state.selected)}/members/remove`,
            'POST',
            { stockIds: [member.stockId], requestId: crypto.randomUUID() },
          );
          await selectList(state.selected);
          notice('本人关注来源已移除；其它来源保留。');
        },
        'text-button',
      ),
    );
    container.append(row);
  }
  if (!container.childElementCount)
    container.append(node('p', '列表还没有自选。导入后即可生成摘要。', 'muted'));
};
const renderReports = async () => {
  const container = clear('#reports');
  if (!state.selected) return;
  const data = await api(`/api/reports?watchlistId=${encodeURIComponent(state.selected)}`);
  for (const report of data.reports) {
    const card = node('article', undefined, 'report-card');
    card.append(
      node(
        'p',
        `${report.status === 'partial' ? '部分完成 · 数据有缺口' : '已完成'} · ${fmtTime(report.generatedAt ?? report.createdAt)}`,
        'eyebrow',
      ),
    );
    card.append(node('h3', report.title ?? '自选事实摘要'));
    for (const section of report.sections ?? []) {
      card.append(node('h4', section.title ?? '事实'));
      if (section.summary) card.append(node('p', section.summary));
      if (section.content)
        card.append(
          node(
            'p',
            typeof section.content === 'string' ? section.content : JSON.stringify(section.content),
          ),
        );
      for (const block of section.blocks ?? []) {
        if (block.text) card.append(node('p', block.text));
        if (block.kind === 'markdown')
          card.append(node('pre', block.content ?? block.markdown ?? '', 'report-text'));
        if (block.kind === 'table') {
          const table = node('table');
          const columns = block.columns ?? [];
          const header = node('tr');
          for (const column of columns)
            header.append(node('th', typeof column === 'string' ? column : column.label));
          table.append(header);
          for (const values of block.rows ?? []) {
            const row = node('tr');
            for (const column of columns) {
              const key = typeof column === 'string' ? column : column.key;
              const value = Array.isArray(values)
                ? (values[columns.indexOf(column)] ?? '—')
                : (values[key] ?? '—');
              const labels = {
                watching: '关注中',
                import: '导入',
                manual: '手动',
                fresh: '及时',
                stale: '已过时',
                missing: '缺失',
                upstream: '上游时间',
                retrieval: '获取时间',
              };
              row.append(
                node(
                  'td',
                  labels[value] ??
                    (/^\d{4}-\d{2}-\d{2}T/.test(String(value)) ? fmtTime(value) : String(value)),
                ),
              );
            }
            table.append(row);
          }
          const scroll = node('div', undefined, 'table-scroll');
          scroll.append(table);
          card.append(scroll);
        }
        if (block.kind === 'list')
          for (const item of block.items) {
            card.append(node('strong', item.title));
            if (item.detail) card.append(node('p', item.detail));
          }
      }
      for (const gap of section.missingDimensions ?? [])
        card.append(node('p', gap.reason, 'data-gap'));
    }
    card.append(
      node(
        'p',
        '事实截止时间、来源和缺口以本次记录为准。条件命中由你设置，不代表买卖建议。',
        'fineprint',
      ),
    );
    container.append(card);
  }
};
const refreshWorkspace = async () => {
  const data = await api('/api/watchlists');
  state.watchlists = data.items.map((item) => item.watchlist);
  renderWatchlists();
  const id = state.watchlists.some((item) => item.id === state.selected)
    ? state.selected
    : state.watchlists[0]?.id;
  if (id) await selectList(id);
  else {
    state.detail = null;
    renderMembers();
  }
};
const showPage = async (page) => {
  for (const element of document.querySelectorAll('.page'))
    element.hidden = element.id !== `page-${page}`;
  for (const tab of document.querySelectorAll('.tab'))
    tab.classList.toggle('active', tab.dataset.page === page);
  if (page === 'service') await loadService();
  if (page === 'records') await loadRecords();
  if (page === 'alerts') await loadAlerts();
};
const loadService = async () => {
  const subscription = await api('/api/subscription');
  const container = clear('#subscription');
  if (!subscription.current)
    container.append(node('p', '当前服务已到期。新任务暂停，仍可导出你的资料。'));
  else {
    const { plan, period, availableUnits, heldUnits } = subscription.current;
    container.append(node('h3', state.me.fixture ? '开发试用' : plan.code));
    container.append(
      node(
        'p',
        `有效至 ${fmtTime(period.endsAt)} · 可用研究额度 ${availableUnits} · 已预占 ${heldUnits}`,
      ),
    );
    container.append(
      node(
        'p',
        `自选上限 ${plan.limits.watchlistStocks} · 启用规则上限 ${plan.limits.enabledRules}`,
        'muted',
      ),
    );
  }
  const usage = await api('/api/usage');
  clear('#usage').append(
    node(
      'p',
      `用量流水 ${usage.entries.length} 条。部分摘要不扣研究额度；已受理任务始终结算到原服务期。`,
      'fineprint',
    ),
  );
  const plans = clear('#purchase-plans');
  for (const plan of subscription.plans) {
    const price = new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: plan.currency,
    }).format(plan.priceMinor / 100);
    plans.append(
      button(
        state.me.fixture
          ? '建立模拟续期订单（不扣款）'
          : `购买 ${plan.durationMonths} 个月 · ${price}`,
        async () => {
          const result = await api('/api/subscription/orders', 'POST', {
            planVersionId: plan.id,
            requestId: crypto.randomUUID(),
          });
          await loadOrders();
          if (!state.me.fixture && result.checkout?.checkoutUrl) {
            const link = node('a', '前往支付页面');
            link.href = result.checkout.checkoutUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            plans.append(link);
          } else
            notice(
              state.me.fixture ? '模拟订单已建立，不会扣款。' : '订单已建立，请查询支付状态。',
            );
        },
      ),
    );
  }
  plans.append(
    node('p', '按次购买服务期，不自动扣款。付款结果以渠道查单或验签回调为准。', 'fineprint'),
  );
  await loadOrders();
  await loadNotificationPreferences();
};
const loadOrders = async () => {
  const orders = await api('/api/subscription/orders');
  const container = clear('#orders');
  if (!orders.length) return;
  container.append(node('h3', '我的订单'));
  for (const order of orders) {
    const card = node('div', undefined, 'order-row');
    const price = new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: order.currency,
    }).format(order.amountMinor / 100);
    card.append(
      node(
        'p',
        `${price} · ${({ created: '订单核查中', pending: '等待支付', paid: '付款已确认', closed: '已关闭' })[order.state] ?? '核查中'} · ${fmtTime(order.createdAt)}`,
      ),
    );
    if (['created', 'pending'].includes(order.state))
      card.append(
        button('查询支付结果', async () => {
          const result = await api(
            `/api/subscription/orders/${encodeURIComponent(order.id)}/query`,
            'POST',
            {},
          );
          notice(
            result.observation === 'unknown'
              ? '渠道结果仍不确定，订单将继续对账。'
              : result.observation === 'confirmed'
                ? '支付已确认，服务期已更新。'
                : '暂未确认付款。',
          );
          await loadService();
        }),
      );
    container.append(card);
  }
};
const loadNotificationPreferences = async () => {
  const preferences = await api('/api/notifications/preferences');
  const container = clear('#notification-preferences');
  const email = node('input');
  email.type = 'checkbox';
  email.checked = preferences.emailEnabled;
  email.id = 'email-notifications';
  const label = node('label', undefined, 'checkbox');
  label.append(email, node('span', `将提醒发送到已验证邮箱 ${state.me.user.email}`));
  container.append(label);
  const quiet = node('input');
  quiet.type = 'checkbox';
  quiet.checked = preferences.quietHours.enabled;
  quiet.id = 'quiet-hours';
  const quietLabel = node('label', undefined, 'checkbox');
  quietLabel.append(quiet, node('span', '22:00–08:00 安静时段（上海时间）'));
  container.append(quietLabel);
  container.append(
    node('p', '邮件只提示有新记录，详情需要登录查看。关闭邮件会抑制待发送的旧通知。', 'fineprint'),
  );
  container.append(
    button('保存通知偏好', async () => {
      await api('/api/notifications/preferences', 'PUT', {
        expectedRevision: preferences.revision,
        emailEnabled: email.checked,
        detail: 'minimal',
        quietHours: {
          enabled: quiet.checked,
          startMinutes: 1320,
          endMinutes: 480,
          timeZone: 'Asia/Shanghai',
        },
      });
      notice('通知偏好已保存。');
      await loadNotificationPreferences();
    }),
  );
  const intents = await api('/api/notifications');
  const deliveries = clear('#deliveries');
  const labels = {
    pending: '待发送',
    sending: '发送处理中',
    accepted: '渠道已受理',
    failed: '发送失败',
    unknown: '结果未知，待核查',
    suppressed: '已停止',
  };
  for (const intent of intents)
    deliveries.append(
      node(
        'p',
        `${intent.channel === 'email' ? '邮件' : '站内'} · ${intent.deliveredAt ? '已确认送达' : labels[intent.state]} · ${fmtTime(intent.createdAt)}`,
        'muted',
      ),
    );
  if (intents.length)
    deliveries.append(
      node('p', '渠道受理不代表收件设备已送达；结果未知时会核查，不直接重复发送。', 'fineprint'),
    );
};
const loadRecords = async () => {
  const data = await api('/api/triggers');
  const container = clear('#triggers');
  if (!data.triggers.length)
    container.append(node('p', '暂时没有正式条件命中。试跑不会加入记录。', 'muted'));
  for (const trigger of data.triggers) {
    const card = node('article', undefined, 'report-card');
    card.append(
      node('h3', trigger.stockId),
      node('p', trigger.reason),
      node('p', fmtTime(trigger.createdAt), 'muted'),
    );
    const feedback = await api(`/api/triggers/${encodeURIComponent(trigger.id)}/feedback`);
    const last = feedback.revisions.at(-1);
    if (last)
      card.append(
        node(
          'p',
          `我的记录：${{ handled: '已处理', useful: '有用', useless: '无用', ignored: '忽略' }[last.rating]} · 修订 ${last.revision}`,
        ),
      );
    const note = node('textarea');
    note.maxLength = 2000;
    note.placeholder = '记录自己的观察（不等于成交）';
    note.value = last?.note ?? '';
    card.append(note);
    for (const [rating, label] of [
      ['handled', '已处理'],
      ['useful', '有用'],
      ['useless', '无用'],
      ['ignored', '忽略'],
    ])
      card.append(
        button(label, async () => {
          await api(`/api/triggers/${encodeURIComponent(trigger.id)}/feedback`, 'POST', {
            expectedRevision: last?.revision ?? 0,
            rating,
            note: note.value,
            requestId: crypto.randomUUID(),
          });
          await loadRecords();
        }),
      );
    container.append(card);
  }
};
const loadAlerts = async () => {
  const container = clear('#alerts-list');
  if (!state.selected) {
    container.append(node('p', '请先创建自选列表。'));
    return;
  }
  const data = await api(`/api/watchlists/${encodeURIComponent(state.selected)}/alerts`);
  for (const item of data.plans) {
    const plan = item.plan;
    const revision = item.planRevision;
    const card = node('article', undefined, 'report-card');
    card.append(node('h3', plan.name), node('p', plan.enabled ? '已启用' : '已暂停', 'eyebrow'));
    card.append(
      button('试跑条件', async () => {
        const { createdAt, updatedAt, ...config } = plan;
        const result = await api('/api/alerts/preview', 'POST', { plan: config });
        const preview = clear('#alert-preview');
        preview.append(
          node('h3', '试跑结果'),
          node('p', '本次只计算条件，不初始化边沿，也不会生成通知。', 'fineprint'),
        );
        for (const condition of result.evaluation.conditions)
          preview.append(
            node(
              'p',
              `${condition.stockId} · ${condition.known ? (condition.active ? '当前满足' : '当前未满足') : '无法判断'} · ${condition.reason}${condition.value === undefined ? '' : ` · 观测值 ${condition.value}`}${condition.dataAsOf === undefined ? '' : ` · 市场时点 ${fmtTime(condition.dataAsOf)}`}`,
            ),
          );
      }),
    );
    card.append(
      button(plan.enabled ? '暂停' : '启用我设置的条件', async () => {
        if (plan.enabled)
          await api('/api/alerts/pause', 'POST', {
            alertPlanId: plan.id,
            expectedPlanRevision: revision,
            requestId: crypto.randomUUID(),
          });
        else {
          const { createdAt, updatedAt, ...config } = plan;
          await api('/api/alerts', 'POST', {
            plan: { ...config, enabled: true },
            expectedPlanRevision: revision,
            requestId: crypto.randomUUID(),
            enableConfirmed: true,
          });
        }
        await loadAlerts();
      }),
    );
    card.append(
      button(
        '移除提醒',
        async () => {
          await api('/api/alerts/remove', 'POST', {
            alertPlanId: plan.id,
            expectedPlanRevision: revision,
            requestId: crypto.randomUUID(),
          });
          await loadAlerts();
        },
        'text-button',
      ),
    );
    container.append(card);
  }
};
const pollJob = async (job) => {
  if (!state.me) return;
  state.job = job;
  const epoch = state.epoch;
  const element = $('#job-status');
  element.hidden = false;
  const labels = {
    preparing: '正在保存输入',
    queued: '已排队',
    running: '正在整理事实',
    succeeded: '摘要已保存',
    partial: '摘要已保存，部分数据不可用',
    failed: '任务未完成',
    cancelled: '任务已取消',
    'needs-review': '任务需要核查',
  };
  element.textContent = labels[job.state] ?? job.state;
  if (['preparing', 'queued', 'running'].includes(job.state)) {
    element.append(
      button('请求取消', async () => {
        await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, 'POST', {});
      }),
    );
    $('#generate-report').disabled = true;
    setTimeout(() => {
      if (state.epoch === epoch)
        api(`/api/jobs/${encodeURIComponent(job.id)}`)
          .then(pollJob)
          .catch((error) => {
            $('#generate-report').disabled = false;
            notice(
              error instanceof TypeError ? '连接中断，请检查网络后重试。' : error.message,
              true,
            );
          });
    }, 1_500);
  } else {
    $('#generate-report').disabled = false;
    await renderReports();
  }
};
$('#request-code').addEventListener(
  'click',
  action(async () => {
    if (!$('#email').reportValidity()) return;
    const result = await api('/api/auth/challenges', 'POST', { email: $('#email').value });
    state.challengeId = result.challengeId;
    $('#login-message').textContent = '若邮箱可以接收邮件，验证码已发送。5 分钟内有效。';
  }),
);
$('#login-form').addEventListener(
  'submit',
  action(async () => {
    if (!state.challengeId) throw new Error('请先发送验证码。');
    await api('/api/auth/sessions', 'POST', {
      challengeId: state.challengeId,
      code: $('#code').value,
      acceptTerms: $('#accept-terms').checked,
    });
    $('#code').value = '';
    state.challengeId = '';
    sessionChannel.postMessage('changed');
    await loadMe();
  }),
);
$('#logout').addEventListener(
  'click',
  action(async () => {
    await api('/api/auth/session', 'DELETE', {});
    sessionChannel.postMessage('changed');
    showLogin();
  }),
);
$('#new-watchlist-form').addEventListener(
  'submit',
  action(async () => {
    const created = await api('/api/watchlists', 'POST', { name: $('#watchlist-name').value });
    $('#watchlist-name').value = '';
    state.selected = created.watchlist?.id ?? created.id;
    await refreshWorkspace();
  }),
);
$('#refresh-workspace').addEventListener(
  'click',
  action(async () => {
    await loadMe();
    notice('已刷新保存内容。');
  }),
);
for (const tab of document.querySelectorAll('.tab'))
  tab.addEventListener(
    'click',
    action(() => showPage(tab.dataset.page)),
  );
$('#open-import').addEventListener('click', () => {
  state.preview = null;
  clear('#import-preview');
  $('#commit-import').hidden = true;
  $('#import-dialog').showModal();
});
$('#close-import').addEventListener('click', () => $('#import-dialog').close());
$('#import-text').addEventListener('input', () => {
  state.importFormat = 'text';
  state.preview = null;
  $('#commit-import').hidden = true;
});
$('#import-file').addEventListener(
  'change',
  action(async () => {
    const file = $('#import-file').files[0];
    if (!file) return;
    if (file.size > 1_048_576) throw new Error('文件不能超过 1 MiB。');
    $('#import-text').value = new TextDecoder('utf-8', { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    state.importFormat = 'csv';
    state.preview = null;
    $('#commit-import').hidden = true;
  }),
);
$('#preview-import').addEventListener(
  'click',
  action(async () => {
    const result = await api(
      `/api/watchlists/${encodeURIComponent(state.selected)}/import/preview`,
      'POST',
      { content: $('#import-text').value, format: state.importFormat },
    );
    state.preview = result.preview;
    const container = clear('#import-preview');
    for (const row of result.preview.rows) {
      const line = node('label', undefined, 'preview-row');
      line.append(node('span', `${row.row}. ${row.text}`));
      const select = node('select');
      select.dataset.row = String(row.row);
      select.append(new Option('明确排除本行', ''));
      for (const stock of row.candidates)
        select.append(new Option(`${stock.name} · ${stock.id}`, stock.id));
      if (row.status === 'ready') select.value = row.stockId;
      line.append(
        select,
        node(
          'span',
          {
            ready: '已识别',
            duplicate: '重复，默认排除',
            unknown: '未知，需排除',
            ambiguous: '有歧义，请选择',
          }[row.status],
          'muted',
        ),
      );
      container.append(line);
    }
    $('#extra-columns').hidden = !result.preview.ignoredColumns.length;
    $('#acknowledge-columns').checked = false;
    $('#commit-import').hidden = false;
  }),
);
$('#commit-import').addEventListener(
  'click',
  action(async () => {
    if (!state.preview) return;
    const selections = [];
    const excludedRows = [];
    for (const select of document.querySelectorAll('#import-preview select')) {
      if (select.value) selections.push({ row: Number(select.dataset.row), stockId: select.value });
      else excludedRows.push(Number(select.dataset.row));
    }
    const data = await api('/api/watchlists/import/commit', 'POST', {
      previewId: state.preview.id,
      inputHash: state.preview.inputHash,
      requestId: crypto.randomUUID(),
      selections,
      excludedRows,
      acknowledgeExtraColumns: $('#acknowledge-columns').checked,
    });
    $('#import-dialog').close();
    await selectList(state.selected);
    notice(`已导入 ${data.result.enteredCount} 项关注。`);
  }),
);
$('#generate-report').addEventListener(
  'click',
  action(async () => {
    const result = await api('/api/jobs', 'POST', {
      operation: 'report.watchlist-facts',
      version: 1,
      requestId: crypto.randomUUID(),
      input: { watchlistId: state.selected },
    });
    await pollJob(result.job);
  }),
);
$('#rule-kind').addEventListener('change', () => {
  $('#rule-unit').textContent = $('#rule-kind').value === 'price-level' ? '元' : '%';
});
$('#alert-form').addEventListener(
  'submit',
  action(async () => {
    if (!state.selected) throw new Error('请先选择自选列表。');
    const above = $('#rule-direction').value === 'above';
    const ruleKind = $('#rule-kind').value;
    const rule =
      ruleKind === 'price-level'
        ? {
            kind: ruleKind,
            id: crypto.randomUUID(),
            side: above ? 'above' : 'below',
            level: Number($('#rule-value').value),
          }
        : {
            kind: ruleKind,
            id: crypto.randomUUID(),
            direction: above ? 'up' : 'down',
            pct: Number($('#rule-value').value) / 100,
          };
    const plan = {
      id: crypto.randomUUID(),
      name: $('#alert-name').value,
      watchlistId: state.selected,
      rules: [rule],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 60,
      dailyNotificationLimit: 5,
      notifyOnRecovery: false,
      enabled: false,
    };
    await api('/api/alerts', 'POST', {
      plan,
      expectedPlanRevision: null,
      requestId: crypto.randomUUID(),
      enableConfirmed: false,
    });
    await loadAlerts();
  }),
);
const pollExport = async (metadata, epoch) => {
  if (state.epoch !== epoch) return;
  const container = clear('#exports');
  if (metadata.state === 'ready') {
    const link = node('a', '下载我的资料');
    link.href = `/api/data/exports/${encodeURIComponent(metadata.id)}/download`;
    link.download = 'luoome-personal-data.json';
    container.append(
      link,
      node('p', `需当前账户登录 · 有效至 ${fmtTime(metadata.expiresAt)}`, 'fineprint'),
    );
  } else if (metadata.state === 'requested') {
    container.append(node('p', '正在准备导出，可以继续使用工作区。', 'muted'));
    setTimeout(() => {
      if (state.epoch === epoch)
        api(`/api/data/exports/${encodeURIComponent(metadata.id)}`)
          .then((result) => pollExport(result.export, epoch))
          .catch((error) => notice(error.message, true));
    }, 1500);
  } else
    container.append(
      node(
        'p',
        metadata.state === 'expired' ? '导出已过期，请重新申请。' : '导出未完成，请稍后重新申请。',
        'muted',
      ),
    );
};
$('#export-data').addEventListener(
  'click',
  action(async () => {
    const result = await api('/api/data/exports', 'POST', { requestId: crypto.randomUUID() });
    await pollExport(result.export, state.epoch);
  }),
);
$('#delete-account').addEventListener('click', () => {
  $('#deletion-email').textContent = `当前邮箱：${state.me.user.email}`;
  $('#deletion-code').value = '';
  $('#deletion-confirmation').value = '';
  state.deletionChallengeId = '';
  $('#deletion-dialog').showModal();
});
$('#close-deletion').addEventListener('click', () => $('#deletion-dialog').close());
$('#deletion-request-code').addEventListener(
  'click',
  action(async () => {
    const result = await api('/api/auth/challenges', 'POST', { email: state.me.user.email });
    state.deletionChallengeId = result.challengeId;
    notice('确认验证码已发送到当前邮箱，5 分钟内有效。');
  }),
);
$('#deletion-form').addEventListener(
  'submit',
  action(async () => {
    if ($('#deletion-confirmation').value !== '删除我的数据')
      throw new Error('请完整输入「删除我的数据」。');
    if (!state.deletionChallengeId) throw new Error('请先发送确认验证码。');
    await api('/api/auth/sessions', 'POST', {
      challengeId: state.deletionChallengeId,
      code: $('#deletion-code').value,
      acceptTerms: true,
    });
    const me = await api('/api/me');
    state.me = me;
    state.csrf = me.csrfToken;
    const result = await api('/api/me/deletion', 'POST', {
      confirmation: '删除我的数据',
      requestId: crypto.randomUUID(),
    });
    sessionChannel.postMessage('changed');
    $('#deletion-dialog').close();
    showLogin();
    notice(
      `删除已受理（${result.deletionId ?? '已登记'}）。旧会话已撤销，正在排空任务并清除资料。`,
    );
  }),
);
sessionChannel.addEventListener('message', (event) => {
  if (event.data !== 'changed') return;
  showLogin();
  loadMe().catch(() => showLogin());
});
api('/health/ready')
  .then((health) => {
    $('#fixture-banner').hidden = !health.fixture;
  })
  .catch(() => {});
loadMe().catch(() => showLogin());
