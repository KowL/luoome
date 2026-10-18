import { afterEach, beforeEach, expect, it } from 'bun:test';
import { clearHostedSession, configureHostedSession, setAccountId } from './api.js';

const keys = ['Node', 'document', 'window', 'location', 'history', 'sessionStorage', 'fetch'];
let originals;
let values;
let input;
let host;
let events;
const install = (key, value) =>
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const login = (id) => {
  configureHostedSession({ user: { id }, csrfToken: id });
  setAccountId('account');
};

beforeEach(() => {
  originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  values = new Map();
  events = new EventTarget();
  input = { value: '', addEventListener() {}, focus() {} };
  host = { hidden: true, scrollIntoView() {} };
  install('document', {
    body: { dataset: { runtime: 'hosted' } },
    documentElement: { style: { setProperty() {} } },
    querySelector: (selector) =>
      selector === '#chat-input' ? input : selector === '#workspace-discussion' ? host : null,
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  install('window', { innerHeight: 800, scrollY: 120, requestAnimationFrame: (fn) => fn() });
  install('location', { hash: '#dashboard' });
  install('history', { state: null, pushState() {} });
  install('sessionStorage', {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  login('user-a');
});

afterEach(() => {
  clearHostedSession();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const subjects = [{ ref: { kind: 'stock', id: '002594.SZ' }, label: 'A 的持仓' }];

it('跳转首页期间切换身份，不在新身份读取或恢复旧讨论', async () => {
  const requests = [];
  install('fetch', async (path) => {
    requests.push(path);
    return Response.json({ ok: true, data: { sessions: [] } });
  });
  location.hash = '#holdings';
  window.requestAnimationFrame = (fn) => {
    login('user-b');
    fn();
  };
  const { openWorkspaceDiscussion } = await import('./workspace.js');
  await openWorkspaceDiscussion(subjects, 'A 的私人问题');
  expect(requests).toEqual([]);
  expect(input.value).toBe('');
  expect(host.hidden).toBe(true);
});

it('读取讨论期间切换身份，不把旧卡片和问题写入新身份草稿', async () => {
  let complete;
  let requested;
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  install(
    'fetch',
    () =>
      new Promise((resolve) => {
        complete = resolve;
        requested();
      }),
  );
  const { openWorkspaceDiscussion } = await import('./workspace.js');
  const opening = openWorkspaceDiscussion(subjects, 'A 的私人问题');
  await started;
  login('user-b');
  complete(Response.json({ ok: true, data: { sessions: [] } }));
  await opening;
  expect(input.value).toBe('');
  expect(host.hidden).toBe(true);
  expect(sessionStorage.getItem('luoome.workspace.chat')).toBeNull();
});

it('身份未变化时正常打开卡片讨论并保存主体和问题', async () => {
  install('fetch', async () => Response.json({ ok: true, data: { sessions: [] } }));
  const { openWorkspaceDiscussion } = await import('./workspace.js');
  await openWorkspaceDiscussion(subjects, '请核对风险');
  expect(host.hidden).toBe(false);
  expect(input.value).toBe('请核对风险');
  expect(JSON.parse(sessionStorage.getItem('luoome.workspace.chat'))).toMatchObject({
    identity: 'user-a:account',
    subjects,
    draft: '请核对风险',
  });
});

it('市场方向展示真实覆盖与来源，保存共识后不提供无映射的跟踪入口', async () => {
  class TestNode {
    constructor() {
      this.children = [];
      this.textContent = '';
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    addEventListener() {}
    setAttribute() {}
  }
  install('Node', TestNode);
  const nodes = new Map();
  document.createElement = () => new TestNode();
  document.createTextNode = (text) => Object.assign(new TestNode(), { textContent: text });
  document.querySelectorAll = () => [];
  document.querySelector = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new TestNode());
    return nodes.get(selector);
  };
  window.addEventListener = () => {};
  window.scrollTo = () => {};
  const now = '2026-10-16T08:00:00Z';
  const reason = '没有真实策略和股票候选映射，暂不能开启个股跟踪。';
  const source = { kind: 'market-snapshot', snapshotId: 'snapshot-a', subject: 'market-breadth' };
  const direction = {
    id: 'direction-a',
    name: '广度观察',
    opportunityType: 'market-participation',
    source,
    rank: 1,
    stance: 'observe',
    rationale: '先核对风险',
    comparisonReason: '只有广度可用',
    coverage: {
      kind: 'market-facts',
      scope: 'CN_A_SHARES_SH_SZ',
      observedCount: 100,
      unit: 'stocks',
      dataHealth: 'partial',
      description: '本次来源范围，不能外推为完整选股。',
    },
    evidenceIds: ['evidence-a'],
    objections: [],
    risks: ['广度不能代替逐股判断'],
    waitFor: ['补充个股证据'],
    abandonWhen: ['事实变化'],
    reviewWhen: ['下次开盘'],
    horizon: 'short',
    dataAsOf: now,
    validUntil: now,
    tracking: { eligible: false, reason },
  };
  const investment = {
    research: {
      id: 'research-a',
      status: 'complete',
      directions: [direction],
      limitations: [],
      disclaimers: ['仅用于讨论'],
      evidence: [
        {
          id: 'evidence-a',
          text: '本次读取 100 只',
          source,
          dataAsOf: now,
          provenance: [{ provider: 'fixture-market', observedAt: now, fetchedAt: now }],
        },
      ],
    },
    consensus: {
      id: 'consensus-a',
      version: 1,
      reviewAt: now,
      validUntil: now,
      constraints: [],
      selections: [{ direction, role: 'observe', userReason: '先观察' }],
    },
    consensusState: 'confirmed',
    tracking: null,
    history: [],
    limitations: [],
    trackingEligibility: {
      eligible: false,
      reason,
      mappedDirectionIds: [],
      unmappedDirections: [{ directionId: direction.id, reason }],
    },
  };
  const ok = (data) => ({ ok: true, data });
  install('fetch', async () =>
    Response.json(
      ok({
        readAt: now,
        account: ok({ account: { name: 'fixture', initialCapital: 0, cashBalance: 0 } }),
        holdings: ok({ holdings: [] }),
        plans: ok({ plans: [], views: [] }),
        facts: ok({ status: 'unavailable', reasons: [] }),
        watch: ok({ latest: null }),
        reports: ok({ reports: [] }),
        investment: ok(investment),
        candidates: ok({ candidates: [] }),
      }),
    ),
  );
  const { renderInvestmentWorkspace } = await import('./workspace.js');
  await renderInvestmentWorkspace();
  const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
  const directions = text(nodes.get('#workspace-directions'));
  expect(directions).toContain('100 只股票');
  expect(directions).toContain('部分数据');
  expect(directions).toContain('fixture-market');
  expect(directions).not.toContain('undefined');
  expect(directions).not.toContain('入选');
  const consensus = text(nodes.get('#workspace-consensus'));
  expect(consensus).toContain('当前共识 · v1');
  expect(consensus).toContain(reason);
  expect(consensus).not.toContain('连接 / 恢复方向跟踪');
});
