import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const originals = new Map(
  ['Node', 'document', 'localStorage', 'sessionStorage', 'fetch'].map((key) => [
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
const pendingKey = 'luoome.decisionPending';
const subject = { kind: 'advice', id: 'advice-1' };
const refusal = (kind = 'invariant_violation') => ({
  ok: false,
  error: { kind, message: '账本已变化，请刷新', entity: 'DecisionWriteReceipt' },
});
let body;
let requests;
let respond;
let openDecisionReview;
let revision;
let caseId = 0;
const button = (text) =>
  allNodes(body).find((node) => node.tagName === 'button' && node.textContent === text);
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
const click = async (text) => {
  button(text).click();
  await settle();
};
const pending = () => JSON.parse(sessionStorage.getItem(pendingKey));
const context = () => ({
  accountId: 'account-a',
  stockId: null,
  sourceOccurredAt: '2026-09-30T01:00:00Z',
  context: { contextHash: 'context-hash', source: {} },
  selected: null,
  selectedRevision: null,
  current: revision ? { review: { currentRevision: revision } } : null,
  candidateTrades: [],
  revisions: [],
  observations: [],
  observationStatus: 'unavailable',
});

beforeEach(async () => {
  body = new TestNode('div');
  const nodes = new Map([
    ['#modal-body', body],
    ['#modal-title', new TestNode('h2')],
    ['#modal-overlay', new TestNode('div')],
  ]);
  install('Node', TestNode);
  install('document', {
    createElement: (tag) => new TestNode(tag),
    createTextNode: (text) => Object.assign(new TestNode(), { textContent: text }),
    querySelector: (selector) => nodes.get(selector) ?? null,
  });
  install('localStorage', storage());
  install('sessionStorage', storage());
  localStorage.setItem('luoome.accountId', 'account-a');
  requests = [];
  revision = 0;
  respond = () => refusal();
  install('fetch', async (path, init) => {
    const request = {
      path,
      accountId: init.headers.get('x-luoome-account-id'),
      input: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (path.startsWith('/api/decision-reviews/context'))
      return Response.json({ ok: true, data: context() });
    return Response.json(await respond(request));
  });
  ({ openDecisionReview } = await import(`./decision-review-ui.js?case=${caseId++}`));
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

describe('决策复盘未决请求恢复', () => {
  it('原子拒绝后核对回执，重新读取修订并允许新请求', async () => {
    await openDecisionReview(subject);
    await click('保存复盘');
    const first = pending();
    expect(first.outcome).toBe('rejected');
    revision = 2;
    respond = (request) => (request.input ? { ok: true, data: {} } : refusal('not_found'));
    await click('确认未提交并重新加载');
    expect(pending()).toBeNull();
    await click('保存复盘');
    const writes = requests.filter((request) => request.input);
    expect(writes).toHaveLength(2);
    expect(writes[1].input.requestId).not.toBe(first.input.requestId);
    expect(writes[1].input.expectedRevision).toBe(2);
    expect(requests.every((request) => request.accountId === 'account-a')).toBe(true);
  });

  it.each(['invalid_input', 'not_found', 'permission_denied'])(
    '%s 明确拒绝也可核对后恢复',
    async (kind) => {
      respond = () => refusal(kind);
      await openDecisionReview(subject);
      await click('保存复盘');
      expect(pending().outcome).toBe('rejected');
      expect(button('确认未提交并重新加载')).toBeDefined();
    },
  );

  it('响应丢失后 not_found 回执不足以释放请求，重试保持原键和内容', async () => {
    respond = () => {
      throw new TypeError('response lost');
    };
    await openDecisionReview(subject);
    await click('保存复盘');
    const first = pending();
    expect(first.outcome).toBe('unknown');
    expect(button('确认未提交并重新加载')).toBeUndefined();
    respond = (request) => refusal(request.input ? 'invariant_violation' : 'not_found');
    await click('查询上次未决提交');
    await click('复用原请求重试');
    expect(pending().input).toEqual(first.input);
    expect(pending().outcome).toBe('unknown');
    expect(button('确认未提交并重新加载')).toBeUndefined();
    await click('保存复盘');
    expect(requests.filter((request) => request.input)).toHaveLength(2);
  });

  it('写入和重试期间禁用并阻止并发查询与重试', async () => {
    let complete;
    respond = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    await openDecisionReview(subject);
    await click('保存复盘');
    expect(button('复用原请求重试').disabled).toBe(true);
    expect(button('查询上次未决提交').disabled).toBe(true);
    await click('复用原请求重试');
    expect(requests.filter((request) => request.input)).toHaveLength(1);
    complete(refusal());
    await settle();
    await click('复用原请求重试');
    expect(button('复用原请求重试').disabled).toBe(true);
    await click('复用原请求重试');
    expect(requests.filter((request) => request.input)).toHaveLength(2);
    complete({ ok: true, data: {} });
    await settle();
    expect(pending()).toBeNull();
  });

  it('账户切换阻止恢复、查询和重试，异步回执也不能清除原账户请求', async () => {
    await openDecisionReview(subject);
    await click('保存复盘');
    const first = pending();
    localStorage.setItem('luoome.accountId', 'account-b');
    const count = requests.length;
    await click('确认未提交并重新加载');
    await click('查询上次未决提交');
    await click('复用原请求重试');
    expect(requests).toHaveLength(count);
    localStorage.setItem('luoome.accountId', 'account-a');
    let complete;
    respond = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    await click('确认未提交并重新加载');
    localStorage.setItem('luoome.accountId', 'account-b');
    complete(refusal('not_found'));
    await settle();
    expect(pending().input).toEqual(first.input);
  });

  it('恢复核对若发现成功回执则收敛为成功，查询失败则保留原请求', async () => {
    let saved = 0;
    await openDecisionReview(subject, {
      onSaved: () => {
        saved++;
      },
    });
    await click('保存复盘');
    respond = () => refusal('internal');
    await click('确认未提交并重新加载');
    expect(pending()).not.toBeNull();
    respond = () => ({ ok: true, data: {} });
    await click('确认未提交并重新加载');
    expect(pending()).toBeNull();
    expect(saved).toBe(1);
  });
});
