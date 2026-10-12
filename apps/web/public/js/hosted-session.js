import {
  callApi,
  clearHostedSession,
  configureHostedSession,
  getHostedSession,
  isHostedMode,
  onHostedSessionExpired,
  setAccountId,
} from './api.js';

const SESSION_EVENT = 'luoome.session.changed';
let channel;
const reloadSession = () => {
  document.body.classList.add('auth-pending');
  clearHostedSession();
  window.location.reload();
};
const broadcast = () => {
  channel?.postMessage('changed');
  try {
    localStorage.setItem(SESSION_EVENT, crypto.randomUUID());
  } catch {
    /* 跨标签备用通道不可用。 */
  }
};
const errorText = (error) =>
  error?.required === 'auth:rate-limit'
    ? '发送过于频繁，请稍后重试。'
    : '暂时无法完成，请检查验证码或稍后重试。';

const waitForLogin = () =>
  new Promise((resolve) => {
    const card = document.createElement('section');
    card.id = 'hosted-auth';
    card.className = 'card hosted-auth';
    card.innerHTML = `
    <h1>登录 luoome</h1>
    <p class="muted">登录后继续管理你的自选、策略、通知与复盘。</p>
    <form id="hosted-login-form">
      <div class="field"><label for="hosted-email">邮箱</label><input id="hosted-email" type="email" autocomplete="email" required /></div>
      <button id="hosted-send-code" class="btn btn-outline" type="button">发送验证码</button>
      <div class="field"><label for="hosted-code">邮箱验证码</label><input id="hosted-code" autocomplete="one-time-code" inputmode="numeric" required /></div>
      <details><summary>服务说明</summary><p>此服务用于个人投资研究和记录，不自动下单，不承诺投资收益。订阅为主动购买服务期，不自动扣款。你的数据按登录用户隔离。</p></details>
      <label class="hosted-check"><input id="hosted-terms" type="checkbox" required />我已阅读并接受以上服务说明</label>
      <button class="btn btn-primary" type="submit">登录 / 注册</button>
    </form>
    <p id="hosted-login-status" role="status" aria-live="polite"></p>`;
    document.getElementById('hosted-auth')?.remove();
    document.body.append(card);
    let challengeId = '';
    let challengeEmail = '';
    const status = card.querySelector('#hosted-login-status');
    const send = card.querySelector('#hosted-send-code');
    send.addEventListener('click', async () => {
      const email = card.querySelector('#hosted-email');
      if (!email.reportValidity()) return;
      send.disabled = true;
      const result = await callApi('/api/auth/challenges', {
        method: 'POST',
        body: JSON.stringify({ email: email.value.trim() }),
      });
      send.disabled = false;
      if (!result.ok) {
        status.textContent = errorText(result.error);
        return;
      }
      challengeId = result.data.challengeId;
      challengeEmail = email.value.trim();
      status.textContent = '验证码已发送，请查收邮箱。';
      card.querySelector('#hosted-code').focus();
    });
    card.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!challengeId || challengeEmail !== card.querySelector('#hosted-email').value.trim()) {
        status.textContent = '请先向当前邮箱发送验证码。';
        return;
      }
      const button = card.querySelector('[type="submit"]');
      button.disabled = true;
      const result = await callApi('/api/auth/sessions', {
        method: 'POST',
        body: JSON.stringify({
          challengeId,
          code: card.querySelector('#hosted-code').value.trim(),
          acceptTerms: true,
        }),
      });
      button.disabled = false;
      if (!result.ok) {
        status.textContent = errorText(result.error);
        return;
      }
      broadcast();
      card.remove();
      resolve();
    });
  });

export const initializeHostedSession = async () => {
  if (!isHostedMode()) return;
  document.body.classList.add('auth-pending');
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(SESSION_EVENT);
    channel.onmessage = reloadSession;
  }
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_EVENT) reloadSession();
  });
  onHostedSessionExpired(reloadSession);
  while (true) {
    const me = await callApi('/api/me');
    if (!me.ok) {
      await waitForLogin();
      continue;
    }
    configureHostedSession(me.data);
    if (!['active', 'suspended'].includes(me.data.tenant.status)) {
      let notice = document.getElementById('hosted-auth');
      if (!notice) {
        notice = document.createElement('section');
        notice.id = 'hosted-auth';
        notice.className = 'card hosted-auth';
        document.body.append(notice);
      }
      notice.textContent = me.data.tenant.provisioningErrorKind
        ? '工作区初始化暂未完成，请稍后重试。'
        : '正在准备你的工作区和默认账户…';
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    const accounts = await callApi('/api/accounts');
    if (!accounts.ok || accounts.data.accounts.length !== 1) {
      let notice = document.getElementById('hosted-auth');
      if (!notice) {
        notice = document.createElement('section');
        notice.id = 'hosted-auth';
        notice.className = 'card hosted-auth';
        document.body.append(notice);
      }
      notice.textContent = '暂时无法打开默认账户，请稍后刷新重试。';
      return false;
    }
    setAccountId(accounts.data.accounts[0].id);
    document.getElementById('hosted-auth')?.remove();
    document.querySelector('.account-select-wrap')?.remove();
    const userLink = document.createElement('a');
    userLink.href = '#settings?tab=subscription';
    userLink.className = 'btn btn-ghost btn-sm';
    userLink.textContent = me.data.fixture ? '模拟订阅 · 不扣款' : '我的订阅';
    document.querySelector('.topbar-meta').prepend(userLink);
    const logout = document.createElement('button');
    logout.className = 'btn btn-ghost btn-sm';
    logout.textContent = '退出登录';
    logout.type = 'button';
    logout.addEventListener('click', async () => {
      const result = await callApi('/api/auth/session', { method: 'DELETE' });
      if (!result.ok) {
        logout.textContent = '退出失败，重试';
        return;
      }
      broadcast();
      reloadSession();
    });
    document.querySelector('.topbar-meta').append(logout);
    document.getElementById('btn-account-create')?.closest('.card').remove();
    document.querySelector('.vault-settings-card')?.remove();
    for (const tab of ['ai', 'market', 'data']) {
      document.querySelector(`[data-settings-tab="${tab}"]`)?.remove();
      document.querySelector(`[data-settings-pane="${tab}"]`)?.remove();
    }
    const subscriptionNav = document.createElement('a');
    subscriptionNav.href = '#settings?tab=subscription';
    subscriptionNav.className = 'settings-subnav-item';
    subscriptionNav.dataset.settingsTab = 'subscription';
    subscriptionNav.textContent = '订阅';
    document.querySelector('.settings-subnav').prepend(subscriptionNav);
    const subscription = document.createElement('div');
    subscription.dataset.settingsPane = 'subscription';
    subscription.id = 'hosted-subscription';
    subscription.className = 'card';
    subscription.hidden = true;
    document.getElementById('route-settings').append(subscription);
    const notify = document.getElementById('feishu-settings-form');
    const personalNotify = document.createElement('div');
    personalNotify.id = 'hosted-notifications';
    personalNotify.dataset.settingsPane = 'notify';
    personalNotify.className = 'card';
    personalNotify.hidden = true;
    notify.replaceWith(personalNotify);
    document.querySelector('[data-settings-tab="system"]').textContent = '账户与记录';
    document.querySelector('#route-settings .route-meta').textContent = '订阅 / 通知 / 账户与记录';
    document.body.classList.remove('auth-pending');
    let checking = false;
    const checkIdentity = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const current = await callApi('/api/me');
        if (current.ok && current.data.user.id !== getHostedSession()?.user.id) reloadSession();
      } finally {
        checking = false;
      }
    };
    window.addEventListener('focus', checkIdentity);
    document.addEventListener('visibilitychange', checkIdentity);
    return true;
  }
};
