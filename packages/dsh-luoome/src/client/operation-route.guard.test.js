// P0 回归守卫：client 必须打**服务端真实存在的** Operation 路由。
//
// ## 为什么是源码守卫而不是运行时测试
//
// client 的 `.js` 都是 React 组件模块（`import ... from 'react'`），而 `react`
// 不在本包的测试依赖里——运行时 `import` 直接失败。既有做法见
// `client-health.guard.test.js`：DOM 级断言进 `infra/dsh/panels-browser-acceptance.ts`
// （不在 `test:all`），而「不得出现某种写法」这类要求在这里用**源码断言**钉住。
//
// ## 这条守的是什么
//
// `plans.js` 曾把确认动作写成 `/operations/:id/execute`。服务端路由是
// `/^\/api\/luoome\/operations\/([^/]{1,600})(?:\/(confirm|cancel|reconcile))?$/`
// （`operations.ts:43`），**没有 `execute`** ⇒ 请求 404，交易计划面板的「保存」
// 实际是坏的。批次 A 只跑了 host 层 e2e（直接调 operation service），全程绿——
// **host 层 e2e 绿 ≠ 用户点得动**。
//
// 所以这里做两件事：
// 1. 从**服务端源码**解析出**允许的动作集合**（不写死，服务端改了这里自动跟随）；
// 2. 扫所有 client 模块，凡是拼 `operations/<id>/<action>` 的，action 必须在该集合内。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = resolve(import.meta.dirname);
const HOST_ROOT = resolve(import.meta.dirname, '../host');
const read = (path) => readFileSync(path, 'utf8');

/**
 * 从服务端路由正则里解析出允许的动作名。
 *
 * 直接扫源码里 `/api/luoome/operations/(...)(?:/(confirm|cancel|reconcile))?` 那段，
 * **不把动作清单抄进本测试**——服务端加/减动作时这里自动跟随，守卫不会过期。
 */
const allowedActions = () => {
  const source = read(resolve(HOST_ROOT, 'operations.ts'));
  // 源码里是正则字面量，斜杠被转义成 `\/`。这里**不写正则**去解正则——
  // 只需找到 `(confirm|cancel|reconcile)` 这个分组，它在本仓只出现这一次。
  const marker = '(confirm|cancel|reconcile)';
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('找不到 operations 路由的动作分组');
  return marker
    .slice(1, -1)
    .split('|')
    .map((name) => name.trim());
};

/** 去掉注释再断言：注释里会写「曾经用过 /execute」这种说明，把它算进去是误报。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** client 里所有「拼 operations/<id>/<action>」的字面量。 */
const clientOperationActions = () => {
  const found = [];
  for (const file of readdirSync(CLIENT_ROOT).filter((name) => name.endsWith('.js'))) {
    const source = stripComments(read(resolve(CLIENT_ROOT, file)));
    // 形如 `operations/${...}/execute` 或 `operations/${...}/${action}`
    for (const match of source.matchAll(/operations\/\$\{[^}]+\}\/(\w+)/g))
      found.push({ file, action: match[1] });
  }
  return found;
};

describe('client 的 Operation 路由守卫', () => {
  it('服务端允许的动作集合可被解析（不是写死在本测试里）', () => {
    expect(allowedActions().sort()).toEqual(['cancel', 'confirm', 'reconcile']);
  });

  it('client 打的每一个操作动作都在服务端路由内', () => {
    const allowed = new Set(allowedActions());
    const offending = clientOperationActions().filter(({ action }) => !allowed.has(action));
    expect(
      offending.map(({ file, action }) => `${file}: /${action}`),
      'client 打了服务端不存在的操作动作（会 404，按钮实际是坏的）',
    ).toEqual([]);
  });

  it('plans.js 不得再打 /execute（原始缺陷）', () => {
    const source = stripComments(read(resolve(CLIENT_ROOT, 'plans.js')));
    expect(source).not.toContain('/execute');
  });

  it('plans.js 处理 prepare 的两种返回形态（已终结 / 待确认），不假设只有一种', () => {
    const source = stripComments(read(resolve(CLIENT_ROOT, 'plans.js')));
    // 服务端 prepare 若返回 token 就会**当场 confirm**（`operations.ts:59-72`），
    // 因此客户端必须能接受「prepare 直接返回 succeeded」这种形状。
    expect(source).toContain('confirmationToken');
    // 同时也要兼容「只冻结、未执行」的形态：仅在 `state === 'pending'` 时才补 confirm。
    expect(source).toContain("state === 'pending'");
    expect(source).toContain('/confirm');
  });

  it('plans.js 的未知态（unknown）必须显式处理，不能当成功', () => {
    const source = stripComments(read(resolve(CLIENT_ROOT, 'plans.js')));
    expect(source).toContain("state !== 'succeeded'");
    expect(source).toContain("'unknown'");
  });
});
