/* apps/web/public/js/market-sync.js —— 设置页「数据同步」区块。
 *
 * GET /api/market-data-status 展示 datasets / providers 状态；
 * 「同步股票目录」→ sync_stock_universe，「同步日线」→ sync_daily_bars，
 * 长调用显式 timeoutMs: 300_000，进行中禁用按钮，完成后刷新状态表。
 * 表格只列这两个按钮真正刷新的数据集；其余数据集的实时状态见上方
 * 各行情源的能力表与仪表盘「数据健康」卡。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { $, el, mount } from './ui.js';

/** 本面板只展示两个同步按钮作用的数据集。 */
const SYNCED_DATASETS = new Set(['stock-universe', 'daily-bars']);

const DATASET_LABELS = {
  'stock-universe': '股票目录',
  'daily-bars': '日线',
  quote: '实时快照',
  'realtime-index': '指数行情',
  'minute-bars': '分钟 OHLCV',
  'intraday-minutes': '分时',
  'market-snapshot': '市场快照',
  'market-snapshot-envelope': '市场快照完整性',
};

const FRESHNESS_LABELS = {
  fresh: '新鲜',
  stale: '过期',
  unknown: '未知',
  unavailable: '不可用',
};

const fmtTime = (value) => {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
};

export { DATASET_LABELS, FRESHNESS_LABELS, fmtTime, initMarketSync, renderMarketSyncStatus };

const setMessage = (text, isError = false) => {
  const node = $('#market-sync-message');
  if (node === null) return;
  node.textContent = text;
  node.className = isError ? 'status error' : 'status';
  node.hidden = false;
};

const setBusy = (busy) => {
  for (const id of ['#btn-sync-universe', '#btn-sync-daily-bars']) {
    const btn = $(id);
    if (btn !== null) btn.disabled = busy;
  }
};

const renderMarketSyncStatus = async () => {
  const wrap = $('#market-sync-status');
  if (wrap === null) return;
  const r = await callApi('/api/market-data-status');
  if (!r.ok) {
    mount(wrap, el('p', 'placeholder', `数据状态加载失败（${r.error?.kind ?? 'internal'}）。`));
    return;
  }
  const datasets = (Array.isArray(r.data?.datasets) ? r.data.datasets : []).filter((ds) =>
    SYNCED_DATASETS.has(ds.dataset),
  );
  const providers = (Array.isArray(r.data?.providers) ? r.data.providers : []).filter((p) =>
    datasets.some((ds) => ds.source === p.provider),
  );
  const rows = datasets.map((ds) =>
    el('tr', null, [
      el('td', null, DATASET_LABELS[ds.dataset] ?? ds.dataset),
      el('td', null, ds.source),
      el('td', null, FRESHNESS_LABELS[ds.freshness] ?? ds.freshness),
      el('td', null, fmtTime(ds.dataAsOf ?? ds.lastSuccessAt)),
      el('td', 'muted', ds.lastErrorKind ?? ''),
    ]),
  );
  const providerText =
    providers.length === 0
      ? null
      : el(
          'p',
          'muted',
          `源新鲜度：${providers
            .map(
              (p) =>
                `${p.provider} ${p.freshness}${p.latestObservedAt ? `（${fmtTime(p.latestObservedAt)}）` : ''}`,
            )
            .join(' · ')}`,
        );
  mount(
    wrap,
    el(
      'div',
      null,
      [
        el('table', 'table market-sync-table', [
          el('thead', null, [
            el('tr', null, [
              el('th', null, '数据集'),
              el('th', null, '来源'),
              el('th', null, '新鲜度'),
              el('th', null, '数据截至'),
              el('th', null, '最近错误'),
            ]),
          ]),
          el('tbody', null, rows),
        ]),
        providerText,
      ].filter((node) => node !== null),
    ),
  );
};

const runSync = async (toolName, input, label) => {
  setBusy(true);
  setMessage(`${label}进行中（可能需要几分钟）…`);
  const r = await callApi(`/api/tools/${toolName}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
    timeoutMs: 300_000,
  });
  setBusy(false);
  if (!r.ok) {
    setMessage(`${label}失败（${r.error?.kind ?? 'internal'}）`, true);
  } else {
    const d = r.data ?? {};
    const summary =
      toolName === 'sync_stock_universe'
        ? `新增 ${d.createdStocks ?? 0} / 更新 ${d.updatedStocks ?? 0} / 缺失标记 ${d.markedMissing ?? 0}`
        : `同步 ${d.synced ?? 0} / 失败 ${d.failed ?? 0}（共 ${d.totalRequested ?? 0}）`;
    setMessage(`${label}完成：${summary}`);
  }
  await renderMarketSyncStatus();
};

let bound = false;
const initMarketSync = () => {
  if (bound) return;
  bound = true;
  $('#btn-sync-universe')?.addEventListener(
    'click',
    () => void runSync('sync_stock_universe', {}, '同步股票目录'),
  );
  $('#btn-sync-daily-bars')?.addEventListener(
    'click',
    () => void runSync('sync_daily_bars', {}, '同步日线'),
  );
};
