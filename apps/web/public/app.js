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

/* ---------------- 战法页 ---------------- */

const renderTactics = (result) => {
  const list = $('#tactics-list');
  list.replaceChildren();
  if (!result.ok) {
    list.append(el('p', 'placeholder', `加载失败：${result.error.kind}`));
    return;
  }
  if (result.data.tactics.length === 0) {
    list.append(el('p', 'placeholder', '（暂无战法）'));
    return;
  }
  const ul = el('ul', 'tactic-list');
  for (const t of result.data.tactics) {
    const li = el('li', 'tactic-item');
    li.append(el('strong', null, `${t.name}（${t.id}）`));
    li.append(el('span', 'tactic-tag', `tag: ${t.tag}`));
    li.append(el('p', 'tactic-desc', t.description));
    li.append(el('p', 'tactic-meta', `方向: ${t.direction} · 风险: ${t.risk}`));
    ul.append(li);
  }
  list.append(ul);
};

const renderTacticSignals = (result) => {
  const box = $('#tactic-signals');
  box.replaceChildren();
  if (!result.ok) {
    box.append(el('p', 'placeholder', `扫描失败：${result.error.kind}`));
    return;
  }
  const d = result.data;
  box.append(
    el(
      'p',
      'tactic-meta',
      `战法 ${d.totalTactics} 个 · 评估 ${d.evaluatedStocks ?? 0} 股 · 命中 ${d.ranked.length}`,
    ),
  );
  if (d.ranked.length === 0) {
    box.append(el('p', 'placeholder', '（当前未命中任何战法信号）'));
    return;
  }
  const ul = el('ul', 'signal-list');
  for (const s of d.ranked) {
    const code = (s.stockId ?? '').split('.')[0] || s.stockId;
    const li = el('li', 'signal-item');
    li.append(
      el(
        'p',
        null,
        `${code} · ${s.tacticName} · ${s.direction} · 评分 ${(s.llmScore ?? 0).toFixed(1)}`,
      ),
    );
    li.append(el('p', 'signal-rationale', s.rationale ?? ''));
    ul.append(li);
  }
  box.append(ul);
};

const loadTactics = async () => {
  setStatus('加载战法…');
  const r = await callApi('/api/tactics');
  renderTactics(r);
  setStatus('战法列表已刷新');
};

const runTacticScan = async () => {
  const btn = $('#btn-tactic-scan');
  btn.disabled = true;
  setStatus('扫描中…（list_tactics → run_tactic × N → score_signals）');
  try {
    const r = await callApi('/api/tactics/scan?topN=10&scope=holdings');
    renderTacticSignals(r);
    setStatus(r.ok ? `扫描完成 · top ${r.data.ranked.length}` : `扫描失败：${r.error.kind}`, !r.ok);
  } finally {
    btn.disabled = false;
  }
};

const btnTacticList = $('#btn-tactic-list');
const btnTacticScan = $('#btn-tactic-scan');
if (btnTacticList !== null) btnTacticList.addEventListener('click', loadTactics);
if (btnTacticScan !== null) btnTacticScan.addEventListener('click', runTacticScan);

/* ---------------- 复盘页 ---------------- */

const renderReviewStats = (stats) => {
  const box = $('#review-stats');
  box.replaceChildren();
  const fmtPct = (n) => `${(n * 100).toFixed(2)}%`;
  box.append(
    el(
      'p',
      'stats-line',
      `总条数 ${stats.totalAdvices} · 平均信心度 ${stats.avgConfidence.toFixed(1)} · 命中率 ${fmtPct(stats.hitRate)}`,
    ),
  );
  box.append(
    el(
      'p',
      'stats-line',
      `outcome 比例：followed ${fmtPct(stats.outcomeRate.followed)} / ` +
        `partially_followed ${fmtPct(stats.outcomeRate.partiallyFollowed)} / ` +
        `ignored ${fmtPct(stats.outcomeRate.ignored)}`,
    ),
  );
  box.append(el('h4', null, '按决策分解'));
  const ul = el('ul', 'by-decision');
  for (const [decision, s] of Object.entries(stats.byDecision ?? {})) {
    const li = el('li', null);
    li.append(
      el(
        'p',
        null,
        `${decision}: ${s.totalAdvices} 条 · 平均信心 ${s.avgConfidence.toFixed(1)} · ` +
          `命中率 ${fmtPct(s.hitRate)}`,
      ),
    );
    ul.append(li);
  }
  box.append(ul);
};

const renderReviewList = (advices) => {
  const box = $('#review-list');
  box.replaceChildren();
  if (advices.length === 0) {
    box.append(el('p', 'placeholder', '（暂无建议）'));
    return;
  }
  const ul = el('ul', 'review-list');
  for (const a of advices) {
    const code = (a.subjectId ?? '').split('.')[0] || a.subjectId;
    const li = el('li', 'review-item');
    const status = a.outcome === undefined ? '（待回填）' : a.outcome.outcome;
    const pnl = a.outcome?.pnl !== undefined ? `盈亏 ${a.outcome.pnl.toFixed(2)}` : '';
    li.append(
      el('p', 'review-line', `${code} · ${a.decision} · 信心 ${a.confidence}% · ${status} ${pnl}`),
    );
    li.append(el('p', 'review-premise', a.reasoning?.premise ?? ''));
    if (a.outcome === undefined) {
      const btn = el('button', 'btn btn-outline btn-sm', '回填 outcome');
      btn.type = 'button';
      btn.addEventListener('click', () => fillOutcomeForm(a.id, a.decision));
      li.append(btn);
    }
    ul.append(li);
  }
  box.append(ul);
};

const fillOutcomeForm = async (adviceId, decision) => {
  const followed = !window.confirm(
    `回填 advice ${adviceId.slice(0, 8)}（决策 ${decision}）
` + `确定 = 跟单；取消 = 不跟单（仍调用 API 记录）`,
  )
    ? false
    : !window.confirm('跟单？确定 = followed，取消 = ignored')
      ? false
      : true;
  const pnlStr = followed === true ? (window.prompt('实际盈亏（人民币，可负）', '0') ?? '0') : '0';
  const pnl = Number(pnlStr);
  const r = await callApi(`/api/review/${adviceId}/outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { followed, pnl } }),
  });
  if (r.ok) {
    setStatus(`outcome 已回填 ${adviceId.slice(0, 8)}`);
    await loadReview();
  } else {
    setStatus(`回填失败：${r.error.kind}（${r.error.message ?? ''}）`, true);
  }
};

const loadReview = async () => {
  setStatus('加载复盘…');
  const r = await callApi('/api/review');
  const box = $('#review-stats');
  if (!r.ok) {
    if (box !== null) box.replaceChildren(el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  if (box !== null) renderReviewStats(r.data.stats);
  renderReviewList(r.data.advices.advices ?? []);
  setStatus('复盘已刷新');
};

/* ---------------- Hash 路由 ---------------- */

const ROUTES = ['dashboard', 'tactics', 'review'];

const showRoute = (name) => {
  const safe = ROUTES.includes(name) ? name : 'dashboard';
  document.querySelectorAll('.route').forEach((node) => {
    node.hidden = node.dataset.route !== safe;
  });
  document.querySelectorAll('.nav-link').forEach((node) => {
    const isActive = node.dataset.route === safe;
    node.classList.toggle('active', isActive);
    if (isActive) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (safe === 'tactics') {
    void loadTactics();
  } else if (safe === 'review') {
    void loadReview();
  }
};

const currentHash = () => {
  const h = window.location.hash.replace(/^#/, '');
  return h.length > 0 ? h : 'dashboard';
};

window.addEventListener('hashchange', () => showRoute(currentHash()));
showRoute(currentHash());

refreshAll();

// v0.2 起：5s 自动刷新（plan-v0.2-v0.3 §3.9）。与 TUI 周期对齐，
// 拉取 holdings（含最新价）+ 今日建议。setInterval 在页面关闭时由浏览器回收。
setInterval(refreshAll, 5_000);
