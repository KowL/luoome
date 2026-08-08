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

const applyTheme = (theme) => {
  if (typeof document === 'undefined' || document.documentElement === undefined) return;
  document.documentElement.setAttribute('data-theme', validTheme(theme));
};

const updateThemeUI = () => {
  if (typeof document === 'undefined') return;
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
  applyTheme(storedTheme());
  applyBackground(getBackgroundImage());
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

  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.theme-card');
    if (card === null) return;
    setTheme(card.dataset.theme);
  });

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  const fileInput = document.getElementById('bg-file-input');
  const uploadBtn = document.getElementById('bg-upload-btn');
  const clearBtn = document.getElementById('bg-clear-btn');
  const status = document.getElementById('bg-status');
  if (fileInput === null || uploadBtn === null || clearBtn === null || status === null) {
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
    });
    reader.readAsDataURL(file);
  });

  updateBgStatus();
  updateThemeUI();
};
