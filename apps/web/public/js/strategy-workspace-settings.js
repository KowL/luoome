import {
  badge,
  callApi,
  closeModal,
  confirmDialog,
  createFeatureCache,
  el,
  errorText,
  fmtDateTime,
  metric,
  post,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateSettingsCache = () => featureCache.clear();

const RECOMMENDATION_POLICY_V2_DEFAULTS = {
  skipExistingHolding: true,
  requireLiquidityFacts: true,
  maxDataAgeTradingDays: 1,
  rejectOnExitSignal: true,
  rejectOnRiskSignal: true,
};

const PREFLIGHT_REASON_LABELS = {
  'run-not-publishable': '运行未达到发布门槛',
  'account-facts-unavailable': '账户事实不可用',
  'candidate-data-unavailable': '候选数据不可用',
  'candidate-data-stale': '候选数据过旧',
  'signal-facts-unavailable': '信号事实不可用',
  'entry-exit-conflict': '入场 / 退出冲突',
  'entry-risk-conflict': '入场 / 风险冲突',
  'exit-risk-conflict': '退出 / 风险冲突',
  'exit-signal': '存在退出信号',
  'risk-signal': '存在风险信号',
  'holding-facts-unavailable': '持仓事实不可用',
  'existing-holding': '已有持仓',
  'same-strategy-duplicate-exposure': '同策略重复暴露',
  'strategy-exposure-facts-unavailable': '策略暴露事实不可用',
  'single-position-exposure-unavailable': '单仓暴露不可用',
  'single-position-exposure-exceeded': '单仓暴露超过阈值',
  'industry-facts-unavailable': '行业事实不可用',
  'industry-exposure-unavailable': '行业暴露不可用',
  'industry-exposure-exceeded': '行业暴露超过阈值',
  'portfolio-valuation-unavailable': '组合估值不可用',
  'liquidity-facts-unavailable': '流动性事实不可用',
  'cooldown-facts-unavailable': '冷却事实不可用',
  cooldown: '冷却中',
};

const PREFLIGHT_STATUS = {
  eligible: ['可进入 Advice 分析', 'badge-active'],
  skipped: ['已跳过', 'badge-important'],
  unavailable: ['事实不可用', 'badge-neutral'],
};

const openVersionEditor = (strategy, latest, setStatus, refresh) => {
  const input = el('textarea', 'strategy-def-input');
  input.rows = 22;
  input.wrap = 'off';
  input.value = JSON.stringify(latest?.definition ?? {}, null, 2);
  const summary = el('input');
  summary.placeholder = '说明本次规则变化';
  const submit = el('button', 'btn btn-primary', '创建草案');
  submit.type = 'button';
  submit.addEventListener('click', async () => {
    let definition;
    try {
      definition = JSON.parse(input.value);
    } catch {
      setStatus('策略定义不是合法 JSON', true);
      return;
    }
    submit.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/versions`, {
      definition,
      changeSummary: summary.value.trim() || 'Web 创建版本草案',
    });
    submit.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    closeModal();
    featureCache.clear();
    setStatus(`v${result.data.version.version} 草案已创建`);
    await refresh();
  });
  openModal(
    `新版本草案 · ${strategy.name}`,
    el('div', 'modal-form', [
      el('p', 'hint', '发布版本不可原地修改；保存会创建新的不可变版本草案。'),
      summary,
      input,
      el('div', 'modal-actions', [submit]),
    ]),
  );
};

const renderPreflightHistory = (history) => {
  const runs = Array.isArray(history?.runs) ? history.runs : [];
  const reasonCounts = Array.isArray(history?.reasonCounts) ? history.reasonCounts : [];
  const limitations = Array.isArray(history?.limitations) ? history.limitations : [];
  const latest = runs[0];
  const limitationText = limitations.join(' ');
  const emptyKind = limitationText.includes('损坏')
    ? 'corrupt'
    : limitationText.includes('旧运行')
      ? 'legacy'
      : 'empty';
  const emptyTitle =
    emptyKind === 'corrupt'
      ? '历史快照损坏'
      : emptyKind === 'legacy'
        ? '只有旧历史'
        : '暂无预检历史';
  const emptyMessage =
    emptyKind === 'corrupt'
      ? '发现的 preflight 快照未通过校验，已保守忽略；这不代表候选全部通过。'
      : emptyKind === 'legacy'
        ? '历史运行没有可读取的 preflight 快照，未用默认值补齐。'
        : '尚未读取到已结束的账户预检运行；未运行不等于全部通过。';

  const reasonRows = reasonCounts.map((item) => {
    const code = String(item.code ?? 'unknown');
    return el('li', 'strategy-preflight-reason-row', [
      el('span', null, PREFLIGHT_REASON_LABELS[code] ?? '未知原因'),
      el('code', 'mono muted', code),
      el('strong', 'mono', String(item.count ?? 0)),
    ]);
  });
  const runRows = runs.map((run, index) =>
    el('li', 'strategy-preflight-run-row', [
      el('span', 'mono muted', `#${index + 1} · ${fmtDateTime(run.finishedAt)}`),
      badge(
        run.workflowStatus === 'succeeded'
          ? ['完成', 'badge-active']
          : run.workflowStatus === 'partial'
            ? ['部分完成', 'badge-important']
            : ['失败', 'badge-pos'],
        run.workflowStatus,
      ),
      el('span', null, `可分析 ${run.eligible} · 跳过 ${run.skipped} · 不可用 ${run.unavailable}`),
    ]),
  );

  const latestContent =
    latest === undefined
      ? el('div', `strategy-preflight-empty strategy-preflight-empty-${emptyKind}`, [
          el('strong', null, emptyTitle),
          el('p', 'muted', emptyMessage),
        ])
      : el('div', 'strategy-preflight-latest', [
          el('div', 'strategy-preflight-latest-head', [
            el('div', null, [
              el('span', 'eyebrow', '最近一次预检'),
              el('strong', null, fmtDateTime(latest.finishedAt)),
            ]),
            el('span', 'mono muted', `运行开始 ${fmtDateTime(latest.startedAt)}`),
          ]),
          el('div', 'strategy-preflight-summary-grid', [
            metric('可进入 Advice 分析', latest.eligible, 'eligible'),
            metric('已跳过', latest.skipped, 'skipped'),
            metric('事实不可用', latest.unavailable, 'unavailable'),
            metric('候选总数', latest.total),
          ]),
          el('div', 'strategy-preflight-detail-grid', [
            el('section', 'strategy-preflight-subpanel', [
              el('div', 'strategy-preflight-subhead', [
                el('h4', null, `最近 ${runs.length} 次原因分布`),
                el('span', 'mono muted', `${reasonRows.length} 类 · ${runs.length} 次`),
              ]),
              ...(reasonRows.length === 0
                ? [el('p', 'placeholder', '本次没有记录阻断原因。')]
                : [el('ul', 'strategy-preflight-reason-list', reasonRows)]),
            ]),
            el('section', 'strategy-preflight-subpanel', [
              el('div', 'strategy-preflight-subhead', [
                el('h4', null, '候选事实'),
                el('span', 'mono muted', `${latest.candidates?.length ?? 0} 行`),
              ]),
              ...(latest.candidates?.length
                ? [
                    el('div', 'strategy-preflight-table-wrap', [
                      el('table', 'strategy-preflight-table', [
                        el('thead', null, [
                          el('tr', null, [
                            el('th', null, '股票'),
                            el('th', null, '资格状态'),
                            el('th', null, '原因 / 审计 code'),
                            el('th', null, '事实数'),
                          ]),
                        ]),
                        el(
                          'tbody',
                          null,
                          latest.candidates.map((candidate) =>
                            el('tr', null, [
                              el('td', null, [
                                el('strong', 'mono', candidate.stockId),
                                el('small', 'muted', fmtDateTime(candidate.evaluatedAt)),
                              ]),
                              el('td', null, [
                                badge(PREFLIGHT_STATUS[candidate.status], candidate.status),
                              ]),
                              el(
                                'td',
                                null,
                                (candidate.reasonCodes ?? []).length === 0
                                  ? el('span', 'muted', '—')
                                  : (candidate.reasonCodes ?? []).map((code) =>
                                      el('span', 'strategy-preflight-reason-chip', [
                                        el(
                                          'span',
                                          null,
                                          PREFLIGHT_REASON_LABELS[code] ?? '未知原因',
                                        ),
                                        el('code', 'mono muted', code),
                                      ]),
                                    ),
                              ),
                              el('td', 'mono', `事实 ${candidate.factCount ?? 0}`),
                            ]),
                          ),
                        ),
                      ]),
                    ]),
                  ]
                : [el('p', 'placeholder', '本次没有候选明细；不补齐默认候选。')]),
            ]),
          ]),
        ]);

  return el('section', 'strategy-schedule-panel strategy-preflight-history', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '最近预检摘要'),
        el(
          'p',
          'muted',
          '只读取已结束 strategy-daily-cycle 快照；不会重跑预检、请求行情或调用 AI。',
        ),
      ]),
      el('span', 'mono muted', `${runs.length} 次可读取运行`),
    ]),
    latestContent,
    ...(runRows.length > 1
      ? [
          el('details', 'strategy-preflight-run-history', [
            el('summary', null, '查看更早的已读取运行'),
            el('ol', null, runRows.slice(1)),
          ]),
        ]
      : []),
    ...(limitations.length > 0
      ? [
          el('div', 'strategy-preflight-limitations', [
            el('strong', null, '读取限制'),
            el(
              'ul',
              null,
              limitations.map((limitation) => el('li', null, limitation)),
            ),
          ]),
        ]
      : []),
  ]);
};

const optionalNumberValue = (input) => {
  const raw = input.value.trim();
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const renderScheduleSettings = (strategy, schedule, setStatus, refresh) => {
  const existingPolicy = schedule?.recommendationPolicy;
  const initialV2 = existingPolicy?.schemaVersion === 2;
  let policyVersion = initialV2 ? 'v2' : 'v1';
  let v2Values = {
    ...RECOMMENDATION_POLICY_V2_DEFAULTS,
    ...(initialV2 ? existingPolicy.portfolioPreflight : {}),
  };
  const cron = el('input');
  cron.id = 'strategy-schedule-cron';
  cron.value = schedule?.cron ?? '0 18 * * 1-5';
  cron.placeholder = '0 18 * * 1-5';
  const timezone = el('input');
  timezone.id = 'strategy-schedule-timezone';
  timezone.value = schedule?.timezone ?? 'Asia/Shanghai';
  const enabled = el('input');
  enabled.id = 'strategy-schedule-enabled';
  enabled.type = 'checkbox';
  enabled.checked = schedule?.enabled ?? true;
  const recommendationEnabled = el('input');
  recommendationEnabled.id = 'strategy-recommendation-enabled';
  recommendationEnabled.type = 'checkbox';
  recommendationEnabled.checked = existingPolicy?.enabled ?? false;
  const configuredHorizons = Array.isArray(existingPolicy?.observationHorizons)
    ? existingPolicy.observationHorizons
    : ['t3', 't5'];
  const observationHorizons = ['t1', 't3', 't5'].map((horizon) => {
    const input = el('input');
    input.type = 'checkbox';
    input.value = horizon;
    input.checked = configuredHorizons.includes(horizon);
    return { horizon, input };
  });
  const minScore = el('input');
  minScore.type = 'number';
  minScore.min = '0';
  minScore.max = '100';
  minScore.value = String(existingPolicy?.minScore ?? 70);
  const maxRank = el('input');
  maxRank.type = 'number';
  maxRank.min = '1';
  maxRank.max = '200';
  maxRank.value = String(existingPolicy?.maxRank ?? 10);
  const maxPerRun = el('input');
  maxPerRun.type = 'number';
  maxPerRun.min = '1';
  maxPerRun.max = '20';
  maxPerRun.value = String(existingPolicy?.maxPerRun ?? 3);
  const cooldownHours = el('input');
  cooldownHours.type = 'number';
  cooldownHours.min = '1';
  cooldownHours.max = '720';
  cooldownHours.value = String(existingPolicy?.cooldownHours ?? 72);
  const notify = el('input');
  notify.type = 'checkbox';
  notify.checked = existingPolicy?.notify ?? true;
  const channel = el('select');
  for (const [value, label] of [
    ['log', '站内日志'],
    ['feishu', '飞书'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    channel.append(option);
  }
  channel.value = existingPolicy?.channel ?? 'log';

  const policyBadge = el('span', 'badge badge-neutral', 'Legacy V1');
  const policyNote = el('span', 'muted', '无 schemaVersion 的存量 policy 按 V1 语义保存。');
  const versionAction = el('button', 'btn btn-outline btn-sm', '启用账户预检 V2');
  versionAction.type = 'button';
  const preflightParameters = el('div', 'strategy-preflight-parameters');
  let preflightControls;

  const checkboxControl = (id, checked) => {
    const input = el('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked === true;
    return input;
  };
  const numberControl = (id, value, { min = '0', max = '100', step = '0.1' } = {}) => {
    const input = el('input');
    input.id = id;
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.placeholder = '留空表示不启用';
    input.value = value === undefined ? '' : String(value);
    return input;
  };
  const checkboxLabel = (input, label, note) => {
    const node = el('label', 'strategy-preflight-toggle');
    node.htmlFor = input.id;
    node.append(input, el('span', null, label));
    if (note !== undefined) node.append(el('small', 'muted', note));
    return node;
  };
  const numberLabel = (input, label, note) => {
    const node = el('label', 'strategy-preflight-number');
    node.htmlFor = input.id;
    node.append(el('span', null, label), input);
    if (note !== undefined) node.append(el('small', 'muted', note));
    return node;
  };
  const preflightGroup = (title, key, controls) =>
    el('fieldset', 'strategy-preflight-group', [
      el('legend', null, title),
      el('p', 'muted', key),
      ...controls,
    ]);
  const readPreflightValues = () => {
    if (preflightControls === undefined) return v2Values;
    return {
      maxSinglePositionExposurePct: optionalNumberValue(
        preflightControls.maxSinglePositionExposurePct,
      ),
      maxIndustryExposurePct: optionalNumberValue(preflightControls.maxIndustryExposurePct),
      skipExistingHolding: preflightControls.skipExistingHolding.checked,
      requireLiquidityFacts: preflightControls.requireLiquidityFacts.checked,
      maxDataAgeTradingDays: Number(preflightControls.maxDataAgeTradingDays.value),
      rejectOnExitSignal: preflightControls.rejectOnExitSignal.checked,
      rejectOnRiskSignal: preflightControls.rejectOnRiskSignal.checked,
    };
  };
  const showLockedPreflight = () => {
    preflightControls = undefined;
    preflightParameters.replaceChildren(
      el('div', 'strategy-preflight-locked', [
        el('strong', null, '账户级预检未启用'),
        el(
          'p',
          'muted',
          'Legacy V1 不读取账户门禁；点击上方动作并确认后，才会显示并保存 V2 参数。',
        ),
      ]),
    );
  };
  const ensurePreflightControls = () => {
    if (preflightControls !== undefined) return;
    const skipExistingHolding = checkboxControl(
      'strategy-preflight-skip-existing-holding',
      v2Values.skipExistingHolding,
    );
    const requireLiquidityFacts = checkboxControl(
      'strategy-preflight-require-liquidity-facts',
      v2Values.requireLiquidityFacts,
    );
    const maxDataAgeTradingDays = numberControl(
      'strategy-preflight-max-data-age',
      v2Values.maxDataAgeTradingDays,
      { min: '0', max: '30', step: '1' },
    );
    maxDataAgeTradingDays.placeholder = '必填：0–30 的整数';
    const rejectOnExitSignal = checkboxControl(
      'strategy-preflight-reject-exit',
      v2Values.rejectOnExitSignal,
    );
    const rejectOnRiskSignal = checkboxControl(
      'strategy-preflight-reject-risk',
      v2Values.rejectOnRiskSignal,
    );
    const maxSinglePositionExposurePct = numberControl(
      'strategy-preflight-max-single-exposure',
      v2Values.maxSinglePositionExposurePct,
    );
    const maxIndustryExposurePct = numberControl(
      'strategy-preflight-max-industry-exposure',
      v2Values.maxIndustryExposurePct,
    );
    preflightControls = {
      maxSinglePositionExposurePct,
      maxIndustryExposurePct,
      skipExistingHolding,
      requireLiquidityFacts,
      maxDataAgeTradingDays,
      rejectOnExitSignal,
      rejectOnRiskSignal,
    };
    preflightParameters.replaceChildren(
      el(
        'p',
        'strategy-preflight-intro',
        'V2 在 Advice 分析前增加确定性账户门禁；缺失事实会保持不可用，不会猜测为安全。',
      ),
      el('div', 'strategy-preflight-grid', [
        preflightGroup('候选资格', '按持仓事实决定是否跳过候选。', [
          checkboxLabel(skipExistingHolding, '跳过已有持仓', '默认开启'),
        ]),
        preflightGroup('账户暴露', '空阈值不启用检查，保存时不会写入 0。', [
          numberLabel(maxSinglePositionExposurePct, '单仓暴露上限 (%)', '可选 · 0–100'),
          numberLabel(maxIndustryExposurePct, '行业暴露上限 (%)', '可选 · 0–100'),
        ]),
        preflightGroup('信号冲突', '遇到明确的退出或风险信号时阻断进入分析。', [
          checkboxLabel(rejectOnExitSignal, '拒绝退出信号', '默认开启'),
          checkboxLabel(rejectOnRiskSignal, '拒绝风险信号', '默认开启'),
        ]),
        preflightGroup('数据质量', '只接受指定新鲜度和流动性事实。', [
          checkboxLabel(requireLiquidityFacts, '要求流动性事实', '默认开启'),
          numberLabel(maxDataAgeTradingDays, '最大数据年龄（交易日）', '必填 · 0–30 的整数'),
        ]),
      ]),
    );
  };

  const updatePolicyVersionUi = () => {
    const v2 = policyVersion === 'v2';
    policyBadge.className = `badge ${v2 ? 'badge-active' : 'badge-neutral'}`;
    policyBadge.textContent = v2 ? 'Account-gated V2' : 'Legacy V1';
    policyNote.textContent = v2
      ? '保存会写入完整 schemaVersion=2 与 portfolioPreflight。'
      : '无 schemaVersion 的存量 policy 按 V1 语义保存，不会静默升级。';
    versionAction.textContent = v2 ? '切回 Legacy V1' : '启用账户预检 V2';
    if (v2) ensurePreflightControls();
    else showLockedPreflight();
  };
  updatePolicyVersionUi();
  versionAction.addEventListener('click', async () => {
    const target = policyVersion === 'v2' ? 'v1' : 'v2';
    const confirmed = await confirmDialog({
      title: target === 'v2' ? '启用账户预检 V2' : '切回 Legacy V1',
      message:
        target === 'v2'
          ? '确认选择 Account-gated V2？保存后将在 Advice 分析前读取账户、暴露、信号和数据质量事实；不会自动交易。'
          : '切回 Legacy V1 会丢弃本次保存的账户预检配置，只保留原有推荐字段。确认继续？',
      confirmLabel: target === 'v2' ? '选择 V2' : '切回 V1',
      danger: target === 'v1',
    });
    if (!confirmed) return;
    if (policyVersion === 'v2') v2Values = readPreflightValues();
    policyVersion = target;
    updatePolicyVersionUi();
    setStatus(
      target === 'v2'
        ? '已选择 Account-gated V2；保存前还会再次确认授权边界。'
        : '已选择 Legacy V1；保存将移除账户预检配置。',
    );
  });

  const buildRecommendationPolicy = () => {
    const base = {
      enabled: recommendationEnabled.checked,
      minScore: Number(minScore.value),
      maxRank: Number(maxRank.value),
      maxPerRun: Number(maxPerRun.value),
      cooldownHours: Number(cooldownHours.value),
      notify: notify.checked,
      channel: channel.value,
      observationHorizons: observationHorizons
        .filter(({ input }) => input.checked)
        .map(({ horizon }) => horizon),
    };
    if (policyVersion !== 'v2') return base;
    const values = readPreflightValues();
    return {
      ...base,
      schemaVersion: 2,
      portfolioPreflight: {
        ...(values.maxIndustryExposurePct === undefined
          ? {}
          : { maxIndustryExposurePct: values.maxIndustryExposurePct }),
        ...(values.maxSinglePositionExposurePct === undefined
          ? {}
          : { maxSinglePositionExposurePct: values.maxSinglePositionExposurePct }),
        skipExistingHolding: values.skipExistingHolding,
        requireLiquidityFacts: values.requireLiquidityFacts,
        maxDataAgeTradingDays: values.maxDataAgeTradingDays,
        rejectOnExitSignal: values.rejectOnExitSignal,
        rejectOnRiskSignal: values.rejectOnRiskSignal,
      },
    };
  };

  const save = el('button', 'btn btn-primary btn-sm', '保存调度');
  save.type = 'button';
  save.disabled = strategy.status !== 'active' || strategy.currentVersionId === undefined;
  const validateRequiredPreflightValues = () => {
    if (policyVersion !== 'v2') return true;
    const input = preflightControls?.maxDataAgeTradingDays;
    const raw = input?.value.trim() ?? '';
    const value = Number(raw);
    if (raw.length === 0 || !Number.isInteger(value) || value < 0 || value > 30) {
      setStatus('最大数据年龄（交易日）必须填写 0–30 之间的整数。', true);
      input?.focus();
      return false;
    }
    return true;
  };
  save.addEventListener('click', async () => {
    if (!validateRequiredPreflightValues()) return;
    if (policyVersion === 'v2') {
      const confirmed = await confirmDialog({
        title: '保存 Account-gated V2',
        message:
          '确认保存完整 V2 账户预检配置？它只决定候选是否进入 Advice 分析，不会发布、下单或自动交易。',
        confirmLabel: '确认保存 V2',
      });
      if (!confirmed) return;
    }
    save.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/schedule`, {
      cron: cron.value.trim(),
      timezone: timezone.value.trim(),
      enabled: enabled.checked,
      recommendationPolicy: buildRecommendationPolicy(),
    });
    save.disabled = false;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    featureCache.clear();
    setStatus(`调度已保存，下次运行 ${fmtDateTime(result.data.schedule.nextRunAt)}`);
    await refresh();
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, '自动调度'),
        el('p', 'muted', '标准 5 段 cron；luoome 运行时每分钟自动检查到期策略。'),
      ]),
      save,
    ]),
    el('div', 'strategy-policy-status', [
      el('div', 'strategy-policy-status-copy', [
        el('span', 'eyebrow', '推荐 policy'),
        policyBadge,
        policyNote,
      ]),
      versionAction,
    ]),
    el('div', 'strategy-schedule-form', [
      el('label', null, ['Cron 表达式', cron]),
      el('label', null, ['时区', timezone]),
      el('label', 'strategy-schedule-toggle', [enabled, '启用']),
      el('label', 'strategy-schedule-toggle', [recommendationEnabled, '自动生成并保存 AI Advice']),
      el('fieldset', 'strategy-recommendation-horizons', [
        el('legend', null, '生成 Advice 的阶段观察'),
        ...observationHorizons.map(({ horizon, input }) =>
          el('label', 'strategy-schedule-toggle', [input, horizon.toUpperCase()]),
        ),
      ]),
      el('label', null, ['最低评分', minScore]),
      el('label', null, ['最高排名', maxRank]),
      el('label', null, ['每轮最多推荐', maxPerRun]),
      el('label', null, ['冷却小时', cooldownHours]),
      el('label', 'strategy-schedule-toggle', [notify, '生成后发送通知（与 Advice 开关独立）']),
      el('label', null, ['通知渠道', channel]),
    ]),
    preflightParameters,
    el('div', 'strategy-recommendation-notice', [
      el('strong', null, '推荐策略授权边界'),
      el('p', null, '仅对 accepted + published operational run 生效。'),
      el('p', null, '勾选的 T+n 观察完成后，系统才会再次生成并保存阶段 Advice。'),
      el('p', null, '不会自动交易；通知开关与 Advice 生成开关相互独立。'),
    ]),
    el(
      'p',
      'mono muted',
      schedule?.nextRunAt
        ? `下次计划 ${fmtDateTime(schedule.nextRunAt)}`
        : '保存后计算下次运行时间；策略暂停时调度会跳过并推进。',
    ),
    ...(save.disabled ? [el('p', 'status warning', '只有已发布且运行中的策略可以启用调度。')] : []),
  ]);
};

const renderStrategyWatchlistSubscriptions = async (strategy, setStatus, refresh) => {
  const [subscriptionsResult, watchlistsResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`),
    cachedGet('/api/watchlists'),
  ]);
  if (!subscriptionsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(subscriptionsResult)),
    ]);
  }
  if (!watchlistsResult.ok) {
    return el('section', 'strategy-schedule-panel', [
      el('h3', null, 'Strategy → Watchlist 订阅'),
      el('p', 'status error', errorText(watchlistsResult)),
    ]);
  }
  const subscriptions = subscriptionsResult.data.subscriptions ?? [];
  const targets = (watchlistsResult.data.items ?? []).filter(
    ({ watchlist }) => watchlist.enabled && watchlist.kind !== 'system',
  );
  const select = el('select');
  for (const { watchlist } of targets) {
    const option = el('option', null, `${watchlist.name} · ${watchlist.id}`);
    option.value = watchlist.id;
    select.append(option);
  }
  const subscribe = el('button', 'btn btn-primary btn-sm', '订阅目标 Watchlist');
  subscribe.type = 'button';
  subscribe.disabled = targets.length === 0;
  subscribe.addEventListener('click', async () => {
    if (select.value.length === 0) return;
    const target = targets.find(({ watchlist }) => watchlist.id === select.value)?.watchlist;
    const confirmed = await confirmDialog({
      title: '订阅 Strategy 输出',
      message: `确认将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? select.value}”？部分数据只会标 stale，试跑/评估/未发布运行不会改变 Watchlist。`,
      confirmLabel: '确认订阅',
    });
    if (!confirmed) return;
    subscribe.disabled = true;
    const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/watchlists`, {
      watchlistId: select.value,
    });
    subscribe.disabled = targets.length === 0;
    if (!result.ok) {
      setStatus(errorText(result), true);
      return;
    }
    featureCache.clear();
    setStatus(result.data.idempotent ? '订阅已存在' : 'Strategy→Watchlist 订阅已创建');
    await refresh();
  });
  const activeRows = subscriptions.map((subscription) => {
    const target = targets.find(({ watchlist }) => watchlist.id === subscription.watchlistId);
    const cancel = el('button', 'btn btn-outline btn-sm', '取消订阅');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: '取消 Strategy 订阅',
        message: `确认停止将 ${strategy.name} 的后续 published operational run 同步到“${target?.name ?? subscription.watchlistId}”？已有 Watchlist 成员和同步历史不会被删除。`,
        confirmLabel: '取消订阅',
      });
      if (!confirmed) return;
      cancel.disabled = true;
      const result = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/watchlists/${encodeURIComponent(subscription.watchlistId)}`,
        { method: 'DELETE', body: '{}' },
      );
      if (!result.ok) {
        cancel.disabled = false;
        setStatus(errorText(result), true);
        return;
      }
      featureCache.clear();
      setStatus('Strategy→Watchlist 订阅已取消');
      await refresh();
    });
    return el('article', 'entity-item', [
      el('div', 'flex gap-2', [
        el('strong', null, target?.name ?? subscription.watchlistId),
        el('span', 'badge badge-active', '同步中'),
      ]),
      el(
        'p',
        'muted',
        `source ${subscription.sourceKey} · 创建于 ${fmtDateTime(subscription.createdAt)}`,
      ),
      cancel,
    ]);
  });
  return el('section', 'strategy-schedule-panel', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('h3', null, 'Strategy → Watchlist 订阅'),
        el(
          'p',
          'muted',
          '必须显式选择目标。只有 published operational run 才会同步；partial 只标 stale，不根据缺失集合退出来源。',
        ),
      ]),
      el('div', 'row-actions', [select, subscribe]),
    ]),
    ...(targets.length === 0 ? [el('p', 'status warning', '没有可订阅的启用 Watchlist。')] : []),
    ...(activeRows.length === 0
      ? [el('p', 'placeholder', '当前没有 active Strategy→Watchlist 订阅。')]
      : [el('div', 'entity-list', activeRows)]),
  ]);
};

export const renderSettings = async (strategyId, setStatus, refresh) => {
  const [result, scheduleResult, preflightHistoryResult] = await Promise.all([
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}`),
    cachedGet(`/api/strategies/${encodeURIComponent(strategyId)}/schedule`),
    cachedGet(
      `/api/strategies/${encodeURIComponent(strategyId)}/recommendation-preflights?limit=10`,
    ),
  ]);
  if (!result.ok) return el('p', 'status error', errorText(result));
  if (!scheduleResult.ok) return el('p', 'status error', errorText(scheduleResult));
  const { strategy, versions } = result.data;
  const subscriptionPanel = await renderStrategyWatchlistSubscriptions(
    strategy,
    setStatus,
    refresh,
  );
  const preflightHistory = preflightHistoryResult.ok
    ? preflightHistoryResult.data
    : {
        runs: [],
        reasonCounts: [],
        limitations: ['预检历史暂时不可读；当前设置仍可保存。'],
      };
  const latest = versions.at(-1);
  const actions = el('div', 'row-actions');
  const create = el('button', 'btn btn-outline btn-sm', '创建新版本');
  create.type = 'button';
  create.addEventListener('click', () => openVersionEditor(strategy, latest, setStatus, refresh));
  actions.append(create);
  if (latest !== undefined && latest.publishedAt === undefined) {
    const validate = el('button', 'btn btn-outline btn-sm', '静态校验');
    validate.type = 'button';
    validate.addEventListener('click', async () => {
      validate.disabled = true;
      const checked = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/validate`, {
        versionId: latest.id,
      });
      validate.disabled = false;
      featureCache.clear();
      setStatus(checked.ok ? '版本校验完成' : errorText(checked), !checked.ok);
      if (checked.ok) await refresh();
    });
    actions.append(validate);
    if (latest.validationStatus === 'valid') {
      const publish = el('button', 'btn btn-primary btn-sm', '发布版本');
      publish.type = 'button';
      publish.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
          title: '发布策略版本',
          message: `确认发布 v${latest.version} 并将其设为当前有效版本？`,
          confirmLabel: '发布',
        });
        if (!confirmed) return;
        publish.disabled = true;
        const published = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/publish`, {
          versionId: latest.id,
        });
        publish.disabled = false;
        featureCache.clear();
        setStatus(published.ok ? '策略版本已发布' : errorText(published), !published.ok);
        if (published.ok) await refresh();
      });
      actions.append(publish);
    }
  }
  if (strategy.status === 'active' || strategy.status === 'paused') {
    const next = strategy.status === 'active' ? 'pause' : 'resume';
    const toggle = el(
      'button',
      'btn btn-outline btn-sm',
      next === 'pause' ? '暂停策略' : '恢复策略',
    );
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      const changed = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/${next}`, {});
      featureCache.clear();
      setStatus(
        changed.ok ? (next === 'pause' ? '策略已暂停' : '策略已恢复') : errorText(changed),
        !changed.ok,
      );
      if (changed.ok) await refresh();
    });
    actions.append(toggle);
  }
  const remove = el('button', 'btn btn-danger btn-sm', '删除策略');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除策略',
      message: `确认删除“${strategy.name}”？版本、调度、运行结果、信号和观察数据都会一并删除，且无法撤销。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    remove.disabled = true;
    const deleted = await callApi(`/api/strategies/${encodeURIComponent(strategy.id)}`, {
      method: 'DELETE',
      body: '{}',
    });
    if (!deleted.ok) {
      remove.disabled = false;
      setStatus(errorText(deleted), true);
      return;
    }
    featureCache.clear();
    setStatus('策略已删除');
    window.location.hash = '#strategies';
  });
  actions.append(remove);
  const versionRows = versions.map((version) =>
    el('article', 'entity-item strategy-version-item', [
      el('div', 'flex gap-2', [
        el('strong', null, `v${version.version}`),
        badge(
          version.validationStatus === 'valid'
            ? ['有效', 'badge-active']
            : version.validationStatus === 'invalid'
              ? ['无效', 'badge-pos']
              : ['待校验', 'badge-neutral'],
          version.validationStatus,
        ),
        ...(version.publishedAt ? [el('span', 'badge badge-active', '已发布')] : []),
      ]),
      el('p', null, version.changeSummary ?? '无变更说明'),
      ...(version.validationErrors ?? []).map((message) => el('p', 'status error', message)),
      el('details', null, [
        el('summary', null, '查看 definition JSON'),
        el('pre', 'strategy-definition-json', JSON.stringify(version.definition, null, 2)),
      ]),
    ]),
  );
  return el('div', null, [
    el('div', 'strategy-tab-heading', [el('h3', null, '版本与运行设置'), actions]),
    ...(versionRows.length === 0
      ? [el('p', 'placeholder', '尚无版本，请创建第一个版本草案。')]
      : versionRows),
    subscriptionPanel,
    el('div', 'strategy-automation-grid', [
      renderScheduleSettings(strategy, scheduleResult.data.schedule, setStatus, refresh),
      renderPreflightHistory(preflightHistory),
    ]),
  ]);
};
