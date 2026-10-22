import { callApi, getHostedSession, getSessionEpoch, randomRequestId } from './api.js';

const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const date = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const amount = (value, currency) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value / 100);
const read = async (path, init) => {
  const result = await callApi(path, init);
  if (!result.ok) {
    if (result.error?.required === 'hosted:admin') throw new Error('当前账号不是管理员。');
    if (result.error?.message === 'operator_reference_reused')
      throw new Error('同一凭证备注已登记过一笔收款，请补充区分信息。');
    throw new Error(result.error?.message ?? '暂时无法完成，请稍后重试。');
  }
  return result.data;
};
const post = (path, input) => read(path, { method: 'POST', body: JSON.stringify(input) });
const actionButton = (text, action, setStatus) => {
  const element = node('button', text, 'btn btn-outline btn-sm');
  element.type = 'button';
  element.addEventListener('click', async () => {
    element.disabled = true;
    try {
      await action();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      element.disabled = false;
    }
  });
  return element;
};

const USER_STATUS = { active: '正常', disabled: '已停用', deleted: '已删除' };
const TENANT_STATUS = {
  provisioning: '初始化中',
  active: '正常',
  suspended: '已暂停',
  deleting: '删除中',
  deleted: '已删除',
};
const PERIOD_STATUS = { trial: '试用', paid: '已付费', expired: '已到期', revoked: '已撤销' };
const ORDER_STATE = { created: '核查中', pending: '等待支付', paid: '已支付', closed: '已关闭' };

const entitlementText = (entitlement) => {
  if (entitlement === null) return '无有效订阅';
  const { period, plan, availableUnits } = entitlement;
  return `${PERIOD_STATUS[period.status] ?? period.status} · ${plan.code} · 至 ${date(period.endsAt)} · 剩余额度 ${availableUnits}`;
};

const renderDetail = async (box, row, setStatus) => {
  box.replaceChildren(node('p', '正在加载详情…', 'muted'));
  const detail = await read(`/api/admin/users/${encodeURIComponent(row.tenant.id)}`);
  box.replaceChildren();
  box.append(node('h3', `详情 · ${detail.user.email ?? detail.user.emailKey}`));
  box.append(
    node(
      'p',
      `注册 ${date(detail.user.createdAt)} · 工作区 ${TENANT_STATUS[detail.tenant.status] ?? detail.tenant.status}`,
      'muted',
    ),
  );

  const payment = node('section', undefined, 'hosted-admin-payment');
  payment.append(node('h4', '标记收款 / 赠送服务期'));
  const plans = [...new Map(detail.periods.map((period) => [period.planVersionId, null])).keys()];
  const select = node('select');
  const options = await read('/api/subscription').catch(() => null);
  const planChoices = options?.plans?.length
    ? options.plans
    : plans.map((id) => ({ id, code: id, durationMonths: 0, priceMinor: 0, currency: 'CNY' }));
  for (const plan of planChoices) {
    const option = node(
      'option',
      `${plan.code} · ${plan.durationMonths} 个月 · ${amount(plan.priceMinor, plan.currency)}`,
    );
    option.value = plan.id;
    select.append(option);
  }
  const reference = node('input');
  reference.type = 'text';
  reference.placeholder = '凭证备注，如：微信转账 2026-10-15 或 赠送';
  reference.minLength = 2;
  reference.maxLength = 120;
  const referenceLabel = node('label', '凭证备注', 'field');
  referenceLabel.append(reference);
  let requestId = null;
  payment.append(
    select,
    referenceLabel,
    actionButton(
      '确认登记',
      async () => {
        if (!reference.reportValidity()) return;
        requestId ??= randomRequestId();
        const result = await post(
          `/api/admin/users/${encodeURIComponent(row.tenant.id)}/operator-payments`,
          { planVersionId: select.value, reference: reference.value.trim(), requestId },
        );
        setStatus(
          result.replayed
            ? '该请求已登记过，未重复入账。'
            : `已登记 ${amount(result.order.amountMinor, result.order.currency)}，服务期至 ${date(result.period.endsAt)}。`,
        );
        requestId = null;
        await renderDetail(box, row, setStatus);
        await renderHostedAdmin(setStatus, { keepDetail: row.tenant.id });
      },
      setStatus,
    ),
    node('p', '线下收款（微信 / 支付宝转账）或赠送在此登记，立即授予服务期。', 'muted'),
  );
  box.append(payment);

  const periods = node('section');
  periods.append(node('h4', '服务期'));
  for (const period of [...detail.periods].sort(
    (a, b) => new Date(b.startsAt) - new Date(a.startsAt),
  ))
    periods.append(
      node(
        'p',
        `${PERIOD_STATUS[period.status] ?? period.status} · ${date(period.startsAt)} ～ ${date(period.endsAt)} · 套餐 ${period.planVersionId}`,
        'muted',
      ),
    );
  box.append(periods);

  const orders = node('section');
  orders.append(node('h4', '订单'));
  if (detail.orders.length === 0) orders.append(node('p', '暂无订单', 'muted'));
  for (const order of detail.orders)
    orders.append(
      node(
        'p',
        `${amount(order.amountMinor, order.currency)} · ${ORDER_STATE[order.state] ?? order.state} · ${order.provider === 'operator-manual' ? '人工登记' : order.provider} · ${date(order.createdAt)}`,
        'muted',
      ),
    );
  box.append(orders);

  const usage = node('section');
  usage.append(node('h4', '额度流水'));
  if (detail.usage.length === 0) usage.append(node('p', '暂无额度消耗', 'muted'));
  for (const entry of [...detail.usage].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  ))
    usage.append(
      node(
        'p',
        `${entry.delta > 0 ? '+' : ''}${entry.delta} · ${entry.reason === 'capture' ? '消耗' : '修正'} · ${date(entry.createdAt)}`,
        'muted',
      ),
    );
  box.append(usage);
};

export const renderHostedAdmin = async (setStatus, options = {}) => {
  const box = document.getElementById('hosted-admin');
  if (!box) return;
  const session = getHostedSession();
  if (!session?.admin) {
    box.replaceChildren(node('h2', '管理'), node('p', '当前账号不是管理员。'));
    return;
  }
  const epoch = getSessionEpoch();
  const { users } = await read('/api/admin/users');
  if (getSessionEpoch() !== epoch || !getHostedSession()?.admin) return;
  box.replaceChildren(
    node('h2', '用户与订阅管理'),
    node('p', `共 ${users.length} 个用户`, 'muted'),
  );
  const ai = node('a', '配置 AI 模型 →', 'btn btn-ghost');
  ai.href = '#settings?tab=ai';
  box.append(ai);
  for (const row of users) {
    const card = node('section', undefined, 'hosted-admin-user');
    const head = node('div', undefined, 'hosted-admin-user-head');
    head.append(
      node(
        'p',
        `${row.user.email ?? row.user.emailKey} · ${USER_STATUS[row.user.status] ?? row.user.status}`,
      ),
      node('p', entitlementText(row.entitlement), 'muted'),
    );
    const detailBox = node('div', undefined, 'hosted-admin-detail');
    detailBox.hidden = true;
    const actions = node('div', undefined, 'hosted-actions');
    let loaded = false;
    actions.append(
      actionButton(
        '详情',
        async () => {
          detailBox.hidden = !detailBox.hidden;
          if (!detailBox.hidden && !loaded) {
            loaded = true;
            await renderDetail(detailBox, row, setStatus);
          }
        },
        setStatus,
      ),
    );
    if (row.user.status === 'active')
      actions.append(
        actionButton(
          '停用',
          async () => {
            await post(`/api/admin/users/${encodeURIComponent(row.user.id)}/status`, {
              status: 'disabled',
            });
            setStatus(`已停用 ${row.user.email ?? row.user.emailKey}，其会话已全部失效。`);
            await renderHostedAdmin(setStatus);
          },
          setStatus,
        ),
      );
    if (row.user.status === 'disabled')
      actions.append(
        actionButton(
          '恢复',
          async () => {
            await post(`/api/admin/users/${encodeURIComponent(row.user.id)}/status`, {
              status: 'active',
            });
            setStatus(`已恢复 ${row.user.email ?? row.user.emailKey}。`);
            await renderHostedAdmin(setStatus);
          },
          setStatus,
        ),
      );
    head.append(actions);
    card.append(head, detailBox);
    box.append(card);
    if (options.keepDetail === row.tenant.id) {
      detailBox.hidden = false;
      loaded = true;
      await renderDetail(detailBox, row, setStatus);
    }
  }
};
