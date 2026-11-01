// 交易计划面板（task-39 批次 A）。
//
// 纪律：
// - 格式化**复用 `format.js`**、取数**复用 `projection.js` 的 `dataOf`**，不新造第二套。
// - 四要素缺失**只是提示，不阻断保存**：`save_trading_plan` 没有这条硬校验
//   （`trading-plan.ts:100-130` 只拒「事实变化 / active 时事实不完整 / active 时约束未过」）。
// - **不承诺并发安全**：`save_trading_plan` 没有乐观锁，保护只来自 `accountFactsDigest` + 版本链，
//   不覆盖「同事实并发编辑」。冲突只能**事后发现并显式提示**。
import { Fragment, createElement as h, useEffect, useState } from 'react';

import { usePanelState } from './data.js';
import { money, when } from './format.js';
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
  if (!response.ok || !result.ok)
    throw new Error(result.error?.message ?? result.error?.kind ?? `HTTP ${response.status}`);
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
export const persistPlan = async ({ plan }) => {
  const operationId = crypto.randomUUID();
  const operation = await operationRequest('prepare', {
    id: operationId,
    tool: 'save_trading_plan',
    input: { plan },
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
  const { results, loading, panelError, loadedAt, health: healthState } = usePanelState('plans');
  const listed = dataOf(results, 'list_trading_plans');
  const [selected, setSelected] = useState(null);
  // 打开详情时记下当时的版本：保存后用它判断「我编辑期间是否被替换」（A-1 硬要求 2）。
  const [openedVersionId, setOpenedVersionId] = useState(null);
  const [notice, setNotice] = useState(null);

  /**
   * 保存 d 草稿（走 Operation：`save_trading_plan` 是 write）。
   *
   * **不承诺并发安全**：工具没有乐观锁。这里能做的只有「保存后对比版本链」，
   * 发现被替换就**显式告诉用户**，而不是静默成功。
   */
  const saveDraft = (plan) => {
    persistPlan({ plan, openedVersionId })
      .then((saved) => {
        const clash = replacedWhileEditing({ openedVersionId, saved });
        setNotice(
          clash === null
            ? { kind: 'saved', text: `已保存 v${String(saved.version ?? '?')}` }
            : {
                kind: 'replaced',
                text: `这份计划在你编辑期间已被更新：你打开的是 ${String(clash.openedVersionId)}，提交前已存在 ${String(clash.superseded)}。你的提交已保存为 ${String(clash.savedVersionId)}，请核对是否覆盖了别人的修改。`,
              },
        );
      })
      .catch((error) => setNotice({ kind: 'error', text: String(error.message ?? error) }));
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
    if (current !== null) setOpenedVersionId(current.versionId ?? current.id ?? null);
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
          h(
            'div',
            { className: 'luo-actions' },
            h(
              'button',
              {
                className: 'luo-btn',
                type: 'button',
                'aria-label': '保存为下一版本',
                'data-plan-save': 'next-version',
                onClick: () => saveDraft({ ...current, version: (current.version ?? 1) + 1 }),
              },
              '保存为下一版本',
            ),
            h('span', { className: 'luo-fine' }, '保存不会自动下单；计划只是记录与约束。'),
          ),
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
              { className: 'luo-fine', 'data-no-optimistic-lock': 'true' },
              '保存没有乐观锁：并发编辑可能后写覆盖前写。保存后请核对版本号是否变化。',
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
