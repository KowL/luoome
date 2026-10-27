import { createElement as h, useEffect, useState } from 'react';
import { int, when } from './format.js';
import { Card, Empty, ErrorNote, Pill, Refresh, SkeletonLines } from './primitives.js';
import { strategyText } from './projection.js';
import { useResearchOperation, useResearchRead } from './research-data.js';
import { DefinitionEditor, ResearchField } from './research-editor.js';
import {
  COMPARISON_KINDS,
  DIAGNOSIS_KIND,
  researchFormOf as formOf,
  researchSettingsOf,
  stockIdsFromText,
} from './research-model.js';
import {
  DiagnosisRows,
  ObservationSummary,
  OperationReceipt,
  PreflightFacts,
  ResearchLimitations,
  ResearchPagination,
  ResearchStatus,
  RobustnessFacts,
  RuleEvidence,
  RunComparison,
  StrictBacktests,
  ValidationFacts,
} from './research-results.js';
import {
  operationResult,
  requestResearch,
  researchErrorText,
  researchExportJson,
  researchUrl,
  unwrapResearchResult,
} from './research-transport.js';
import { StockDetail } from './stock.js';

const toolData = (result) => (result?.ok === true ? result.data : null);
const toolError = (result) => (result?.ok === false ? researchErrorText(result.error) : null);
const versionLabel = (version) =>
  version ? `第 ${version.version} 版${version.publishedAt ? ' · 已发布' : ' · 候选'}` : '未选择';
const Button = ({ children, ...props }) =>
  h('button', { type: 'button', className: 'luo-btn', ...props }, children);
const tabs = [
  ['question', '01', '问题与规则'],
  ['compare', '02', '试跑与诊断'],
  ['validation', '03', '分层验证'],
  ['notes', '04', '结论与更新'],
];

function ResearchDiagnosis({ strategy, workspace, trial, versions, onAnalyzeStock }) {
  const [source, setSource] = useState('current');
  const [kind, setKind] = useState('selected');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [stock, setStock] = useState(null);
  const limit = 20;
  const isTrial = source !== 'current';
  const version =
    source === 'base'
      ? versions.find((item) => item.id === trial?.base.run.strategyVersionId)
      : source === 'draft'
        ? versions.find((item) => item.id === trial?.draft.run.strategyVersionId)
        : workspace?.currentRunVersion;
  const run =
    source === 'base'
      ? trial?.base.run
      : source === 'draft'
        ? trial?.draft.run
        : workspace?.currentRun;
  const read = useResearchRead(
    researchUrl('diagnostics', strategy.id, {
      versionId: version?.id,
      runId: run?.id,
      kind,
      query: search.trim(),
      offset,
      limit,
    }),
    undefined,
    { enabled: !isTrial && Boolean(run && version) },
  );
  const persisted = toolData(read.data?.diagnostics);
  const all = isTrial
    ? (trial?.diagnostics?.[source] ?? []).filter(
        (view) => view.kind === kind && (!search || view.result.stockId.includes(search)),
      )
    : [];
  const rows = isTrial ? all.slice(offset, offset + limit) : (persisted?.rows ?? []);
  const total = isTrial ? all.length : (persisted?.total ?? 0);
  const reset = (change) => {
    setOffset(0);
    change();
  };
  useEffect(() => {
    setOffset(0);
  }, [trial]);
  return h(
    Card,
    { title: '选股诊断', meta: run ? `事实时间 ${when(run.dataAsOf)}` : '尚无运行事实' },
    h(
      'div',
      { className: 'luo-research-fields' },
      h(
        ResearchField,
        { label: '诊断来源' },
        h(
          'select',
          { value: source, onChange: (event) => reset(() => setSource(event.target.value)) },
          h('option', { value: 'current' }, '正式运行结果'),
          h('option', { value: 'base', disabled: !trial?.diagnostics }, '本次试跑 · 基线'),
          h('option', { value: 'draft', disabled: !trial?.diagnostics }, '本次试跑 · 候选'),
        ),
      ),
      h(
        ResearchField,
        { label: '分类' },
        h(
          'select',
          { value: kind, onChange: (event) => reset(() => setKind(event.target.value)) },
          Object.entries(DIAGNOSIS_KIND).map(([value, [label]]) =>
            h('option', { key: value, value }, label),
          ),
        ),
      ),
    ),
    h(
      'form',
      {
        className: 'luo-research-search',
        onSubmit: (event) => {
          event.preventDefault();
          reset(() => setSearch(query));
        },
      },
      h(
        ResearchField,
        { label: isTrial ? '股票代码筛选' : '股票代码或名称' },
        h('input', {
          type: 'search',
          value: query,
          maxLength: 100,
          onChange: (event) => setQuery(event.target.value),
          placeholder: '输入后筛选',
        }),
      ),
      h('button', { type: 'submit', className: 'luo-btn', disabled: !run }, '筛选'),
      !isTrial && run ? h(Refresh, { loading: read.loading, onClick: read.refresh }) : null,
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `${versionLabel(version)} · ${isTrial ? '内存试跑，未替换正式结果' : '逐条规则使用保存的运行事实；个股最新行情在详情中另行读取'}`,
    ),
    read.error || (!isTrial && toolError(read.data?.diagnostics))
      ? h(ErrorNote, { error: read.error ?? toolError(read.data?.diagnostics) })
      : null,
    !run
      ? h(Empty, {
          title: '尚无可诊断的运行',
          hint: '选择已保存的候选并完成试跑，或等正式运行产生结果。',
        })
      : !isTrial && read.loading && !persisted
        ? h(SkeletonLines, { lines: 3 })
        : h(DiagnosisRows, { rows, version, onSelectStock: (row) => setStock({ ...row, run }) }),
    run
      ? h(ResearchPagination, {
          offset,
          limit,
          total,
          disabled: !isTrial && read.loading,
          onChange: setOffset,
        })
      : null,
    h(ResearchLimitations, {
      items: isTrial ? trial?.inputIdentity?.limitations : persisted?.warnings,
    }),
    stock
      ? h(StockDetail, {
          key: `${stock.run.id}:${stock.stock.stockId}`,
          stock: stock.stock,
          result: stock.result,
          version: stock.version,
          strategyName: strategyText(strategy.name),
          sourceLabel: isTrial ? '内存试跑诊断' : '正式运行诊断',
          evidence: h(RuleEvidence, { result: stock.result, version: stock.version }),
          onClose: () => setStock(null),
          onAnalyze: () =>
            onAnalyzeStock({
              stockId: stock.stock.stockId,
              stockName: stock.stock.stockName,
              strategyId: strategy.id,
              strategyName: strategy.name,
              runId: stock.run.id,
              version: stock.version.version,
              dataAsOf: stock.run.dataAsOf,
              sourceKind: isTrial ? 'trial' : 'diagnostic',
              selected: stock.result.selected,
              ruleEvaluations: stock.result.ruleEvaluations,
              scoringBreakdown: stock.result.scoringBreakdown,
            }),
        })
      : null,
  );
}

function ResearchWorkbenchBody({
  strategy,
  workspace,
  initialState,
  accountId,
  definitions,
  catalog,
  saved,
  onResearch,
  onManage,
  onAnalyzeStock,
}) {
  const [form, setForm] = useState(() =>
    formOf(initialState, definitions.data.versions, definitions.data.strategy.currentVersionId),
  );
  const [revision, setRevision] = useState(initialState?.revision ?? 0);
  const [savedForm, setSavedForm] = useState(form);
  const [tab, setTab] = useState('question');
  const [definition, setDefinition] = useState(null);
  const [definitionDirty, setDefinitionDirty] = useState(false);
  const [changeSummary, setChangeSummary] = useState('');
  const [trial, setTrial] = useState(null);
  const [robustness, setRobustness] = useState(null);
  const [candidateIds, setCandidateIds] = useState([]);
  const [mode, setMode] = useState('scan');
  const [asOf, setAsOf] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [preflightScope, setPreflightScope] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const versions = definitions.data.versions;
  const currentVersionId = definitions.data.strategy.currentVersionId;
  const baseVersion = versions.find((item) => item.id === form.baseVersionId);
  const candidateVersion = versions.find((item) => item.id === form.candidateVersionId);
  const stockIds = stockIdsFromText(form.stockText);
  const currentPreflightScope = JSON.stringify({
    versionId: candidateVersion?.id ?? baseVersion?.id,
    stockIds,
    from: form.from,
    to: form.to,
    benchmarkStockId: form.benchmarkStockId,
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  const scope = {
    baseVersionId: form.baseVersionId,
    candidateVersionId: form.candidateVersionId,
    trainingSessionId: form.trainingSessionId,
    validationSessionId: form.validationSessionId,
  };
  const contextRead = useResearchRead(researchUrl('context', strategy.id, scope), undefined, {
    enabled: Boolean(baseVersion),
  });
  const context = toolData(contextRead.data?.context);
  const sessions = useResearchRead(researchUrl('sessions', strategy.id));
  const updates = useResearchRead(
    researchUrl('updates', strategy.id, {
      versionId: form.candidateVersionId || form.baseVersionId,
    }),
    undefined,
    { enabled: tab === 'notes' },
  );
  const validation = useResearchRead(
    researchUrl('validation', strategy.id, { sessionId: form.validationSessionId }),
    undefined,
    {
      enabled: Boolean(form.validationSessionId),
      poll: (data) =>
        tab === 'validation' &&
        (data?.worker === 'running' || toolData(data?.session)?.session?.status === 'running'),
    },
  );

  const update = (patch) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setMessage('');
  };
  useEffect(() => {
    if (definitionDirty) return;
    setDefinition(structuredClone((candidateVersion ?? baseVersion)?.definition ?? null));
  }, [candidateVersion, baseVersion, definitionDirty]);

  const operation = useResearchOperation({
    accountId,
    strategyId: strategy.id,
    onCompleted: (receipt, { recovered }) => {
      if (receipt.tool === 'save_strategy_research_state') saved.refresh();
      const data = operationResult(receipt);
      if (!data) return;
      setMessage('已取得操作回执。');
      definitions.refresh();
      contextRead.refresh();
      if (receipt.tool === 'create_strategy_version' && data.version && !recovered) {
        update({ candidateVersionId: data.version.id });
        setDefinitionDirty(false);
        setMessage('候选已保存。请独立校验后再试跑；研究空间的版本选择仍需保存。');
      }
      if (receipt.tool === 'save_strategy_research_state' && data.state && !recovered) {
        const nextForm = formOf(data.state, versions, currentVersionId);
        setForm(nextForm);
        setSavedForm(nextForm);
        setRevision(data.state.revision);
        saved.refresh();
        setMessage('研究问题、范围与结论已保存，可刷新或跨日继续。');
      }
      if (receipt.tool === 'trial_strategy_version') {
        setTrial(data);
        setTab('compare');
      }
      if (receipt.tool === 'run_strategy_research_comparison') {
        setRobustness(data);
        setTab('compare');
      }
      if (data.session && (!recovered || !form.validationSessionId)) {
        update({ validationSessionId: data.session.id });
        sessions.refresh();
        validation.refresh();
      }
    },
  });
  const locked = operation.locked;
  const restored = toolData(saved.data?.state)?.state;
  const newerRevision = restored && restored.revision > revision;
  const restore = () => {
    const next = formOf(restored, versions, currentVersionId);
    setForm(next);
    setSavedForm(next);
    setRevision(restored?.revision ?? 0);
    setDefinitionDirty(false);
    setError(null);
    setMessage('已恢复最近保存的研究与常用设置。');
  };
  const save = () =>
    operation.prepare('save_strategy_research_state', (requestId) => ({
      accountId,
      strategyId: strategy.id,
      expectedRevision: revision,
      requestId,
      state: researchSettingsOf(form),
    }));
  const checkData = async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const data = await requestResearch(
        researchUrl('preflight', strategy.id, {
          versionId: candidateVersion?.id ?? baseVersion?.id,
          from: form.from,
          to: form.to,
          stockIds: stockIds.join(','),
          benchmarkStockId: form.benchmarkStockId,
        }),
      );
      setPreflight(unwrapResearchResult(data.preflight));
      setPreflightScope(currentPreflightScope);
    } catch (failure) {
      setError(researchErrorText(failure));
    } finally {
      setChecking(false);
    }
  };
  const research = async (intent) => {
    setError(null);
    try {
      const request = onResearch(strategy.id, workspace?.currentRun?.id ?? null, {
        strategyName: strategy.name,
        version: (candidateVersion ?? baseVersion)?.version,
        dataAsOf: workspace?.currentRun?.dataAsOf,
        runVersion: workspace?.currentRunVersion?.version,
        question: form.question,
        intent,
        accountId,
        baseVersionId: form.baseVersionId,
        candidateVersionId: form.candidateVersionId,
        baseVersion: baseVersion?.version,
        candidateVersion: candidateVersion?.version,
        researchRevision: revision,
        trainingSessionId: form.trainingSessionId,
        validationSessionId: form.validationSessionId,
        stockIds,
        from: form.from,
        to: form.to,
        benchmarkStockId: form.benchmarkStockId,
        nextStep: form.nextStep,
        definition: definitionDirty ? definition : undefined,
      });
      const result = await request?.completion;
      if (result?.ok === false) setError('研究草稿未能放入对话，请保留当前工作台并重试。');
      else setMessage('已将当前问题与固定版本放入对话草稿，请过目后发送。');
    } catch {
      setError('研究草稿未能放入对话，请保留当前工作台并重试。');
    }
  };
  const trialInput = {
    strategyId: strategy.id,
    baseVersionId: form.baseVersionId,
    draftVersionId: form.candidateVersionId,
    stockIds,
    mode,
    ...(mode === 'replay' && asOf ? { asOf: `${asOf}T15:00:00+08:00` } : {}),
  };
  const trialReady =
    candidateVersion?.validationStatus === 'valid' &&
    baseVersion?.validationStatus === 'valid' &&
    candidateVersion.id !== baseVersion.id &&
    stockIds.length > 0 &&
    stockIds.length <= 500 &&
    (mode !== 'replay' || asOf);
  const validationSession = toolData(validation.data?.session)?.session;
  const sessionList = (toolData(sessions.data?.sessions)?.sessions ?? []).map((session) =>
    session.id === validationSession?.id ? validationSession : session,
  );
  const continuity = updates.data?.continuity;
  const comparison = toolData(updates.data?.comparison);
  const allowedVersionIds = new Set([form.baseVersionId, form.candidateVersionId]);
  const references = [
    ...[baseVersion, candidateVersion].filter(Boolean).map((version) => ({
      id: `strategy-version:${version.id}`,
      label: `${versionLabel(version)} · 不可变规则定义`,
    })),
    ...sessionList
      .filter((session) => allowedVersionIds.has(session.strategyVersionId))
      .map((session) => ({
        id: `strategy-evaluation:${session.id}`,
        label: `${when(session.from)} → ${when(session.to)} · 历史评估`,
      })),
    ...(context?.strictBacktests ?? []).map((run) => ({
      id: `strict-backtest:${run.id}`,
      label: `${when(run.spec.from)} → ${when(run.spec.to)} · 严格回测审计`,
    })),
    ...(context?.realObservations.observationIds ?? []).map((id, index) => ({
      id: `signal-observation:${id}`,
      label: `真实观察证据 ${index + 1}`,
    })),
  ];
  const referenceChoices = [
    ...references,
    ...form.evidenceReferences
      .filter((id) => !references.some((item) => item.id === id))
      .map((id) => ({ id, label: '前次研究的历史引用 · 换版后需重新核对' })),
  ];

  return h(
    'section',
    {
      className: 'luo-research-workbench',
      'aria-labelledby': 'luo-research-title',
      'data-research-workbench': strategy.id,
    },
    h(
      'header',
      { className: 'luo-research-head' },
      h(
        'div',
        null,
        h('p', { className: 'luo-eyebrow' }, 'Strategy research'),
        h('h3', { id: 'luo-research-title' }, '实验工作台'),
        h('p', { className: 'luo-fine' }, '把一个问题变成可核对的规则、对照和研究记录。'),
      ),
      h(
        Pill,
        { tone: dirty || definitionDirty ? 'warn' : 'quiet' },
        dirty || definitionDirty
          ? '页面修改未保存'
          : revision
            ? `已恢复第 ${revision} 次保存`
            : '尚未保存研究',
      ),
    ),
    h(
      'div',
      { className: 'luo-research-binding' },
      h('span', null, `基线 ${versionLabel(baseVersion)}`),
      h('span', null, `候选 ${versionLabel(candidateVersion)}`),
      h(
        Button,
        { onClick: () => research('继续当前研究，核对当前基线、候选与保存状态。') },
        '在对话中继续研究',
      ),
      h(Button, { disabled: saved.loading, onClick: saved.refresh }, '读取已保存修订'),
    ),
    saved.error ? h(ErrorNote, { error: saved.error }) : null,
    baseVersion && currentVersionId && baseVersion.id !== currentVersionId
      ? h(
          'p',
          { className: 'luo-err' },
          '正式策略已更新，当前研究仍绑定原基线。请核对差异后显式选择是否更换，页面不会自动换版。',
        )
      : null,
    newerRevision
      ? h(
          'p',
          { className: 'luo-err' },
          '服务端已有更新的研究修订。请恢复最新记录并合并修改后再保存。',
        )
      : null,
    h(
      'nav',
      { className: 'luo-research-tabs', 'aria-label': '研究步骤' },
      tabs.map(([id, index, title]) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            'aria-current': tab === id ? 'step' : undefined,
            onClick: () => setTab(id),
          },
          h('span', null, index),
          title,
        ),
      ),
    ),
    h(OperationReceipt, { control: operation }),
    message ? h('p', { className: 'luo-fine', role: 'status' }, message) : null,
    error ? h(ErrorNote, { error }) : null,
    tab === 'question'
      ? h(
          'div',
          { className: 'luo-research-stage' },
          h(
            Card,
            { title: '研究问题', meta: '先写能被反证的假设' },
            h(
              ResearchField,
              { label: '这次只想验证什么', wide: true },
              h('textarea', {
                rows: 3,
                maxLength: 2000,
                value: form.question,
                disabled: locked,
                placeholder: '例如：提高量比门槛后，是否减少弱势入选，同时保留原有强势样本？',
                onChange: (event) => update({ question: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'luo-research-fields' },
              h(
                ResearchField,
                { label: '基线版本' },
                h(
                  'select',
                  {
                    value: form.baseVersionId,
                    disabled: locked || definitionDirty,
                    onChange: (event) => update({ baseVersionId: event.target.value }),
                  },
                  versions.map((version) =>
                    h('option', { key: version.id, value: version.id }, versionLabel(version)),
                  ),
                ),
              ),
              h(
                ResearchField,
                { label: '候选版本' },
                h(
                  'select',
                  {
                    value: form.candidateVersionId,
                    disabled: locked || definitionDirty,
                    onChange: (event) => update({ candidateVersionId: event.target.value }),
                  },
                  h('option', { value: '' }, '从基线起草新候选'),
                  versions
                    .filter((version) => version.id !== form.baseVersionId)
                    .map((version) =>
                      h(
                        'option',
                        { key: version.id, value: version.id },
                        `${versionLabel(version)}${version.validationStatus === 'valid' ? ' · 已校验' : ' · 待校验'}`,
                      ),
                    ),
                ),
              ),
            ),
            h(
              'p',
              { className: 'luo-fine' },
              '基线与候选固定到不可变版本。改变范围或参数后，需要重新预检与试跑。',
            ),
          ),
          h(
            Card,
            { title: '样本、区间与基准', meta: `${int(stockIds.length)} 只显式样本` },
            h(
              ResearchField,
              {
                label: '股票范围',
                wide: true,
                hint: '沪深 A 股完整代码，用逗号、空格或换行分隔。试跑必须显式选择 1–500 只；历史范围留空时使用当时的 PIT 股票集合。',
              },
              h('textarea', {
                rows: 2,
                value: form.stockText,
                disabled: locked,
                onChange: (event) => update({ stockText: event.target.value }),
                placeholder: '600519.SH、000001.SZ',
              }),
            ),
            h(
              'div',
              { className: 'luo-research-fields' },
              h(
                ResearchField,
                { label: '区间开始' },
                h('input', {
                  type: 'date',
                  value: form.from,
                  disabled: locked,
                  onChange: (event) => update({ from: event.target.value }),
                }),
              ),
              h(
                ResearchField,
                { label: '区间结束' },
                h('input', {
                  type: 'date',
                  value: form.to,
                  disabled: locked,
                  onChange: (event) => update({ to: event.target.value }),
                }),
              ),
              h(
                ResearchField,
                { label: '基准标的', hint: '填入已有本地历史的完整代码；缺基准时不展示超额收益。' },
                h('input', {
                  value: form.benchmarkStockId,
                  disabled: locked,
                  maxLength: 12,
                  placeholder: '完整证券代码',
                  onChange: (event) => update({ benchmarkStockId: event.target.value }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'luo-actions' },
              h(
                Button,
                {
                  disabled:
                    locked ||
                    checking ||
                    !baseVersion ||
                    !form.from ||
                    !form.to ||
                    form.from > form.to ||
                    stockIds.length > 500,
                  onClick: checkData,
                },
                checking ? '检查本地数据…' : '检查数据资格',
              ),
              h(Button, { disabled: locked, onClick: restore }, '恢复上次保存的设置'),
            ),
            preflight
              ? h(
                  'div',
                  null,
                  preflightScope !== currentPreflightScope
                    ? h(
                        'p',
                        { className: 'luo-err' },
                        '下方预检对应先前版本或范围。当前设置已改变，请重新检查。',
                      )
                    : null,
                  h(PreflightFacts, { preflight }),
                )
              : h(
                  'p',
                  { className: 'luo-fine' },
                  '尚未检查。实时试跑、历史评估与严格回测的数据资格各自判断。',
                ),
          ),
          h(
            Card,
            {
              title: '候选规则与参数',
              meta: definitionDirty
                ? '修改仅在页面内'
                : versionLabel(candidateVersion ?? baseVersion),
            },
            h(DefinitionEditor, {
              definition,
              catalog: catalog.data,
              disabled: locked || strategy.owner === 'builtin',
              onChange: (next) => {
                setDefinition(next);
                setDefinitionDirty(true);
              },
            }),
            catalog.error ? h(ErrorNote, { error: catalog.error }) : null,
            h(
              ResearchField,
              { label: '这次改动的理由', wide: true },
              h('input', {
                value: changeSummary,
                disabled: locked,
                maxLength: 500,
                onChange: (event) => setChangeSummary(event.target.value),
                placeholder: '只改一个主要假设，并说明预计影响',
              }),
            ),
            h(
              'div',
              { className: 'luo-actions' },
              h(
                Button,
                {
                  disabled:
                    locked ||
                    !definition ||
                    !definitionDirty ||
                    !changeSummary.trim() ||
                    strategy.owner === 'builtin',
                  onClick: () =>
                    operation.prepare('create_strategy_version', {
                      strategyId: strategy.id,
                      parentVersionId: form.baseVersionId,
                      definition,
                      changeSummary: changeSummary.trim(),
                    }),
                },
                '保存为新候选版本',
              ),
              h(
                Button,
                {
                  disabled: locked || !candidateVersion || definitionDirty,
                  onClick: () =>
                    operation.prepare('validate_strategy_version', {
                      strategyId: strategy.id,
                      versionId: candidateVersion.id,
                    }),
                },
                '校验已保存候选',
              ),
              definitionDirty
                ? h(
                    Button,
                    { disabled: locked, onClick: () => setDefinitionDirty(false) },
                    '丢弃页面规则修改',
                  )
                : null,
            ),
            candidateVersion?.validationErrors?.length
              ? h(ResearchLimitations, {
                  title: '候选校验问题',
                  items: candidateVersion.validationErrors,
                })
              : null,
            strategy.owner === 'builtin'
              ? h(
                  'p',
                  { className: 'luo-fine' },
                  '内置策略可查看；在对话中确认复制为个人策略后再修改。',
                )
              : null,
          ),
        )
      : null,
    tab === 'compare'
      ? h(
          'div',
          { className: 'luo-research-stage' },
          h(
            Card,
            { title: '同快照试跑', meta: '1–500 只 · 不发布正式结果' },
            h('p', { className: 'luo-fine' }, COMPARISON_KINDS.versions.note),
            h(
              'div',
              { className: 'luo-research-fields' },
              h(
                ResearchField,
                { label: '事实来源' },
                h(
                  'select',
                  {
                    value: mode,
                    disabled: locked,
                    onChange: (event) => setMode(event.target.value),
                  },
                  h('option', { value: 'scan' }, '当前可用事实'),
                  h('option', { value: 'replay' }, '指定历史交易日'),
                ),
              ),
              mode === 'replay'
                ? h(
                    ResearchField,
                    { label: '试跑交易日' },
                    h('input', {
                      type: 'date',
                      value: asOf,
                      disabled: locked,
                      onChange: (event) => setAsOf(event.target.value),
                    }),
                  )
                : null,
            ),
            h(
              'p',
              { className: 'luo-fine' },
              `${int(stockIds.length)} 只样本 · ${versionLabel(baseVersion)} → ${versionLabel(candidateVersion)}`,
            ),
            h(
              Button,
              {
                disabled: locked || !trialReady || definitionDirty,
                onClick: () => operation.prepare('trial_strategy_version', trialInput),
              },
              '准备同快照试跑',
            ),
            !trialReady
              ? h(
                  'p',
                  { className: 'luo-fine' },
                  '需选择两个已校验的不同版本及显式样本；历史试跑还需指定交易日。',
                )
              : null,
            trial
              ? h(
                  'div',
                  { className: 'luo-research-snapshot' },
                  h(
                    Pill,
                    { tone: trial.inputIdentity ? 'accent' : 'warn' },
                    trial.inputIdentity
                      ? '共享输入身份已记录'
                      : '缺少共享输入身份，暂不作受控对照结论',
                  ),
                  h(
                    'p',
                    { className: 'luo-fine' },
                    `事实时间 ${when(trial.inputIdentity?.dataAsOf)} · 采集时间 ${when(trial.inputIdentity?.capturedAt)} · 样本 ${int(trial.stockIds.length)} 只`,
                  ),
                  h(
                    'p',
                    { className: 'luo-fine' },
                    `本次结果版本：${versionLabel(versions.find((version) => version.id === trial.base.run.strategyVersionId))} → ${versionLabel(versions.find((version) => version.id === trial.draft.run.strategyVersionId))}`,
                  ),
                  trial.base.run.strategyVersionId !== form.baseVersionId ||
                    trial.draft.run.strategyVersionId !== form.candidateVersionId ||
                    JSON.stringify([...trial.stockIds].sort()) !==
                      JSON.stringify([...stockIds].sort())
                    ? h(
                        'p',
                        { className: 'luo-err' },
                        '当前版本或样本已改变。此处保留的是之前的试跑，请重新对照后再判断当前设置。',
                      )
                    : null,
                  h(
                    'p',
                    { className: 'luo-fine' },
                    '试跑保留在本次操作回执内；它不是历史验证或收益回测。',
                  ),
                  h(ResearchLimitations, { items: trial.inputIdentity?.limitations }),
                )
              : null,
          ),
          trial?.diff
            ? h(RunComparison, {
                title: '本次版本对照',
                diff: trial.diff,
                from: trial.base.run.dataAsOf,
                to: trial.draft.run.dataAsOf,
              })
            : null,
          h(ResearchDiagnosis, {
            strategy,
            workspace,
            trial,
            versions,
            onAnalyzeStock,
          }),
          h(
            Card,
            { title: '小范围稳健性对照', meta: '最多 8 个已保存候选' },
            h(
              'p',
              { className: 'luo-fine' },
              '先把少量参数或规则修改保存为独立候选。对照保留每个候选的成功、失败与限制，不自动挑选最高收益。',
            ),
            h(
              'fieldset',
              { className: 'luo-research-candidates', disabled: locked },
              h('legend', null, '选择候选版本'),
              versions
                .filter((version) => version.id !== baseVersion?.id)
                .map((version) =>
                  h(
                    'label',
                    { key: version.id },
                    h('input', {
                      type: 'checkbox',
                      checked: candidateIds.includes(version.id),
                      disabled: !candidateIds.includes(version.id) && candidateIds.length >= 8,
                      onChange: (event) =>
                        setCandidateIds((previous) =>
                          event.target.checked
                            ? [...previous, version.id]
                            : previous.filter((id) => id !== version.id),
                        ),
                    }),
                    versionLabel(version),
                  ),
                ),
            ),
            h(
              Button,
              {
                disabled:
                  locked ||
                  !baseVersion ||
                  !candidateIds.length ||
                  !stockIds.length ||
                  stockIds.length > 500 ||
                  (mode === 'replay' && !asOf),
                onClick: () =>
                  operation.prepare('run_strategy_research_comparison', {
                    strategyId: strategy.id,
                    baseVersionId: baseVersion.id,
                    candidateVersionIds: candidateIds,
                    stockIds,
                    mode,
                    ...(mode === 'replay' ? { asOf: `${asOf}T15:00:00+08:00` } : {}),
                    ...(form.trainingSessionId && form.validationSessionId
                      ? {
                          trainingSessionId: form.trainingSessionId,
                          validationSessionId: form.validationSessionId,
                        }
                      : {}),
                  }),
              },
              '准备有界候选对照',
            ),
            Boolean(form.trainingSessionId) !== Boolean(form.validationSessionId)
              ? h(
                  'p',
                  { className: 'luo-fine' },
                  '当前只选择了一类历史任务，本次仅比较规则敏感性。同时选择独立训练与验证任务后才会核对隔离；当前不表示样本外验证。',
                )
              : null,
            robustness
              ? h(
                  'div',
                  null,
                  h(RobustnessFacts, { comparison: robustness, versions }),
                  h(
                    Button,
                    {
                      disabled: locked,
                      onClick: () => {
                        update({
                          summary: robustness.candidates
                            .map(
                              (candidate) =>
                                `第 ${versions.find((version) => version.id === candidate.candidateVersionId)?.version ?? '?'} 版：${candidate.status === 'complete' ? '同快照规则对照已执行，仍需独立验证' : `研究失败，${researchErrorText(candidate.error)}`}`,
                            )
                            .join('\n'),
                          outcome: 'inconclusive',
                          limitations: (
                            robustness.record?.limitations ?? robustness.limitations
                          ).join('\n'),
                          comparison: robustness.record,
                          evidenceReferences: [
                            ...new Set([
                              `strategy-version:${robustness.baseVersionId}`,
                              ...robustness.candidates
                                .filter((candidate) =>
                                  allowedVersionIds.has(candidate.candidateVersionId),
                                )
                                .map(
                                  (candidate) => `strategy-version:${candidate.candidateVersionId}`,
                                ),
                            ]),
                          ],
                        });
                        setTab('notes');
                      },
                    },
                    '把对照结果与失败带入结论草稿',
                  ),
                )
              : null,
          ),
          h(
            Card,
            { title: '比较边界' },
            Object.entries(COMPARISON_KINDS).map(([key, item]) =>
              h(
                'p',
                { key, className: 'luo-fine' },
                h('strong', null, `${item.title}：`),
                item.note,
              ),
            ),
          ),
        )
      : null,
    tab === 'validation'
      ? h(
          'div',
          { className: 'luo-research-stage' },
          h(
            Card,
            { title: '四层证据', meta: '每层单独判断' },
            contextRead.error || toolError(contextRead.data?.context)
              ? h(ErrorNote, { error: contextRead.error ?? toolError(contextRead.data?.context) })
              : null,
            h(
              'ol',
              { className: 'luo-evidence-layers' },
              (context?.evidenceLayers ?? []).map((layer) =>
                h(
                  'li',
                  { key: layer.id },
                  h(
                    'div',
                    null,
                    h(
                      'strong',
                      null,
                      {
                        trial: '同快照试跑',
                        'historical-evaluation': '历史选股评估',
                        'strict-backtest': '严格组合回测',
                        'signal-observation': '真实信号观察',
                      }[layer.id],
                    ),
                    h(ResearchStatus, {
                      status:
                        layer.id === 'trial'
                          ? trial
                            ? 'memory-only'
                            : 'not-started'
                          : layer.id === 'historical-evaluation'
                            ? (validationSession?.status ?? layer.status)
                            : layer.status,
                    }),
                  ),
                  h('p', { className: 'luo-fine' }, strategyText(layer.description)),
                ),
              ),
            ),
            !context
              ? h(Empty, {
                  title: '尚未读取到分层证据',
                  hint: '选择版本后刷新；数据不可用不能当作已验证。',
                })
              : null,
            h(ResearchLimitations, { items: context?.limitations }),
          ),
          h(
            Card,
            { title: '历史选股评估', meta: '逐日规则重放，可断点续跑' },
            h(
              'p',
              { className: 'luo-fine' },
              '历史评估统计入选与信号事实。执行结束不代表证据完整，也不产生组合净收益。',
            ),
            h(
              'div',
              { className: 'luo-research-fields' },
              h(
                ResearchField,
                { label: '继续已有验证任务' },
                h(
                  'select',
                  {
                    value: form.validationSessionId,
                    disabled: locked,
                    onChange: (event) => update({ validationSessionId: event.target.value }),
                  },
                  h('option', { value: '' }, '未选择'),
                  sessionList.map((session) =>
                    h(
                      'option',
                      { key: session.id, value: session.id },
                      `${when(session.from)} → ${when(session.to)} · ${versions.find((version) => version.id === session.strategyVersionId)?.version ? `第 ${versions.find((version) => version.id === session.strategyVersionId).version} 版` : '历史版本'} · ${({ running: '进行中', complete: '已结束', failed: '失败', cancelled: '取消' })[session.status] ?? '待核对'}`,
                    ),
                  ),
                ),
              ),
              h(
                ResearchField,
                {
                  label: '独立训练区间（可选）',
                  hint: '训练与验证应使用不同会话、区间与样本隔离；服务端核对。',
                },
                h(
                  'select',
                  {
                    value: form.trainingSessionId,
                    disabled: locked,
                    onChange: (event) => update({ trainingSessionId: event.target.value }),
                  },
                  h('option', { value: '' }, '未配置训练区间'),
                  sessionList
                    .filter((session) => session.id !== form.validationSessionId)
                    .map((session) =>
                      h(
                        'option',
                        { key: session.id, value: session.id },
                        `${when(session.from)} → ${when(session.to)}`,
                      ),
                    ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'luo-actions' },
              h(
                Button,
                {
                  disabled:
                    locked ||
                    !candidateVersion ||
                    candidateVersion.validationStatus !== 'valid' ||
                    !form.from ||
                    !form.to ||
                    form.from > form.to,
                  onClick: () =>
                    research(
                      '请按当前已保存的版本、范围与区间建立或继续历史选股评估，先核对已有 session 防止重复；启动与推进都经原生审批。',
                    ),
                },
                '在对话中讨论验证方案',
              ),
              h(
                Button,
                {
                  disabled:
                    locked ||
                    !candidateVersion ||
                    candidateVersion.validationStatus !== 'valid' ||
                    !form.from ||
                    !form.to ||
                    form.from > form.to ||
                    stockIds.length > 500,
                  onClick: () =>
                    operation.prepare('start_strategy_evaluation_session', (requestId) => ({
                      accountId,
                      requestId,
                      strategyId: strategy.id,
                      versionId: candidateVersion.id,
                      from: form.from,
                      to: form.to,
                      ...(stockIds.length ? { stockIds } : {}),
                    })),
                },
                '准备历史选股评估',
              ),
              h(Refresh, {
                loading: sessions.loading || validation.loading,
                onClick: () => {
                  sessions.refresh();
                  validation.refresh();
                  contextRead.refresh();
                },
              }),
            ),
            sessions.error || toolError(sessions.data?.sessions)
              ? h(ErrorNote, { error: sessions.error ?? toolError(sessions.data?.sessions) })
              : null,
            form.validationSessionId
              ? h(ValidationFacts, {
                  data: validation.data,
                  loading: validation.loading,
                  error: validation.error,
                  operation,
                  strategyId: strategy.id,
                  sessionId: form.validationSessionId,
                })
              : h(Empty, {
                  title: '没有选定历史任务',
                  hint: '已有任务可跨日恢复；新任务需要显式确认。',
                }),
          ),
          h(StrictBacktests, { runs: context?.strictBacktests }),
          h(
            Button,
            {
              onClick: () =>
                research(
                  '请核对当前候选是否具备严格组合回测的数据门禁，逐项报告 PIT、历史修订、费用、滑点、可交易性、公司行动与基准缺口；完整数据可用时再准备需审批的回测操作。',
                ),
            },
            '在对话中核对严格回测门禁',
          ),
          h(ObservationSummary, {
            observations: context?.realObservations,
            version: versions.find((version) => version.id === context?.realObservations.versionId),
          }),
        )
      : null,
    tab === 'notes'
      ? h(
          'div',
          { className: 'luo-research-stage' },
          h(
            Card,
            { title: '结论、失败与下一步', meta: '保存无法支持的假设也有价值' },
            h(
              ResearchField,
              { label: '当前结论', wide: true },
              h('textarea', {
                rows: 4,
                maxLength: 4000,
                value: form.summary,
                disabled: locked,
                onChange: (event) => update({ summary: event.target.value }),
                placeholder: '记录支持或推翻了什么；数据不足时明确写暂不能判断。',
              }),
            ),
            h(
              ResearchField,
              { label: '判断' },
              h(
                'select',
                {
                  value: form.outcome,
                  disabled: locked,
                  onChange: (event) => update({ outcome: event.target.value }),
                },
                h('option', { value: 'inconclusive' }, '证据不足，继续研究'),
                h('option', { value: 'supported' }, '当前证据支持假设'),
                h('option', { value: 'rejected' }, '假设被反证 / 研究失败'),
              ),
            ),
            h(
              ResearchField,
              {
                label: '限制与反证（每行一条）',
                wide: true,
                hint: '保存结论至少记录一条限制；支持假设时还需选择下方可审计证据。',
              },
              h('textarea', {
                rows: 3,
                maxLength: 8000,
                value: form.limitations,
                disabled: locked,
                onChange: (event) => update({ limitations: event.target.value }),
              }),
            ),
            h(
              ResearchField,
              { label: '下一步', wide: true },
              h('textarea', {
                rows: 2,
                maxLength: 2000,
                value: form.nextStep,
                disabled: locked,
                onChange: (event) => update({ nextStep: event.target.value }),
                placeholder: '下一次只改变一个变量，或先补齐哪段事实。',
              }),
            ),
            h(
              'p',
              { className: 'luo-fine' },
              '结论是你的研究记录，不会自动发布策略或生成交易。证据不足不能解释为零收益。',
            ),
            h(
              'fieldset',
              { className: 'luo-research-candidates', disabled: locked },
              h('legend', null, '结论引用的事实'),
              referenceChoices.slice(0, 50).map((reference) =>
                h(
                  'label',
                  { key: reference.id },
                  h('input', {
                    type: 'checkbox',
                    checked: form.evidenceReferences.includes(reference.id),
                    onChange: (event) =>
                      update({
                        evidenceReferences: event.target.checked
                          ? [...form.evidenceReferences, reference.id]
                          : form.evidenceReferences.filter((id) => id !== reference.id),
                      }),
                  }),
                  reference.label,
                ),
              ),
            ),
            referenceChoices.length > 50
              ? h(
                  'p',
                  { className: 'luo-fine' },
                  '此处展示前 50 条证据。完整引用可在对话中核对并保存。',
                )
              : null,
            operation.operation?.result?.ok === false
              ? h(
                  Button,
                  {
                    disabled: locked,
                    onClick: () =>
                      update({
                        summary: `本次研究操作失败：${researchErrorText(operation.operation.result.error)}`,
                        outcome: 'inconclusive',
                        limitations: '操作未产生完整证据，不能据此判断策略有效。',
                      }),
                  },
                  '将本次失败带入结论草稿',
                )
              : null,
          ),
          form.comparison
            ? h(
                Card,
                {
                  title: '本次附带的候选对照',
                  meta: `${int(form.comparison.candidates.length)} 个候选`,
                },
                h(
                  'p',
                  { className: 'luo-fine' },
                  `事实时间 ${when(form.comparison.dataAsOf)}。保存时保留完整候选、失败与限制；变更基线或样本后应重新比较。`,
                ),
                h(
                  Button,
                  { disabled: locked, onClick: () => update({ comparison: undefined }) },
                  '本次不附带对照摘要',
                ),
              )
            : null,
          restored?.conclusions.length
            ? h(
                Card,
                {
                  title: '已保存的研究结论',
                  meta: `${int(restored.conclusions.length)} 条 · 含失败与反证`,
                },
                [...restored.conclusions]
                  .reverse()
                  .slice(0, 20)
                  .map((record) =>
                    h(
                      'details',
                      { key: record.revision, className: 'luo-research-scope' },
                      h(
                        'summary',
                        null,
                        `${{ supported: '证据支持', inconclusive: '尚不能判断', rejected: '假设被反证' }[record.conclusion.outcome]} · ${when(record.recordedAt)}`,
                      ),
                      h(
                        'p',
                        { className: 'luo-fine' },
                        `基线 ${versionLabel(versions.find((version) => version.id === record.baseVersionId))} · 候选 ${versionLabel(versions.find((version) => version.id === record.candidateVersionId))}`,
                      ),
                      h('p', { className: 'luo-rule-expression' }, record.conclusion.summary),
                      h(ResearchLimitations, { items: record.conclusion.limitations }),
                      h(
                        'p',
                        { className: 'luo-fine' },
                        `${int(record.conclusion.evidenceReferences.length)} 条已核对引用`,
                      ),
                    ),
                  ),
              )
            : null,
          restored?.comparisons?.length
            ? h(
                Card,
                {
                  title: '已保存的候选对照',
                  meta: `${int(restored.comparisons.length)} 组 · 保留全部候选与失败`,
                },
                h(
                  'p',
                  { className: 'luo-fine' },
                  '人工保存的对照摘要不包含原始行情包，不能仅凭输入身份当作 PIT 或收益证据。',
                ),
                [...restored.comparisons]
                  .reverse()
                  .slice(0, 20)
                  .map((record, index) =>
                    h(
                      'details',
                      { key: `${record.snapshotHash}:${index}`, className: 'luo-research-scope' },
                      h(
                        'summary',
                        null,
                        `${when(record.dataAsOf)} · ${int(record.candidates.length)} 个候选`,
                      ),
                      record.candidates.map((candidate) =>
                        h(
                          'div',
                          { key: candidate.candidateVersionId, className: 'luo-research-snapshot' },
                          h(
                            'strong',
                            null,
                            versionLabel(
                              versions.find(
                                (version) => version.id === candidate.candidateVersionId,
                              ),
                            ),
                          ),
                          h(ResearchStatus, { status: candidate.status }),
                          candidate.dataHealth
                            ? h(ResearchStatus, { status: candidate.dataHealth })
                            : null,
                          h(
                            'p',
                            { className: 'luo-fine' },
                            `入选 ${int(candidate.selectedCount)} · 缺失 ${int(candidate.missingCount)}`,
                          ),
                          candidate.error
                            ? h('p', { className: 'luo-fine' }, strategyText(candidate.error))
                            : null,
                        ),
                      ),
                      h(ResearchLimitations, { items: record.limitations }),
                    ),
                  ),
              )
            : null,
          h(
            Card,
            {
              title: '持续研究更新',
              meta: h(Refresh, { loading: updates.loading, onClick: updates.refresh }),
            },
            updates.error ? h(ErrorNote, { error: updates.error }) : null,
            continuity
              ? h(
                  'div',
                  null,
                  h(
                    Pill,
                    {
                      tone:
                        continuity.status === 'healthy'
                          ? 'ok'
                          : continuity.status === 'running'
                            ? 'accent'
                            : 'warn',
                    },
                    {
                      disabled: '持续观察未启用',
                      paused: '策略已暂停',
                      'not-configured': '尚未配置',
                      blocked: '授权或任务待补齐',
                      waiting: '等待真实业务回执',
                      running: '正在执行',
                      healthy: '运行事实已核对',
                      partial: '数据部分可用',
                      stale: '事实待更新',
                      unknown: '状态待核对',
                    }[continuity.status],
                  ),
                  h(
                    'p',
                    { className: 'luo-fine' },
                    `事实截止 ${when(continuity.factCutoff)} · 已核对任务 ${int(continuity.tasks.length)} 个`,
                  ),
                  h(ResearchLimitations, {
                    title: '运行核对',
                    items: [...continuity.reasons, ...continuity.limitations],
                  }),
                )
              : h(Empty, { title: '持续运行事实尚未读到' }),
            h(
              Button,
              { onClick: () => onManage(strategy.id, { strategyName: strategy.name }) },
              '在对话中管理持续观察',
            ),
          ),
          comparison?.diff
            ? h(RunComparison, {
                title: '最近跨日选股变化',
                diff: comparison.diff,
                from: comparison.fromRun.dataAsOf,
                to: comparison.toRun.dataAsOf,
              })
            : null,
          toolError(updates.data?.comparison)
            ? h('p', { className: 'luo-fine' }, '当前没有两份可按同口径比较的正式运行。')
            : null,
          h(ObservationSummary, {
            observations: toolData(updates.data?.context)?.realObservations,
            version: versions.find(
              (version) =>
                version.id === toolData(updates.data?.context)?.realObservations.versionId,
            ),
          }),
          h(
            Card,
            { title: '导出研究定义', meta: versionLabel(candidateVersion ?? baseVersion) },
            h(
              'p',
              { className: 'luo-fine' },
              '导出包含不可变定义、能力依赖和证据引用。供应商完整 PIT 数据不随文件提供；导出不代表可在任意环境完全复现。',
            ),
            h(
              Button,
              {
                disabled: checking || !(candidateVersion ?? baseVersion),
                onClick: async () => {
                  setChecking(true);
                  setError(null);
                  try {
                    const data = await requestResearch(
                      researchUrl('manifest', strategy.id, {
                        versionId: (candidateVersion ?? baseVersion).id,
                      }),
                    );
                    const exported = unwrapResearchResult(data.manifest);
                    const url = URL.createObjectURL(
                      new Blob([researchExportJson(exported)], { type: 'application/json' }),
                    );
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `strategy-research-v${(candidateVersion ?? baseVersion).version}.json`;
                    anchor.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    setMessage('研究定义已交给浏览器下载。数据可复现边界保留在导出文件中。');
                  } catch (failure) {
                    setError(researchErrorText(failure));
                  } finally {
                    setChecking(false);
                  }
                },
              },
              '导出 manifest 文件',
            ),
          ),
        )
      : null,
    h(
      'footer',
      { className: 'luo-research-save' },
      h(
        'p',
        { className: 'luo-fine' },
        definitionDirty
          ? '规则修改还未形成候选版本；先保存候选，再保存研究上下文。'
          : '保存问题、版本选择、常用范围与未完成研究。每次保存均需核对确认。',
      ),
      h(
        'div',
        { className: 'luo-actions' },
        h(
          Button,
          {
            disabled:
              locked ||
              !form.question.trim() ||
              !baseVersion ||
              definitionDirty ||
              newerRevision ||
              Boolean(form.from) !== Boolean(form.to) ||
              (form.from && form.to && form.from > form.to) ||
              (form.summary.trim() && !form.limitations.trim()) ||
              (form.summary.trim() &&
                form.outcome === 'supported' &&
                !form.evidenceReferences.length),
            onClick: save,
          },
          '保存研究空间',
        ),
        h(Button, { disabled: locked, onClick: restore }, '恢复已保存研究'),
      ),
    ),
  );
}

export function ResearchWorkbench({ strategy, workspace, onResearch, onManage, onAnalyzeStock }) {
  const saved = useResearchRead(researchUrl('state', strategy.id));
  const definitions = useResearchRead('api/luoome/call', {
    tool: 'get_strategy',
    input: { strategyId: strategy.id },
  });
  const catalog = useResearchRead('api/luoome/call', {
    tool: 'get_strategy_dsl_catalog',
    input: {},
  });
  const stateResult = saved.data?.state;
  if (!definitions.data || stateResult?.ok !== true)
    return h(
      Card,
      {
        title: '实验工作台',
        meta: h(Refresh, {
          loading: saved.loading || definitions.loading,
          onClick: () => {
            saved.refresh();
            definitions.refresh();
            catalog.refresh();
          },
        }),
      },
      saved.loading || definitions.loading
        ? h(SkeletonLines, { lines: 4 })
        : h(Empty, {
            title: '研究空间暂时无法恢复',
            hint: '重试读取后继续；已有正式策略与匹配结果仍可在下方查看。',
          }),
      saved.error || definitions.error || toolError(stateResult)
        ? h(ErrorNote, { error: saved.error ?? definitions.error ?? toolError(stateResult) })
        : null,
    );
  return h(ResearchWorkbenchBody, {
    key: `${saved.data.accountId}:${strategy.id}`,
    strategy,
    workspace,
    initialState: stateResult.data.state,
    accountId: saved.data.accountId,
    definitions,
    catalog,
    saved,
    onResearch,
    onManage,
    onAnalyzeStock,
  });
}

export function ResearchOnboarding({ onResearch }) {
  const read = useResearchRead(researchUrl('onboarding'));
  const [error, setError] = useState(null);
  return h(
    Card,
    {
      title: '开始一项小范围研究',
      meta: h(Refresh, { loading: read.loading, onClick: read.refresh }),
    },
    h(
      'p',
      { className: 'luo-fine' },
      '先提出一个能被事实反驳的问题，再选择规则与样本。初始化只核对现有资料，不会创建示例投资资产或自动任务。',
    ),
    read.data?.steps
      ? h(
          'ol',
          { className: 'luo-evidence-layers' },
          read.data.steps.map((step) =>
            h(
              'li',
              { key: step.action },
              h(
                'div',
                null,
                h('strong', null, step.title),
                step.requiresApproval ? h(Pill, null, '需确认') : null,
              ),
            ),
          ),
        )
      : null,
    read.error || error ? h(ErrorNote, { error: read.error ?? error }) : null,
    h(
      Button,
      {
        onClick: async () => {
          setError(null);
          try {
            const result = await onResearch(null, null, {}).completion;
            if (result?.ok === false) setError('研究草稿未能放入对话，请重试。');
          } catch {
            setError('研究草稿未能放入对话，请重试。');
          }
        },
      },
      '在对话中起草第一项研究',
    ),
  );
}
