import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { setAccountId } from './api.js';

const originals = new Map(
  ['Node', 'document', 'localStorage', 'fetch'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const install = (key, value) =>
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

class TestNode {
  constructor(tag = '') {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute() {}
  after() {}
  remove() {}
  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }
  click() {
    if (!this.disabled) return this.listeners.get('click')?.();
  }
}
const allNodes = (root) => [root, ...root.children.flatMap(allNodes)];
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};
const subject = { kind: 'advice', id: 'advice-1' };
let body;
let requests;
let respond;
let openDecisionReview;
let caseId = 0;
const nodeByText = (text) =>
  allNodes(body).find((node) => node.tagName === 'button' && node.textContent === text);
const nodeById = (id) => allNodes(body).find((node) => node.id === id);
const texts = () =>
  allNodes(body)
    .map((node) => node.textContent)
    .filter((value) => value !== '');
const settle = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const click = async (text) => {
  nodeByText(text).click();
  await settle();
};

beforeEach(async () => {
  body = new TestNode('div');
  const nodes = new Map([
    ['#modal-body', body],
    ['#modal-title', new TestNode('h2')],
    ['#modal-overlay', new TestNode('div')],
  ]);
  install('Node', TestNode);
  install('document', {
    addEventListener() {},
    dispatchEvent() {},
    createElement: (tag) => new TestNode(tag),
    createTextNode: (text) => Object.assign(new TestNode(), { textContent: text }),
    querySelector: (selector) => nodes.get(selector) ?? null,
  });
  install('localStorage', storage());
  localStorage.setItem('luoome.accountId', 'account-a');
  requests = [];
  respond = () => ({ ok: true, data: { review: {} } });
  install('fetch', async (path, init) => {
    const headers = init.headers ?? {};
    const headerValue =
      typeof headers.get === 'function'
        ? headers.get('x-luoome-account-id')
        : headers['x-luoome-account-id'];
    requests.push({
      path,
      accountId: headerValue,
      input: init.body ? JSON.parse(init.body) : null,
    });
    if (path.startsWith('/api/decision-reviews?'))
      return Response.json({
        ok: true,
        data: { accountId: 'account-a', records: [], nextCursor: null },
      });
    return Response.json(respond());
  });
  ({ openDecisionReview } = await import(`./decision-review-ui.js?case=${caseId++}`));
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe('决策复盘单表弹窗', () => {
  it('按 subject 读取最近复盘并提交单表 save_decision_review 语义', async () => {
    setAccountId('account-a');
    let saved = 0;
    await openDecisionReview(subject, { onSaved: async () => (saved += 1) });
    expect(requests[0]?.path).toContain('subjectKind=advice');
    expect(requests[0]?.path).toContain('subjectId=advice-1');
    expect(requests[0]?.accountId).toBe('account-a');

    nodeById('decision-review-note').value = '复盘结论';
    nodeById('decision-review-tags').value = '按计划, 追高';
    nodeById('decision-review-trades').value = 'trade-1,trade-2';
    await click('保存复盘');
    const save = requests.find((request) => request.path === '/api/decision-reviews');
    expect(save?.input).toEqual({
      subject,
      content: {
        tradeIds: ['trade-1', 'trade-2'],
        adviceFeedback: null,
        lessonTags: ['按计划', '追高'],
        note: '复盘结论',
      },
    });
    expect(saved).toBe(1);
  });

  it('advice 反馈随复盘一起保存，盈亏未知不写成 0', async () => {
    setAccountId('account-a');
    await openDecisionReview(subject);
    nodeById('decision-review-note').value = '按建议执行';
    nodeById('decision-review-outcome').value = 'partially_followed';
    await click('保存复盘');
    const save = requests.find((request) => request.path === '/api/decision-reviews');
    expect(save?.input).toEqual({
      subject,
      content: {
        tradeIds: [],
        adviceFeedback: { outcome: 'partially_followed' },
        lessonTags: [],
        note: '按建议执行',
      },
    });
  });

  it('空内容只提示本地校验错误，不提交写入', async () => {
    setAccountId('account-a');
    await openDecisionReview(subject);
    await click('保存复盘');
    expect(requests.some((request) => request.path === '/api/decision-reviews')).toBe(false);
    expect(texts()).toContain('复盘内容不能全部为空');
  });

  it('保存失败展示 ToolError，不触发 onSaved', async () => {
    setAccountId('account-a');
    respond = () => ({ ok: false, error: { kind: 'invalid_input', message: '关联成交不可用' } });
    let saved = 0;
    await openDecisionReview(subject, { onSaved: async () => (saved += 1) });
    nodeById('decision-review-note').value = '复盘结论';
    await click('保存复盘');
    expect(saved).toBe(0);
    expect(texts().some((text) => text.includes('关联成交不可用'))).toBe(true);
  });

  it('交易计划版本映射为单表 trading-plan 对象', async () => {
    setAccountId('account-a');
    await openDecisionReview({ kind: 'trading-plan-version', id: 'plan-v1' });
    expect(requests[0]?.path).toContain('subjectKind=trading-plan');
    expect(requests[0]?.path).toContain('subjectId=plan-v1');
    nodeById('decision-review-note').value = '计划执行复盘';
    await click('保存复盘');
    const save = requests.find((request) => request.path === '/api/decision-reviews');
    expect(save?.input).toMatchObject({
      subject: { kind: 'trading-plan', id: 'plan-v1' },
    });
  });

  it('盯盘提醒改为原生反馈，不再写复盘修订', async () => {
    setAccountId('account-a');
    await openDecisionReview({ kind: 'watch-trigger', id: 'trigger-1' });
    expect(requests).toHaveLength(0);
    await click('保存反馈');
    expect(requests[0]?.path).toBe('/api/watch/triggers/trigger-1/feedback');
    expect(requests[0]?.input).toEqual({ feedback: 'handled' });
  });
});
