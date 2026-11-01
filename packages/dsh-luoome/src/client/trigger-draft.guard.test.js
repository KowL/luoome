// M4-10 路径二（AI 草稿）的**源码级守卫**。
//
// ## 为什么是源码级，而不是浏览器里找 composer
//
// 需求负责人裁定：**不为测试改产品契约**（不加宿主发送入口、不加可注入 `send`）。
// 而浏览器验收里 composer 在 DSH 宿主内，选择器无法可靠命中——
// 那一层的证据只能到「它自己说没提交」（弱）。
//
// 真正可靠的是**代码结构**：草稿路径必须复用 `openPromptInConversation`
// （关注页「交给 AI 管理」的同一范式，该范式从未自动发送），
// 且**不得出现任何发送调用**。这验的是结构，不是运行时的偶然现象。
//
// `composerHasPrompt: false` 在浏览器证据里的含义是「我没找到」，**不是「没写入」**——
// 这条注解也写进了 `panels-browser-acceptance.ts` 的 evidence。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = resolve(import.meta.dirname);
const read = (file) => readFileSync(resolve(CLIENT_ROOT, file), 'utf8');

/** 去注释再断言：注释里会出现「不发送」这类说明，算进去会误判。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出 `draft` 函数体（从 `const draft = (view)` 到匹配的闭括号）。 */
const draftBody = (source) => {
  const start = source.indexOf('const draft = (view) => {');
  if (start < 0) throw new Error('找不到 alerts.js 的 draft 函数');
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('draft 函数体未闭合');
};

describe('路径二：AI 草稿不得自动发送（源码级）', () => {
  it('index.js 的 openTriggerEditInConversation **复用** openPromptInConversation', () => {
    const source = stripComments(read('index.js'));
    const start = source.indexOf('export const openTriggerEditInConversation');
    expect(start).toBeGreaterThan(-1);
    // 取到下一个 export 之前
    const nextExport = source.indexOf('export const', start + 10);
    const body = source.slice(start, nextExport < 0 ? undefined : nextExport);
    expect(body).toContain('openPromptInConversation');
    // 同一个 composer 写入范式，不做任何额外发送
    expect(body).not.toMatch(/\bsendMessage\b|\bsendStockAnalysis\b|\bsubmit\b/i);
  });

  it('alerts.js 的草稿路径只上抛提示词，自己不发消息', () => {
    const body = draftBody(stripComments(read('alerts.js')));
    // 只交给注入的回调（由 index.js 走 composer 写入）
    expect(body).toContain('onDraftTriggerEdit');
    // **不得**出现任何发送调用
    expect(body).not.toMatch(/\bsendMessage\b|\bsendStockAnalysis\b|\bdispatchSend\b|\bsubmit\b/i);
    // 也不得自己打网络请求（fetch/XHR 都算发送）
    expect(body).not.toMatch(/\bfetch\s*\(|XMLHttpRequest/);
  });

  it('整个 alerts.js 里不存在「草稿路径直接发消息」的分支', () => {
    const source = stripComments(read('alerts.js'));
    // 发送型工具在告警面板里根本不该出现
    for (const forbidden of ['sendMessage', 'sendStockAnalysis', 'dispatchSend'])
      expect(source, `alerts.js 出现了发送调用：${forbidden}`).not.toContain(forbidden);
  });

  it('草稿提示词本身要求「我确认后再写入」，不诱导自动写入', () => {
    // 提示词模板在纯逻辑模块里，与「是否发送」是两件事，但同属「不替用户做决定」。
    const source = stripComments(read('alert-trigger-model.js'));
    expect(source).toContain('我确认后再写入');
  });
});
