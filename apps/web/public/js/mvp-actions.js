/* 分组与盯盘池的 mutation 表单。服务端负责最终 schema / 引用校验。 */

import { callApi, getAccountId } from './api.js';
import { $, el } from './ui.js';

let refreshGroups = async () => {};
let refreshWatch = async () => {};
let notify = () => {};

export const initMvpActions = ({ onGroupsChanged, onWatchChanged, setStatus }) => {
  refreshGroups = onGroupsChanged;
  refreshWatch = onWatchChanged;
  notify = setStatus;
};

const openModal = (title, body) => {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(body);
  $('#modal-overlay').hidden = false;
};

const closeModal = () => {
  $('#modal-overlay').hidden = true;
};

const control = (tag, id, value = '') => {
  const node = el(tag);
  node.id = id;
  node.value = value;
  return node;
};

const field = (label, node, hint) => {
  const labelNode = el('label', null, label);
  labelNode.htmlFor = node.id;
  const box = el('div', 'field', [labelNode, node]);
  if (hint) box.append(el('span', 'hint', hint));
  return box;
};

const option = (value, label) => {
  const node = el('option', null, label);
  node.value = value;
  return node;
};

const errorMessage = (error) => {
  if (error === null || typeof error !== 'object') return '提交失败';
  return error.message ?? error.cause ?? error.kind ?? '提交失败';
};

const submit = async (button, errorNode, tool, input, after, message) => {
  button.disabled = true;
  errorNode.textContent = '';
  const result = await callApi(`/api/tools/${tool}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  button.disabled = false;
  if (!result.ok) {
    errorNode.textContent = errorMessage(result.error);
    return false;
  }
  closeModal();
  await after();
  notify(message);
  return true;
};

const actionRow = (label, onSubmit) => {
  const errorNode = el('p', 'modal-error');
  const cancel = el('button', 'btn btn-outline', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  const ok = el('button', 'btn btn-primary', label);
  ok.type = 'button';
  ok.addEventListener('click', () => void onSubmit(ok, errorNode));
  return [errorNode, el('div', 'modal-actions', [cancel, ok])];
};

const groupResolverFields = (kind, current) => {
  const box = el('div');
  if (kind === 'manual') {
    const value = current?.kind === 'manual' ? current.stockIds.join(', ') : '';
    box.append(
      field(
        '股票代码',
        control('textarea', 'group-stock-ids', value),
        '逗号或换行分隔，如 002594.SZ, 600519.SH',
      ),
    );
  } else if (kind === 'holdings') {
    box.append(
      field(
        '账户 ID',
        control('input', 'group-account-id', current?.accountId ?? getAccountId()),
        '持仓分组是实时活视图，无需刷新。',
      ),
    );
  } else if (kind === 'formula') {
    box.append(
      field('战法 ID', control('input', 'group-tactic-id', current?.tacticId ?? '')),
      field('回看天数', control('input', 'group-lookback', String(current?.lookbackDays ?? 7))),
      field('最低分数', control('input', 'group-min-score', String(current?.minScore ?? 60))),
    );
  } else {
    box.append(
      field(
        '成员提示词',
        control('textarea', 'group-prompt', current?.prompt ?? ''),
        '模型必须输出可识别的股票代码；失败或空结果会保留旧快照。',
      ),
      field('最多成员', control('input', 'group-max-members', String(current?.maxMembers ?? 20))),
    );
  }
  return box;
};

const readResolver = (kind) => {
  if (kind === 'manual') {
    return {
      kind,
      stockIds: $('#group-stock-ids')
        .value.split(/[,\n，\s]+/)
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    };
  }
  if (kind === 'holdings') {
    return { kind, accountId: $('#group-account-id').value.trim() };
  }
  if (kind === 'formula') {
    return {
      kind,
      tacticId: $('#group-tactic-id').value.trim(),
      lookbackDays: Number($('#group-lookback').value),
      minScore: Number($('#group-min-score').value),
    };
  }
  return {
    kind: 'llm',
    prompt: $('#group-prompt').value.trim(),
    maxMembers: Number($('#group-max-members').value),
  };
};

export const openGroupModal = (item = null) => {
  const group = item?.group ?? null;
  const form = el('div');
  const id = control('input', 'group-id', group?.id ?? '');
  id.disabled = group !== null;
  id.placeholder = '例如 semiconductor-leaders';
  const name = control('input', 'group-name', group?.name ?? '');
  const description = control('textarea', 'group-description', group?.description ?? '');
  const kind = control('select', 'group-kind', group?.resolver.kind ?? 'manual');
  for (const [value, label] of [
    ['manual', '手动成员'],
    ['holdings', '账户持仓'],
    ['formula', '战法动态'],
    ['llm', 'LLM 动态'],
  ]) {
    kind.append(option(value, label));
  }
  kind.value = group?.resolver.kind ?? 'manual';
  const resolverBox = el('div');
  const drawResolver = () => {
    const current = kind.value === group?.resolver.kind ? group.resolver : null;
    resolverBox.replaceChildren(groupResolverFields(kind.value, current));
  };
  kind.addEventListener('change', drawResolver);
  drawResolver();
  form.append(
    field('分组 ID', id, '小写 kebab-case，创建后不可修改。'),
    field('名称', name),
    field('说明', description),
    field('成员来源', kind),
    resolverBox,
  );
  const [errorNode, actions] = actionRow(group ? '保存修改' : '创建分组', async (button, error) => {
    const input = {
      id: id.value.trim(),
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      resolver: readResolver(kind.value),
      refreshPolicy: kind.value === 'manual' || kind.value === 'holdings' ? 'manual' : 'daily',
      enabled: group?.enabled ?? true,
    };
    await submit(
      button,
      error,
      group ? 'update_stock_group' : 'create_stock_group',
      input,
      refreshGroups,
      group ? '分组已更新' : '分组已创建',
    );
  });
  form.append(errorNode, actions);
  openModal(group ? `编辑分组 · ${group.name}` : '新建股票分组', form);
};

const poolRuleFields = (kind, current) => {
  const box = el('div');
  if (kind === 'price-change') {
    box.append(
      field(
        '涨跌幅阈值（%）',
        control('input', 'pool-price-pct', String((current?.pct ?? 0.05) * 100)),
      ),
    );
  } else if (kind === 'cost-threshold') {
    box.append(
      field(
        '止损（%）',
        control('input', 'pool-stop-loss', String((current?.stopLossPct ?? 0.08) * 100)),
      ),
      field(
        '止盈（%）',
        control('input', 'pool-take-profit', String((current?.takeProfitPct ?? 0.15) * 100)),
      ),
    );
  } else {
    box.append(
      field('战法 ID', control('input', 'pool-tactic-id', current?.tacticId ?? '')),
      field('最低分数', control('input', 'pool-min-score', String(current?.minScore ?? 60))),
    );
  }
  return box;
};

const readRule = (kind) => {
  if (kind === 'price-change') {
    return { kind, pct: Number($('#pool-price-pct').value) / 100 };
  }
  if (kind === 'cost-threshold') {
    const stopLossPct = Number($('#pool-stop-loss').value) / 100;
    const takeProfitPct = Number($('#pool-take-profit').value) / 100;
    return { kind, stopLossPct, takeProfitPct };
  }
  return {
    kind: 'tactic',
    tacticId: $('#pool-tactic-id').value.trim(),
    minScore: Number($('#pool-min-score').value),
  };
};

export const openPoolModal = async (pool = null) => {
  const groupsResult = await callApi('/api/groups');
  if (!groupsResult.ok) {
    notify(`无法读取分组：${errorMessage(groupsResult.error)}`, true);
    return;
  }
  const form = el('div');
  const id = control('input', 'pool-id', pool?.id ?? '');
  id.disabled = pool !== null;
  id.placeholder = '例如 momentum-watch';
  const name = control('input', 'pool-name', pool?.name ?? '');
  const description = control('textarea', 'pool-description', pool?.description ?? '');
  const groupId = control('select', 'pool-group-id');
  for (const item of groupsResult.data.groups) {
    groupId.append(option(item.group.id, `${item.group.name} · ${item.group.id}`));
  }
  groupId.value = pool?.groupId ?? groupsResult.data.groups[0]?.group.id ?? '';
  const firstRule = pool?.rules[0] ?? null;
  const kind = control('select', 'pool-rule-kind', firstRule?.kind ?? 'price-change');
  for (const [value, label] of [
    ['price-change', '日内涨跌幅'],
    ['cost-threshold', '成本止盈止损'],
    ['tactic', '战法命中'],
  ]) {
    kind.append(option(value, label));
  }
  kind.value = firstRule?.kind ?? 'price-change';
  const ruleBox = el('div');
  const drawRule = () => {
    const current = kind.value === firstRule?.kind ? firstRule : null;
    ruleBox.replaceChildren(poolRuleFields(kind.value, current));
  };
  kind.addEventListener('change', drawRule);
  drawRule();
  const cooldown = control('input', 'pool-cooldown', String(pool?.cooldownMinutes ?? 30));
  form.append(
    field('盯盘池 ID', id, '小写 kebab-case，创建后不可修改。'),
    field('名称', name),
    field('说明', description),
    field('成员分组', groupId),
    field('规则类型', kind, 'MVP 表单每个池配置一条规则；可创建多个池组合规则。'),
    ruleBox,
    field('通知冷却（分钟）', cooldown),
  );
  const [errorNode, actions] = actionRow(
    pool ? '保存修改' : '创建盯盘池',
    async (button, error) => {
      const input = {
        id: id.value.trim(),
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        groupId: groupId.value,
        rules: [readRule(kind.value), ...(pool?.rules.slice(1) ?? [])],
        cooldownMinutes: Number(cooldown.value),
        enabled: pool?.enabled ?? true,
      };
      await submit(
        button,
        error,
        pool ? 'update_stock_pool' : 'create_stock_pool',
        input,
        refreshWatch,
        pool ? '盯盘池已更新' : '盯盘池已创建',
      );
    },
  );
  form.append(errorNode, actions);
  openModal(pool ? `编辑盯盘池 · ${pool.name}` : '新建盯盘池', form);
};

export const mutateEntity = async (tool, input, after, message) => {
  const result = await callApi(`/api/tools/${tool}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  if (!result.ok) {
    notify(`${message}失败：${errorMessage(result.error)}`, true);
    return false;
  }
  await after();
  notify(message);
  return true;
};
