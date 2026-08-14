/* apps/web/public/js/theme.js —— 皮肤主题切换与持久化。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

const THEME_KEY = 'luoome-theme';
const DEFAULT_THEME = 'teal';

const THEMES = [
  { id: 'teal', label: '青碧' },
  { id: 'crimson', label: '彤阳' },
  { id: 'blue', label: '海蓝' },
  { id: 'violet', label: '藤紫' },
  { id: 'rose', label: '玫红' },
  { id: 'amber', label: '琥珀' },
  { id: 'sage', label: '苍绿' },
  { id: 'slate', label: '岩灰' },
  { id: 'dark', label: '暗夜' },
];

const BG_KEY = 'luoome-bg-image';

const applyBackground = (dataUrl) => {
  if (typeof document === 'undefined' || document.documentElement === undefined) return;
  const layer = document.getElementById('bg-layer');
  if (layer === null) return;
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
    layer.style.backgroundImage = `url("${dataUrl}")`;
    document.documentElement.classList.add('has-bg-image');
  } else {
    layer.style.backgroundImage = '';
    document.documentElement.classList.remove('has-bg-image');
  }
};

export const getBackgroundImage = () => {
  try {
    const value = localStorage.getItem(BG_KEY);
    return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
  } catch {
    return null;
  }
};

// 返回是否成功持久化；图片超出 localStorage 配额时仅本次会话生效。
export const setBackgroundImage = (dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  applyBackground(dataUrl);
  try {
    localStorage.setItem(BG_KEY, dataUrl);
    return true;
  } catch {
    return false;
  }
};

export const clearBackgroundImage = () => {
  applyBackground(null);
  try {
    localStorage.removeItem(BG_KEY);
  } catch {
    // localStorage 不可用时不阻断。
  }
};

const OPACITY_KEY = 'luoome-panel-opacity';
// 启用自定义背景且用户未手动调节时，CSS 侧默认面板不透明度（%），与 style.css 中 html.has-bg-image 保持一致
const OPACITY_DEFAULT_BG = 78;

const clampOpacity = (value) => {
  // localStorage 未写入时 getItem 返回 null，而 Number(null) 为 0，会被误夹到 30
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(100, Math.max(30, Math.round(num)));
};

const applyPanelOpacity = (percent) => {
  if (typeof document === 'undefined' || document.documentElement === undefined) return;
  if (percent === null) {
    document.documentElement.style.removeProperty('--panel-opacity');
    return;
  }
  document.documentElement.style.setProperty('--panel-opacity', String(percent / 100));
};

// 返回用户持久化的面板不透明度（30~100），未设置过返回 null（走 CSS 默认值）。
export const getPanelOpacity = () => {
  try {
    return clampOpacity(localStorage.getItem(OPACITY_KEY));
  } catch {
    return null;
  }
};

// percent 取 30~100；传 null 清除用户设置，恢复 CSS 默认（无背景 100%，有背景 78%）。
export const setPanelOpacity = (percent) => {
  const next = percent === null ? null : clampOpacity(percent);
  applyPanelOpacity(next);
  try {
    if (next === null) {
      localStorage.removeItem(OPACITY_KEY);
    } else {
      localStorage.setItem(OPACITY_KEY, String(next));
    }
  } catch {
    // localStorage 不可用时不阻断。
  }
  return next;
};

const validTheme = (value) => {
  if (typeof value !== 'string') return DEFAULT_THEME;
  return THEMES.some((theme) => theme.id === value) ? value : DEFAULT_THEME;
};

const storedTheme = () => {
  try {
    return validTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
};

const FOLLOW_KEY = 'luoome-theme-follow-system';
const SYSTEM_LIGHT_THEME = 'teal';
const SYSTEM_DARK_THEME = 'dark';

const systemTheme = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_THEME;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? SYSTEM_DARK_THEME
    : SYSTEM_LIGHT_THEME;
};

export const getFollowSystem = () => {
  try {
    return localStorage.getItem(FOLLOW_KEY) === '1';
  } catch {
    return false;
  }
};

// 开启后立即按当前系统外观应用主题；关闭时保留当前主题不变。
export const setFollowSystem = (enabled) => {
  try {
    if (enabled) {
      localStorage.setItem(FOLLOW_KEY, '1');
    } else {
      localStorage.setItem(THEME_KEY, getTheme());
      localStorage.removeItem(FOLLOW_KEY);
    }
  } catch {
    // localStorage 不可用时不阻断。
  }
  if (enabled) {
    applyTheme(systemTheme());
    updateThemeUI();
  }
};

let systemListenerBound = false;
// 跟随开启时响应系统外观变化（含 macOS「自动」的日出/日落切换）。
const bindSystemAppearance = () => {
  if (
    systemListenerBound ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return;
  }
  systemListenerBound = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getFollowSystem()) return;
    applyTheme(systemTheme());
    updateThemeUI();
  });
};

const applyTheme = (theme) => {
  if (typeof document === 'undefined' || document.documentElement === undefined) return;
  document.documentElement.setAttribute('data-theme', validTheme(theme));
};

const updateThemeUI = () => {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const current = getTheme();
  document.querySelectorAll('.theme-card').forEach((button) => {
    const active = button.dataset.theme === current;
    button.classList.toggle('active', active);
  });
};

export const getTheme = () => {
  if (typeof document === 'undefined' || document.documentElement === undefined) {
    return DEFAULT_THEME;
  }
  return validTheme(document.documentElement.getAttribute('data-theme'));
};

export const setTheme = (theme) => {
  const next = validTheme(theme);
  applyTheme(next);
  updateThemeUI();
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // localStorage 不可用时不阻断。
  }
};

export const getThemes = () => THEMES;

export const initTheme = () => {
  applyTheme(getFollowSystem() ? systemTheme() : storedTheme());
  applyBackground(getBackgroundImage());
  applyPanelOpacity(getPanelOpacity());
  bindSystemAppearance();
};

export const bindTopbarTheme = () => {
  if (typeof document === 'undefined') return;
  const toggle = document.getElementById('theme-drawer-toggle');
  const drawer = document.getElementById('theme-drawer');
  const closeBtn = document.getElementById('theme-drawer-close');
  const backdrop = drawer?.querySelector('.drawer-backdrop');
  const grid = document.getElementById('theme-grid');
  if (
    toggle === null ||
    drawer === null ||
    closeBtn === null ||
    backdrop === null ||
    grid === null
  ) {
    return;
  }

  const openDrawer = () => {
    drawer.classList.add('is-open');
    updateThemeUI();
    closeBtn.focus();
  };

  const closeDrawer = () => {
    drawer.classList.remove('is-open');
    toggle.focus();
  };

  toggle.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  // 跟随系统外观开关；手动选择色块会关闭跟随
  const followInput = document.getElementById('follow-system-input');
  const syncFollowUI = () => {
    if (followInput !== null) followInput.checked = getFollowSystem();
  };
  if (followInput !== null) {
    followInput.addEventListener('change', () => {
      setFollowSystem(followInput.checked);
      syncFollowUI();
    });
  }
  syncFollowUI();

  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.theme-card');
    if (card === null) return;
    setTheme(card.dataset.theme);
    setFollowSystem(false);
    syncFollowUI();
  });

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  // 面板透明度滑杆：未手动设置时跟随是否有背景图显示默认值
  const opacityInput = document.getElementById('panel-opacity-input');
  const opacityValue = document.getElementById('panel-opacity-value');
  const syncOpacityUI = () => {
    if (opacityInput === null || opacityValue === null) return;
    const current =
      getPanelOpacity() ??
      (document.documentElement.classList.contains('has-bg-image') ? OPACITY_DEFAULT_BG : 100);
    opacityInput.value = String(current);
    opacityValue.textContent = `${current}%`;
  };
  if (opacityInput !== null) {
    opacityInput.addEventListener('input', () => {
      const next = setPanelOpacity(opacityInput.value);
      if (opacityValue !== null) opacityValue.textContent = `${next}%`;
    });
  }

  const fileInput = document.getElementById('bg-file-input');
  const uploadBtn = document.getElementById('bg-upload-btn');
  const clearBtn = document.getElementById('bg-clear-btn');
  const status = document.getElementById('bg-status');
  if (fileInput === null || uploadBtn === null || clearBtn === null || status === null) {
    syncOpacityUI();
    updateThemeUI();
    return;
  }

  const updateBgStatus = () => {
    const applied = document.documentElement.classList.contains('has-bg-image');
    if (!applied) {
      status.textContent = '';
      return;
    }
    status.textContent =
      getBackgroundImage() === null ? '图片超出存储配额，仅本次会话生效。' : '已启用自定义背景。';
  };

  uploadBtn.addEventListener('click', () => fileInput.click());

  clearBtn.addEventListener('click', () => {
    clearBackgroundImage();
    fileInput.value = '';
    updateBgStatus();
    syncOpacityUI();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    if (!file.type.startsWith('image/')) {
      status.textContent = '请选择图片文件。';
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      setBackgroundImage(reader.result);
      updateBgStatus();
      syncOpacityUI();
    });
    reader.readAsDataURL(file);
  });

  updateBgStatus();
  syncOpacityUI();
  updateThemeUI();
};
