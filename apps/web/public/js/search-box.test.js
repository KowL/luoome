/* apps/web/public/js/search-box.test.js —— 搜索框组件纯函数测试。
 * DOM 交互（debounce / 键盘 / 浮层）由浏览器验收覆盖，这里只测选中策略。
 */

import { describe, expect, it } from 'bun:test';

import { pickSearchCandidate } from './search-box.js';

const stock = (id) => ({ id, code: id.split('.')[0], name: `股票${id}`, exchange: 'SZ' });

describe('Enter 选中策略', () => {
  it('无高亮（active=-1）时取第一条', () => {
    const items = [stock('000001.SZ'), stock('002594.SZ')];
    expect(pickSearchCandidate(items, -1).id).toBe('000001.SZ');
  });

  it('有高亮时取高亮项', () => {
    const items = [stock('000001.SZ'), stock('002594.SZ')];
    expect(pickSearchCandidate(items, 1).id).toBe('002594.SZ');
  });

  it('空列表返回 undefined（调用方不应跳转）', () => {
    expect(pickSearchCandidate([], -1)).toBeUndefined();
  });
});
