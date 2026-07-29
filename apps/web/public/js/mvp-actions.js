/* 分组与盯盘方案的 mutation 表单。服务端负责最终 schema / 引用校验。 */

import { callApi, getAccountId } from './api.js';
import { $, el, fmtNum } from './ui.js';

let refreshGroups = async () => {};
let refreshWatch = async () => {};
let notify = () => {};

export const initMvpActions = ({ onGroupsChanged, onWatchChanged, setStatus }) => {
  refreshGroups = onGroupsChanged;
  refreshWatch = onWatchChanged;
  notify = setStatus;
};

const openModal = (title, body, extraClass = '') => {
  $('#modal-title').textContent = title;
  const modal = $('#modal-overlay > .modal');
  if (modal !== null) {
    if (extraClass.length > 0) modal.classList.add(extraClass);
    else modal.classList.remove('modal-wide');
  }
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

/** 战法列表缓存：下拉选择用（用户选战法而非填 id）。 */
let tacticsCache = null;
const loadTactics = async () => {
  if (tacticsCache !== null) return tacticsCache;
  const result = await callApi('/api/tactics');
  tacticsCache = result.ok ? result.data.tactics : [];
  return tacticsCache;
};

/** 战法下拉：value = tacticId，展示 = 战法名称。 */
const tacticSelect = (id, tactics, selected = '') => {
  const node = control('select', id);
  if (tactics.length === 0) node.append(option('', '（暂无战法，请先创建）'));
  for (const t of tactics) node.append(option(t.id, t.name));
  if (selected) node.value = selected;
  return node;
};

export const toolErrorText = (error) => {
  if (error === null || typeof error !== 'object') return '提交失败';
  if (error.kind === 'permission_denied') {
    const required = error.required ?? '写操作需要有效 Web token';
    return `权限校验失败：${required}；请前往「设置」保存当前服务的 Web token。`;
  }
  const detail = error.message ?? error.cause ?? '';
  return detail === '' ? String(error.kind) : `${error.kind}：${detail}`;
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
    errorNode.textContent = toolErrorText(result.error);
    return false;
  }
  closeModal();
  await after();
  notify(message);
  return true;
};

const callTool = (tool, input) =>
  callApi(`/api/tools/${tool}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });

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

const groupResolverFields = (kind, current, tactics = []) => {
  const box = el('div');
  if (kind === 'manual') {
    const value = current?.kind === 'manual' ? current.stockIds.join(', ') : '';
    box.append(
      field(
        '股票代码',
        control('textarea', 'group-stock-ids', value),
        '逗号或换行分隔，如 002594.SZ, 600519.SH；可先留空，创建后到分组详情单独添加',
      ),
    );
  } else if (kind === 'holdings') {
    // 账户跟随当前登录账户，用户无需关心账户 id：用隐藏 input 承载，仅展示说明。
    const accountId = control('input', 'group-account-id', current?.accountId ?? getAccountId());
    accountId.type = 'hidden';
    box.append(accountId, el('p', 'hint', '实时跟随当前账户持仓，无需刷新。'));
  } else if (kind === 'formula') {
    box.append(
      field('战法', tacticSelect('group-tactic-id', tactics, current?.tacticId), '选择一个战法'),
      field('回看天数', control('input', 'group-lookback', String(current?.lookbackDays ?? 120))),
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

export const openGroupModal = async (item = null) => {
  const group = item?.group ?? null;
  const tactics = await loadTactics();
  const form = el('div');
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
    resolverBox.replaceChildren(groupResolverFields(kind.value, current, tactics));
  };
  kind.addEventListener('change', drawResolver);
  drawResolver();
  form.append(
    field('名称', name),
    field('说明', description),
    field('成员来源', kind),
    resolverBox,
  );
  const [errorNode, actions] = actionRow(group ? '保存修改' : '创建分组', async (button, error) => {
    const input = {
      ...(group ? { id: group.id } : {}),
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

/**
 * 向 manual 分组追加成员。复刻 holdings-actions 的搜索 + 合成候选，但每个候选行带
 * 代码 / 名称 / 现价 / 日内涨幅（远程 batch_quote 拉行情），已选贴一张预览卡在顶部。
 */
export const openAddMemberModal = async (group, onAdded) => {
  if (group.resolver.kind !== 'manual') return;
  const existing = new Set(group.resolver.stockIds);
  const STOCK_ID_PATTERN_UI = /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/;

  /** 渲染 quote 行情块：现价 + 日内变化%（涨/跌染色）。 */
  const priceBlock = (quote) => {
    const wrap = el('div', 'quote-line');
    if (quote === null) {
      wrap.append(el('span', 'quote-price muted', '--'));
      wrap.append(el('span', 'quote-pct muted', '行情暂不可用'));
      return wrap;
    }
    const close = Number(quote.close);
    const open = Number(quote.open);
    let pctText = '—';
    let pctClass = '';
    if (Number.isFinite(close) && Number.isFinite(open) && open !== 0) {
      const pct = (close - open) / open;
      const sign = pct > 0 ? '+' : '';
      pctText = `日内 ${sign}${fmtNum(pct * 100, 2)}%`;
      pctClass = pct > 0 ? 'text-pos' : pct < 0 ? 'text-neg' : '';
    }
    wrap.append(el('span', 'quote-price', Number.isFinite(close) ? fmtNum(close, 2) : '--'));
    wrap.append(el('span', `quote-pct ${pctClass}`, pctText));
    return wrap;
  };

  const renderRow = (entry, quote) => {
    const row = el('button', 'autocomplete-item autocomplete-rich');
    row.type = 'button';
    const main = el('div', 'ac-line-1', [
      el('span', 'mono', entry.id),
      el('span', 'ac-name', entry.name ?? entry.id),
    ]);
    const tail = priceBlock(quote);
    row.append(main, tail);
    row.addEventListener('click', () =>
      pickStock(entry.id, `${entry.id} ${entry.name ?? entry.id}`, entry.name ?? ''),
    );
    return row;
  };

  /** 把 batch_quote 结果按 stockId 索引；不存在的返回 null。 */
  const indexQuotes = (resp) => {
    const m = new Map();
    if (!resp.ok || !Array.isArray(resp.data?.quotes)) return m;
    for (const q of resp.data.quotes) m.set(q.stockId, q);
    return m;
  };

  let selectedStockId = '';
  let selectedStockName = '';

  const pickStock = (id, label, name) => {
    selectedStockId = id;
    selectedStockName = name;
    stockInput.value = label;
    acList.hidden = true;
  };

  const stockInput = el('input');
  stockInput.id = 'add-member-stock';
  stockInput.placeholder = '代码或名称，如 002594 / 比亚迪';
  stockInput.autocomplete = 'off';

  const acList = el('div', 'autocomplete-list');
  acList.hidden = true;
  const acWrap = el('div', 'autocomplete', [stockInput, acList]);

  const syntheticCandidates = (q) => {
    if (/^\d{6}$/.test(q)) return [`${q}.SH`, `${q}.SZ`];
    if (/^\d{4,5}$/.test(q)) return [`${q}.HK`];
    if (/^[A-Za-z]{1,5}$/.test(q)) return [`${q.toUpperCase()}.US`];
    return [];
  };

  let timer = 0;
  stockInput.addEventListener('input', () => {
    selectedStockId = '';
    selectedStockName = '';
    window.clearTimeout(timer);
    const q = stockInput.value.trim();
    if (q.length === 0) {
      acList.hidden = true;
      return;
    }
    if (STOCK_ID_PATTERN_UI.test(q.toUpperCase())) {
      acList.hidden = true;
      return;
    }
    timer = window.setTimeout(() => {
      void (async () => {
        const r = await callApi('/api/tools/search_stocks/call', {
          method: 'POST',
          body: JSON.stringify({ input: { query: q, limit: 8 } }),
        });
        const stocks = r.ok && Array.isArray(r.data?.stocks) ? r.data.stocks : [];
        const entries = stocks.map((s) => ({ id: s.id, name: s.name }));
        const ids = entries.map((e) => e.id);
        const quoteMap =
          ids.length === 0
            ? new Map()
            : indexQuotes(
                await callApi('/api/tools/batch_quote/call', {
                  method: 'POST',
                  body: JSON.stringify({ input: { stockIds: ids } }),
                }),
              );
        const items = entries.map((s) => renderRow(s, quoteMap.get(s.id) ?? null));
        const extras =
          entries.length === 0
            ? syntheticCandidates(q).map((id) =>
                renderRow({ id, name: '（未入库，添加时自动登记）' }, null),
              )
            : [];
        const all = [...items, ...extras];
        if (all.length === 0) {
          acList.hidden = true;
          return;
        }
        acList.replaceChildren(...all);
        acList.hidden = false;
      })();
    }, 300);
  });

  const [errorNode, actions] = actionRow('添加到分组', async (_button, errorNodeSubmit) => {
    let stockId = selectedStockId;
    let stockName = selectedStockName;
    if (stockId.length === 0) {
      const raw = stockInput.value.trim().toUpperCase();
      if (raw.length === 0) {
        errorNodeSubmit.textContent = '请选择候选或填写完整代码';
        return;
      }
      const first = raw.split(/\s+/)[0] ?? '';
      if (!STOCK_ID_PATTERN_UI.test(first)) {
        errorNodeSubmit.textContent = '股票代码必须形如 002594.SZ（代码.交易所）';
        return;
      }
      stockId = first;
      stockName = '';
    }
    if (existing.has(stockId)) {
      errorNodeSubmit.textContent = `${stockId} 已在分组中`;
      return;
    }
    const input = { groupId: group.id, stockId, ...(stockName.length > 0 ? { stockName } : {}) };
    const r = await callApi('/api/tools/add_group_member/call', {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    if (!r.ok) {
      errorNodeSubmit.textContent = toolErrorText(r.error);
      return;
    }
    existing.add(stockId);
    closeModal();
    await onAdded();
    notify(`已添加 ${stockId} 到分组「${group.name}」`);
  });

  const form = el('div', 'add-member-form');
  form.append(
    field(
      '股票',
      acWrap,
      '输 6 位代码 / 1-5 位字母，按候选点选；已有记录的股票会自动带现价与日内涨幅；批量维护请改用「编辑分组」',
    ),
    errorNode,
    actions,
  );
  openModal(`添加成员 · ${group.name}`, form, 'modal-wide');
};

const poolRuleFields = (kind, current, tactics = []) => {
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
      field('战法', tacticSelect('pool-tactic-id', tactics, current?.tacticId), '选择一个战法'),
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

export const openPoolModal = async (pool = null, preferredGroupId = '') => {
  const groupsResult = await callApi('/api/groups');
  if (!groupsResult.ok) {
    notify(`无法读取分组：${toolErrorText(groupsResult.error)}`, true);
    return;
  }
  const tactics = await loadTactics();
  const form = el('div');
  const name = control('input', 'pool-name', pool?.name ?? '');
  const description = control('textarea', 'pool-description', pool?.description ?? '');
  const groupId = control('select', 'pool-group-id');
  for (const item of groupsResult.data.groups) {
    groupId.append(option(item.group.id, item.group.name));
  }
  groupId.value =
    pool?.groupId ?? (preferredGroupId || groupsResult.data.groups[0]?.group.id || '');
  const targetBox = el('div');
  let targetModeControl = null;
  let targetMode = 'existing';
  if (pool === null && preferredGroupId.length === 0) {
    targetMode = groupsResult.data.groups.length > 0 ? 'existing' : 'new';
    const modeGrid = el('div', 'target-mode-grid');
    const targetRadio = (value, title, copy) => {
      const radio = control('input', `pool-target-${value}`, value);
      radio.type = 'radio';
      radio.name = 'pool-target-mode';
      radio.checked = targetMode === value;
      radio.disabled = value === 'existing' && groupsResult.data.groups.length === 0;
      const card = el('label', 'target-mode-card', [
        radio,
        el('span', null, [el('strong', null, title), el('small', null, copy)]),
      ]);
      radio.addEventListener('change', () => {
        targetMode = value;
        drawTarget();
      });
      return card;
    };
    modeGrid.append(
      targetRadio('existing', '选择已有分组', '复用同一组成员，可被多个方案监控'),
      targetRadio('new', '顺手创建分组', '先定义成员，再为它配置盯盘规则'),
    );

    const drawTarget = () => {
      if (targetMode === 'existing') {
        targetBox.replaceChildren(
          field(
            '成员分组',
            groupId,
            groupsResult.data.groups.length > 0
              ? '分组只负责“看哪些股票”，可被多个盯盘方案复用。'
              : '还没有可选分组，请改为“顺手创建分组”。',
          ),
        );
        return;
      }
      const inlineName = control(
        'input',
        'inline-group-name',
        name.value.trim() ? `${name.value.trim()}分组` : '',
      );
      const inlineKind = control('select', 'inline-group-kind', 'manual');
      for (const [value, label] of [
        ['manual', '手动成员'],
        ['holdings', '账户持仓'],
        ['formula', '战法动态选股'],
        ['llm', 'LLM 动态选股'],
      ]) {
        inlineKind.append(option(value, label));
      }
      const inlineResolver = el('div');
      const drawInlineResolver = () => {
        inlineResolver.replaceChildren(groupResolverFields(inlineKind.value, null, tactics));
      };
      inlineKind.addEventListener('change', drawInlineResolver);
      drawInlineResolver();
      targetBox.replaceChildren(
        el('div', 'inline-group-panel', [
          el('div', 'inline-group-heading', [
            el('span', 'eyebrow', '成员定义'),
            el('strong', null, '新建股票分组'),
          ]),
          field('分组名称', inlineName),
          field('成员来源', inlineKind),
          inlineResolver,
        ]),
      );
    };
    name.addEventListener('input', () => {
      const inlineName = $('#inline-group-name');
      if (inlineName !== null && inlineName.dataset.edited !== 'true') {
        inlineName.value = name.value.trim() ? `${name.value.trim()}分组` : '';
      }
    });
    targetBox.addEventListener('input', (event) => {
      if (event.target.id === 'inline-group-name') {
        event.target.dataset.edited = 'true';
      }
    });
    targetModeControl = field('监控对象', modeGrid);
    drawTarget();
  } else {
    if (pool === null) groupId.disabled = true;
    targetBox.append(field('成员分组', groupId, '分组负责“看哪些股票”，盯盘方案负责“何时提醒”。'));
  }
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
    ruleBox.replaceChildren(poolRuleFields(kind.value, current, tactics));
  };
  kind.addEventListener('change', drawRule);
  drawRule();
  const cooldown = control('input', 'pool-cooldown', String(pool?.cooldownMinutes ?? 30));
  form.append(field('名称', name), field('说明', description));
  if (targetModeControl !== null) form.append(targetModeControl);
  form.append(
    targetBox,
    field('触发规则', kind, '成员分组决定看谁；这里决定何时提醒。'),
    ruleBox,
    field('通知冷却（分钟）', cooldown),
  );
  const [errorNode, actions] = actionRow(
    pool ? '保存修改' : '创建盯盘方案',
    async (button, error) => {
      button.disabled = true;
      error.textContent = '';
      let createdGroupId = null;
      if (pool === null && targetMode === 'new') {
        const inlineKind = $('#inline-group-kind').value;
        const groupResult = await callTool('create_stock_group', {
          name: $('#inline-group-name').value.trim(),
          resolver: readResolver(inlineKind),
          refreshPolicy: inlineKind === 'manual' || inlineKind === 'holdings' ? 'manual' : 'daily',
          enabled: true,
        });
        if (!groupResult.ok) {
          button.disabled = false;
          error.textContent = `分组创建失败：${toolErrorText(groupResult.error)}`;
          return;
        }
        createdGroupId = groupResult.data.group.id;
      }
      const input = {
        ...(pool ? { id: pool.id } : {}),
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        groupId: createdGroupId ?? groupId.value,
        rules: [readRule(kind.value), ...(pool?.rules.slice(1) ?? [])],
        cooldownMinutes: Number(cooldown.value),
        enabled: pool?.enabled ?? true,
      };
      const result = await callTool(pool ? 'update_stock_pool' : 'create_stock_pool', input);
      button.disabled = false;
      if (!result.ok) {
        if (createdGroupId !== null) {
          await callTool('delete_stock_group', { id: createdGroupId });
        }
        error.textContent = toolErrorText(result.error);
        return;
      }
      closeModal();
      await refreshWatch();
      notify(pool ? '盯盘方案已更新' : '盯盘方案已创建');
    },
  );
  form.append(errorNode, actions);
  openModal(pool ? `编辑盯盘方案 · ${pool.name}` : '新建盯盘方案', form);
};

export const mutateEntity = async (tool, input, after, message) => {
  const result = await callApi(`/api/tools/${tool}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  if (!result.ok) {
    notify(`${message}失败：${toolErrorText(result.error)}`, true);
    return false;
  }
  await after();
  notify(message);
  return true;
};
