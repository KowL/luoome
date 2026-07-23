/* apps/web/public/js/pages.js —— 7 个路由页面的渲染逻辑。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { openCloseConfirm, openEditModal, openTradeModal } from './holdings-actions.js';
import {
  $,
  adviceCard,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  statBlock,
} from './ui.js';

/* ============ dashboard ============ */

const renderDashboard = async (setStatus) => {
  const holdingsRes = await callApi('/api/holdings');
  const adviceRes = await callApi('/api/advice');

  // 总市值 / 盈亏
  if (holdingsRes.ok) {
    const d = holdingsRes.data;
    $('#dash-total-value').textContent = fmtNum(d.totalValue);
    const pnlNode = $('#dash-total-pnl');
    pnlNode.textContent = fmtSigned(d.totalPnL);
    pnlNode.className = `value ${d.totalPnL > 0 ? 'text-pos' : d.totalPnL < 0 ? 'text-neg' : ''}`;
    const pnlPctNode = $('#dash-total-pnl-pct');
    pnlPctNode.textContent = fmtPct(d.totalPnLPct);
    pnlPctNode.className = `delta ${d.totalPnL > 0 ? 'pos' : d.totalPnL < 0 ? 'neg' : ''}`;
    $('#dash-holdings-count').textContent = String(d.holdings.length);
  }

  // 今日建议
  if (adviceRes.ok) {
    const advices = adviceRes.data.advices;
    $('#dash-advice-count').textContent = String(advices.length);
    // 按信心度倒序，top 3
    const top = [...advices].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    const list = $('#dash-advice-list');
    mount(
      list,
      top.length === 0
        ? el('p', 'placeholder', '暂无建议，去「持仓」页点「分析全部」生成。')
        : top.map(adviceCard),
    );
    const byDecision = advices.reduce((acc, a) => {
      acc[a.decision] = (acc[a.decision] ?? 0) + 1;
      return acc;
    }, {});
    $('#dash-advice-summary').textContent = Object.entries(byDecision)
      .map(([d, n]) => `${d}×${n}`)
      .join(' · ');
  }

  setStatus('仪表盘已刷新');
};

/* ============ holdings ============ */

const renderHoldings = async (setStatus) => {
  const r = await callApi('/api/holdings');
  const body = $('#holdings-body');
  if (!r.ok) {
    mount(
      body,
      el('tr', null, el('td', { colspan: 8, class: 'placeholder' }, `加载失败：${r.error.kind}`)),
    );
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const { holdings, totalValue, totalPnL, totalPnLPct } = r.data;
  if (holdings.length === 0) {
    mount(body, el('tr', null, el('td', { colspan: 9, class: 'placeholder' }, '（无持仓）')));
  } else {
    mount(
      body,
      holdings.map((item) => {
        const code = String(item.holding.stockId).split('.')[0] || item.holding.stockId;
        const pnlCls = item.pnl > 0 ? 'pos' : item.pnl < 0 ? 'neg' : '';
        const h = {
          id: item.holding.id,
          stockId: item.holding.stockId,
          stockName: item.stockName,
          quantity: item.holding.quantity,
          availableQuantity: item.holding.availableQuantity,
          avgCost: item.holding.avgCost,
          currentPrice: item.currentPrice,
        };
        const actionBtn = (label, onClick) => {
          const b = el('button', 'btn btn-outline btn-sm', label);
          b.type = 'button';
          b.addEventListener('click', onClick);
          return b;
        };
        return el('tr', null, [
          el('td', null, code),
          el('td', null, item.stockName),
          el('td', 'num', String(item.holding.quantity)),
          el('td', 'num', fmtNum(item.holding.avgCost)),
          el('td', 'num', fmtNum(item.currentPrice)),
          el('td', 'num', fmtNum(item.marketValue)),
          el('td', `num ${pnlCls}`, fmtSigned(item.pnl)),
          el('td', `num ${pnlCls}`, fmtPct(item.pnlPct)),
          el('td', null, [
            el('div', 'row-actions', [
              actionBtn('加仓', () => openTradeModal(h, 'buy')),
              actionBtn('减仓', () => openTradeModal(h, 'sell')),
              actionBtn('纠错', () => openEditModal(h)),
              actionBtn('平仓', () => openCloseConfirm(h)),
            ]),
          ]),
        ]);
      }),
    );
  }
  $('#holdings-total-value').textContent = fmtNum(totalValue);
  const pnlNode = $('#holdings-total-pnl');
  pnlNode.textContent = fmtSigned(totalPnL);
  pnlNode.className = `num ${totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : ''}`;
  const pctNode = $('#holdings-total-pnl-pct');
  pctNode.textContent = fmtPct(totalPnLPct);
  pctNode.className = `num ${totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : ''}`;
  $('#holdings-foot').hidden = holdings.length === 0;
  setStatus(`持仓已刷新 · ${holdings.length} 只`);
};

const analyzeAllHoldings = async (setStatus) => {
  const btn = $('#btn-holdings-analyze');
  if (btn === null) return;
  btn.disabled = true;
  try {
    const r = await callApi('/api/holdings');
    if (!r.ok) {
      setStatus(`加载失败：${r.error.kind}`, true);
      return;
    }
    let done = 0;
    let failed = 0;
    for (const item of r.data.holdings) {
      const stockId = item.holding.stockId;
      setStatus(`分析中 ${done + 1}/${r.data.holdings.length}：${stockId}`);
      const ar = await callApi('/api/tools/analyze_stock/call', {
        method: 'POST',
        body: JSON.stringify({ input: { stockId } }),
      });
      if (ar.ok) done += 1;
      else failed += 1;
    }
    setStatus(
      failed === 0 ? `分析完成：${done} 只` : `分析完成：${done} 成功 / ${failed} 失败`,
      failed > 0,
    );
  } finally {
    btn.disabled = false;
  }
};

/* ============ tactics ============ */

const renderTacticsList = async (setStatus) => {
  const r = await callApi('/api/tactics');
  const list = $('#tactics-list');
  if (!r.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  if (r.data.tactics.length === 0) {
    mount(list, el('p', 'placeholder', '（暂无战法）'));
    return;
  }
  const ul = el('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const t of r.data.tactics) {
    const li = el(
      'li',
      null,
      el('div', null, [
        el('strong', null, `${t.name}（${t.id}）`),
        el('span', 'badge', ` ${t.tag} `),
        el('span', 'badge', ` ${t.direction} `),
        el('span', 'badge', ` ${t.source} `),
        el('p', 'muted', t.description),
      ]),
    );
    li.style.padding = 'var(--space-3) 0';
    li.style.borderBottom = '1px solid var(--line)';
    ul.append(li);
  }
  mount(list, ul);
  setStatus(`战法列表已刷新 · ${r.data.tactics.length} 个`);
};

const runTacticScan = async (setStatus) => {
  const btn = $('#btn-tactic-scan');
  if (btn !== null) btn.disabled = true;
  setStatus('扫描中…（list_tactics → run_tactic × N → score_signals）');
  const r = await callApi('/api/tactics/scan?topN=10&scope=holdings');
  const box = $('#tactic-signals');
  if (!r.ok) {
    mount(box, el('p', 'placeholder', `扫描失败：${r.error.kind}`));
    setStatus(`扫描失败：${r.error.kind}`, true);
    if (btn !== null) btn.disabled = false;
    return;
  }
  const d = r.data;
  const head = el(
    'p',
    'muted',
    `战法 ${d.totalTactics} · 评估 ${d.evaluatedStocks ?? 0} 股 · 命中 ${d.ranked.length}`,
  );
  if (d.ranked.length === 0) {
    mount(box, [head, el('p', 'placeholder', '（未命中任何战法信号）')]);
    setStatus('扫描完成（无信号）');
    if (btn !== null) btn.disabled = false;
    return;
  }
  const ul = el('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  for (const s of d.ranked) {
    const code = String(s.stockId ?? '').split('.')[0] || s.stockId;
    const li = el(
      'li',
      null,
      el('div', null, [
        el('strong', null, `${code} · ${s.tacticName}`),
        el('p', null, `方向 ${s.direction} · 评分 ${(s.llmScore ?? 0).toFixed(1)}`),
        el('p', 'muted', s.rationale ?? ''),
      ]),
    );
    li.style.padding = 'var(--space-3) 0';
    li.style.borderBottom = '1px solid var(--line)';
    ul.append(li);
  }
  mount(box, [head, ul]);
  setStatus(`扫描完成 · top ${d.ranked.length}`);
  if (btn !== null) btn.disabled = false;
};

/* ============ advice ============ */

const renderAdviceList = async (setStatus) => {
  const r = await callApi('/api/advice?includeExpired=true');
  const list = $('#advice-full-list');
  if (!r.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const all = [...r.data.advices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const filter = $('#advice-filter')?.value ?? 'all';
  const filtered = filter === 'all' ? all : all.filter((a) => a.decision === filter);
  if (filtered.length === 0) {
    mount(
      list,
      el('p', 'placeholder', filter === 'all' ? '（暂无建议）' : `（无 ${filter} 类建议）`),
    );
  } else {
    mount(list, filtered.map(adviceCard));
  }
  setStatus(`建议已刷新 · ${filtered.length} / ${all.length} 条`);
};

/* ============ review ============ */

const renderTrend = (data) => {
  const box = $('#review-trend');
  if (!Array.isArray(data) || data.length < 2) {
    box.innerHTML = '';
    mount(
      box,
      el(
        'div',
        { class: 'muted', style: { textAlign: 'center', paddingTop: '60px' } },
        '样本不足 2 个时间窗，暂不绘制趋势图。',
      ),
    );
    return;
  }
  const w = box.clientWidth || 600;
  const h = 160;
  const pad = 32;
  const xs = data.map((_, i) => pad + (i * (w - 2 * pad)) / (data.length - 1));
  const ys = data.map((d) => h - pad - (d.hitRate ?? 0) * (h - 2 * pad));
  const line = data
    .map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`)
    .join(' ');
  const dots = data
    .map(
      (d, i) =>
        `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3" fill="var(--accent)" />` +
        `<text x="${xs[i].toFixed(1)}" y="${(ys[i] - 8).toFixed(1)}" text-anchor="middle" ` +
        `font-size="10" fill="var(--ink-soft)">${((d.hitRate ?? 0) * 100).toFixed(0)}%</text>`,
    )
    .join('');
  const xLabels = data
    .map((d, i) => {
      const label = d.date ?? d.label ?? String(i);
      return `<text x="${xs[i].toFixed(1)}" y="${(h - pad + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
    })
    .join('');
  const svg = `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--line)" />
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--line)" />
      <text x="${pad - 4}" y="${pad + 4}" text-anchor="end" font-size="10" fill="var(--muted)">100%</text>
      <text x="${pad - 4}" y="${h - pad}" text-anchor="end" font-size="10" fill="var(--muted)">0%</text>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" />
      ${dots}
      ${xLabels}
    </svg>
  `;
  box.innerHTML = svg;
};

const renderReview = async (setStatus) => {
  const r = await callApi('/api/review');
  if (!r.ok) {
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const stats = r.data.stats;
  const grid = $('#review-stats-grid');
  mount(grid, [
    statBlock('总条数', String(stats.totalAdvices)),
    statBlock('平均信心度', stats.avgConfidence.toFixed(1)),
    statBlock('命中率', fmtPct(stats.hitRate)),
    statBlock(
      '跟单盈亏',
      fmtSigned(stats.pnlWhenFollowed),
      stats.pnlWhenFollowed > 0 ? 'pos' : stats.pnlWhenFollowed < 0 ? 'neg' : '',
    ),
    statBlock(
      '忽略盈亏',
      fmtSigned(stats.pnlWhenIgnored),
      stats.pnlWhenIgnored > 0 ? 'pos' : stats.pnlWhenIgnored < 0 ? 'neg' : '',
    ),
    statBlock(
      'follow 占比',
      fmtPct(stats.outcomeRate.followed),
      `${fmtPct(stats.outcomeRate.partiallyFollowed)} 部分 / ${fmtPct(stats.outcomeRate.ignored)} 忽略`,
    ),
  ]);
  $('#review-stats-meta').textContent = `${stats.totalAdvices} 条（含已过期）`;

  // ====== W4 confidence 自校准表 ======
  const calR = await callApi('/api/review/calibration');
  if (calR.ok) {
    const cal = calR.data;
    $('#review-calibration-meta').textContent =
      `${cal.totalAdvices} 条 / ${cal.totalWithOutcome} 已回填 · 整体命中率 ${fmtPct(cal.overallHitRate)}`;
    const tbody = $('#review-calibration-table tbody');
    tbody.innerHTML = cal.buckets
      .map((b) => {
        const hitColor =
          b.withOutcome === 0 ? '' : b.hitRate >= 0.7 ? 'pos' : b.hitRate <= 0.3 ? 'neg' : 'warn';
        const pnlClass =
          b.withOutcome === 0 ? '' : b.avgPnl > 0 ? 'pos' : b.avgPnl < 0 ? 'neg' : '';
        return (
          `<tr>` +
          `<td>${b.range.min}-${b.range.max}</td>` +
          `<td>${b.total}</td>` +
          `<td>${b.withOutcome}</td>` +
          `<td>${b.hits}</td>` +
          `<td class="${hitColor}">${fmtPct(b.hitRate)}</td>` +
          `<td class="${pnlClass}">${fmtSigned(b.avgPnl)}</td>` +
          `<td>${b.avgConfidence.toFixed(1)}</td>` +
          `</tr>`
        );
      })
      .join('');
  } else {
    $('#review-calibration-meta').textContent = `加载校准失败：${calR.error.kind ?? ''}`;
  }

  // 趋势图：mock 数据（W4.E 待后端给出 byDay 序列）；先用 byDecision 的 hitRate
  const decisionData = Object.entries(stats.byDecision ?? {})
    .filter(([, s]) => s.totalAdvices > 0)
    .map(([decision, s]) => ({ label: decision, hitRate: s.hitRate }));
  renderTrend(decisionData);

  // 列表 + outcome 回填按钮
  const advices = r.data.advices.advices ?? [];
  const list = $('#review-list');
  if (advices.length === 0) {
    mount(list, el('p', 'placeholder', '（暂无建议）'));
  } else {
    mount(
      list,
      advices.map((a) => {
        const code = String(a.subjectId).split('.')[0] || a.subjectId;
        const li = el('div', 'advice-card');
        const status = a.outcome === undefined ? '（待回填）' : a.outcome.outcome;
        const pnlText = a.outcome?.pnl !== undefined ? `  盈亏 ${fmtSigned(a.outcome.pnl)}` : '';
        li.append(
          el('div', 'row-1', [
            el('div', 'subject', [el('span', 'code', code), a.subjectId]),
            el('span', 'badge', `${a.decision} · 信心 ${a.confidence}%`),
          ]),
        );
        li.append(el('p', 'premise', a.reasoning?.premise ?? ''));
        const row2 = el('div', 'row-2', `${status}${pnlText}  有效至 ${fmtDateTime(a.validUntil)}`);
        li.append(row2);
        if (a.outcome === undefined) {
          const btn = el('button', 'btn btn-outline btn-sm', '回填 outcome');
          btn.type = 'button';
          btn.addEventListener('click', (event) => {
            event.stopPropagation();
            fillOutcomeForm(a.id, a.decision);
          });
          li.append(btn);
        }
        return li;
      }),
    );
  }
  setStatus('复盘已刷新');
};

const fillOutcomeForm = async (adviceId, decision) => {
  const followedText = window.prompt(
    `回填 ${adviceId.slice(0, 8)}（决策 ${decision}）\n输入: followed / partially_followed / ignored`,
    'followed',
  );
  if (followedText === null) return;
  const pnlText = window.prompt('实际盈亏（人民币，可负）', '0');
  if (pnlText === null) return;
  const pnl = Number(pnlText);
  const notes = window.prompt('备注（可选）', '') ?? '';
  const r = await callApi(`/api/review/${adviceId}/outcome`, {
    method: 'POST',
    body: JSON.stringify({
      input: {
        followed: followedText === 'followed' || followedText === '1',
        pnl: Number.isFinite(pnl) ? pnl : 0,
        ...(notes.length > 0 ? { notes } : {}),
      },
    }),
  });
  if (r.ok) {
    setStatus(`outcome 已回填 ${adviceId.slice(0, 8)}`);
    await renderReview(setStatus);
  } else {
    setStatus(
      `回填失败：${r.error.kind}${r.error.message !== undefined ? `（${r.error.message}）` : ''}`,
      true,
    );
  }
};

/* ============ settings ============ */

const renderSettings = (setStatus) => {
  const input = $('#settings-token');
  if (input === null) return;
  input.value = window.__luoome.getToken();
  setStatus('设置已加载');
};

const bindSettingsActions = () => {
  const setToken = window.__luoome.setToken;
  const genBtn = $('#btn-token-generate');
  const clrBtn = $('#btn-token-clear');
  if (genBtn !== null) {
    genBtn.addEventListener('click', () => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      setToken(token);
      $('#settings-token').value = token;
    });
  }
  if (clrBtn !== null) {
    clrBtn.addEventListener('click', () => {
      setToken('');
      $('#settings-token').value = '';
    });
  }
};

const renderSettingsAccount = async () => {
  const box = $('#settings-account');
  if (box === null) return;
  const r = await callApi('/api/holdings');
  if (!r.ok) {
    mount(box, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    return;
  }
  mount(
    box,
    el('div', null, [
      el('p', null, `账户 ID：${r.data.accountId}`),
      el('p', null, `状态：${r.data.status}`),
      el('p', null, `持仓数：${r.data.holdings.length}`),
      el('p', null, `总市值：${fmtNum(r.data.totalValue)}`),
      el('p', null, `总盈亏：${fmtSigned(r.data.totalPnL)}（${fmtPct(r.data.totalPnLPct)}）`),
    ]),
  );
};

export {
  analyzeAllHoldings,
  bindSettingsActions,
  renderAdviceList,
  renderDashboard,
  renderHoldings,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderTacticsList,
  runTacticScan,
};
