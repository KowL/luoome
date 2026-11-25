/* apps/web/public/js/market-room-board.js —— 作战室总览的累计成交额块。
 *
 * 盘面卡里只放数字和对比条：已填长度是当前成交额，竖线是昨日同时点，满格是昨日全天。
 * 口径、样本数与缺失原因不上页面，统一进盘面卡的折叠说明。
 */

import { formatAmount } from './market-shared.js';
import { el } from './ui.js';

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

const signedPct = (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

const deltaTone = (value) => (value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : 'muted');

export function amountBlock(amount) {
  const value = amount?.value;
  const box = el('div', 'room-cash');
  box.append(el('span', 'room-cash-label', '沪深 A 股累计成交额'));
  if (!value) {
    const reason = amount?.warnings?.[0] ?? '成交额缺失';
    box.append(el('p', 'room-missing', reason));
    return box;
  }
  const close = value.previousCloseAmount;
  const prior = value.comparison?.previousAmount;
  box.append(
    el('div', 'room-cash-head', [
      el('b', 'room-cash-value mono', formatAmount(value.currentAmount)),
      value.comparison === undefined
        ? null
        : el(
            'span',
            `room-cash-delta mono ${deltaTone(value.comparison.deltaPct)}`,
            signedPct(value.comparison.deltaPct),
          ),
    ]),
  );
  if (!(close > 0)) {
    box.append(
      el('div', 'room-cash-legend', [
        prior == null
          ? el('span', 'room-missing', '昨日同时点缺失')
          : el('span', '', `昨日同时点 ${formatAmount(prior)}`),
        el('span', 'room-missing', '昨日全天缺失'),
      ]),
    );
    return box;
  }
  const share = (100 * value.currentAmount) / close;
  box.append(
    track(value.currentAmount, close, prior),
    el('div', 'room-cash-legend', [
      prior == null
        ? el('span', 'room-missing', '昨日同时点缺失')
        : el('span', '', `昨日同时点 ${formatAmount(prior)}`),
      el('span', '', `昨日全天 ${formatAmount(close)}`),
      el('span', 'room-cash-share mono', `占昨日 ${share.toFixed(1)}%`),
    ]),
  );
  return box;
}
