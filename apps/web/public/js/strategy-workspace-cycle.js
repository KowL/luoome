import { buildStrategyHash } from './strategy-workspace-route.js';
import {
  badge,
  createFeatureCache,
  el,
  errorText,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  PUBLICATION_STATUS,
  RUN_STATUS,
  stockIdentityLink,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateCycleCache = () => featureCache.clear();

const pct = (value) => (value === undefined ? '--' : `${fmtNum(value * 100, 2)}%`);

const CYCLE_STATUS = {
  complete: ['完整', 'badge-active'],
  pending: ['待观察', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

const cycleLink = (href, label, className = 'btn btn-outline btn-sm') => {
  const link = el('a', className, label);
  link.href = href;
  return link;
};

const observationFactText = (observation) => {
  const values = [
    `收益 ${pct(observation.returnPct)}`,
    `MFE ${pct(observation.maxFavorableExcursionPct)}`,
    `MAE ${pct(observation.maxAdverseExcursionPct)}`,
    `基准 ${observation.benchmarkStatus === 'complete' ? pct(observation.benchmarkReturnPct) : '不可用'}`,
  ];
  return values.join(' · ');
};

const adviceValidityText = (advice) =>
  new Date(advice.validUntil).getTime() < Date.now() ? '已过期' : '有效';

const renderCycleCard = (cycle, strategyId) => {
  const stock = stockIdentityLink({
    stockId: cycle.stockId,
    stockName: cycle.stockId,
    nameStatus: 'unavailable',
  });
  const progress = cycle.observationProgress ?? [];
  const observationsById = new Map((cycle.observations ?? []).map((row) => [row.id, row]));
  const adviceRows = cycle.advices ?? [];
  const tradeRows = cycle.trades ?? [];
  const tradeLinks = cycle.tradeLinks ?? [];
  const insightHref = buildStrategyHash({
    strategyId,
    tab: 'insights',
    scope: 'operational',
    runId: cycle.runId,
  });
  const timeline = el('ol', 'strategy-cycle-timeline', [
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 入选结果'),
        el(
          'span',
          'mono muted',
          `score ${cycle.result.score ?? '--'} · rank ${cycle.result.rank ?? '--'}`,
        ),
      ]),
      el('p', null, 'StrategyResult 已明确入选；以下事实均绑定本次 run。'),
      el('p', 'mono muted', `证据：${(cycle.result.evidence ?? []).join('、') || '无'}`),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / emitted StrategySignal'),
        el('span', 'mono muted', `${(cycle.signals ?? []).length} 条`),
      ]),
      ...((cycle.signals ?? []).length === 0
        ? [el('p', 'placeholder', '本周期没有 emitted signal。')]
        : (cycle.signals ?? []).map((signal) =>
            el('article', 'strategy-cycle-fact-row', [
              el('strong', 'mono', signal.id),
              el('span', null, `${signal.direction} · score ${fmtNum(signal.score)}`),
              el('p', 'muted', (signal.evidence ?? []).join('；')),
            ]),
          )),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-fact', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '事实 / 事后观察'),
        el('span', 'muted', '不是回测'),
      ]),
      el(
        'div',
        'strategy-cycle-horizons',
        ['t1', 't3', 't5'].map((horizon) => {
          const item = progress.find((row) => row.horizon === horizon) ?? {
            horizon,
            status: 'unavailable',
            observationIds: [],
            completeCount: 0,
            pendingCount: 0,
            unavailableCount: 0,
            benchmarkStatus: 'unavailable',
            unavailableReasons: ['尚无观察记录'],
          };
          const facts = (item.observationIds ?? [])
            .map((id) => observationsById.get(id))
            .filter(Boolean);
          return el('article', 'strategy-cycle-horizon', [
            el('div', 'strategy-cycle-stage-head', [
              el('strong', null, horizon.toUpperCase()),
              badge(CYCLE_STATUS[item.status], item.status),
            ]),
            el(
              'p',
              'mono muted',
              `完整 ${item.completeCount ?? 0} · 待观察 ${item.pendingCount ?? 0} · 不可用 ${item.unavailableCount ?? 0}`,
            ),
            ...(facts.length === 0
              ? [el('p', 'muted', item.unavailableReasons?.join('；') || '事实不可用')]
              : facts.map((observation) =>
                  el('p', 'muted', `${observation.id} · ${observationFactText(observation)}`),
                )),
            el(
              'small',
              'muted',
              `benchmark ${item.benchmarkStatus === 'complete' ? '可用' : '不可用'} · due ${fmtDateTime(item.dueAt)}`,
            ),
          ]);
        }),
      ),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-ai', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI 洞察 / 解释'),
        cycleLink(insightHref, '查看事实与 AI 洞察'),
      ]),
      el('p', null, 'AI 洞察只解释已核验事实并保留证据引用；此处不把解释改写成买卖建议。'),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-advice', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', 'AI Advice / 决策快照'),
        cycleLink(`#advice?stockId=${encodeURIComponent(cycle.stockId)}`, '打开 Advice 页面'),
      ]),
      ...(adviceRows.length === 0
        ? [
            el(
              'p',
              'placeholder',
              '本周期没有 Advice；自动生成需要用户显式启用推荐策略且满足生产运行门禁。',
            ),
          ]
        : adviceRows.map((advice) => {
            const trigger = advice.basedOn?.strategy?.recommendationTrigger ?? '--';
            const outcome = advice.outcome;
            const outcomeSummary =
              outcome === undefined
                ? 'Outcome 待回填'
                : [
                    `Outcome ${outcome.outcome}`,
                    ...(outcome.pnl === undefined ? [] : [`PnL ${fmtSigned(outcome.pnl)}`]),
                    ...(outcome.benchmarkPnl === undefined
                      ? []
                      : [`基准 ${fmtSigned(outcome.benchmarkPnl)}`]),
                  ].join(' · ');
            return el('article', 'strategy-cycle-advice-row', [
              el('div', 'strategy-cycle-stage-head', [
                el('strong', null, `${advice.decision} · confidence ${advice.confidence}/100`),
                el('span', 'badge badge-neutral', `阶段 ${trigger}`),
              ]),
              el('p', null, advice.reasoning?.premise ?? '无 Advice premise'),
              el(
                'p',
                'muted',
                `${adviceValidityText(advice)} ${fmtDateTime(advice.validFrom)} → ${fmtDateTime(advice.validUntil)} · ${outcomeSummary}`,
              ),
              ...(outcome?.tradeIds?.length
                ? [el('p', 'mono muted', `显式 Trade IDs：${outcome.tradeIds.join('、')}`)]
                : []),
              cycleLink(
                `#advice?stockId=${encodeURIComponent(cycle.stockId)}`,
                `Advice ${advice.id.slice(0, 10)}…`,
              ),
            ]);
          })),
    ]),
    el('li', 'strategy-cycle-stage strategy-cycle-trade', [
      el('div', 'strategy-cycle-stage-head', [
        el('span', 'strategy-cycle-type', '用户行动 / 显式 Trade'),
        cycleLink('#review', '打开全局复盘'),
      ]),
      ...(tradeRows.length === 0
        ? [
            el(
              'p',
              'placeholder',
              '当前账户没有通过 Advice ID 或 AdviceOutcome.tradeIds 显式关联的 Trade。',
            ),
          ]
        : tradeRows.map((trade) => {
            const links = tradeLinks.filter((link) => link.tradeId === trade.id);
            return el('article', 'strategy-cycle-trade-row', [
              el('strong', 'mono', trade.id),
              el('span', null, `${trade.side} · ${trade.quantity} @ ${trade.price}`),
              el('span', 'muted', fmtDateTime(trade.executedAt)),
              el('small', 'muted', links.map((link) => link.relation).join('、')),
            ]);
          })),
    ]),
  ]);
  const audit = el('details', 'strategy-cycle-audit', [
    el('summary', null, '证据、未知项与限制'),
    el(
      'p',
      'mono muted',
      `factsAsOf ${fmtDateTime(cycle.factsAsOf)} · evidence ${cycle.evidenceIds?.length ?? 0}`,
    ),
    el('p', null, `Evidence IDs：${(cycle.evidenceIds ?? []).join('、') || '无'}`),
    ...(cycle.unknowns?.length
      ? [el('p', 'status warning', `Unknown：${cycle.unknowns.join('；')}`)]
      : []),
    ...(cycle.limitations?.length
      ? [el('p', 'muted', `限制：${cycle.limitations.join('；')}`)]
      : []),
  ]);
  return el('article', 'strategy-cycle-card', [
    el('header', 'strategy-cycle-head', [
      el('div', null, [
        stock,
        el('p', 'mono muted', `run ${cycle.runId} · version ${cycle.strategyVersionId}`),
      ]),
      el('div', 'strategy-cycle-run-meta', [
        badge(RUN_STATUS[cycle.run?.status], cycle.run?.status ?? '--'),
        badge(
          PUBLICATION_STATUS[cycle.run?.publication?.status],
          cycle.run?.publication?.status ?? '--',
        ),
        el('span', 'mono muted', `数据截止 ${fmtDateTime(cycle.run?.dataAsOf)}`),
      ]),
    ]),
    timeline,
    audit,
  ]);
};

export const renderDecisionCycles = async (strategyId, state = {}) => {
  const params = new URLSearchParams({ limit: '50' });
  if (state.runId) params.set('runId', state.runId);
  if (state.stockId) params.set('stockId', state.stockId);
  const result = await cachedGet(
    `/api/strategies/${encodeURIComponent(strategyId)}/decision-cycles?${params.toString()}`,
  );
  if (!result.ok) return el('p', 'status error', errorText(result));
  const payload = result.data;
  const cycles = payload.cycles ?? [];
  const header = el('div', 'strategy-tab-heading', [
    el('div', null, [
      el('span', 'section-kicker', 'DECISION CYCLE'),
      el('h3', null, '策略候选闭环'),
      el(
        'p',
        'muted',
        '按 strategyId + runId + stockId 派生；观察是事后事实，Advice 是可选决策快照。',
      ),
    ]),
    cycleLink('#review', '全局复盘'),
  ]);
  if (cycles.length === 0) {
    return el('div', 'strategy-cycle-grid', [
      header,
      el('div', 'strategy-empty-state', [
        el('strong', null, '暂无可展示的生产候选周期'),
        el(
          'p',
          'muted',
          '仅 published operational run 的 selected StrategyResult 进入闭环；replay、evaluation、withheld 和未发布运行会被排除。',
        ),
        ...(payload.unknowns?.length
          ? [el('p', 'status warning', payload.unknowns.join('；'))]
          : []),
      ]),
    ]);
  }
  return el('div', 'strategy-cycle-grid', [
    header,
    el(
      'p',
      'mono muted',
      `共 ${payload.total} 个周期 · factsAsOf ${fmtDateTime(payload.factsAsOf)} · evidence ${payload.evidenceIds?.length ?? 0}`,
    ),
    ...cycles.map((cycle) => renderCycleCard(cycle, strategyId)),
    ...(payload.limitations?.length
      ? [
          el(
            'div',
            'strategy-health-banner warning',
            payload.limitations.map((item) => el('p', null, item)),
          ),
        ]
      : []),
  ]);
};
