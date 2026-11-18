import { callApi } from './api.js';
import { DASHBOARD_INDEX_CODES, INDEX_DEFS } from './index-defs.js';
import { el, fmtNum } from './ui.js';

const definitions = INDEX_DEFS.filter((index) => DASHBOARD_INDEX_CODES.includes(index.code));
const minuteMs = 60_000;
const observedTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
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

function minuteCard(def, response) {
  const card = el('div', 'minute-card', [el('strong', '', def.name)]);
  const data = response.data;
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
  const stamp = observedTime.format(new Date(last.time));
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
    el('b', '', fmtNum(last.price)),
    svg,
    el('div', 'minute-axis', [
      el('span', '', '09:30'),
      el('span', '', '午休'),
      el('span', '', '15:00'),
    ]),
    el('small', '', stamp + (stamp.endsWith('15:00') ? ' 收盘' : ' 行情')),
  );
  return card;
}

if (globalThis.customElements && !customElements.get('room-index-minutes')) {
  customElements.define(
    'room-index-minutes',
    class extends HTMLElement {
      connectedCallback() {
        this.innerHTML =
          '<div class="minute-heading"><strong>指数分时</strong><small>真实行情 · 分钟线</small></div><div class="minute-grid"></div>';
        this.querySelector('.minute-grid').textContent = '正在读取分时…';
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), minuteMs);
      }
      disconnectedCallback() {
        clearInterval(this.timer);
      }
      async refresh() {
        if (document.hidden || !this.getClientRects().length) return;
        const grid = this.querySelector('.minute-grid');
        const results = await fetchIndices();
        if (grid.isConnected)
          grid.replaceChildren(...results.map((r, i) => minuteCard(definitions[i], r)));
      }
    },
  );
}
