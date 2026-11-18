import { sectorDetailHash } from './market-room-sector-detail.js';
import { formatAmount, formatClock, formatPct } from './market-shared.js';
import { el } from './ui.js';

let ordering = 'day';
const volumeFilters = ['全部', '放量走强', '放量下跌', '缩量回落'];
let volumeFilter = '全部';
let leaderMetric = 'leaders';

function track(value, max, previous) {
  const node = el('div', 'room-track');
  if (!Number.isFinite(value) || !(max > 0)) return node;
  const fill = el('span', 'room-fill');
  fill.style.width = `${Math.min(100, (100 * value) / max)}%`;
  node.append(fill);
  if (Number.isFinite(previous)) {
    const mark = el('i');
    mark.style.left = `${Math.max(0, Math.min(100, (100 * previous) / max))}%`;
    node.append(mark);
  }
  return node;
}

export function amountMeter(amount, batch) {
  const value = amount.value;
  const box = el('section', 'card room-cash', [el('h2', '', '沪深 A 股累计成交额')]);
  if (!value) {
    box.append(el('p', 'room-caption', amount.warnings.join(' · ') || '成交额缺失'));
    return box;
  }
  const close = value.previousCloseAmount;
  const prior = value.comparison?.previousAmount;
  box.append(
    el('b', 'room-cash-value mono', formatAmount(value.currentAmount)),
    el(
      'span',
      'room-caption',
      `　${batch.tradingDate} · ${formatClock(batch.sampledAt)} 批次 · 有效 ${value.currentSampleCount} / ${value.currentTotalCount} 只`,
    ),
  );
  if (close > 0) {
    box.append(
      track(value.currentAmount, close, prior),
      el('div', 'room-meter-notes', [
        el(
          'span',
          '',
          prior == null ? '昨日同时点缺样本' : '白线 · 昨日同时点 ' + formatAmount(prior),
        ),
        el(
          'span',
          '',
          `昨日全天 ${formatAmount(close)} · 当前为昨日的 ${((100 * value.currentAmount) / close).toFixed(1)}%`,
        ),
      ]),
    );
  } else box.append(el('small', 'room-caption', '昨日全天基准缺失'));
  return box;
}

const shareOf = (metric) => metric?.value ?? metric?.observedSharePct ?? null;

function priceVolume(windowReturn, entry) {
  const price = windowReturn?.value;
  let percent = formatPct(price, true, '缺失');
  if (price !== 0 && Math.abs(price) < 0.005 && Number.isFinite(price)) {
    percent = `${price > 0 ? '+' : ''}${price.toFixed(4)}%`;
  }
  const current = entry?.share;
  const previous = entry?.previousShare;
  const amount = current?.numeratorAmount;
  const prior = previous?.numeratorAmount;
  const label = entry?.priceVolume ?? '量价待定';
  const comparable = label !== '量价待定';
  const tone = comparable ? (price > 0 ? ' price-up' : price < 0 ? ' price-down' : '') : '';
  const title = comparable
    ? `板块成交额：前窗 ${formatAmount(prior)}，当前 ${formatAmount(amount)}。15 分钟涨跌幅为有效成分等权均值。`
    : '相邻窗口成交额或成分覆盖不可比';
  return { percent, label, tone, title };
}

function renderLeaders(list, row) {
  list.replaceChildren();
  const recent = leaderMetric === 'leaders15';
  const previous = row.previousLeaders15Ids;
  for (const [index, stock] of (row[leaderMetric] ?? []).entries()) {
    const label = el('span', '', stock.name);
    label.title = stock.stockId;
    const line = el('div', '', [label]);
    if (recent && previous?.length) {
      const before = previous.indexOf(stock.stockId);
      if (before < 0 || before > index) {
        const isNew = before < 0;
        const badge = el(
          'small',
          `room-leader-move ${isNew ? 'new' : 'up'}`,
          isNew ? '新进' : `↑${before - index}`,
        );
        const priorRank = isNew ? '前窗未入前三' : `前窗第 ${before + 1} 名`;
        badge.title = `${priorRank}，本窗第 ${index + 1} 名`;
        badge.setAttribute('aria-label', badge.title);
        line.append(badge);
      }
    }
    line.append(el('b', 'mono', formatPct(stock.changePct, true)));
    list.append(line);
  }
  if (recent && !previous?.length && list.childElementCount) {
    list.append(el('small', 'room-caption', '名次变化不可比'));
  }
  if (!list.childElementCount) {
    list.textContent = recent ? '缺少15分钟可比报价' : '缺少日涨幅报价';
  }
}

export function rotationBoard(ranking, distribution, at) {
  const section = el('section', 'card room-rotation');
  if (!ranking?.rows.length) {
    section.append(
      el('h2', '', '题材涨幅与成交占比'),
      el('p', 'room-caption', '该批次没有可用概念板块行情'),
    );
    return section;
  }
  const distributions = new Map((distribution?.rows ?? []).map((row) => [row.sectorId, row]));
  const share = (row) => shareOf(row.turnover);
  const changes = new Map();
  for (const entry of distributions.values()) {
    const current = shareOf(entry.share);
    const previous = shareOf(entry.previousShare);
    if (current === null || previous === null) continue;
    const delta = entry.deltaPp?.value ?? Number((current - previous).toFixed(2));
    changes.set(entry.sectorId, delta);
  }
  const quoted = ranking.rows.filter((row) => Number.isFinite(row.day.value));
  const states = new Map();
  const counts = new Map();
  for (const row of quoted) {
    const state = priceVolume(row.window15, distributions.get(row.sectorId));
    states.set(row.sectorId, state);
    counts.set(state.label, (counts.get(state.label) ?? 0) + 1);
  }
  function paint() {
    const rows = quoted
      .filter((row) => volumeFilter === '全部' || states.get(row.sectorId).label === volumeFilter)
      .sort((a, b) => {
        if (ordering === 'shareUp' || ordering === 'shareDown') {
          const left = changes.get(a.sectorId);
          const right = changes.get(b.sectorId);
          if (left === undefined || right === undefined)
            return Number(right !== undefined) - Number(left !== undefined);
          return ordering === 'shareUp' ? right - left : left - right;
        }
        if (ordering === 'share') return (share(b) ?? -1) - (share(a) ?? -1);
        return ordering === 'fall' ? a.day.value - b.day.value : b.day.value - a.day.value;
      });
    const controls = el('div', 'room-board-controls');
    const select = el('select');
    select.setAttribute('aria-label', '题材排序');
    for (const [key, title] of [
      ['day', '涨幅领先'],
      ['fall', '跌幅居前'],
      ['share', '成交活跃'],
      ['shareUp', '近15分钟占比升幅'],
      ['shareDown', '近15分钟占比降幅'],
    ]) {
      const option = el('option', '', title);
      option.value = key;
      select.append(option);
    }
    select.value = ordering;
    select.onchange = () => {
      ordering = select.value;
      paint();
    };
    const leaderLists = new Map();
    const metric = el('select');
    for (const [key, title] of [
      ['leaders', '日涨幅前三'],
      ['leaders15', '近15分钟涨幅前三'],
    ]) {
      const option = el('option', '', title);
      option.value = key;
      metric.append(option);
    }
    metric.value = leaderMetric;
    metric.onchange = () => {
      leaderMetric = metric.value;
      for (const [row, list] of leaderLists) renderLeaders(list, row);
    };
    controls.append(select, el('label', 'room-leader-control', ['领涨股', metric]));
    const filters = el('div', 'room-volume-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '按量价标签筛选');
    for (const label of volumeFilters) {
      const count = label === '全部' ? quoted.length : (counts.get(label) ?? 0);
      const button = el('button', 'btn btn-sm btn-outline', `${label} ${count}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(label === volumeFilter));
      button.onclick = () => {
        volumeFilter = label;
        paint();
        section
          .querySelector('.room-volume-filters [aria-pressed="true"]')
          .focus({ preventScroll: true });
      };
      filters.append(button);
    }
    const grid = el('div', 'room-board-grid');
    grid.tabIndex = 0;
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-label', `${volumeFilter}题材`);
    const high = Math.max(0, ...quoted.map((row) => row.day.value));
    const low = Math.max(0, ...quoted.map((row) => -row.day.value));
    const scale = 48 / (high + low || 1);
    const baseline = high * scale;
    const maxShare = Math.max(
      1,
      ...quoted.flatMap((row) => [
        share(row) ?? 0,
        shareOf(distributions.get(row.sectorId)?.previousShare) ?? 0,
      ]),
    );
    for (const row of rows) {
      const pct = row.day.value,
        h = Math.abs(pct) * scale;
      const col = el('div', 'room-board-col');
      const link = el('a', 'room-theme-title', row.name);
      link.title = row.name;
      link.href =
        '#' +
        sectorDetailHash({
          kind: 'concept',
          sort: 'day',
          window: 'w15',
          sectorId: row.sectorId,
          at,
        });
      const plot = el('div', 'room-bar-plot');
      const zero = el('div', 'room-zero');
      zero.style.top = baseline + 'px';
      const bar = el('div', 'room-real-bar ' + (pct < 0 ? 'loss' : 'gain'));
      bar.style.height = h + 'px';
      bar.style.top = (pct < 0 ? baseline : baseline - h) + 'px';
      const value = el(
        'strong',
        'room-bar-value ' + (pct < 0 ? 'text-neg' : 'text-pos'),
        formatPct(pct, true),
      );
      plot.append(zero, bar);
      const leaders = el('div', 'room-board-leaders');
      renderLeaders(leaders, row);
      leaderLists.set(row, leaders);
      const shareNow = share(row),
        previous = shareOf(distributions.get(row.sectorId)?.previousShare);
      const shareLabel = row.turnover.observedSharePct != null ? '样本成交占比' : '成交占比';
      const delta = changes.get(row.sectorId);
      const badge = el('strong', 'room-share-change', '占比变化缺失');
      if (delta !== undefined) {
        const direction = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
        badge.classList.add(delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat');
        badge.textContent =
          delta === 0
            ? '占比持平'
            : `${direction} 占比 ${delta > 0 ? '+' : ''}${delta.toFixed(2)} 个百分点`;
        badge.title = `上一窗口 ${formatPct(previous)} · 当前窗口 ${formatPct(shareNow)}`;
      }
      const state = states.get(row.sectorId);
      const line = el('div', 'room-price-volume', [
        el('span', 'room-window-return', `15分钟 ${state.percent}`),
        el('strong', 'room-pv-state' + state.tone, state.label),
      ]);
      line.title = state.title;
      col.append(
        el('div', 'room-theme-head', [link, value]),
        line,
        el('div', 'room-theme-body', [plot, leaders]),
      );
      const strengthening = distributions.get(row.sectorId)?.strengthening;
      if (strengthening) {
        col.classList.add('just-strengthened');
        const time = el('time', '', formatClock(strengthening.at));
        time.dateTime = strengthening.at;
        const recent = el('div', 'room-strengthening', ['刚走强 ', time]);
        recent.title = `${strengthening.previousState} → 放量走强 · 相邻分钟批次确认，突出显示 5 分钟`;
        col.insertBefore(recent, col.firstChild);
      }
      col.append(
        el('div', 'room-share-label', shareLabel + ' ' + formatPct(shareNow, false, '缺失')),
        track(shareNow, maxShare, previous),
        badge,
      );
      grid.append(col);
    }
    const market = ranking.turnover;
    const windows = distribution?.windows;
    const start = windows?.current?.startSampledAt;
    const priorStart = windows?.previous?.startSampledAt;
    const windowLabel =
      start && priorStart
        ? `当前 ${formatClock(start)}–${formatClock(ranking.anchor.sampledAt)} · 前窗 ${formatClock(priorStart)}–${formatClock(start)}`
        : '近 15 分钟与前一个 15 分钟比较';
    section.replaceChildren(
      el('div', 'card-header', [
        el('div', '', [
          el('h2', '', '题材涨幅与成交占比'),
          el(
            'div',
            'card-meta',
            `${ranking.tradingDate} · ${formatClock(ranking.anchor.sampledAt)} 批次 · ${quoted.length} 个有报价概念 · 柱高为成分日涨幅等权均值`,
          ),
        ]),
        controls,
      ]),
      el('div', 'room-window-caption', `${windowLabel} · 放量 / 缩量按板块成交额与前窗比较`),
      filters,
      rows.length ? grid : el('p', 'room-caption', `当前批次没有符合「${volumeFilter}」的题材`),
      el(
        'p',
        'room-caption',
        `近 15 分钟成交占比 · 成分成交额增量 / 同期沪深有效样本增量，有效 ${market.marketSampleCount} / ${market.marketTotalCount} 只。竖线为前一窗口，全部题材共用刻度。概念成分可能重叠。`,
      ),
    );
  }
  paint();
  return section;
}
