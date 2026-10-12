import { callApi, getHostedSession } from './api.js';

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
  if (!result.ok)
    throw new Error(
      result.error?.required?.startsWith('entitlement:')
        ? '订阅已到期，请续费后再试。'
        : (result.error?.message ?? '暂时无法完成，请稍后重试。'),
    );
  return result.data;
};
const post = (path, input) => read(path, { method: 'POST', body: JSON.stringify(input) });
const button = (text, action, setStatus) => {
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

export const renderHostedSubscription = async (setStatus) => {
  const box = document.getElementById('hosted-subscription');
  if (!box) return;
  const [subscription, orders] = await Promise.all([
    read('/api/subscription'),
    read('/api/subscription/orders'),
  ]);
  const session = getHostedSession();
  if (!session) return;
  box.replaceChildren(node('h2', '我的订阅'), node('p', session.user.email, 'muted'));
  if (session.fixture) box.append(node('p', '当前为模拟环境，订单不会扣款。', 'text-warn'));
  if (subscription.current) {
    const { period, plan } = subscription.current;
    box.append(
      node(
        'p',
        `${period.status === 'trial' ? '试用中' : '订阅生效'} · ${plan.code} · 有效至 ${date(period.endsAt)}`,
      ),
    );
  } else box.append(node('p', '订阅已到期。已保存的记录仍可查看；续费后可继续编辑和运行任务。'));
  box.append(
    node('p', '按次购买服务期，不自动扣款。付款状态以服务端核实的支付结果为准。', 'muted'),
  );
  const purchases = node('div', undefined, 'hosted-actions');
  for (const plan of subscription.plans) {
    let requestId = null;
    purchases.append(
      button(
        session.fixture
          ? '创建模拟续费订单'
          : `购买 ${plan.durationMonths} 个月 · ${amount(plan.priceMinor, plan.currency)}`,
        async () => {
          requestId ??= crypto.randomUUID();
          const result = await post('/api/subscription/orders', {
            planVersionId: plan.id,
            requestId,
          });
          setStatus(session.fixture ? '模拟订单已创建，不会扣款。' : '订单已创建，请完成支付。');
          if (!session.fixture && result.checkout?.checkoutUrl) {
            const url = new URL(result.checkout.checkoutUrl);
            if (url.protocol !== 'https:') throw new Error('支付链接不可用，请查询订单状态。');
            const link = node('a', '前往支付', 'btn btn-primary');
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            purchases.append(link);
          }
          await renderOrders(
            box.querySelector('#hosted-orders'),
            await read('/api/subscription/orders'),
            setStatus,
          );
        },
        setStatus,
      ),
    );
  }
  box.append(purchases);
  const history = node('section');
  history.id = 'hosted-orders';
  box.append(history);
  await renderOrders(history, orders, setStatus);
};

const renderOrders = async (box, orders, setStatus) => {
  if (!box) return;
  box.replaceChildren(node('h3', '订单记录'));
  if (orders.length === 0) box.append(node('p', '暂无订单', 'muted'));
  for (const order of orders) {
    const row = node('div', undefined, 'hosted-order');
    const label =
      { created: '核查中', pending: '等待支付', paid: '已支付', closed: '已关闭' }[order.state] ??
      '处理中';
    row.append(
      node(
        'p',
        `${amount(order.amountMinor, order.currency)} · ${label} · ${date(order.createdAt)}`,
      ),
    );
    if (['created', 'pending'].includes(order.state))
      row.append(
        button(
          '查询支付结果',
          async () => {
            const result = await post(
              `/api/subscription/orders/${encodeURIComponent(order.id)}/query`,
              {},
            );
            setStatus(
              result.observation === 'confirmed'
                ? '支付已确认，订阅已更新。'
                : '尚未确认支付，请稍后查询。',
            );
            await renderHostedSubscription(setStatus);
          },
          setStatus,
        ),
      );
    box.append(row);
  }
};

export const renderHostedNotifications = async (setStatus) => {
  const box = document.getElementById('hosted-notifications');
  if (!box) return;
  const [preferences, deliveries] = await Promise.all([
    read('/api/notifications/preferences'),
    read('/api/notifications'),
  ]);
  const session = getHostedSession();
  if (!session) return;
  box.replaceChildren(
    node('h2', '通知设置'),
    node('p', `收件邮箱：${session.user.email}`, 'muted'),
    node('p', '当前可保存通知偏好；策略和预警的自动邮件通知尚未开通。', 'text-warn'),
  );
  const check = (id, text, checked) => {
    const label = node('label', undefined, 'hosted-check');
    const input = node('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    label.append(input, document.createTextNode(text));
    box.append(label);
    return input;
  };
  const email = check('hosted-email-enabled', '发送邮件通知', preferences.emailEnabled);
  const quiet = check('hosted-quiet-hours', '启用安静时段', preferences.quietHours.enabled);
  const timeInput = (labelText, id, minutes) => {
    const label = node('label', labelText, 'field');
    const input = node('input');
    input.type = 'time';
    input.id = id;
    input.required = true;
    input.value = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    label.append(input);
    box.append(label);
    return input;
  };
  const start = timeInput(
    '安静时段开始（上海时间）',
    'hosted-quiet-start',
    preferences.quietHours.startMinutes,
  );
  const end = timeInput(
    '安静时段结束（上海时间）',
    'hosted-quiet-end',
    preferences.quietHours.endMinutes,
  );
  box.append(
    node('p', '邮件提示有新记录，详情需登录查看。提醒条件仍在原来的“预警”页面管理。', 'muted'),
  );
  box.append(
    button(
      '保存通知设置',
      async () => {
        if (!start.reportValidity() || !end.reportValidity()) return;
        const minutes = (value) => {
          const [h, m] = value.split(':').map(Number);
          return h * 60 + m;
        };
        await read('/api/notifications/preferences', {
          method: 'PUT',
          body: JSON.stringify({
            expectedRevision: preferences.revision,
            emailEnabled: email.checked,
            detail: preferences.detail,
            quietHours: {
              enabled: quiet.checked,
              startMinutes: minutes(start.value),
              endMinutes: minutes(end.value),
              timeZone: 'Asia/Shanghai',
            },
          }),
        });
        setStatus('通知设置已保存。');
        await renderHostedNotifications(setStatus);
      },
      setStatus,
    ),
  );
  box.append(node('h3', '近期通知'));
  if (!deliveries.length) box.append(node('p', '暂无通知记录', 'muted'));
  const labels = {
    pending: '待发送',
    sending: '发送中',
    accepted: '渠道已受理',
    delivered: '已送达',
    failed: '发送失败',
    unknown: '待核实',
    suppressed: '已停止',
  };
  for (const item of deliveries)
    box.append(node('p', `${labels[item.state] ?? '处理中'} · ${date(item.createdAt)}`));
};
