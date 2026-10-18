import {
  callApi,
  clearHostedSession,
  configureHostedSession,
  getHostedSession,
  isHostedMode,
  onHostedSessionExpired,
  randomRequestId,
  setAccountId,
} from './api.js';
import { createHostedPasswordForm } from './hosted-settings.js';

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
    localStorage.setItem(SESSION_EVENT, randomRequestId());
  } catch {
    /* 跨标签备用通道不可用。 */
  }
};
export const restartHostedSession = () => {
  broadcast();
  reloadSession();
};
const errorText = (error) => {
  if (error?.required === 'auth:password-rate-limit') return '登录尝试过于频繁，请 15 分钟后再试。';
  if (error?.required === 'auth:rate-limit') return '发送过于频繁，请稍后重试。';
  if (error?.required === 'security:same-origin')
    return '请求来源与当前页面不一致，请刷新页面后重试。';
  if (error?.cause === 'provider_unconfigured') return '邮件服务尚未配置，请联系管理员。';
  if (error?.cause === 'challenge_delivery_failed') return '验证码邮件发送失败，请稍后重试。';
  if (error?.cause === 'challenge_delivery_unknown')
    return '邮件发送结果暂未确认，请稍后重新发送验证码。';
  if (error?.required === 'auth:valid-credentials')
    return '验证码错误、已过期或当前邮箱无法登录，请检查后重试。';
  if (error?.kind === 'timeout' || error?.kind === 'adapter_error')
    return '网络或邮件服务暂时不可用，请稍后重试。';
  return '暂时无法完成，请稍后重试。';
};

const waitForLogin = (authConfig) =>
  new Promise((resolve) => {
    const card = document.createElement('section');
    card.id = 'hosted-auth';
    card.className = 'card hosted-auth';
    card.innerHTML = `
    <h1>登录 luoome</h1>
    <p id="hosted-login-intro" class="muted">使用邮箱账号和密码登录。</p>
    <div class="hosted-actions"><button id="hosted-mode-login" type="button" class="btn btn-primary btn-sm">密码登录</button><button id="hosted-mode-register" type="button" class="btn btn-outline btn-sm">${authConfig?.registrationEnabled ? '注册 / 首次设置密码' : '首次设置密码'}</button></div>
    ${authConfig && !authConfig.secureTransport ? '<p class="muted">临时 HTTP 访问：验证码和登录会话未加密，请仅用于功能验证。</p>' : ''}
    <form id="hosted-login-form">
      <div class="field"><label for="hosted-email">邮箱</label><input id="hosted-email" type="email" autocomplete="email" required /></div>
      <button id="hosted-send-code" class="btn btn-outline" type="button" hidden>发送验证码</button>
      <div id="hosted-code-field" class="field" hidden><label for="hosted-code">六位邮箱验证码</label><input id="hosted-code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required disabled /><span class="muted">验证码 5 分钟内有效，重新发送后旧验证码失效。</span></div>
      <div class="field"><label for="hosted-password">登录密码</label><input id="hosted-password" type="password" autocomplete="current-password" minlength="1" maxlength="128" required /></div>
      <div id="hosted-confirm-field" class="field" hidden><label for="hosted-confirm-password">确认密码</label><input id="hosted-confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required disabled /></div>
      <details><summary>服务说明</summary><p>此服务用于个人投资研究和记录，不自动下单，不承诺投资收益。订阅为主动购买服务期，不自动扣款。你的数据按登录用户隔离。</p></details>
      <label id="hosted-terms-field" class="hosted-check" hidden><input id="hosted-terms" type="checkbox" required disabled />我已阅读并接受以上服务说明</label>
      <button class="btn btn-primary" type="submit">登录</button>
    </form>
    <p id="hosted-login-status" role="status" aria-live="polite"></p>`;
    document.getElementById('hosted-auth')?.remove();
    document.body.append(card);
    let mode = 'login';
    let challengeId = '';
    let challengeEmail = '';
    let expiresAt = 0;
    let cooldownUntil = 0;
    let sending = false;
    let submitting = false;
    const status = card.querySelector('#hosted-login-status');
    const send = card.querySelector('#hosted-send-code');
    const email = card.querySelector('#hosted-email');
    const code = card.querySelector('#hosted-code');
    const submit = card.querySelector('[type="submit"]');
    const password = card.querySelector('#hosted-password');
    const confirmPassword = card.querySelector('#hosted-confirm-password');
    const terms = card.querySelector('#hosted-terms');
    const canLogin =
      authConfig && (!authConfig.secureTransport || window.location.protocol === 'https:');
    const canSend =
      authConfig?.emailConfigured &&
      (!authConfig.secureTransport || window.location.protocol === 'https:');
    if (!authConfig) status.textContent = '暂时无法获取登录配置，请刷新页面重试。';
    else if (!authConfig.emailConfigured)
      status.textContent = '验证码服务暂不可用，已有密码的账号仍可登录。';
    else if (!canSend)
      status.textContent = '此服务要求通过 HTTPS 登录，请使用管理员提供的 HTTPS 地址。';
    const updateButtons = () => {
      const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      send.disabled = !canSend || sending || submitting || seconds > 0;
      send.textContent = sending
        ? '正在发送…'
        : seconds > 0
          ? `${seconds} 秒后重发`
          : challengeId
            ? '重新发送验证码'
            : '发送验证码';
      submit.disabled = !canLogin || submitting || sending || (mode === 'register' && !challengeId);
      card.querySelector('#hosted-mode-login').disabled = submitting || sending;
      card.querySelector('#hosted-mode-register').disabled = submitting || sending;
      email.disabled = sending || submitting;
    };
    const switchMode = (next) => {
      if (sending || submitting) return;
      mode = next;
      const register = mode === 'register';
      send.hidden = !register;
      for (const id of ['hosted-code-field', 'hosted-confirm-field', 'hosted-terms-field'])
        card.querySelector('#' + id).hidden = !register;
      code.disabled = confirmPassword.disabled = terms.disabled = !register;
      password.autocomplete = register ? 'new-password' : 'current-password';
      password.minLength = register ? 8 : 1;
      password.value = confirmPassword.value = '';
      submit.textContent = register ? '验证邮箱并设置密码' : '登录';
      card.querySelector('#hosted-login-intro').textContent = register
        ? authConfig?.registrationEnabled
          ? '新用户验证邮箱并设置 8～128 位密码后注册；已有无密码账号可在此首次设置。'
          : '新用户注册暂未开放，已有无密码账号可验证邮箱后首次设置密码。'
        : '使用邮箱账号和密码登录。';
      card.querySelector('#hosted-mode-login').className = register
        ? 'btn btn-outline btn-sm'
        : 'btn btn-primary btn-sm';
      card.querySelector('#hosted-mode-register').className = register
        ? 'btn btn-primary btn-sm'
        : 'btn btn-outline btn-sm';
      status.textContent = '';
      updateButtons();
    };
    card.querySelector('#hosted-mode-login').addEventListener('click', () => switchMode('login'));
    card
      .querySelector('#hosted-mode-register')
      .addEventListener('click', () => switchMode('register'));
    updateButtons();
    const timer = setInterval(() => {
      if (!card.isConnected) {
        clearInterval(timer);
        return;
      }
      if (challengeId && Date.now() >= expiresAt) {
        challengeId = '';
        if (mode === 'register') status.textContent = '验证码已过期，请重新发送。';
      }
      updateButtons();
    }, 1000);
    email.addEventListener('input', () => {
      if (challengeId && email.value.trim() !== challengeEmail) {
        challengeId = '';
        code.value = '';
        status.textContent = '邮箱已更改，请向当前邮箱重新发送验证码。';
        updateButtons();
      }
    });
    send.addEventListener('click', async () => {
      if (send.disabled) return;
      if (!email.reportValidity()) return;
      sending = true;
      challengeId = '';
      code.value = '';
      updateButtons();
      status.textContent = '正在发送验证码…';
      const result = await callApi('/api/auth/challenges', {
        method: 'POST',
        body: JSON.stringify({ email: email.value.trim() }),
      });
      sending = false;
      cooldownUntil = Date.now() + 60_000;
      if (!result.ok) {
        status.textContent = errorText(result.error);
        updateButtons();
        return;
      }
      challengeId = result.data.challengeId;
      challengeEmail = email.value.trim();
      expiresAt = new Date(result.data.expiresAt).getTime();
      status.textContent = '验证码邮件已提交发送，请查收邮箱；未收到时也请检查垃圾邮件。';
      updateButtons();
      code.focus();
    });
    card.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting || sending) return;
      if (!card.querySelector('form').reportValidity()) return;
      if (mode === 'register' && (!challengeId || challengeEmail !== email.value.trim())) {
        status.textContent = '请先向当前邮箱发送验证码。';
        return;
      }
      if (mode === 'register' && Date.now() >= expiresAt) {
        challengeId = '';
        status.textContent = '验证码已过期，请重新发送。';
        updateButtons();
        return;
      }
      if (mode === 'register' && password.value !== confirmPassword.value) {
        status.textContent = '两次输入的密码不一致。';
        return;
      }
      submitting = true;
      updateButtons();
      status.textContent = '正在验证并登录…';
      const result = await callApi(
        mode === 'register' ? '/api/auth/sessions' : '/api/auth/password-sessions',
        {
          method: 'POST',
          body: JSON.stringify(
            mode === 'register'
              ? {
                  challengeId,
                  code: code.value.trim(),
                  password: password.value,
                  acceptTerms: terms.checked,
                }
              : { email: email.value.trim(), password: password.value },
          ),
        },
      );
      submitting = false;
      if (!result.ok) {
        status.textContent =
          result.error?.required === 'auth:valid-credentials'
            ? mode === 'login'
              ? '邮箱或密码错误。尚未设置密码的账号请先验证邮箱设置密码。'
              : '验证码错误、已过期，或账号已设置密码，请重试或切换密码登录。'
            : errorText(result.error);
        updateButtons();
        return;
      }
      password.value = confirmPassword.value = '';
      clearInterval(timer);
      broadcast();
      card.remove();
      resolve();
    });
  });

const waitForInitialPassword = (me) =>
  new Promise((resolve) => {
    const card = document.createElement('section');
    card.id = 'hosted-auth';
    card.className = 'card hosted-auth';
    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent = `账号 ${me.user.email} 已验证，请先设置登录密码。`;
    const form = createHostedPasswordForm({
      initial: true,
      onChanged: async () => {
        broadcast();
        clearHostedSession();
        card.remove();
        resolve();
      },
    });
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'btn btn-outline';
    exit.textContent = '退出并重新验证邮箱';
    exit.addEventListener('click', async () => {
      const result = await callApi('/api/auth/session', { method: 'DELETE' });
      if (result.ok) restartHostedSession();
      else exit.textContent = '退出失败，请重试';
    });
    card.append(intro, form, exit);
    document.getElementById('hosted-auth')?.remove();
    document.body.append(card);
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
      const authConfig = await callApi('/api/auth/config');
      await waitForLogin(authConfig.ok ? authConfig.data : null);
      continue;
    }
    configureHostedSession(me.data);
    if (me.data.passwordConfigured === false) {
      await waitForInitialPassword(me.data);
      continue;
    }
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
    if (me.data.admin === true) {
      const navItem = document.createElement('li');
      const navLink = document.createElement('a');
      navLink.className = 'nav-item';
      navLink.href = '#admin';
      navLink.dataset.route = 'admin';
      const navLabel = document.createElement('span');
      navLabel.textContent = '管理';
      navLink.append(navLabel);
      navItem.append(navLink);
      document.querySelector('ul.nav')?.append(navItem);
      const adminRoute = document.createElement('section');
      adminRoute.id = 'route-admin';
      adminRoute.className = 'route';
      adminRoute.dataset.route = 'admin';
      adminRoute.hidden = true;
      const adminHeader = document.createElement('div');
      adminHeader.className = 'route-header';
      const adminTitle = document.createElement('div');
      const adminH1 = document.createElement('h1');
      adminH1.textContent = '管理';
      const adminMeta = document.createElement('p');
      adminMeta.className = 'muted';
      adminMeta.textContent = '用户 · 订阅额度 · 收款登记';
      adminTitle.append(adminH1, adminMeta);
      adminHeader.append(adminTitle);
      const adminCard = document.createElement('div');
      adminCard.id = 'hosted-admin';
      adminCard.className = 'card';
      adminRoute.append(adminHeader, adminCard);
      document.getElementById('content')?.append(adminRoute);
    }
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
