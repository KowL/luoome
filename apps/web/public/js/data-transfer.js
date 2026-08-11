import { callApi } from './api.js';
import { alertDialog, confirmDialog } from './modal.js';
import { $ } from './ui.js';

const CATEGORY_LABELS = {
  portfolio: '账户、持仓与交易',
  strategies: '策略与运行记录',
  watchlists: '关注分组与预警',
  'advice-reports': '建议、报告与任务审计',
  'market-data': '股票目录与行情数据',
  research: '研究索引',
  chat: 'AI 对话记录',
};

const selectedCategories = () =>
  [...document.querySelectorAll('[data-data-category]:checked')].map((node) => node.value);

const setStatus = (text, error = false) => {
  const node = $('#data-transfer-status');
  if (node === null) return;
  node.textContent = text;
  node.className = error ? 'status error' : 'status';
  node.hidden = false;
};

const renderDataTransfer = async () => {
  const result = await callApi('/api/data/categories');
  const list = $('#data-transfer-categories');
  if (list === null) return;
  if (!result.ok) {
    list.textContent = '数据迁移功能不可用';
    return;
  }
  list.replaceChildren(
    ...result.data.categories.map((category) => {
      const label = document.createElement('label');
      label.className = 'check-label';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = category;
      input.checked = true;
      input.dataset.dataCategory = category;
      label.append(input, CATEGORY_LABELS[category] ?? category);
      return label;
    }),
  );
};

const exportData = async () => {
  const categories = selectedCategories();
  if (categories.length === 0) {
    await alertDialog('无法导出', '请至少选择一个数据分类。');
    return;
  }
  setStatus('正在生成导出文件…');
  const response = await fetch('/api/data/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categories }),
  });
  if (!response.ok) {
    setStatus('导出失败', true);
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `luoome-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`已导出 ${categories.length} 个数据分类`);
};

const importData = async () => {
  const input = $('#data-import-file');
  const file = input?.files?.[0];
  if (file === undefined) {
    await alertDialog('无法导入', '请先选择 luoome JSON 数据包。');
    return;
  }
  let archive;
  try {
    archive = JSON.parse(await file.text());
  } catch {
    await alertDialog('无法导入', '文件不是有效的 JSON。');
    return;
  }
  const confirmed = await confirmDialog({
    title: '导入本地数据',
    message: '导入会按主键合并数据，同名记录将以文件内容更新。继续吗？',
    confirmLabel: '确认导入',
  });
  if (!confirmed) return;
  setStatus('正在导入…');
  const result = await callApi('/api/data/import', {
    method: 'POST',
    body: JSON.stringify({ archive }),
  });
  if (!result.ok) {
    setStatus(
      `导入失败：${result.error?.message ?? result.error?.required ?? result.error?.kind}`,
      true,
    );
    return;
  }
  setStatus(`导入完成，共合并 ${result.data.imported} 条记录`);
};

let initialized = false;
const initDataTransfer = () => {
  if (initialized) return;
  initialized = true;
  $('#btn-data-export')?.addEventListener('click', () => void exportData());
  $('#btn-data-import')?.addEventListener('click', () => void importData());
};

export { initDataTransfer, renderDataTransfer, selectedCategories };
