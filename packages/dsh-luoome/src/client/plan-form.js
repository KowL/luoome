// 交易计划四步表单的**纯逻辑**（决策 3-C / 外部评审②）。
//
// 这里刻意只放纯函数、不碰 React：client 的 `.js` 在本仓无法被测试加载
// （`react` 不在依赖里，见 `operation-route.guard.test.js` 的说明），
// 但**纯函数**可以用源码级断言 + 直接 import 的方式验证。
// 计算规则一律调 core，不抄数字——表单里显示什么，取决于 core 给什么。
// **本文件不得 import `@luoome/core`**（架构纪律：语义全在服务端，client 不写第二份）。
// 见 `client-health.guard.test.js`「client 不写第二份日期比较 / 不引 core」。
//
// 所以这里没有区间上限/落点的**计算**，只有**消费**：值由服务端随
// `list_trading_plans` 下发（`rangeWidthCap` / `appliedPct` / `fallbackPct` 都在计划对象里）。

/**
 * 四步表单的字段分组（Codex 定，不许自己加）。
 *
 * 每一步只改它列出的字段；其余字段（`marketFacts` / `evidence` / `explanation.*Ids`）
 * **不在本表单编辑**，见 `UNEDITED_GROUPS` 与预览里的声明。
 */
export const PLAN_FORM_STEPS = Object.freeze([
  {
    id: 'action-entry',
    title: '动作与入场条件',
    fields: [
      'action',
      'entryPriceLow',
      'entryPriceHigh',
      'entryConditions',
      'invalidEntryConditions',
    ],
  },
  {
    id: 'position-pick',
    title: '仓位区间与选点',
    // appliedPct / fallbackPct **不在这里**：它们由 core 算出、只读展示。
    fields: ['targetPctRange', 'rangePick'],
  },
  {
    id: 'exit-hold',
    title: '退出 / 失效条件及持有期限',
    fields: [
      'exit.stopLoss',
      'exit.takeProfit',
      'exit.conditions',
      'invalidationRules',
      'invalidationConditions',
      'holding.minTradingDays',
      'holding.maxTradingDays',
      'holding.nextReviewAt',
    ],
  },
  {
    id: 'risk-preview',
    title: '反证 / 风险与修改预览',
    fields: ['explanation.counterEvidence', 'explanation.risks', 'explanation.unknowns'],
  },
]);

/**
 * **本表单不编辑**的字段组——沿用被编辑版本（vN）的值。
 *
 * 为什么不在表单里编辑（需求负责人裁定）：
 * - `marketFacts` 是**证据链**，不是用户随手填的配置。让它可编辑等于允许在表单里
 *   改写自己引用的市场事实，与「证据要可追溯」直接冲突。
 * - `evidence` / `explanation.supportingEvidenceIds` 同理：它们指向工具产出的事实。
 *
 * **但必须在预览里显式声明**，不能让用户以为「没看到就是没有」。
 */
export const UNEDITED_GROUPS = Object.freeze([
  { key: 'marketFacts', label: '市场事实' },
  { key: 'evidence', label: '证据' },
  { key: 'explanation.supportingEvidenceIds', label: '证据引用 id' },
]);

/**
 * 区间宽度上限：**只消费服务端下发的值**。
 *
 * 服务端在 `list_trading_plans` 的每个计划上带 `rangeWidthCap`（由 core 的
 * `tradingPlanRangeWidthCap` 算出）。client 不重算——否则「分层表」会变成两份真源，
 * 改 core 而前端不跟就会静默不一致。
 */
export const rangeWidthCap = (plan) => {
  const cap = plan?.rangeWidthCap;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
};

/**
 * 落点（`appliedPct`）：当前编辑态尚未保存，服务端没有它的值。
 *
 * 这里**不做计算**（那会在 client 里复制 core 的选点规则）。改为：
 * - 用户没改区间/选点时 → 用计划上已有的 `appliedPct`（服务端算过）
 * - 用户改了 → 返回 null，UI 显示「保存后由服务端计算」，**不猜**
 *
 * 猜一个落点给用户看，比不显示更糟：用户会以为那就是最终值。
 */
export const appliedPctFor = (plan, { range, pick } = {}) => {
  const base = plan?.position;
  if (base === undefined || base === null) return null;
  const unchangedRange =
    range === undefined ||
    range === null ||
    (base.targetPctRange !== null &&
      Number(range.min) === base.targetPctRange.min &&
      Number(range.max) === base.targetPctRange.max);
  const unchangedPick =
    pick === undefined ||
    pick === null ||
    (base.rangePick !== null && JSON.stringify(pick) === JSON.stringify(base.rangePick));
  if (!unchangedRange || !unchangedPick) return null;
  return typeof base.appliedPct === 'number' ? base.appliedPct : null;
};

/**
 * 区间校验提示（**不阻断保存**，与既有「四要素只是提示」的口径一致）。
 *
 * 上限取**服务端下发的** `rangeWidthCap`；取不到时不编一个上限，
 * 只报区间本身的矛盾（min > max），并显示「上限由服务端计算」。
 */
export const rangeHint = (range, plan) => {
  if (range === null || range === undefined) return null;
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max < min) return { tone: 'warn', text: '区间上限小于下限，请检查' };
  const cap = rangeWidthCap(plan);
  const width = Number((max - min).toFixed(2));
  // 无服务端上限：不猜数字，只说明事实。
  if (cap === null) return { tone: 'quiet', text: `区间宽度 ${String(width)}（上限由服务端计算）` };
  return width > cap
    ? {
        tone: 'warn',
        text: `区间宽度 ${String(width)} 超过允许上限 ${String(cap)}（分层上限与 0.30×max 取更严）`,
      }
    : { tone: 'quiet', text: `区间宽度 ${String(width)}（上限 ${String(cap)}）` };
};

/**
 * 预览的「未编辑项声明」。**每一条都必须出现在第 4 步**，
 * 让用户知道哪些东西他改不了、值从哪来。
 */
export const uneditedNotice = (sourceVersionId) =>
  `本表单不编辑 ${UNEDITED_GROUPS.map((group) => group.label).join(' / ')}，` +
  `沿用 ${sourceVersionId ?? '当前版本'} 的值。` +
  '这些是工具产出的事实，不作为可编辑配置——否则你就改写了所引用的证据。';

/**
 * **激活警告**：沿用的市场事实里有 `unavailable` 项时，保存为 `active` 会被 core 拒绝
 * （`trading-plan.ts:742-746`「active 计划不能包含 unavailable 的市场事实」）。
 *
 * 必须在**点保存之前**告诉用户，而不是让他点完再吃一个报错。
 * 返回 null 表示没有阻塞。
 */
export const activeBlockNotice = ({ marketFacts, status }) => {
  if (status !== 'active') return null;
  const blocked = (marketFacts ?? []).filter((fact) => fact?.status === 'unavailable');
  if (blocked.length === 0) return null;
  return {
    tone: 'warn',
    text:
      `当前沿用的市场事实含 ${String(blocked.length)} 项 unavailable（` +
      `${blocked
        .slice(0, 3)
        .map((fact) => fact.id ?? fact.metric ?? '未命名事实')
        .join('、')}${blocked.length > 3 ? ' 等' : ''}），` +
      '保存为 active 会被拒绝；请先用工具刷新事实，或保存为 draft。',
  };
};

/**
 * 把表单编辑结果合并回原计划。
 *
 * **只合并四步覆盖的字段**，其余字段（含 `marketFacts` / `evidence` /
 * `explanation.supportingEvidenceIds`）**原样保留**——这既是「不编辑」的实现，
 * 也是「不会因保存而丢失证据」的保证。
 */
export const mergePlanEdit = (base, edit) => {
  const next = { ...base };
  if (edit.action !== undefined) next.action = edit.action;
  if (edit.entryPriceLow !== undefined) next.entryPriceLow = edit.entryPriceLow;
  if (edit.entryPriceHigh !== undefined) next.entryPriceHigh = edit.entryPriceHigh;
  if (edit.entryConditions !== undefined) next.entryConditions = edit.entryConditions;
  if (edit.invalidEntryConditions !== undefined)
    next.invalidEntryConditions = edit.invalidEntryConditions;
  if (edit.invalidationRules !== undefined) next.invalidationRules = edit.invalidationRules;
  if (edit.invalidationConditions !== undefined)
    next.invalidationConditions = edit.invalidationConditions;

  if (edit.targetPctRange !== undefined || edit.rangePick !== undefined) {
    const targetPctRange =
      edit.targetPctRange === undefined ? base.position.targetPctRange : edit.targetPctRange;
    const rangePick = edit.rangePick === undefined ? base.position.rangePick : edit.rangePick;
    // appliedPct **不由 client 计算**（那会在前端复制 core 的选点规则）。
    // 区间/选点没变 → 沿用服务端已算的值；变了 → 置 null，由保存后的服务端结果填充。
    // `fallbackPct` 是 core 的硬不变量「必须等于区间下限」（`trading-plan.ts:442`），
    // 直接取 min 不是「自己算规则」，而是复述这条不变量。
    const applied = appliedPctFor(base, { range: targetPctRange, pick: rangePick });
    next.position = {
      ...base.position,
      targetPctRange,
      rangePick,
      appliedPct: applied,
      fallbackPct: targetPctRange === null ? null : targetPctRange.min,
    };
  }

  if (edit.exit !== undefined) next.exit = { ...base.exit, ...edit.exit };
  if (edit.holding !== undefined) next.holding = { ...base.holding, ...edit.holding };
  if (edit.explanation !== undefined)
    next.explanation = { ...base.explanation, ...edit.explanation };

  return next;
};

/** 冲突提示文案：必须同时说清「你打开的是哪版」与「现在是哪版」，并声明修改未保存。 */
export const revisionConflictNotice = ({ openedVersionId, actualVersionId }) =>
  `你打开的是 ${String(openedVersionId)}，当前已是 ${String(actualVersionId)}。` +
  '你的修改**未保存**，请重新核对后再提交。';
