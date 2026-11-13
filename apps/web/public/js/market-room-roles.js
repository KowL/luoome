/* apps/web/public/js/market-room-roles.js —— 作战室板块详情里的核心股区块（ticket #41）。
 *
 * 设计要点：
 * - 只读 GET /api/market/room/core-stocks；不复制领域规则，角色 / 时间线 / 证据全部原样展示；
 * - 三个角色逐个给出入选依据（时点 / 字段 / 数值 / 来源），证据不足写原因，不写「暂无」了事；
 * - 时间线只呈现出现 / 开板 / 换位 / 退出与缺样本事实，不把页面展示当成事件存储；
 * - 从核心股反查题材：所属题材、该股在该题材的角色与其他成员同期表现，用来核对
 *   同一只股票是否拉动多个题材；
 * - 供应商封板时间按原口径展示，不用采样时点推算。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { formatAmount } from './market-shared.js';
import { el } from './ui.js';

const ROLE_KINDS = ['ignition', 'turnover', 'height'];
const ROLE_LABELS = { ignition: '启动先锋', turnover: '成交核心', height: '高度标' };
const ROLE_STATUS_LABELS = { assigned: '已入选', tied: '并列', unavailable: '证据不足' };
const ROLE_STATUS_CLASSES = {
  assigned: 'room-status-complete',
  tied: 'room-status-partial',
  unavailable: 'room-status-unavailable',
};
const TIMELINE_KIND_LABELS = {
  appear: '出现',
  open_board: '开板',
  rotate: '换位',
  exit: '退出',
  sample_missing: '缺样本',
};
const FIELD_LABELS = {
  ladderLevel: '连板层级',
  firstTime: '封板时间',
  finalTime: '最后封板',
  dayChangePct: '日涨幅',
  amount: '成交额',
  sectorAdvanceRatio: '板块上涨比例',
  sealed: '封板状态',
  ladderSample: '天梯样本',
};
const KIND_LABELS = { industry: '行业', concept: '概念' };
const EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '该板块没有 active 成分',
  sector_not_found: '该板块不在当前目录中（可能已下架或目录尚未同步）',
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

const fmtValue = (field, value) => {
  if (value === null || value === undefined) return '缺失';
  if (field === 'sealed') return value ? '封板' : '未封';
  if (field === 'ladderSample') return value ? '有样本' : '缺样本';
  if (typeof value === 'number') {
    if (field === 'amount') return formatAmount(value);
    if (field === 'sectorAdvanceRatio' || field === 'dayChangePct') return fmtPct(value);
    return String(value);
  }
  return String(value);
};

/** 单个证据的一行文案：时点 · 字段 · 数值 · 来源 ·（说明）。 */
const evidenceText = (evidence) => {
  if (evidence === null || evidence === undefined) return null;
  const field = FIELD_LABELS[evidence.field] ?? evidence.field;
  const time = evidence.sampledAt === null ? '静态' : fmtClock(evidence.sampledAt);
  const value = fmtValue(evidence.field, evidence.value);
  const source = evidence.source ?? '来源缺失';
  const note = evidence.note === null || evidence.note === undefined ? '' : `（${evidence.note}）`;
  return `${time} · ${field} ${value} · ${source}${note}`;
};

/** 核心股请求路径（纯函数）：kind / at 可选，sectorId 必填。 */
const coreStocksQuery = ({ sectorId, kind, at }) => {
  const query = [`sectorId=${encodeURIComponent(sectorId)}`];
  if (kind !== undefined && kind !== null && kind !== '') {
    query.push(`kind=${encodeURIComponent(kind)}`);
  }
  if (at !== undefined && at !== null && at !== '') {
    query.push(`at=${encodeURIComponent(at)}`);
  }
  return `?${query.join('&')}`;
};

/** 空态文案；ready 返回 null。 */
const coreStocksEmptyText = (core) => {
  if (core?.state !== 'empty') return null;
  const base = EMPTY_TEXTS[core.emptyReason] ?? '核心股暂不可用';
  const anchor = core.anchor;
  return anchor === null || anchor === undefined
    ? base
    : `${base} · 最近批次 ${anchor.tradingDate} ${fmtClock(anchor.sampledAt)}`;
};

/** 页头口径：板块 / 数据时点 / 天梯样本覆盖 / 时间线事件数。 */
const coreStocksMetaText = (core) => {
  if (core === undefined || core === null) return '核心股 · 刷新失败';
  if (core.state === 'empty') return `核心股 · ${coreStocksEmptyText(core)}`;
  const sector = core.sector;
  const kind = KIND_LABELS[sector?.kind] ?? sector?.kind ?? '板块';
  const coverage = core.coverage ?? {};
  return `${sector?.name ?? '--'} · ${kind} ${sector?.vendorCode ?? ''} · 数据时点 ${fmtClock(core.anchor?.sampledAt)} · 天梯样本 ${coverage.ladderSampleCount ?? 0}/${coverage.batchCount ?? 0} · 时间线 ${coverage.timelineEventCount ?? 0} 条`;
};

/** 角色卡模型：状态、持有人、入库证据、缺失原因与口径。 */
const roleCards = (core) => {
  if (core === undefined || core === null || core.state !== 'ready') return [];
  return ROLE_KINDS.map((kind) => {
    const role = core.roles?.[kind];
    if (role === undefined || role === null) return null;
    const holders = (role.holders ?? []).map((holder) => ({
      stockId: holder.stockId,
      code: holder.code,
      name: holder.name ?? null,
      href: `#market?stockId=${encodeURIComponent(holder.stockId)}&range=3m`,
      evidence: (holder.evidence ?? []).map(evidenceText).filter((line) => line !== null),
    }));
    return {
      kind,
      label: role.label ?? ROLE_LABELS[kind] ?? kind,
      status: role.status,
      statusLabel: ROLE_STATUS_LABELS[role.status] ?? role.status,
      statusClass: ROLE_STATUS_CLASSES[role.status] ?? '',
      holders,
      reason: role.reason ?? null,
      method: role.method ?? null,
      warnings: role.warnings ?? [],
    };
  }).filter((card) => card !== null);
};

/** 时间线文案：每条事件带时点、类型、角色与依据；不生成额外事件。 */
const timelineLines = (core) => {
  if (core === undefined || core === null || core.state !== 'ready') return [];
  return (core.timeline ?? []).map((event) => {
    const kindLabel = TIMELINE_KIND_LABELS[event.kind] ?? event.kind;
    const roleLabel =
      event.roleKind === null || event.roleKind === undefined
        ? null
        : (ROLE_LABELS[event.roleKind] ?? event.roleKind);
    const from = (event.from ?? []).map((entry) => entry.code).join(' / ');
    const to = (event.to ?? []).map((entry) => entry.code).join(' / ');
    return {
      sampledAt: event.sampledAt,
      kind: event.kind,
      time: fmtClock(event.sampledAt),
      kindLabel,
      roleLabel,
      from: from === '' ? null : from,
      to: to === '' ? null : to,
      text: event.basis,
      evidence: (event.evidence ?? []).map(evidenceText).filter((line) => line !== null),
    };
  });
};

/** 从核心股反查题材：所属题材 + 该股角色 + 其他成员同期表现。 */
const lookupCards = (core) => {
  if (core === undefined || core === null || core.state !== 'ready') return [];
  return (core.lookups ?? []).map((lookup) => ({
    stockId: lookup.stockId,
    code: lookup.code,
    name: lookup.name ?? null,
    href: `#market?stockId=${encodeURIComponent(lookup.stockId)}&range=3m`,
    multiple: lookup.pullsMultipleThemes === true,
    summary: `${lookup.themeCount} 个题材 · ${lookup.roleThemeCount} 个占用核心角色${lookup.pullsMultipleThemes ? ' · 同一只股票拉动多个题材' : ''}`,
    themes: (lookup.themes ?? []).map((theme) => ({
      sectorId: theme.sectorId,
      name: theme.name,
      kindLabel: KIND_LABELS[theme.kind] ?? theme.kind,
      roleText:
        (theme.roleKinds ?? []).length === 0
          ? '无核心角色'
          : (theme.roleKinds ?? []).map((kind) => ROLE_LABELS[kind] ?? kind).join(' / '),
      breadthText:
        theme.breadth?.advanceRatio === null || theme.breadth?.advanceRatio === undefined
          ? '上涨比例缺失'
          : `上涨比例 ${theme.breadth.advanceRatio.toFixed(2)}%（${theme.breadth.advancing}/${theme.breadth.sampleCount}）`,
      thisStockText: `本股 ${fmtPct(theme.thisStock?.dayChangePct, true) ?? '缺失'}${
        theme.thisStock?.dayRank === null || theme.thisStock?.dayRank === undefined
          ? ''
          : ` · 题材内第 ${theme.thisStock.dayRank} 名`
      }`,
      peers: (theme.peers ?? []).map((peer) => ({
        code: peer.code,
        name: peer.name ?? null,
        day: fmtPct(peer.dayChangePct, true),
        window: fmtPct(peer.windowChangePct, true),
        sealed:
          peer.sealed === null
            ? '封板缺失'
            : peer.sealed
              ? `${peer.ladderLevel ?? ''} 板`.trim()
              : '未封',
      })),
      peerCount: theme.peerCount ?? (theme.peers ?? []).length,
      warnings: theme.warnings ?? [],
    })),
    warnings: lookup.warnings ?? [],
  }));
};

/* ---- DOM 渲染 ---- */

const holderNode = (holder) => {
  const link = el(
    'a',
    'room-role-holder-link',
    holder.name === null ? holder.code : `${holder.code} ${holder.name}`,
  );
  link.href = holder.href;
  return el('div', 'room-role-holder', [
    link,
    el(
      'ul',
      'room-role-evidence',
      holder.evidence.map((line) => el('li', '', line)),
    ),
  ]);
};

const roleCardNode = (card) => {
  const body =
    card.holders.length > 0
      ? card.holders.map(holderNode)
      : [el('p', 'room-role-reason', card.reason ?? '证据不足，未选出核心股')];
  return el('div', 'room-role-card', [
    el('div', 'room-role-head', [
      el('span', 'room-role-label', card.label),
      el('span', `room-status ${card.statusClass}`, card.statusLabel),
    ]),
    el('div', 'room-role-body', body),
    card.warnings.length > 0
      ? el(
          'ul',
          'room-warnings',
          card.warnings.map((warning) => el('li', '', warning)),
        )
      : null,
  ]);
};

const lookupNode = (card) => {
  const link = el(
    'a',
    'room-lookup-link',
    card.name === null ? card.code : `${card.code} ${card.name}`,
  );
  link.href = card.href;
  return el('div', 'room-lookup', [
    el('div', 'room-lookup-head', [
      link,
      el('span', card.multiple ? 'room-lookup-multiple' : 'muted', card.summary),
    ]),
    el(
      'ul',
      'room-lookup-themes',
      card.themes.map((theme) =>
        el('li', 'room-lookup-theme', [
          el('div', 'room-lookup-theme-head', [
            el('span', 'room-lookup-theme-name', `${theme.name}（${theme.kindLabel}）`),
            el('span', 'room-status room-status-partial', theme.roleText),
          ]),
          el('div', 'room-caption', `${theme.breadthText} · ${theme.thisStockText}`),
          theme.peers.length > 0
            ? el(
                'div',
                'room-lookup-peers',
                theme.peers.map((peer) =>
                  el(
                    'span',
                    'room-lookup-peer',
                    `${peer.code}${peer.name === null ? '' : ` ${peer.name}`} ${peer.day ?? '缺失'}${peer.window === null ? '' : ` / ${peer.window}`} · ${peer.sealed}`,
                  ),
                ),
              )
            : null,
          theme.peerCount > theme.peers.length
            ? el(
                'p',
                'room-caption muted',
                `仅展示日涨幅前 ${theme.peers.length} / ${theme.peerCount} 只其他成员`,
              )
            : null,
          theme.warnings.length > 0
            ? el(
                'ul',
                'room-warnings',
                theme.warnings.map((warning) => el('li', '', warning)),
              )
            : null,
        ]),
      ),
    ),
  ]);
};

/** 核心股区块：三个角色 + 时间线 + 从核心股反查题材。 */
const renderCoreStocksPane = (core) => {
  if (core === undefined || core === null) {
    return el('div', 'card room-empty room-core-stocks', [
      el('h2', '', '核心股暂不可用'),
      el('p', '', '读取核心股失败，稍后会自动重试。'),
    ]);
  }
  const empty = coreStocksEmptyText(core);
  if (empty !== null) {
    return el('div', 'card room-empty room-core-stocks', [
      el('h2', '', '核心股'),
      el('p', '', empty),
      el('p', 'room-caption', '页面只读已发布批次；没有样本时不推算角色。'),
    ]);
  }
  const cards = roleCards(core);
  const timeline = timelineLines(core);
  const lookups = lookupCards(core);
  return el('div', 'card room-card room-core-stocks', [
    el('div', 'card-header', [
      el('div', null, [
        el('h2', '', '核心股角色与时间线'),
        el(
          'div',
          'card-meta',
          `${coreStocksMetaText(core)} · 窗口 ${core.window === 'w5' ? '5 分钟' : '15 分钟'}`,
        ),
      ]),
    ]),
    el('div', 'room-roles', cards.map(roleCardNode)),
    el('div', 'room-core-timeline', [
      el('h3', '', '角色时间线'),
      timeline.length === 0
        ? el('p', 'room-caption', '所选时点内没有角色变化；只呈现事实，不生成事件。')
        : el(
            'ul',
            'room-timeline',
            timeline.map((line) =>
              el('li', `room-timeline-item room-timeline-${line.kind}`, [
                el('div', 'room-timeline-head', [
                  el('span', 'room-timeline-time', line.time),
                  el('span', 'room-timeline-kind', line.kindLabel),
                  line.roleLabel === null ? null : el('span', 'muted', line.roleLabel),
                ]),
                el('div', 'room-timeline-text', line.text),
                line.evidence.length > 0
                  ? el(
                      'ul',
                      'room-role-evidence',
                      line.evidence.map((text) => el('li', '', text)),
                    )
                  : null,
              ]),
            ),
          ),
    ]),
    el('div', 'room-core-lookups', [
      el('h3', '', '从核心股反查题材'),
      lookups.length === 0
        ? el('p', 'room-caption', '当前没有核心股可反查；角色为空时不伪造题材归属。')
        : el('div', 'room-lookup-list', lookups.map(lookupNode)),
    ]),
    el('details', 'room-detail-notes', [
      el('summary', '', `口径与缺失说明（${(core.notes ?? []).length} 条）`),
      el(
        'ul',
        'room-warnings',
        (core.notes ?? []).map((note) => el('li', '', note)),
      ),
    ]),
  ]);
};

/** 读取核心股；失败返回 null，由调用方保留上次结果或写空态。 */
const fetchCoreStocks = async (params) => {
  const result = await callApi(`/api/market/room/core-stocks${coreStocksQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.coreStocks ?? null) : null;
};

export {
  coreStocksEmptyText,
  coreStocksMetaText,
  coreStocksQuery,
  evidenceText,
  fetchCoreStocks,
  lookupCards,
  renderCoreStocksPane,
  roleCards,
  timelineLines,
};
