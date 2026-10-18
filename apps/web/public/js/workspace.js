import { callApi, getAccountId, getSessionEpoch, randomRequestId } from './api.js';
import {
  ensureChatSession,
  initChat,
  mountChatView,
  refreshChat,
  saveChatView,
  setDiscussionSubjects,
} from './chat.js';
import { openDecisionReview } from './decision-review-ui.js';
import { alertDialog, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  buildPlanRows,
  entryConditionText,
  openTradingPlanDetailByVersionId,
  planActionLabel,
  planRowStatus,
  planVersionId,
} from './trading-plan-panel.js';
import { $, el, fmtDateTime, fmtNum, fmtPct, mount, resultErrorText } from './ui.js';

let version = 0;
let initialized = false;
let currentData = null;
let discussionOrigin = null;
let preparingDraft = null;
let identityVersion = 0;
let discussionVersion = 0;
const selected = new Map();
const captureIdentity = () => {
  const accountId = getAccountId();
  const epoch = getSessionEpoch();
  const revision = identityVersion;
  return () =>
    accountId === getAccountId() && epoch === getSessionEpoch() && revision === identityVersion;
};
const action = (text, onClick, className = 'workspace-action') => {
  const button = el('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
};
const empty = (title, text) =>
  el('div', 'workspace-empty', [el('strong', null, title), el('p', null, text)]);
const failed = (label, result) =>
  empty(
    `${label}暂不可用`,
    `${resultErrorText(result, '读取失败')}。其它已有事实仍可查看，刷新后再核对。`,
  );

const prepareDraft = async (tool, input, userText, subjects = []) => {
  if (preparingDraft) return;
  const draft = {};
  preparingDraft = draft;
  const isCurrent = captureIdentity();
  try {
    if (!(await openWorkspaceDiscussion(subjects)) || !isCurrent()) return;
    const sessionId = await ensureChatSession();
    if (!isCurrent() || sessionId === null) return;
    const result = await callApi('/api/workspace/drafts', {
      method: 'POST',
      body: JSON.stringify({ sessionId, tool, input, userText }),
    });
    if (!isCurrent()) return;
    if (!result.ok) {
      await alertDialog(
        '草案未完成',
        `${resultErrorText(result)}。先核对会话与最新共识，不要重复执行未知操作。`,
      );
      return;
    }
    await refreshChat();
    if (!isCurrent()) return;
    setDiscussionSubjects(subjects);
  } finally {
    if (preparingDraft === draft) preparingDraft = null;
  }
};
const directionSubject = (research, direction) => ({
  ref: { kind: 'investment-direction', id: direction.id, researchId: research.id },
  label: direction.name,
});
const consensusSubject = (consensus) => ({
  ref: { kind: 'investment-consensus', id: consensus.id, version: consensus.version },
  label: `参与共识 v${consensus.version}`,
});
const ROLE_LABELS = { primary: '主要方向', observe: '继续观察', avoid: '暂不参与' };
const INTENT_LABELS = {
  balanced: '均衡研究',
  cautious: '近期谨慎',
  'holdings-first': '持仓优先',
  'pause-new-opportunities': '暂停新机会',
};

const directionCoverageText = (coverage) => {
  if (coverage.kind !== 'market-facts')
    return `覆盖 ${coverage.evaluatedCount}/${coverage.universeCount}；入选 ${coverage.selectedCount}。${coverage.description}`;
  const scope = {
    CN_A_SHARES_SH_SZ: '沪深 A 股市场广度',
    'cn-equity-indexes': 'A 股指数',
    'limit-up-and-broken-board-pools': '涨停与炸板事件池',
  }[coverage.scope];
  const unit = { stocks: '只股票', indexes: '个指数', 'pool-stocks': '只事件池股票' }[
    coverage.unit
  ];
  return `${scope} · ${coverage.observedCount} ${unit} · ${coverage.dataHealth === 'partial' ? '部分数据' : '来源数据完整'}。${coverage.description}`;
};

const requestResearch = async () => {
  const isCurrent = captureIdentity();
  const values = await promptDialog({
    title: '提出方向研究草案',
    fields: [
      {
        key: 'question',
        label: '这次想比较什么方向？',
        value: '比较当前可研究的短线波段参与方向，说明证据、覆盖范围、反对意见、等待和放弃条件。',
        multiline: true,
        rows: 3,
      },
    ],
    confirmLabel: '生成待确认草案',
    note: '确认草案后才使用模型研究。有合格策略时比较策略事实，否则读取可用市场事实；市场方向没有个股映射时不能开启个股跟踪。不会开启持续付费研究或通知。',
  });
  if (!isCurrent() || !values?.question) return;
  await prepareDraft(
    'research_investment_directions',
    { requestId: randomRequestId(), question: values.question },
    values.question,
  );
};

const proposeConsensus = async (investment, selectedDirection) => {
  const isCurrent = captureIdentity();
  const research = investment.research;
  if (research?.status !== 'complete') return;
  const consensus = investment.consensus;
  const firstUntil = research.directions.map((item) => item.validUntil).sort()[0];
  const values = await promptDialog({
    title: '把选择写成共识草案',
    fields: [
      ...research.directions.map((direction, index) => ({
        key: `role${index}`,
        label: direction.name,
        value:
          consensus?.selections.find((item) => item.directionId === direction.id)?.role ??
          (direction.id === selectedDirection?.id ? 'primary' : 'skip'),
        options: [
          { value: 'skip', label: '本轮不纳入' },
          ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
        ],
      })),
      { key: 'reason', label: '你的理由或保留的分歧', multiline: true, rows: 3 },
      { key: 'reviewAt', label: '复核时间（含时区）', value: firstUntil },
      { key: 'validUntil', label: '共识有效至（含时区）', value: firstUntil },
    ],
    confirmLabel: '生成待确认草案',
    note: '这里明确替换方向选择，其它约束和近期意愿保持原值。只影响未来研究；保存后原方向新候选同步暂停，跟踪需另行确认。',
  });
  if (!isCurrent() || !values?.reason) return;
  const selections = research.directions.flatMap((direction, index) =>
    values[`role${index}`] === 'skip'
      ? []
      : [
          {
            researchId: research.id,
            directionId: direction.id,
            role: values[`role${index}`],
            userReason: values.reason,
          },
        ],
  );
  const summary = selections
    .map(
      (selection) =>
        `${research.directions.find((item) => item.id === selection.directionId).name}：${ROLE_LABELS[selection.role]}`,
    )
    .join('；');
  await prepareDraft(
    'save_investment_consensus',
    {
      requestId: randomRequestId(),
      expectedVersion: consensus?.version ?? 0,
      changes: { selections },
      changeNote: values.reason,
      reviewAt: values.reviewAt,
      validUntil: values.validUntil,
    },
    `我的方向选择：${summary || '清空本轮方向'}。理由与分歧：${values.reason}`,
    research.directions
      .filter((direction) => selections.some((item) => item.directionId === direction.id))
      .map((direction) => directionSubject(research, direction)),
  );
};

const proposeIntent = async (investment) => {
  const isCurrent = captureIdentity();
  const consensus = investment.consensus;
  const defaultTime = consensus?.reviewAt ?? new Date(Date.now() + 86400_000).toISOString();
  const values = await promptDialog({
    title: '调整近期意愿',
    fields: [
      {
        key: 'mode',
        label: '本阶段的重点',
        value: investment.effectiveIntent?.mode ?? 'balanced',
        options: Object.entries(INTENT_LABELS).map(([value, label]) => ({ value, label })),
      },
      { key: 'note', label: '你的具体要求', multiline: true, rows: 3 },
      { key: 'startsAt', label: '开始时间（含时区）', value: new Date().toISOString() },
      { key: 'reviewAt', label: '复核时间（含时区）', value: defaultTime },
      {
        key: 'validUntil',
        label: '共识有效至（含时区）',
        value: consensus?.validUntil ?? defaultTime,
      },
    ],
    confirmLabel: '生成待确认草案',
    note: '只修改近期意愿，保留原方向和约束。暂停新机会不会关闭持仓风险监控，也不会放宽已有退出条件。',
  });
  if (!isCurrent() || !values?.note) return;
  await prepareDraft(
    'save_investment_consensus',
    {
      requestId: randomRequestId(),
      expectedVersion: consensus?.version ?? 0,
      changes: {
        recentIntent: {
          mode: values.mode,
          note: values.note,
          startsAt: values.startsAt,
          reviewAt: values.reviewAt,
        },
      },
      changeNote: values.note,
      reviewAt: values.reviewAt,
      validUntil: values.validUntil,
    },
    `${INTENT_LABELS[values.mode]}：${values.note}`,
    consensus ? [consensusSubject(consensus)] : [],
  );
};

const renderInvestment = (data) => {
  const host = $('#workspace-directions');
  const consensusHost = $('#workspace-consensus');
  if (!data.investment?.ok) {
    mount(host, failed('方向与共识', data.investment));
    mount(consensusHost, []);
    return;
  }
  const investment = data.investment.data;
  const research = investment.research;
  if (research === null || research.status !== 'complete') {
    mount(
      host,
      el('div', 'workspace-direction-start', [
        el(
          'span',
          'workspace-state',
          research === null ? '未研究' : research.status === 'failed' ? '研究失败' : '事实不足',
        ),
        el('h3', null, '让方向有依据，也容得下反对意见。'),
        el(
          'p',
          null,
          research === null
            ? '还没有可展示的方向研究。先核对覆盖范围，再讨论取舍；未研究不代表没有机会。'
            : '本次未完成方向判断。保留已有事实，不把失败写成没有机会。',
        ),
        ...(research?.limitations ?? []).map((text) => el('p', 'workspace-caption', text)),
        action('提出研究草案 ↗', () => void requestResearch()),
        action(
          '先聊一聊',
          () => void openWorkspaceDiscussion([], '先说明当前可用的方向研究事实与覆盖范围。'),
          'workspace-action secondary',
        ),
      ]),
    );
  } else {
    const cards = research.directions.map((direction, index) => {
      const card = el('article', 'workspace-card');
      card.id = `workspace-direction-${index}`;
      card.tabIndex = -1;
      card.append(
        el('div', 'workspace-card-top', [
          el(
            'span',
            'workspace-state',
            { prefer: '倾向优先', observe: '继续观察', oppose: '当前反对' }[direction.stance],
          ),
          el('span', 'workspace-card-index', `0${direction.rank}`),
        ]),
        el('h3', null, direction.name),
        el('p', null, direction.rationale),
        el('p', 'workspace-caption', `比较理由：${direction.comparisonReason}`),
        el('p', 'workspace-caption', directionCoverageText(direction.coverage)),
        el(
          'p',
          'workspace-caption',
          `事实截至 ${fmtDateTime(direction.dataAsOf)} / 有效至 ${fmtDateTime(direction.validUntil)} / 观察周期 ${{ short: '短期', medium: '中期', long: '长期' }[direction.horizon]}`,
        ),
      );
      if (direction.opportunityType === 'market-participation')
        card.append(el('p', 'workspace-caption', direction.tracking.reason));
      for (const risk of direction.risks) card.append(el('p', 'workspace-risk', `风险：${risk}`));
      for (const objection of direction.objections)
        card.append(
          el('div', 'workspace-objection', [
            el(
              'strong',
              null,
              `${{ 'known-risk': '有证据的反对', 'missing-evidence': '证据不足', 'plan-conflict': '与计划冲突' }[objection.kind]}：${objection.conclusion}`,
            ),
            ...objection.unknowns.map((text) => el('p', null, `未知：${text}`)),
            ...objection.reconsiderWhen.map((text) => el('p', null, `改变判断的条件：${text}`)),
            ...objection.alternatives.map((text) => el('p', null, `下一步：${text}`)),
          ]),
        );
      card.append(
        el('p', null, `等待：${direction.waitFor.join('；')}`),
        el('p', null, `放弃：${direction.abandonWhen.join('；')}`),
        el('p', 'workspace-caption', `复核：${direction.reviewWhen.join('；')}`),
      );
      const evidence = el('details', 'workspace-evidence', el('summary', null, '查看可回查证据'));
      evidence.append(
        ...research.evidence
          .filter((fact) => direction.evidenceIds.includes(fact.id))
          .map((fact) => {
            const entry = el('div', 'workspace-caption', [
              el('p', null, `${fact.text} / ${fmtDateTime(fact.dataAsOf)} / ${fact.id}`),
            ]);
            if (fact.source?.kind === 'market-snapshot') {
              entry.append(el('p', null, `市场快照：${fact.source.snapshotId}`));
              for (const source of fact.provenance)
                entry.append(
                  el(
                    'p',
                    null,
                    `来源 ${source.provider} · 对应时间 ${fmtDateTime(source.observedAt)} · 获取时间 ${fmtDateTime(source.fetchedAt)}`,
                  ),
                );
            }
            return entry;
          }),
      );
      card.append(
        evidence,
        ...research.disclaimers.map((text) => el('p', 'workspace-caption', text)),
        subjectControls(directionSubject(research, direction), card.id),
        action('写入共识草案', () => void proposeConsensus(investment, direction)),
      );
      return card;
    });
    mount(host, [
      el('div', 'workspace-card-grid', cards),
      el('div', 'workspace-card-actions', [
        action('重新研究（另行确认）', () => void requestResearch(), 'workspace-action secondary'),
        ...research.limitations.map((text) => el('p', 'workspace-caption', text)),
      ]),
    ]);
  }
  const consensus = investment.consensus;
  const tracking = investment.tracking;
  const eligibility = investment.trackingEligibility;
  const content = el('article', 'workspace-consensus-card');
  content.append(
    el('h3', null, consensus ? `当前共识 · v${consensus.version}` : '把当前意愿记下来'),
    el(
      'p',
      'workspace-caption',
      consensus
        ? `状态：${{ confirmed: '已确认', revoked: '已撤销', expired: '已到期', 'review-required': '待复核' }[investment.consensusState]} / 复核于 ${fmtDateTime(consensus.reviewAt)}`
        : '共识独立保存；关闭或删除聊天不会撤销已确认的内容。',
    ),
  );
  if (consensus)
    content.append(
      ...consensus.selections.map((selection) =>
        el(
          'p',
          null,
          `${ROLE_LABELS[selection.role]} · ${selection.direction.name}：${selection.userReason}`,
        ),
      ),
      ...consensus.constraints.map((text) => el('p', 'workspace-caption', `约束：${text}`)),
      el(
        'p',
        null,
        investment.effectiveIntent
          ? `${INTENT_LABELS[investment.effectiveIntent.mode]}：${investment.effectiveIntent.note}`
          : '近期意愿：当前没有生效的临时调整',
      ),
      el(
        'p',
        'workspace-caption',
        `有效至 ${fmtDateTime(consensus.validUntil)}。只影响未来研究；已有持仓与逐股计划单独复核。`,
      ),
      action('围绕共识继续讨论', () => void openWorkspaceDiscussion([consensusSubject(consensus)])),
    );
  content.append(
    action('调整近期意愿', () => void proposeIntent(investment), 'workspace-action secondary'),
  );
  if (consensus) {
    content.append(
      el(
        'p',
        null,
        `共识保存与跟踪分别核对。方向跟踪：${tracking ? { starting: '启动中，需核对实际状态', tracking: '候选同步已连接', partial: '部分可用', failed: '启动失败', paused: '已暂停' }[tracking.status] : '未开启'}`,
      ),
      ...(tracking?.items ?? []).map((item) => el('p', 'workspace-caption', item.reason)),
      el('p', 'workspace-caption', eligibility.reason),
      ...eligibility.unmappedDirections.map((item) => el('p', 'workspace-caption', item.reason)),
    );
    if (tracking?.status !== 'starting' && eligibility.eligible)
      content.append(
        action(
          '连接 / 恢复方向跟踪',
          () =>
            void prepareDraft(
              'set_investment_tracking',
              { requestId: randomRequestId(), expectedVersion: consensus.version, action: 'start' },
              '我希望连接这些已确认方向的候选同步；不开启新的付费研究或通知渠道。',
              [consensusSubject(consensus)],
            ),
        ),
      );
    content.append(
      action(
        '暂停方向候选同步',
        () =>
          void prepareDraft(
            'set_investment_tracking',
            {
              requestId: randomRequestId(),
              expectedVersion: consensus.version,
              action: 'pause',
              ...(tracking?.status === 'starting' ? { recoverAttemptId: tracking.id } : {}),
            },
            '我希望暂停方向新候选同步，保留持仓风险跟踪。',
            [consensusSubject(consensus)],
          ),
        'workspace-action secondary',
      ),
    );
    const history = el(
      'details',
      'workspace-evidence',
      el('summary', null, `共识历史（${investment.history.length} 个版本）`),
    );
    history.append(
      ...investment.history.map((item) =>
        el('div', null, [
          el('p', null, `v${item.version} / ${fmtDateTime(item.createdAt)}：${item.changeNote}`),
          action(
            '讨论该版本',
            () => void openWorkspaceDiscussion([consensusSubject(item)]),
            'workspace-action secondary',
          ),
        ]),
      ),
    );
    content.append(history);
  }
  for (const text of investment.limitations) content.append(el('p', 'workspace-caption', text));
  if (data.candidates?.ok && data.candidates.data.candidates.length > 0) {
    content.append(el('h4', null, '已关联研究候选（排序不等于买入资格）'));
    for (const candidate of data.candidates.data.candidates)
      content.append(
        el('div', 'workspace-candidate', [
          stockIdentityLink({ stockId: candidate.stockId }),
          action(
            '讨论候选与来源',
            () =>
              void openWorkspaceDiscussion(
                [{ ref: { kind: 'stock', id: candidate.stockId }, label: candidate.stockId }],
                `请核对候选 ${candidate.stockId} 的方向来源和证据，正式个股建议仍须独立确认。`,
              ),
            'workspace-action secondary',
          ),
        ]),
      );
    for (const text of data.candidates.data.limitations)
      content.append(el('p', 'workspace-caption', text));
  }
  mount(consensusHost, content);
};

export const workspaceFactSummary = (data) => {
  const holdings = data.holdings.ok
    ? `${data.holdings.data.holdings.length} 只已登记持仓`
    : '持仓读取未完成';
  const plans = data.plans.ok
    ? `${data.plans.data.views?.length ?? data.plans.data.plans.length} 个计划`
    : '计划读取未完成';
  return `事实摘要 · ${holdings} / ${plans}。研究结论请查看方向与共识，未研究不代表没有机会。`;
};

export const openWorkspaceDiscussion = async (subjects = [], question = '', sourceId = '') => {
  const isCurrent = captureIdentity();
  const requestVersion = ++discussionVersion;
  if (!location.hash.startsWith('#dashboard')) {
    location.hash = 'dashboard';
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  if (!isCurrent() || requestVersion !== discussionVersion) return false;
  initChat();
  await refreshChat();
  if (!isCurrent() || requestVersion !== discussionVersion) return false;
  if (!setDiscussionSubjects(subjects)) return false;
  discussionOrigin = { top: window.scrollY, sourceId };
  const host = $('#workspace-discussion');
  if (host === null) return false;
  if (host.hidden)
    history.pushState(
      { ...history.state, workspaceDiscussion: discussionOrigin },
      '',
      '#dashboard?discussion=open',
    );
  host.hidden = false;
  mountChatView('inline');
  if (question.length > 0) $('#chat-input').value = question;
  saveChatView();
  host.scrollIntoView({ block: 'start', behavior: 'instant' });
  $('#chat-input')?.focus({ preventScroll: true });
  return true;
};

const closeDiscussion = () => {
  discussionVersion += 1;
  const host = $('#workspace-discussion');
  if (host !== null) host.hidden = true;
  const origin = discussionOrigin;
  discussionOrigin = null;
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: origin?.top ?? 0, behavior: 'instant' });
    if (origin?.sourceId) $(`#${CSS.escape(origin.sourceId)}`)?.focus({ preventScroll: true });
  });
};

const subjectControls = (subject, sourceId) => {
  const key = JSON.stringify(subject.ref);
  const compare = action(
    selected.has(key) ? '已选比较' : '加入比较',
    () => {
      if (selected.has(key)) selected.delete(key);
      else if (selected.size < 4) selected.set(key, subject);
      compare.textContent = selected.has(key) ? '已选比较' : '加入比较';
      compare.setAttribute('aria-pressed', String(selected.has(key)));
      renderComparison();
    },
    'workspace-action secondary',
  );
  compare.setAttribute('aria-pressed', String(selected.has(key)));
  return el('div', 'workspace-card-actions', [
    action('一起讨论 ↗', () => void openWorkspaceDiscussion([subject], '', sourceId)),
    compare,
  ]);
};
const renderComparison = () => {
  let bar = $('#workspace-comparison');
  if (bar === null) {
    bar = el('div', 'workspace-comparison');
    bar.id = 'workspace-comparison';
    $('#investment-workspace')?.prepend(bar);
  }
  bar.hidden = selected.size === 0;
  mount(bar, [
    el(
      'span',
      null,
      `比较 ${selected.size}/4：${[...selected.values()].map((item) => item.label).join(' / ')}`,
    ),
    action(
      '一起比较',
      () =>
        void openWorkspaceDiscussion(
          [...selected.values()],
          '请比较这些对象，逐项说明证据、差异、风险和未知项，不串用证据。',
        ),
    ),
    action(
      '清空',
      () => {
        selected.clear();
        if (currentData) renderWorkspaceData(currentData);
        renderComparison();
      },
      'workspace-action secondary',
    ),
  ]);
};

const renderHoldings = (data) => {
  const host = $('#workspace-holdings');
  if (!data.holdings.ok) return mount(host, failed('持仓', data.holdings));
  const items = data.holdings.data.holdings;
  const facts = data.facts.ok ? data.facts.data.facts : null;
  const positions = new Map(
    (facts?.positions ?? []).map((position) => [position.stockId, position]),
  );
  if (items.length === 0)
    return mount(
      host,
      empty('还没有登记持仓', '可以先讨论市场方向；涉及你的仓位和资金时，再补齐真实记录。'),
    );
  mount(
    host,
    items.map((item, index) => {
      const holding = item.holding;
      const card = el('article', 'workspace-card');
      card.id = `workspace-holding-${index}`;
      card.tabIndex = -1;
      const position = positions.get(holding.stockId);
      const qualified = facts?.status === 'complete' && position?.price !== undefined;
      const plans = data.plans.ok
        ? data.plans.data.plans.filter((plan) => plan.stockId === holding.stockId)
        : [];
      const subject = {
        ref: { kind: 'holding', id: holding.id, version: item.discussionVersion },
        label: `${item.stockName} · ${holding.stockId}`,
      };
      card.append(
        el('div', 'workspace-card-top', [
          stockIdentityLink({ stockId: holding.stockId, stockName: item.stockName }),
          el('span', 'workspace-card-index', `0${index + 1}`),
        ]),
        el('p', 'workspace-price', qualified ? `¥ ${fmtNum(position.price)}` : '行情待核验'),
        el(
          'p',
          'workspace-caption',
          qualified && item.currentPrice === position.price && item.todayPnlPct !== null
            ? `相对昨收 ${fmtPct(item.todayPnlPct)} · 行情事实`
            : '今日变化尚未完成核验',
        ),
        el(
          'p',
          'workspace-caption',
          qualified
            ? `行情时点 ${fmtDateTime(position.observedAt)}`
            : '缺少合格行情，不展示精确估值与涨跌判断',
        ),
        el(
          'p',
          null,
          plans.length > 0
            ? `关联 ${plans.length} 个计划版本，可结合原条件讨论。`
            : '尚无逐股计划。先核对事实，再讨论是否需要研究。',
        ),
        el(
          'p',
          'workspace-caption',
          `已登记 ${holding.quantity} 股 / 可卖 ${holding.availableQuantity} 股`,
        ),
        subjectControls(subject, card.id),
      );
      if (plans[0] !== undefined)
        card.append(
          action(
            '查看关联计划',
            () => void openTradingPlanDetailByVersionId(planVersionId(plans[0])),
            'workspace-action secondary',
          ),
        );
      return card;
    }),
  );
};

const renderPlans = (data) => {
  const host = $('#workspace-plans');
  if (!data.plans.ok) return mount(host, failed('计划', data.plans));
  const rows = buildPlanRows(
    data.plans.data.plans,
    data.plans.data.monitoring,
    data.plans.data.views,
  );
  if (rows.length === 0)
    return mount(
      host,
      empty(
        '计划从明确判断开始',
        '已有建议与共识会在这里接续。确认方向不等于确认买入，开启跟踪会单独说明结果。',
      ),
    );
  mount(
    host,
    rows.map((row, index) => {
      const plan = row.plan;
      const status = planRowStatus(row);
      const card = el('article', 'workspace-card');
      card.id = `workspace-plan-${index}`;
      card.tabIndex = -1;
      const subject = {
        ref: { kind: 'trading-plan-version', id: planVersionId(plan) },
        label: `${plan.stockId} · 计划 v${plan.version}`,
      };
      card.append(
        el('div', 'workspace-card-top', [
          stockIdentityLink({ stockId: plan.stockId, stockName: plan.stockName }),
          el('span', 'workspace-state', status.label),
        ]),
        el('h3', null, `${planActionLabel(plan.action)} · v${plan.version}`),
        el('p', null, entryConditionText(plan)),
        el('p', 'workspace-caption', row.monitoring?.reason ?? '资格尚未核验'),
        el(
          'p',
          'workspace-caption',
          `有效至 ${fmtDateTime(row.monitoring?.expiresAt ?? plan.validUntil)}`,
        ),
      );
      for (const risk of plan.explanation?.risks ?? [])
        card.append(el('p', 'workspace-risk', `风险：${risk}`));
      for (const counter of plan.explanation?.counterEvidence ?? [])
        card.append(el('p', 'workspace-risk', `反证：${counter}`));
      card.append(
        subjectControls(subject, card.id),
        el('div', 'workspace-card-actions', [
          action(
            '核对完整计划',
            () => void openTradingPlanDetailByVersionId(planVersionId(plan)),
            'workspace-action secondary',
          ),
          action(
            '登记 / 关联实际成交',
            () => void openDecisionReview(subject.ref, { onSaved: renderInvestmentWorkspace }),
            'workspace-action secondary',
          ),
        ]),
        el('p', 'workspace-caption', '监控资格不代表后台已经检查或通知已经送达。'),
      );
      return card;
    }),
  );
};

const renderWorkspaceData = (data) => {
  currentData = data;
  $('#workspace-facts').textContent =
    `${workspaceFactSummary(data)} 读取于 ${fmtDateTime(data.readAt)}`;
  const account = data.account.ok ? data.account.data.account : null;
  const facts = data.facts.ok ? data.facts.data.facts : null;
  const unregistered =
    account !== null &&
    account.initialCapital === 0 &&
    account.cashBalance === 0 &&
    data.holdings.ok &&
    data.holdings.data.holdings.length === 0;
  mount(
    $('#workspace-account'),
    account === null
      ? failed('账户', data.account)
      : el('div', 'workspace-account-line', [
          el('strong', null, account.name),
          el(
            'span',
            null,
            unregistered
              ? '账户尚未核实登记 · 初始零现金不代表真实资金'
              : `已登记现金 ¥ ${fmtNum(account.cashBalance)}`,
          ),
          el(
            'span',
            null,
            facts?.status === 'complete' && !unregistered
              ? `账户事实截至 ${fmtDateTime(facts.asOf)}`
              : '个性化资金与仓位安排需先核对账户事实',
          ),
          el('a', 'workspace-action secondary', '核对账户 →'),
        ]),
  );
  $('#workspace-account a')?.setAttribute('href', '#holdings');
  if (facts?.status === 'unavailable')
    for (const reason of facts.reasons)
      $('#workspace-account').append(el('p', 'workspace-caption', reason));
  renderHoldings(data);
  renderPlans(data);
  renderInvestment(data);
  const latest = data.watch.ok ? data.watch.data.latest : null;
  mount(
    $('#workspace-tracking'),
    el(
      'p',
      'workspace-caption',
      latest
        ? `最近预警运行：${fmtDateTime(latest.finishedAt ?? latest.startedAt)} · ${latest.status}。覆盖范围请核对计划详情；手机送达未获验证。`
        : '尚无可核实的预警运行记录。监控资格与实际后台运行分别展示；当前请在应用内查看。',
    ),
  );
  if (!data.watch.ok) mount($('#workspace-tracking'), failed('后台运行', data.watch));
  const planRun = data.planChecks?.ok ? data.planChecks.data.runs[0] : null;
  if (planRun) {
    const check = planRun.summary?.tradingPlans;
    $('#workspace-tracking').append(
      el(
        'p',
        'workspace-caption',
        check
          ? `逐股计划最近检查 ${fmtDateTime(planRun.finishedAt ?? planRun.startedAt)} / ${planRun.status}：核对 ${check.checkedPlans} 个计划，合格报价 ${check.freshQuotes} 个，过时计划 ${check.stalePlans} 个。`
          : `后台最近运行 ${fmtDateTime(planRun.finishedAt ?? planRun.startedAt)} / ${planRun.status}；没有可核实的逐股计划检查结果。`,
      ),
    );
    for (const reason of check?.errors ?? [])
      $('#workspace-tracking').append(
        el('p', 'workspace-risk', typeof reason === 'string' ? reason : JSON.stringify(reason)),
      );
  }
  const report = data.reports.ok ? data.reports.data.reports[0] : null;
  mount(
    $('#workspace-report'),
    report
      ? el('div', 'workspace-report', [
          el('span', 'workspace-caption', `已有报告 / 事实截至 ${fmtDateTime(report.dataAsOf)}`),
          el('strong', null, report.title),
          action(
            '围绕报告继续讨论 ↗',
            () =>
              void openWorkspaceDiscussion([
                { ref: { kind: 'report', id: report.id }, label: report.title },
              ]),
          ),
        ])
      : [],
  );
};

export const renderInvestmentWorkspace = async () => {
  initInvestmentWorkspace();
  const requestVersion = ++version;
  const accountId = getAccountId();
  const epoch = getSessionEpoch();
  const result = await callApi('/api/workspace');
  if (requestVersion !== version || accountId !== getAccountId() || epoch !== getSessionEpoch())
    return;
  if (!result.ok) {
    $('#workspace-facts').textContent = '首页事实暂未取得。可以查看已有历史；本次没有完成研究。';
    mount($('#workspace-holdings'), failed('首页事实', result));
    return;
  }
  renderWorkspaceData(result.data);
};

export const mountWorkspaceChatRoute = () => {
  mountChatView('full');
  $('#chat-return').hidden = !location.hash.includes('from=workspace');
};

export const initInvestmentWorkspace = () => {
  if (initialized) return;
  initialized = true;
  $('#workspace-date').textContent = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());
  mount(
    $('#workspace-directions'),
    el('div', 'workspace-direction-start', [
      el('span', 'workspace-state', '未研究'),
      el('h3', null, '让方向有依据，也容得下反对意见。'),
      el(
        'p',
        null,
        '还没有可展示的参与方向研究。先确定覆盖范围，再比较证据、风险、等待和放弃条件。',
      ),
      action(
        '开始方向讨论 ↗',
        () =>
          void openWorkspaceDiscussion(
            [],
            '请研究短线波段参与方向，说明真实证据、覆盖范围、反对意见、等待和放弃条件。',
          ),
      ),
    ]),
  );
  $('#workspace-ask')?.addEventListener('click', () => void openWorkspaceDiscussion());
  document.querySelectorAll('[data-workspace-prompt]').forEach((button) => {
    button.addEventListener(
      'click',
      () => void openWorkspaceDiscussion([], button.dataset.workspacePrompt),
    );
  });
  $('#workspace-expand')?.addEventListener('click', () => {
    location.hash = 'chat?from=workspace';
  });
  $('#workspace-close')?.addEventListener('click', () => {
    if (history.state?.workspaceDiscussion) history.back();
    else closeDiscussion();
  });
  $('#chat-return')?.addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => {
    if (!location.hash.startsWith('#dashboard')) return;
    if (history.state?.workspaceDiscussion) {
      discussionOrigin = history.state.workspaceDiscussion;
      $('#workspace-discussion').hidden = false;
      mountChatView('inline');
    } else closeDiscussion();
  });
  document.addEventListener('luoome:identity-cleared', () => {
    version += 1;
    identityVersion += 1;
    discussionVersion += 1;
    preparingDraft = null;
    selected.clear();
    currentData = null;
    closeDiscussion();
    for (const id of [
      'workspace-holdings',
      'workspace-directions',
      'workspace-consensus',
      'workspace-plans',
      'workspace-account',
      'workspace-report',
      'workspace-comparison',
    ])
      $(`#${id}`)?.replaceChildren();
  });
  document.addEventListener('luoome:workspace-updated', () => void renderInvestmentWorkspace());
  if (location.hash.includes('discussion=open')) {
    discussionOrigin = history.state?.workspaceDiscussion ?? null;
    $('#workspace-discussion').hidden = false;
    initChat();
    mountChatView('inline');
    void refreshChat();
  }
};
