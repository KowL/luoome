import { callApi, isHostedMode } from './api.js';

const form = document.getElementById('hosted-watch-feishu');
if (isHostedMode() && form) {
  let settings;
  let loading = false;
  const field = (id) => document.getElementById(id);
  const status = (message) => {
    field('hosted-watch-feishu-status').textContent = message;
  };
  const request = async (path, input) => {
    const result = await callApi(
      path,
      input === undefined ? undefined : { method: 'POST', body: JSON.stringify(input) },
    );
    if (!result.ok)
      throw new Error(
        result.error?.required?.startsWith('entitlement:')
          ? '订阅已到期，请续费后再试。'
          : (result.error?.message ?? '暂时无法完成，请稍后重试。'),
      );
    return result.data;
  };
  const render = async () => {
    if (
      loading ||
      document.body.classList.contains('auth-pending') ||
      !location.hash.startsWith('#settings') ||
      !location.hash.includes('notify')
    )
      return;
    loading = true;
    try {
      const [next, deliveries] = await Promise.all([
        request('/api/notifications/feishu'),
        request('/api/notifications/watch-deliveries'),
      ]);
      settings = next;
      field('hosted-watch-feishu-configured').textContent = next.configured
        ? '已配置，密钥不回显'
        : '未配置，使用日志备用';
      field('hosted-watch-feishu-enabled').checked = next.enabled;
      field('hosted-watch-feishu-url').value = '';
      field('hosted-watch-feishu-clear').checked = false;
      field('hosted-watch-feishu-test').disabled = !next.configured || !next.enabled;
      const list = field('hosted-watch-deliveries');
      list.replaceChildren();
      for (const item of deliveries.slice(0, 10)) {
        const line = document.createElement('p');
        line.textContent = `${item.state === 'accepted' ? '渠道已受理，设备未验证' : item.state === 'unknown' ? '结果待核实，未自动重发' : item.errorKind === 'fallback-log' ? '日志备用' : { pending: '待发送', sending: '发送中', failed: '发送失败', suppressed: '已停止' }[item.state]} · ${new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        list.append(line);
      }
    } catch (error) {
      status(error.message);
    } finally {
      loading = false;
    }
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!settings || !form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await request('/api/notifications/feishu', {
        expectedRevision: settings.revision,
        enabled: field('hosted-watch-feishu-enabled').checked,
        webhookUrl: field('hosted-watch-feishu-url').value.trim() || undefined,
        clearWebhook: field('hosted-watch-feishu-clear').checked,
        quietHours: settings.quietHours,
      });
      status('飞书设置已保存。旧绑定的待发提醒已停止。');
      await render();
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  });
  field('hosted-watch-feishu-test').addEventListener('click', async () => {
    const button = field('hosted-watch-feishu-test');
    button.disabled = true;
    try {
      await request('/api/notifications/feishu/test', {});
      status('渠道已受理，请在飞书群核对；设备送达未验证。');
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = !settings?.configured || !settings.enabled;
    }
  });
  window.addEventListener('hashchange', render);
  new MutationObserver(render).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  void render();
} else form?.remove();
