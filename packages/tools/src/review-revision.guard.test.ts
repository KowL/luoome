import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * REQ-M4-03「不产生自动发布」的**第二重**保证。
 *
 * 第一重是状态枚举里没有已生效态（类型上写不出来）。
 * 但类型挡不住「绕过枚举直接调 `publish_strategy_version`」——
 * 所以这条守卫查的是**产出路径调用了什么**。
 *
 * > 「枚举没有」和「路径不调」是两件事，两者都要。
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('提案产出路径不调用发布类工具', () => {
  it('`propose-review-revision.ts` 里没有任何发布调用', () => {
    const source = stripComments(read('packages/tools/src/tools/propose-review-revision.ts'));
    for (const forbidden of [
      'publish_strategy_version',
      'publishStrategyVersionTool',
      'publish_strategy',
      'activate_strategy',
    ])
      expect(source, `提案路径不应出现 ${forbidden}`).not.toContain(forbidden);
  });

  it('提案路径**不写策略版本仓储**（只返回提案对象）', () => {
    const source = stripComments(read('packages/tools/src/tools/propose-review-revision.ts'));
    // 不得出现「把 proposal 塞进 strategy 仓储」这类动作
    expect(source).not.toContain('strategy.save');
    expect(source).not.toContain('strategyVersion.save');
    expect(source).not.toContain('publishVersion');
  });

  it('**正向**：输出 schema 的 `published` 是字面量 false（不是 boolean）', () => {
    const source = stripComments(read('packages/tools/src/tools/propose-review-revision.ts'));
    // `z.literal(false)` 让「已发布」在类型上无法表达
    expect(source).toContain('z.literal(false)');
    expect(source).not.toContain('published: z.boolean()');
  });

  it('提案状态的写入点**只有** `draft`（不接受外部传状态）', () => {
    const source = stripComments(read('packages/tools/src/tools/propose-review-revision.ts'));
    // 输入 schema 里不得出现 status 字段
    expect(source).not.toContain('status: z.enum');
    // 输出对象里硬编码 draft
    expect(source).toContain("status: 'draft'");
  });
});
