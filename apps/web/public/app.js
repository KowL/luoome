/* luoome web 仪表盘 —— 原生 JS，无构建步骤。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: index.html 以 classic script（无 type=module）加载本文件，该指令在浏览器中并非冗余
'use strict';

const DECISIONS = {
  buy: '买入',
  sell: '卖出',
  hold: '持有',
  watch: '观望',
  avoid: '回避',
};

const HORIZONS = {
  intraday: '日内',
  short: '短期',
  medium: '中期',
  long: '长期',
};

const $ = (sel) => document.querySelector(sel);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const fmtMoney = (n) =>
  Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (ratio) => `${(Number(ratio) * 100).toFixed(2)}%`;

/** 盈亏着色：沿用 A 股习惯，正 = 红，负 = 绿。 */
const pnlClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat');

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
};

const setStatus = (msg, isError) => {
  const node = $('#status');
  node.textContent = msg || '';
  node.classList.toggle('error', Boolean(isError));
};

const callApi = async (path, options) => {
  const res = await fetch(path, options);
  return res.json();
};

/* ---------------- 持仓 ---------------- */

const renderHoldings = (result) => {
  const body = $('#holdings-body');
  const foot = $('#holdings-foot');
  body.replaceChildren();

  if (!result.ok) {
    const tr = el('tr');
    const td = el('td', 'placeholder', `加载失败：${result.error.kind}`);
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
    foot.hidden = true;
    return;
  }

  const { holdings, totalValue, totalPnL, totalPnLPct } = result.data;
  if (holdings.length === 0) {
    const tr = el('tr');
    const td = el('td', 'placeholder', '暂无持仓');
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
    foot.hidden = true;
    return;
  }

  for (const item of holdings) {
    const h = item.holding;
    const tr = el('tr');
    tr.append(
      el('td', 'code', h.stockId),
      el('td', null, item.stockName),
      el('td', 'num', h.quantity.toLocaleString('zh-CN')),
      el('td', 'num', fmtMoney(h.avgCost)),
      el('td', 'num', fmtMoney(item.currentPrice)),
      el('td', 'num', fmtMoney(item.marketValue)),
      el('td', `num ${pnlClass(item.pnl)}`, fmtMoney(item.pnl)),
      el('td', `num ${pnlClass(item.pnl)}`, fmtPct(item.pnlPct)),
    );
    body.append(tr);
  }

  $('#total-value').textContent = fmtMoney(totalValue);
  const tp = $('#total-pnl');
  tp.textContent = fmtMoney(totalPnL);
  tp.className = `num ${pnlClass(totalPnL)}`;
  const tpp = $('#total-pnl-pct');
  tpp.textContent = fmtPct(totalPnLPct);
  tpp.className = `num ${pnlClass(totalPnL)}`;
  foot.hidden = false;
};

const loadHoldings = async () => {
  const result = await callApi('/api/holdings');
  renderHoldings(result);
  return result.ok ? result.data.holdings : [];
};

/* ---------------- 建议 ---------------- */

const listSection = (title, items, className) => {
  const wrap = el('div', `detail-block ${className || ''}`);
  wrap.append(el('h4', null, title));
  const ul = el('ul');
  for (const item of items || []) ul.append(el('li', null, item));
  if (!items || items.length === 0) ul.append(el('li', 'muted', '（无）'));
  wrap.append(ul);
  return wrap;
};

const renderAdviceCard = (advice, nameByStock) => {
  const card = el('article', 'advice-card');

  const head = el('header', 'advice-head');
  head.append(
    el('span', `badge badge-${advice.decision}`, DECISIONS[advice.decision] || advice.decision),
    el('strong', 'subject', `${advice.subjectId} ${nameByStock[advice.subjectId] || ''}`.trim()),
    el('span', 'horizon', HORIZONS[advice.horizon] || advice.horizon),
    el('span', 'valid', `有效期至 ${fmtTime(advice.validUntil)}`),
  );

  const conf = el('div', 'confidence');
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, advice.confidence))}%`;
  bar.append(fill);
  conf.append(bar, el('span', 'conf-label', `信心度 ${advice.confidence}%`));

  const premise = el('p', 'premise', advice.reasoning.premise);

  const detail = el('div', 'detail');
  detail.hidden = true;
  detail.append(
    listSection('支持证据', advice.reasoning.evidence),
    listSection('反证', advice.reasoning.counterEvidence, 'counter'),
    listSection('风险', advice.risks, 'risks'),
    listSection('免责声明', advice.disclaimers, 'disclaimers'),
  );

  detail.addEventListener('click', (e) => e.stopPropagation());
  card.append(head, conf, premise, detail);
  card.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    card.classList.toggle('open', !detail.hidden);
  });
  return card;
};

const renderAdvice = (result, nameByStock) => {
  const list = $('#advice-list');
  list.replaceChildren();

  if (!result.ok) {
    list.append(el('p', 'placeholder', `加载失败：${result.error.kind}`));
    return;
  }
  if (result.data.advices.length === 0) {
    list.append(el('p', 'placeholder', '暂无有效建议，点击「分析全部持仓」生成。'));
    return;
  }
  for (const advice of result.data.advices) {
    list.append(renderAdviceCard(advice, nameByStock));
  }
};

const loadAdvice = async (nameByStock) => {
  const result = await callApi('/api/advice');
  renderAdvice(result, nameByStock || {});
};

/* ---------------- 动作 ---------------- */

let stockNames = {};

const refreshAll = async () => {
  setStatus('刷新中…');
  try {
    const holdings = await loadHoldings();
    stockNames = Object.fromEntries(holdings.map((i) => [i.holding.stockId, i.stockName]));
    await loadAdvice(stockNames);
    setStatus(`已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  } catch (err) {
    setStatus(`刷新失败：${err.message}`, true);
  }
};

const analyzeAll = async () => {
  const btn = $('#btn-analyze-all');
  btn.disabled = true;
  try {
    setStatus('获取持仓…');
    const holdings = await loadHoldings();
    stockNames = Object.fromEntries(holdings.map((i) => [i.holding.stockId, i.stockName]));
    let done = 0;
    let failed = 0;
    for (const item of holdings) {
      const stockId = item.holding.stockId;
      setStatus(`分析中 ${done + 1}/${holdings.length}：${stockId} ${item.stockName}`);
      const r = await callApi('/api/tools/analyze_stock/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { stockId } }),
      });
      if (r.ok) done += 1;
      else failed += 1;
    }
    await loadAdvice(stockNames);
    setStatus(
      failed === 0 ? `分析完成：${done} 只` : `分析完成：${done} 只成功，${failed} 只失败`,
      failed > 0,
    );
  } catch (err) {
    setStatus(`分析失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
};

$('#btn-refresh').addEventListener('click', refreshAll);
$('#btn-analyze-all').addEventListener('click', analyzeAll);

refreshAll();

// v0.2 起：5s 自动刷新（plan-v0.2-v0.3 §3.9）。与 TUI 周期对齐，
// 拉取 holdings（含最新价）+ 今日建议。setInterval 在页面关闭时由浏览器回收。
setInterval(refreshAll, 5_000);
