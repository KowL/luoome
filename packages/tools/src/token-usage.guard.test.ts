import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTestContext } from '@luoome/tools/testing';

import { describe, expect, it } from 'vitest';

import { getTokenUsageTool } from './tools/get-token-usage.js';

/**
 * REQ-M5-03 第 3 项：token 计量**只读**、缺失给 `null`、**不许估算**。
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('token 计量只读', () => {
  it('工具声明 `sideEffect: read`（写路径不存在）', () => {
    expect(getTokenUsageTool.sideEffect).toBe('read');
  });

  it('实现里**没有任何写入调用**（仓储 / 工具 / 文件）', () => {
    const source = stripComments(read('packages/tools/src/tools/get-token-usage.ts'));
    for (const forbidden of ['repos.', '.save(', '.append(', '.insert(', '.update(', 'writeFile'])
      expect(source, `token 计量不应出现写入：${forbidden}`).not.toContain(forbidden);
  });

  it('**不做估算**：实现里没有按字数/倍率推算的逻辑', () => {
    const source = stripComments(read('packages/tools/src/tools/get-token-usage.ts'));
    for (const forbidden of ['length *', '* 1.3', 'estimate', 'approximate'])
      expect(source, `token 计量不应估算：${forbidden}`).not.toContain(forbidden);
  });
});

describe('缺失时如实给 null', () => {
  it('当前实现返回 `usage: null` 且**说明原因**', async () => {
    const ctx = await buildTestContext();
    const result = await getTokenUsageTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `null` 是「未知」，不是「零消耗」
    expect(result.data.usage).toBeNull();
    // 必须能解释为什么拿不到 —— 不能静默留空
    expect(result.data.unavailableReason).not.toBeNull();
    expect(result.data.unavailableReason).toContain('弃用');
    expect(result.data.source).toBeNull();
  });
});
