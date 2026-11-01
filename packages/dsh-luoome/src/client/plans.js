// 交易计划面板（task-39 批次 A）。
//
// 纪律：
// - 格式化**复用 `format.js`**、取数**复用 `projection.js` 的 `dataOf`**，不新造第二套。
// - 四要素缺失**只是提示，不阻断保存**：`save_trading_plan` 没有这条硬校验
//   （`trading-plan.ts:100-130` 只拒「事实变化 / active 时事实不完整 / active 时约束未过」）。
// - **并发安全**：`save_trading_plan` 自决策 3-A 起有乐观锁（`expectedRevision`），
//   保存时带「打开时那一版」；冲突工具返回 `actual`，表单保留编辑内容并提示重新核对。
//   `replacedWhileEditing` 作为保存成功后的**事后**版本链核对保留（两层保险）。
import { Fragment, createElement as h, useEffect, useState } from 'react';

import { usePanelState } from './data.js';
import { money, when } from './format.js';
import {
  activeBlockNotice,
  appliedPctFor,
  mergePlanEdit,
  PLAN_FORM_STEPS,
  rangeHint,
  revisionConflictNotice,
  uneditedNotice,
} from './plan-form.js';
import { Card, ErrorNote, Head, Kpi, PanelHealthBadge, Pill, Section } from './primitives.js';
import { dataOf } from './projection.js';

/**
 * 四要素缺项（配置期**提示**用，不是校验）。
 *
 * 四个都在 `TradingPlan` 的既有字段上，**不加新字段**（REQ-M3-09 Q4 的纪律：存量不改）。
 */
export const planGaps = (plan) => {
  if (plan === null || plan === undefined) return [];
  const gaps = [];
  const rules = plan.invalidationRules ?? [];
  const conditions = plan.invalidationConditions ?? [];
  if (rules.length === 0 && conditions.length === 0) gaps.push('失效条件');
  if ((plan.counterEvidence ?? []).length === 0) gaps.push('反证');
  if ((plan.risks ?? []).length === 0) gaps.push('风险');
  if (plan.validUntil === undefined || plan.validUntil === null) gaps.push('有效期');
  return gaps;
};

/**
 * 保存后**事后**发现「我编辑期间被替换」。
 *
 * `save_trading_plan` 没有乐观锁，所以只能靠版本链判断：新版本若 `supersedesVersionId`
 * 不等于我打开时那个版本 id，说明有人在中间插了一版。
 */
export const replacedWhileEditing = ({ openedVersionId, saved }) => {
  if (
    openedVersionId === null ||
    openedVersionId === undefined ||
    saved === null ||
    saved === undefined
  )
    return null;
  const savedVersionId = saved.versionId ?? null;
  if (savedVersionId === null) return null;
  const superseded = saved.supersedesVersionId ?? null;
  // 我打开时那版仍是直接前驱 ⇒ 没有中间版本被跳过。
  if (superseded === null || superseded === openedVersionId) return null;
  return { savedVersionId, superseded, openedVersionId };
};

/** 服务端 Operation 路由只接受这三个动作（`operations.ts:43`）。 */
const operationRequest = async (path, body) => {
  const response = await fetch(`api/luoome/operations/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    // **把结构化 issues 带出来**：工具用 `issues` 承载 `reason`/`actual`，
    // 只抛 message 会让上层只能靠正则猜（Codex 缺陷③）。
    const failure = new Error(
      result.error?.message ?? result.error?.kind ?? `HTTP ${response.status}`,
    );
    failure.issues = Array.isArray(result.error?.issues) ? result.error.issues : [];
    failure.kind = result.error?.kind ?? null;
    throw failure;
  }
  return result.data;
};

/**
 * 走 Operation 通道保存计划（`save_trading_plan` 是 `write`）。
 *
 * ## 服务端的 prepare 实际语义（实测 `operations.test.ts:55`）
 *
 * `POST /operations/prepare` **不是**「只冻结输入、等人确认」：
 * - 若 `prepare` 返回了 `confirmationToken`，服务端**在同一次请求里就 confirm 了**
 *   （`operations.ts:59-72`），响应是**已终结**的 Operation（`state: 'succeeded'`）；
 * - 若 `prepare` 没返回 token（`confirmationToken` 字段缺席），说明它已直接执行完。
 *
 * 也就是说：**客户端发一次 prepare 就够，不需要再发 confirm。**
 * 之前的 `/execute` 是错的（服务端没有这个动作）；但把它换成「prepare 后再 confirm」
 * **同样是错的**——第二次 confirm 打在一个已终结的 Operation 上，只会拿到状态冲突。
 * 这里两种返回形状都处理，不假设只有一种。
 *
 * 回执里的 `versionId` / `supersedesVersionId` 是「事后发现并发」的唯一依据。
 */
export const persistPlan = async ({ plan, expectedRevision }) => {
  const operationId = crypto.randomUUID();
  const operation = await operationRequest('prepare', {
    id: operationId,
    tool: 'save_trading_plan',
    input: {
      plan,
      // 决策 3-A 的乐观锁：声明「我基于哪一版编辑的」。不传 = 不做版本比对。
      ...(expectedRevision === undefined || expectedRevision === null ? {} : { expectedRevision }),
    },
  });

  // 兼容「prepare 只冻结、未执行」的形态：那时才需要显式 confirm。
  const settled =
    operation.state === 'pending' && operation.confirmationToken != null
      ? await operationRequest(`${encodeURIComponent(operationId)}/confirm`, {
          token: operation.confirmationToken,
        })
      : operation;

  // `unknown` 表示「可能已提交但结果未明」：不能当成功，也不能盲目重试。
  if (settled.state !== 'succeeded')
    throw new Error(
      settled.state === 'unknown'
        ? '保存结果尚未明确，请核对计划列表后再决定是否重试（不要直接重复提交）'
        : `保存未成功（${String(settled.state)}）`,
    );
  // 回执形状：`{ versionId, planId, version, supersedesVersionId, status }`。
  return settled.result?.data ?? settled.result ?? {};
};

/**
 * 四步编辑表单（决策 3-C / 外部评审②）。
 *
 * **所有计算都调 `plan-form.js`**，那里再调 core：
 * 区间上限 `tradingPlanRangeWidthCap`、落点 `tradingPlanPickedPct`。
 * 这个组件只负责摆放控件，不做任何数值判断——否则数字会散落成第二份真源。
 */
const PlanForm = ({ plan, onSave, busy }) => {
  const [step, setStep] = useState(PLAN_FORM_STEPS[0].id);
  // 编辑草稿：只放四步覆盖的字段。`marketFacts`/`evidence` 不在这里出现。
  const [edit, setEdit] = useState({
    action: plan.action,
    targetPctRange: plan.position?.targetPctRange ?? null,
    rangePick: plan.position?.rangePick ?? null,
    exit: { stopLoss: plan.exit?.stopLoss, takeProfit: plan.exit?.takeProfit },
    holding: {
      minTradingDays: plan.holding?.minTradingDays,
      maxTradingDays: plan.holding?.maxTradingDays,
    },
    explanation: {
      counterEvidence: plan.explanation?.counterEvidence ?? [],
      risks: plan.explanation?.risks ?? [],
      unknowns: plan.explanation?.unknowns ?? [],
    },
  });
  const patch = (next) => setEdit((current) => ({ ...current, ...next }));
  const merged = mergePlanEdit(plan, edit);
  // 两个值都**消费服务端**（`list_trading_plans` 下发 rangeWidthCap；
  // appliedPct 来自计划本身），client 不做任何数值计算。
  const cap = rangeHint(edit.targetPctRange, plan);
  const applied = appliedPctFor(plan, {
    range: edit.targetPctRange,
    pick: edit.rangePick,
  });
  const blockNotice = activeBlockNotice({
    marketFacts: plan.marketFacts,
    status: plan.status,
  });
  const index = PLAN_FORM_STEPS.findIndex((item) => item.id === step);
  const go = (delta) => {
    const next = PLAN_FORM_STEPS[index + delta];
    if (next !== undefined) setStep(next.id);
  };
  const field = (label, control, hint) =>
    h(
      'label',
      { className: 'luo-field', key: label },
      label,
      control,
      hint === undefined ? null : h('span', { className: 'luo-fine' }, hint),
    );
  const listEditor = (label, values, onChange) =>
    field(
      label,
      h('textarea', {
        'data-plan-field': label,
        rows: 3,
        value: values.join('\n'),
        onChange: (event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          ),
      }),
      '每行一条',
    );

  const body = (() => {
    if (step === 'action-entry')
      return [
        field(
          '动作',
          h(
            'select',
            {
              'data-plan-field': 'action',
              value: edit.action,
              onChange: (event) => patch({ action: event.target.value }),
            },
            ['observe', 'enter', 'add', 'hold', 'reduce', 'exit', 'avoid'].map((value) =>
              h('option', { key: value, value }, value),
            ),
          ),
        ),
      ];
    if (step === 'position-pick')
      return [
        field(
          '目标仓位下限（%）',
          h('input', {
            type: 'number',
            min: 0,
            max: 100,
            'data-plan-field': 'targetMin',
            value: edit.targetPctRange?.min ?? 0,
            onChange: (event) =>
              patch({
                targetPctRange: {
                  min: Number(event.target.value),
                  max: edit.targetPctRange?.max ?? 0,
                },
              }),
          }),
        ),
        field(
          '目标仓位上限（%）',
          h('input', {
            type: 'number',
            min: 0,
            max: 100,
            'data-plan-field': 'targetMax',
            value: edit.targetPctRange?.max ?? 0,
            onChange: (event) =>
              patch({
                targetPctRange: {
                  min: edit.targetPctRange?.min ?? 0,
                  max: Number(event.target.value),
                },
              }),
          }),
        ),
        field(
          '选点规则',
          h(
            'select',
            {
              'data-plan-field': 'rangePick',
              value: edit.rangePick?.ruleId ?? 'lower-bound',
              onChange: (event) =>
                patch({
                  rangePick:
                    event.target.value === 'mid' ? { ruleId: 'mid' } : { ruleId: 'lower-bound' },
                }),
            },
            [
              { value: 'lower-bound', label: '下限' },
              { value: 'mid', label: '中点' },
            ].map((option) =>
              h('option', { key: option.value, value: option.value }, option.label),
            ),
          ),
        ),
        // 落点与底价**只读**：由 core 算，用户改区间/选点即可。
        h(
          'p',
          { className: 'luo-fine', 'data-plan-applied': String(applied ?? '—') },
          `落点 appliedPct = ${String(applied ?? '—')}（由选点规则计算，不可手填） · ` +
            `底价 fallbackPct = ${String(edit.targetPctRange?.min ?? '—')}（恒等于区间下限）`,
        ),
        cap === null
          ? null
          : h('p', { className: 'luo-fine', 'data-plan-cap': cap.text }, cap.text),
      ];
    if (step === 'exit-hold')
      return [
        field(
          '止损',
          h('input', {
            type: 'number',
            'data-plan-field': 'stopLoss',
            value: edit.exit.stopLoss ?? '',
            onChange: (event) =>
              patch({
                exit: {
                  ...edit.exit,
                  stopLoss: event.target.value === '' ? undefined : Number(event.target.value),
                },
              }),
          }),
        ),
        field(
          '止盈',
          h('input', {
            type: 'number',
            'data-plan-field': 'takeProfit',
            value: edit.exit.takeProfit ?? '',
            onChange: (event) =>
              patch({
                exit: {
                  ...edit.exit,
                  takeProfit: event.target.value === '' ? undefined : Number(event.target.value),
                },
              }),
          }),
        ),
        field(
          '最少持有交易日',
          h('input', {
            type: 'number',
            min: 0,
            'data-plan-field': 'minTradingDays',
            value: edit.holding.minTradingDays ?? 0,
            onChange: (event) =>
              patch({
                holding: { ...edit.holding, minTradingDays: Number(event.target.value) },
              }),
          }),
        ),
        field(
          '最多持有交易日',
          h('input', {
            type: 'number',
            min: 0,
            'data-plan-field': 'maxTradingDays',
            value: edit.holding.maxTradingDays ?? 0,
            onChange: (event) =>
              patch({
                holding: { ...edit.holding, maxTradingDays: Number(event.target.value) },
              }),
          }),
        ),
      ];
    return [
      listEditor('反证', edit.explanation.counterEvidence, (counterEvidence) =>
        patch({ explanation: { ...edit.explanation, counterEvidence } }),
      ),
      listEditor('风险', edit.explanation.risks, (risks) =>
        patch({ explanation: { ...edit.explanation, risks } }),
      ),
      listEditor('未知项', edit.explanation.unknowns, (unknowns) =>
        patch({ explanation: { ...edit.explanation, unknowns } }),
      ),
      // 未编辑项声明：**必须出现**，否则用户以为「没看到就是没有」。
      h(
        'p',
        { className: 'luo-fine', 'data-plan-unedited': 'true' },
        uneditedNotice(plan.versionId ?? `v${String(plan.version ?? 1)}`),
      ),
      // 激活警告：必须**在保存之前**出现，不许让用户点完才知道。
      blockNotice === null
        ? null
        : h('p', { className: 'luo-fine', 'data-plan-active-block': 'true' }, blockNotice.text),
      h(
        'p',
        { className: 'luo-fine', 'data-plan-preview': 'true' },
        `将保存：动作 ${String(merged.action)} · 区间 ${String(merged.position?.targetPctRange?.min ?? '—')}–${String(merged.position?.targetPctRange?.max ?? '—')} · 落点 ${String(merged.position?.appliedPct ?? '—')} · 底价 ${String(merged.position?.fallbackPct ?? '—')}`,
      ),
    ];
  })();

  return h(
    Card,
    { title: `编辑计划 · ${PLAN_FORM_STEPS[index].title}` },
    h(
      'p',
      { className: 'luo-fine', 'data-plan-step': step },
      `第 ${String(index + 1)} / ${String(PLAN_FORM_STEPS.length)} 步`,
    ),
    ...body,
    h(
      'div',
      { className: 'luo-actions' },
      h(
        'button',
        { type: 'button', className: 'luo-btn', disabled: index === 0, onClick: () => go(-1) },
        '上一步',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'luo-btn',
          disabled: index === PLAN_FORM_STEPS.length - 1,
          onClick: () => go(1),
        },
        '下一步',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'luo-btn',
          'data-plan-submit': 'form',
          disabled: busy === true,
          onClick: () => onSave(merged),
        },
        busy === true ? '保存中…' : '保存为下一版本',
      ),
    ),
  );
};

const PlanRow = ({ entry, selected, onSelect }) =>
  h(
    'tr',
    {
      'data-plan-row': entry.planId,
      'aria-selected': selected === entry.planId ? 'true' : undefined,
      onClick: () => onSelect(entry.planId),
    },
    h('td', null, entry.stockName ?? entry.stockId ?? entry.planId),
    h(
      'td',
      null,
      h(
        Pill,
        { tone: entry.status === 'active' ? 'good' : 'quiet' },
        entry.status === 'active' ? '生效中' : entry.status === 'draft' ? '草案' : '历史',
      ),
    ),
    h('td', null, `v${String(entry.version ?? 1)}`),
    h('td', null, when(entry.validUntil)),
    h(
      'td',
      null,
      entry.gaps.length > 0
        ? h(Pill, { tone: 'warn' }, `缺 ${String(entry.gaps.length)} 项要素`)
        : null,
    ),
  );

export function PlansPanel() {
  const {
    results,
    loading,
    panelError,
    loadedAt,
    health: healthState,
    refresh,
  } = usePanelState('plans');
  const listed = dataOf(results, 'list_trading_plans');
  const [selected, setSelected] = useState(null);
  // 打开详情时记下当时的版本：保存后用它判断「我编辑期间是否被替换」（A-1 硬要求 2）。
  const [openedVersionId, setOpenedVersionId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  /**
   * 保存（走 Operation：`save_trading_plan` 是 write）。
   *
   * 决策 3-A 之后工具已有乐观锁：`persistPlan` 会带上 `expectedRevision`（=打开时那一版）。
   * 冲突时工具返回带 `actual` 的错误，表单**保留编辑内容**并提示重新核对。
   * `replacedWhileEditing` 仍保留，作为保存成功后的**事后**版本链核对（两层保险）。
   */
  const saveDraft = (plan, expectedRevision = openedVersionId) => {
    setSaving(true);
    persistPlan({ plan, expectedRevision })
      .then((saved) => {
        const clash = replacedWhileEditing({ openedVersionId, saved });
        // 保存成功必须刷新列表：否则 `current` 仍是旧版本，
        // 下一次保存会基于**陈旧基线**，冲突提示永远不出现（浏览器验收实测踩过）。
        refresh();
        setNotice(
          clash === null
            ? { kind: 'saved', text: `已保存 v${String(saved.version ?? '?')}` }
            : {
                kind: 'replaced',
                text: `这份计划在你编辑期间已被更新：你打开的是 ${String(clash.openedVersionId)}，提交前已存在 ${String(clash.superseded)}。你的提交已保存为 ${String(clash.savedVersionId)}，请核对是否覆盖了别人的修改。`,
              },
        );
      })
      .catch((error) => {
        // 冲突**保留编辑内容**：只更新提示，不动表单 state（草稿还在，用户可重新核对）。
        //
        // 识别方式：读工具错误里的**结构化 issues**（`path: ['reason']` = 'revision-conflict'，
        // `path: ['actual']` = 当前最新版本），**不用正则解析消息**——
        // 文案会变，结构不会（Codex 缺陷③要求「明确传递『冲突且未提交』，
        // 同时继续区分真正的结果未知」）。
        const issues = Array.isArray(error?.issues) ? error.issues : [];
        const reasonOf = (name) =>
          issues.find((issue) => Array.isArray(issue?.path) && issue.path[0] === name)?.message;
        const actualVersionId = reasonOf('actual');
        const isConflict = reasonOf('reason') === 'revision-conflict';
        setNotice(
          isConflict
            ? {
                kind: 'conflict',
                text: revisionConflictNotice({
                  openedVersionId,
                  actualVersionId: actualVersionId ?? '（服务端未给出）',
                }),
              }
            : // 真正的「结果未知」仍然单独表达——不许和「确定的冲突」混为一谈。
              { kind: 'error', text: String(error?.message ?? error) },
        );
      })
      .finally(() => setSaving(false));
  };

  const plans = listed?.plans ?? listed?.items ?? [];
  const rows = plans.map((plan) => ({
    planId: plan.id ?? plan.planId,
    stockId: plan.stockId,
    stockName: plan.stockName,
    status: plan.status,
    version: plan.version,
    validUntil: plan.validUntil,
    gaps: planGaps(plan),
  }));
  const current = plans.find((plan) => (plan.id ?? plan.planId) === selected) ?? null;

  useEffect(() => {
    // `TradingPlanReadSchema` **不含 `versionId`**（它只是 `id` + `version` 的派生值），
    // 所以不能指望 `current.versionId`。按 core 的同一口径自己拼：
    // `tradingPlanVersionId = \`${id}:v${version}\``（`trading-plan.ts:966`）。
    if (current !== null)
      setOpenedVersionId(
        current.versionId ??
          (current.id === undefined ? null : `${current.id}:v${String(current.version ?? 1)}`),
      );
  }, [selected]);

  return h(
    Fragment,
    null,
    h(PanelHealthBadge, { key: 'health', health: healthState }),
    h(Head, {
      eyebrow: 'LUOOME / 交易计划',
      title: '交易计划',
      subtitle: '逐股结构化计划 · 版本链 · 四要素提示',
      side: h('span', { className: 'luo-fine' }, `更新 ${when(loadedAt)}`),
    }),
    panelError ? h(ErrorNote, { label: '计划读取', error: panelError }) : null,
    h(
      Section,
      { title: '计划列表' },
      rows.length === 0
        ? h('p', { className: 'luo-fine' }, loading ? '读取中…' : '还没有交易计划。')
        : h(
            'table',
            { className: 'luo-table', 'data-plan-table': 'list' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['标的', '状态', '版本', '有效期', '要素提示'].map((label) =>
                  h('th', { key: label }, label),
                ),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((entry) =>
                h(PlanRow, { key: entry.planId, entry, onSelect: setSelected, selected }),
              ),
            ),
          ),
      h(
        'p',
        { className: 'luo-fine' },
        '缺少失效条件 / 反证 / 风险 / 有效期只是**提示**，不阻止保存：它是提醒投递期的闸门，不是配置期校验。',
      ),
    ),
    current === null
      ? null
      : h(
          Section,
          {
            title: `计划详情 · ${current.stockName ?? current.stockId ?? ''}`,
            id: 'plan-detail',
          },
          h(
            'div',
            { className: 'luo-grid is-kpi', 'data-plan-detail': current.id ?? current.planId },
            h(Kpi, { label: '动作', value: current.action ?? '—', sub: when(current.validFrom) }),
            h(Kpi, {
              label: '目标仓位',
              value:
                current.position?.targetPctRange === null ||
                current.position?.targetPctRange === undefined
                  ? '—'
                  : `${String(current.position.targetPctRange.min)}%–${String(current.position.targetPctRange.max)}%`,
              sub: '区间 + 选点，不是单一目标价',
            }),
            h(Kpi, {
              label: '止损',
              value: current.exit?.stopLoss === undefined ? '未设' : money(current.exit.stopLoss),
              sub: current.exit?.canSellNow === true ? '可卖' : '当前不可卖',
            }),
            h(Kpi, {
              label: '止盈',
              value:
                current.exit?.takeProfit === undefined ? '未设' : money(current.exit.takeProfit),
              sub: '缺省不阻断保存',
            }),
          ),
          h(
            Card,
            { title: '失效条件（结构化）' },
            (current.invalidationRules ?? []).length === 0
              ? h('p', { className: 'luo-fine' }, '未填结构化失效条件。')
              : h(
                  'ul',
                  null,
                  (current.invalidationRules ?? []).map((rule, index) =>
                    h('li', { key: index }, rule.description ?? String(index)),
                  ),
                ),
          ),
          h(
            Card,
            { title: '反证与风险' },
            h(
              'p',
              { className: 'luo-fine' },
              `反证 ${String((current.counterEvidence ?? []).length)} 条 · 风险 ${String((current.risks ?? []).length)} 条`,
            ),
          ),
          h(PlanForm, {
            plan: current,
            busy: saving,
            onSave: (editable) =>
              saveDraft(
                { ...editable, version: (current.version ?? 1) + 1 },
                // ⚠️ 基线**只能**是 `openedVersionId`（打开编辑时那一版）。
                //
                // 这里曾经写成 `current.versionId`，那是「**列表当前**的版本」——
                // 保存成功后列表刷新，它就会跟着变成新版本，于是下次保存声明的基线
                // 悄悄被换掉，**乐观锁形同虚设**（Codex 查出的缺陷①）。
                //
                // 列表刷新只更新列表；**不许**动正在编辑的草稿的基线。
                openedVersionId,
              ),
          }),
          h('span', { className: 'luo-fine' }, '保存不会自动下单；计划只是记录与约束。'),
          h(
            Card,
            { title: '版本链' },
            h(
              'p',
              { className: 'luo-fine' },
              current.supersedesVersionId === undefined
                ? '这是首个版本。'
                : `取代了 ${current.supersedesVersionId}`,
            ),
            h(
              'p',
              { className: 'luo-fine', 'data-optimistic-lock': 'true' },
              '保存带乐观锁：以你打开时的版本为基线，若期间已被别人更新，本次保存会被拒绝并提示重新核对。',
            ),
          ),
        ),
    notice === null
      ? null
      : h(
          'p',
          { role: 'status', className: 'luo-fine', 'data-plan-notice': notice.kind },
          notice.text,
        ),
  );
}
