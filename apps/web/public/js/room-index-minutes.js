import { callApi } from './api.js';
import { DASHBOARD_INDEX_CODES, INDEX_DEFS } from './index-defs.js';
import { el, fmtNum } from './ui.js';

const definitions = INDEX_DEFS.filter((index) => DASHBOARD_INDEX_CODES.includes(index.code));
const minuteMs = 60_000;
const pctText = (quote) => {
  if (!Number.isFinite(quote?.changePct)) return null;
  return `${quote.changePct > 0 ? '+' : ''}${quote.changePct.toFixed(2)}%`;
};

const pctTone = (quote) => {
  if (!Number.isFinite(quote?.changePct)) return 'muted';
  if (quote.changePct > 0) return 'text-pos';
  if (quote.changePct < 0) return 'text-neg';
  return 'muted';
};
let requestedAt = 0;
let pending;

function fetchIndices() {
  if (!pending || Date.now() - requestedAt >= minuteMs) {
    requestedAt = Date.now();
    pending = Promise.all(
      definitions.map(({ code }) =>
        callApi(`/api/market/indices/intraday?code=${code}`, { timeoutMs: 12_000 }),
      ),
    );
  }
  return pending;
}

function minuteCard(def, response, quote) {
  const data = response.data;
  // 上游冷却时服务端会复用上一次成功的分时并标 stale：线照画，只在名称旁标滞后。
  const card = el('div', 'minute-card', [
    el('div', 'minute-head', [
      el('strong', '', def.name),
      data?.stale === true ? el('span', 'minute-stale', '滞后') : null,
    ]),
  ]);
  const points = (data?.points ?? []).filter(
    (point) =>
      Number.isFinite(point.price) && point.price > 0 && Number.isFinite(Date.parse(point.time)),
  );
  if (!response.ok || !points.length) {
    card.append(
      el('small', '', data?.supported === false ? '当前数据源不支持分时' : '分时暂不可用'),
    );
    return card;
  }
  const last = points.at(-1);
  // 价格与涨跌幅取同一份指数快照：分时最后一分钟往往比报价慢一拍，混用会自相矛盾。
  const price = Number.isFinite(quote?.close) ? quote.close : last.price;
  const change = pctText(quote);
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 220 48');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${def.name}分时，区间 ${fmtNum(min)} 至 ${fmtNum(max)}`);
  const plot = document.createElementNS(svg.namespaceURI, 'path');
  let lastMinute = -Infinity;
  let line = '';
  for (const point of points) {
    const date = new Date(point.time);
    const localMinute = ((date.getUTCHours() + 8) % 24) * 60 + date.getUTCMinutes();
    const sessionMinute = localMinute - 570 - (localMinute >= 780 ? 90 : 0);
    if (sessionMinute < 0 || sessionMinute > 240 || (localMinute > 690 && localMinute < 780))
      continue;
    const x = 2 + (216 * sessionMinute) / 240;
    const y = max === min ? 24 : 44 - (40 * (point.price - min)) / (max - min);
    const command = sessionMinute - lastMinute > 1 ? 'M' : 'L';
    line += `${command}${x.toFixed(1)} ${y.toFixed(1)} `;
    lastMinute = sessionMinute;
  }
  plot.setAttribute('d', line);
  const title = document.createElementNS(svg.namespaceURI, 'title');
  title.textContent = svg.getAttribute('aria-label');
  svg.append(title, plot);
  card.append(
    el('div', 'minute-value', [
      el('b', '', fmtNum(price)),
      change === null ? null : el('span', `minute-change ${pctTone(quote)}`, change),
    ]),
    svg,
  );
  return card;
}

if (globalThis.customElements && !customElements.get('room-index-minutes')) {
  customElements.define(
    'room-index-minutes',
    class extends HTMLElement {
      connectedCallback() {
        this.innerHTML = '<div class="minute-grid"></div>';
        this.querySelector('.minute-grid').textContent = '正在读取分时…';
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), minuteMs);
      }
      disconnectedCallback() {
        clearInterval(this.timer);
      }
      async refresh() {
        if (document.hidden || !this.getClientRects().length) return;
        if (Date.now() < (this.retryAt ?? 0)) return;
        const grid = this.querySelector('.minute-grid');
        const results = await fetchIndices();
        // 四条全挂或全在复用旧数据，说明上游正在限流：按 1→2→5 分钟退避，
        // 别让 1 分钟一次的失败重试继续压冷却中的公开源。
        const failed = results.every((r) => !r.ok || r.data?.stale === true);
        this.failures = failed ? (this.failures ?? 0) + 1 : 0;
        this.retryAt = failed
          ? Date.now() + Math.min(minuteMs * 2 ** (this.failures - 1), 5 * minuteMs)
          : 0;
        const quotes = this.indexes ?? [];
        if (grid.isConnected)
          grid.replaceChildren(
            ...results.map((r, i) => {
              const def = definitions[i];
              return minuteCard(
                def,
                r,
                quotes.find((quote) => quote?.code === def.code),
              );
            }),
          );
      }
    },
  );
}
