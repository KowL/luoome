import { describe, expect, it } from 'vitest';

import { notificationText } from './notification.js';

const FIRST = '若价格无法收复MA5(约36)并跌破MA10(约35.24)，多头结构可能被破坏需放弃入场';
const SECOND = '相对MA60距离已达10.77%，大盘转弱时回撤幅度可能较大';

describe('notificationText', () => {
  it('放得下时保留全部分段', () => {
    expect(notificationText(`${FIRST}；${SECOND}`, 200)).toBe(`${FIRST}；${SECOND}`);
  });

  it('超长时保留完整分段，不在句子中间截断', () => {
    const out = notificationText(`${FIRST}；${SECOND}`, 60);
    expect(out).toBe(FIRST);
    expect(out).not.toContain('…');
  });

  it('单段自身超限才退化为按字数截断', () => {
    expect(notificationText(SECOND, 10)).toBe(`${SECOND.slice(0, 9)}…`);
  });

  it('丢弃含内部身份的段落，保留可读原因', () => {
    const out = notificationText(
      `${FIRST}；计划版本 account:manual-account-8b1af13a-bfb1-42ba-bd96-2f623dab4e01:stock:000753.SZ:v1`,
      200,
    );
    expect(out).toBe(FIRST);
  });
});
