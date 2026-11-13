/* apps/web/public/js/market-room-events.js —— 作战室「盘中事件」区（ticket #42）。
 *
 * 设计要点：
 * - 只读 GET /api/market/room/events；事件、阈值与证据全部原样展示，不复制领域规则；
 * - 按检测时点倒序列出扩散 / 分化 / 换位，点开一行展开当时的榜单、上涨面、窗口涨幅、
 *   成交占比、天梯样本（涨停原因 / 封板时间）与已知成分；
 * - 缺失一律写「缺失」，不把缺天梯样本写成 0，也不补造「待核实」方向；
 * - 本票只做展示与选中态（hash 的 event 参数）；点事件切换三个视图的时点属于 #43。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import {
  replayAtFromHash,
  replayClockLabel,
  replayEmptyNotice,
  replayHashSuffix,
  replayParam,
} from './market-room-replay.js';
import { el } from './ui.js';

const EVENT_KIND_LABELS = { diffusion: '扩散', divergence: '分化', rotation: '换位' };
const EVENT_STATUS_LABELS = { complete: '证据完整', partial: '证据部分缺失' };
const SECTOR_KIND_LABELS = { industry: '行业', concept: '概念' };
const EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  no_events: '该交易日没有扩散 / 分化 / 换位事件',
};

const fmtClock = (value) => {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtPct = (value, signed = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

const fmtPp = (value, signed = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}pp`;
};

const eventKindLabel = (kind) => EVENT_KIND_LABELS[kind] ?? kind ?? '事件';

/** 阈值文案：不同事件种类的判定条件逐项写出，避免只写「达到阈值」。 */
const thresholdsText = (thresholds) => {
  if (thresholds === null || thresholds === undefined) return '缺失';
  const lookback = thresholds.lookbackSamples;
  const suffix = lookback === undefined ? '' : `（回看 ${lookback} 个样本）`;
  if (thresholds.kind === 'diffusion') {
    return `上涨面 ≥ ${fmtPp(thresholds.advanceRatioGainPp)} · 窗口 > ${fmtPct(thresholds.windowChangePctAbove)} · 占比 ≥ ${fmtPp(thresholds.turnoverShareDeltaPpAtLeast)}${suffix}`;
  }
  if (thresholds.kind === 'divergence') {
    return `日涨幅名次 ≤ ${thresholds.dayRankMax} · 上涨面回落 ≥ ${fmtPp(thresholds.advanceRatioDropPp)} · 窗口 < ${fmtPct(thresholds.windowChangePctBelow)}${suffix}`;
  }
  if (thresholds.kind === 'rotation') {
    return `连续 ${thresholds.consecutiveSamples} 个样本窗口差 ≥ ${fmtPp(thresholds.windowLeadPpAtLeast)}${suffix}`;
  }
  return '缺失';
};

/** 一行摘要：让用户先看懂「发生了什么」，再决定是否展开证据。 */
const eventSummaryText = (event) => {
  const evidence = event?.evidence;
  if (evidence === undefined || evidence === null) return '证据缺失';
  if (event.kind === 'rotation') {
    const from = evidence.rotation?.from?.sector?.name ?? '旧领先者';
    const to = evidence.rotation?.to?.sector?.name ?? event.sector?.name ?? '新领先者';
    const lead = (evidence.rotation?.leadSamples ?? []).at(-1);
    const leadText = lead === undefined ? '窗口差缺失' : `窗口差 ${fmtPp(lead.deltaPp)}`;
    return `领涨 ${from} → ${to} · 连续 ${(evidence.rotation?.leadSamples ?? []).length} 个样本 ${leadText}`;
  }
  const breadth = evidence.breadth ?? {};
  const window = evidence.window ?? {};
  const turnover = evidence.turnover ?? {};
  const ratio =
    breadth.advanceRatio === null || breadth.advanceRatio === undefined
      ? '上涨面缺失'
      : `上涨面 ${fmtPct(breadth.baseAdvanceRatio) ?? '缺失'} → ${fmtPct(breadth.advanceRatio)}（${fmtPp(breadth.deltaPp)}）`;
  const windowText = `窗口 ${fmtPct(window.changePct, true) ?? '缺失'}`;
  if (event.kind === 'divergence') {
    const rank =
      evidence.ranking?.dayRank === null || evidence.ranking?.dayRank === undefined
        ? '名次缺失'
        : `日涨幅第 ${evidence.ranking.dayRank} / ${evidence.ranking.sectorCount} 名`;
    return `${rank} · ${ratio} · ${windowText}`;
  }
  return `${ratio} · ${windowText} · 占比 ${fmtPct(turnover.sharePct) ?? '缺失'}（${fmtPp(turnover.deltaPp)}）`;
};

/** 事件证据的可核对事实。 */
const eventDetailFacts = (event) => {
  const evidence = event?.evidence ?? {};
  const breadth = evidence.breadth ?? {};
  const window = evidence.window ?? {};
  const turnover = evidence.turnover ?? {};
  const ranking = evidence.ranking ?? {};
  const ladder = evidence.ladder ?? {};
  const rankText =
    ranking.dayRank === null || ranking.dayRank === undefined
      ? '缺失'
      : `第 ${ranking.dayRank} / ${ranking.sectorCount} 名`;
  const breadthText =
    breadth.advanceRatio === null || breadth.advanceRatio === undefined
      ? '缺失'
      : `上涨 ${breadth.advancing} / 有效 ${breadth.sampleCount}（${fmtPct(breadth.advanceRatio)}，成分 ${breadth.memberCount}）`;
  const breadthDelta =
    breadth.deltaPp === null || breadth.deltaPp === undefined
      ? '缺失'
      : `${fmtPp(breadth.deltaPp)}（基准 ${fmtPct(breadth.baseAdvanceRatio) ?? '缺失'}）`;
  const turnoverText =
    turnover.sharePct === null || turnover.sharePct === undefined
      ? '缺失'
      : `${fmtPct(turnover.sharePct)}（较上一窗口 ${fmtPp(turnover.deltaPp) ?? '缺失'}）`;
  const ladderText =
    ladder.sealedCount === null || ladder.sealedCount === undefined
      ? '缺失'
      : `${ladder.sealedCount} 只`;
  return [
    {
      label: '检测时点',
      value: `${fmtClock(event?.sampledAt)} · 交易日 ${event?.tradingDate ?? '--'}`,
    },
    {
      label: '板块',
      value:
        `${event?.sector?.name ?? '--'} · ${SECTOR_KIND_LABELS[event?.sector?.kind] ?? event?.sector?.kind ?? '--'} ${event?.sector?.vendorCode ?? ''}`.trim(),
    },
    { label: '日涨幅名次', value: rankText },
    { label: '日涨幅', value: fmtPct(ranking.dayChangePct, true) ?? '缺失' },
    {
      label: '窗口涨幅',
      value: `${fmtPct(window.changePct, true) ?? '缺失'}（回看 ${window.lookbackSamples ?? '--'} 个样本）`,
    },
    { label: '上涨面', value: breadthText },
    { label: '上涨面变化', value: breadthDelta },
    { label: '窗口成交占比', value: turnoverText },
    { label: '封板数', value: ladderText },
    {
      label: '事件状态',
      value: EVENT_STATUS_LABELS[event?.status] ?? event?.status ?? '缺失',
    },
    {
      label: '核实状态',
      value:
        event?.verification?.status === 'verified'
          ? '已核实 · 已收录目录板块'
          : (event?.verification?.status ?? '缺失'),
    },
    { label: '触发阈值', value: thresholdsText(event?.thresholds) },
  ];
};

/** 天梯证据：封板时间与涨停原因缺失时写「缺失」，不推算、不写 0。 */
const eventLadderLines = (event) => {
  const ladder = event?.evidence?.ladder;
  if (ladder === null || ladder === undefined) return ['缺失'];
  if (ladder.status === 'unavailable') return [ladder.reason ?? '天梯样本缺失'];
  const stocks = ladder.stocks ?? [];
  if (stocks.length === 0) return ['该时点板块内没有封板成分（天梯样本存在）'];
  return stocks.map(
    (stock) =>
      `${stock.code} ${stock.name} · ${stock.ladderLevel} 板 · 封板 ${stock.firstTime ?? '缺失'} · 涨停原因 ${stock.reason ?? '缺失'}`,
  );
};

/** 当日异动关键词：来自供应商涨停原因，没有时空数组。 */
const eventKeywordText = (event) => {
  const keywords = event?.evidence?.keywords ?? [];
  return keywords.length === 0 ? null : keywords.map((keyword) => keyword.text).join(' / ');
};

/** 已知成分（按日涨幅降序的前 N 只）。 */
const eventMemberLines = (event) => {
  const members = event?.evidence?.members;
  if (members === null || members === undefined) return { lines: [], caption: null };
  const lines = (members.peers ?? []).map((peer) => {
    const name = peer.name === null || peer.name === undefined ? '' : ` ${peer.name}`;
    const sealed = peer.sealed === true ? `${peer.ladderLevel ?? ''} 板`.trim() : '未封';
    return `${peer.code}${name} ${fmtPct(peer.dayChangePct, true) ?? '缺失'} / ${fmtPct(peer.windowChangePct, true) ?? '缺失'} · ${sealed}`;
  });
  const caption = members.truncated
    ? `仅展示日涨幅前 ${members.shownCount} / ${members.memberCount} 只 active 成分`
    : `共 ${members.memberCount} 只 active 成分`;
  return { lines, caption };
};

/** 换位领先样本：逐样本给旧 / 新领先者的窗口涨幅与差值。 */
const rotationLeadLines = (event) => {
  const rotation = event?.evidence?.rotation;
  if (rotation === null || rotation === undefined) return [];
  const from = rotation.from?.sector?.name ?? '旧领先者';
  const to = rotation.to?.sector?.name ?? '新领先者';
  return (rotation.leadSamples ?? []).map(
    (sample) =>
      `${fmtClock(sample.sampledAt)} ${from} ${fmtPct(sample.fromWindowChangePct, true) ?? '缺失'} / ${to} ${fmtPct(sample.toWindowChangePct, true) ?? '缺失'}（${fmtPp(sample.deltaPp)}）`,
  );
};

/** 口径与缺失说明：方法、警告、缺失原因与换位领先样本合并去重。 */
const eventNotes = (event) => {
  const evidence = event?.evidence ?? {};
  const notes = [
    evidence.ranking?.method,
    evidence.window?.method,
    evidence.breadth?.method,
    evidence.turnover?.method,
    evidence.ladder?.method,
    evidence.members?.method,
    ...(evidence.window?.warnings ?? []),
    ...(evidence.breadth?.warnings ?? []),
    ...(evidence.turnover?.warnings ?? []),
    ...(evidence.window?.reason ? [evidence.window.reason] : []),
    ...(evidence.turnover?.reason ? [evidence.turnover.reason] : []),
    ...(evidence.ladder?.reason ? [evidence.ladder.reason] : []),
    ...rotationLeadLines(event),
  ];
  return [...new Set(notes.filter((note) => typeof note === 'string' && note.length > 0))];
};

/** 倒序：最近的事件在最上面；同一样本按种类稳定排序。 */
const sortEventsDesc = (events) => {
  const kindOrder = { diffusion: 0, divergence: 1, rotation: 2 };
  return [...(events ?? [])].sort((left, right) => {
    const byTime = new Date(right.sampledAt).getTime() - new Date(left.sampledAt).getTime();
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    const byKind = (kindOrder[left.kind] ?? 9) - (kindOrder[right.kind] ?? 9);
    if (byKind !== 0) return byKind;
    const bySector = String(left.sector?.sectorId ?? '').localeCompare(
      String(right.sector?.sectorId ?? ''),
    );
    if (bySector !== 0) return bySector;
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
};

/** 空态文案；ready 返回 null。回放没有已知事件时说明按当时已知截断。 */
const eventsEmptyText = (view, at = null) => {
  if (view?.state !== 'empty') return null;
  if (view.emptyReason === 'no_events' && at !== null && at !== undefined) {
    return `回放时点 ${replayClockLabel(at)} 之前没有已记录的事件`;
  }
  return EMPTY_TEXTS[view.emptyReason] ?? '暂无盘中事件';
};

/** 页头口径：交易日 / 三类事件条数 / 排序方式。 */
const eventsMetaText = (view) => {
  if (view === undefined || view === null) return '盘中事件 · 刷新失败';
  if (view.state === 'empty') return `盘中事件 · ${eventsEmptyText(view)}`;
  const counts = view.counts ?? {};
  return `交易日 ${view.tradingDate} · 共 ${counts.total ?? 0} 条（扩散 ${counts.diffusion ?? 0} / 分化 ${counts.divergence ?? 0} / 换位 ${counts.rotation ?? 0}）· 按时间倒序`;
};

/**
 * hash 里的选中事件与回放时点（#market-room?tab=events&event=<id>&at=<iso>）。
 * at 与其它三个视图共用同一个值：点事件时设为该事件的检测时点。
 */
const eventsParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const eventId = params.get('event');
  return {
    eventId: eventId !== null && eventId.length > 0 ? eventId : null,
    at: replayAtFromHash(hash),
  };
};

const eventsHash = ({ eventId, at = null }) => {
  const selected =
    eventId === null || eventId === undefined
      ? 'market-room?tab=events'
      : `market-room?tab=events&event=${encodeURIComponent(eventId)}`;
  return `${selected}${replayHashSuffix(at)}`;
};

/**
 * 事件请求路径（纯函数）：回放时只带 knownAt（信息可见时点），
 * 由服务端只返回该时点之前已记录的事件；最新模式不附带任何时点参数。
 */
const eventsQuery = ({ at = null } = {}) => {
  const knownAt = replayParam(at);
  return knownAt === null ? '' : `?knownAt=${encodeURIComponent(knownAt)}`;
};

/* ---- DOM 渲染 ---- */

const factNode = (fact) =>
  el('div', 'room-fact', [
    el('span', 'label', fact.label),
    el('span', 'value', fact.value ?? '缺失'),
  ]);

const listBlock = (title, lines) =>
  el('div', 'room-event-block', [
    el('h4', '', title),
    lines.length === 0
      ? el('p', 'room-caption', '缺失')
      : el(
          'ul',
          'room-role-evidence',
          lines.map((line) => el('li', '', line)),
        ),
  ]);

const evidenceNode = (event) => {
  const members = eventMemberLines(event);
  const keywordText = eventKeywordText(event);
  const notes = eventNotes(event);
  return el('div', 'room-event-evidence', [
    el('div', 'room-facts room-event-facts', eventDetailFacts(event).map(factNode)),
    listBlock('天梯样本（封板 / 涨停原因）', eventLadderLines(event)),
    el('div', 'room-event-block', [
      el('h4', '', '当日异动关键词'),
      el('p', 'room-caption', keywordText ?? '缺失（天梯样本没有涨停原因，不编造关键词）'),
    ]),
    listBlock('已知成分', members.lines),
    members.caption === null ? null : el('p', 'room-caption muted', members.caption),
    el('details', 'room-detail-notes', [
      el('summary', '', `口径与缺失说明（${notes.length} 条）`),
      el(
        'ul',
        'room-warnings',
        notes.map((note) => el('li', '', note)),
      ),
    ]),
  ]);
};

const eventNode = (event, params) => {
  const selected = params.eventId === event.id;
  const button = el(
    'button',
    `room-event-row room-event-${event.kind}${selected ? ' selected' : ''}`,
    [
      el('span', 'room-event-time', fmtClock(event.sampledAt)),
      el('span', 'room-event-kind', eventKindLabel(event.kind)),
      el('span', 'room-event-sector', event.sector?.name ?? '--'),
      el('span', 'room-event-summary', eventSummaryText(event)),
      el(
        'span',
        `room-status room-status-${event.status === 'complete' ? 'complete' : 'partial'}`,
        EVENT_STATUS_LABELS[event.status] ?? event.status,
      ),
    ],
  );
  button.type = 'button';
  button.dataset.eventId = event.id;
  button.setAttribute('aria-pressed', String(selected));
  button.setAttribute('aria-expanded', String(selected));
  button.addEventListener('click', () => {
    // 选中事件即把统一时间轴切到该事件的检测时点；取消选中保留当前时点。
    window.location.hash = eventsHash({
      eventId: selected ? null : event.id,
      at: selected ? params.at : event.sampledAt,
    });
  });
  return el('li', `room-event-item${selected ? ' selected' : ''}`, [
    button,
    selected ? evidenceNode(event) : null,
  ]);
};

/** 盘中事件区：按时间倒序列出事件；选中行展开当时的证据。 */
const renderEventsPane = (view, params = eventsParamsFromHash()) => {
  if (view === undefined || view === null) {
    return el('div', 'card room-empty room-events', [
      el('h2', '', '盘中事件暂不可用'),
      el('p', '', '读取事件流失败，稍后会自动重试。'),
    ]);
  }
  const replayNotice = view?.emptyReason === 'no_batch' ? replayEmptyNotice(params.at) : null;
  const empty = eventsEmptyText(view, params.at);
  if (empty !== null) {
    return el('div', 'card room-empty room-events', [
      el('h2', '', replayNotice === null ? '盘中事件' : '该时点不可回放'),
      el('p', '', replayNotice ?? empty),
      el(
        'p',
        'room-caption',
        '页面只读已发布批次；事件由后台采集后的幂等扫描写入，缺样本不产生事件。',
      ),
    ]);
  }
  const events = sortEventsDesc(view.events ?? []);
  return el('div', 'card room-card room-events', [
    el('div', 'card-header', [
      el('div', null, [el('h2', '', '盘中事件'), el('div', 'card-meta', eventsMetaText(view))]),
      el('span', 'room-caption', '点击事件展开当时的证据'),
    ]),
    el(
      'ul',
      'room-events-list',
      events.map((event) => eventNode(event, params)),
    ),
    el('details', 'room-detail-notes', [
      el('summary', '', `口径与事件说明（${(view.notes ?? []).length} 条）`),
      el(
        'ul',
        'room-warnings',
        (view.notes ?? []).map((note) => el('li', '', note)),
      ),
    ]),
  ]);
};

/** 读取盘中事件；失败返回 null，由调用方保留上次结果或写空态。 */
const fetchRoomEvents = async (params = eventsParamsFromHash()) => {
  const result = await callApi(`/api/market/room/events${eventsQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.view ?? null) : null;
};

export {
  eventDetailFacts,
  eventKeywordText,
  eventKindLabel,
  eventLadderLines,
  eventMemberLines,
  eventNotes,
  eventSummaryText,
  eventsEmptyText,
  eventsHash,
  eventsMetaText,
  eventsParamsFromHash,
  eventsQuery,
  fetchRoomEvents,
  renderEventsPane,
  rotationLeadLines,
  sortEventsDesc,
  thresholdsText,
};
