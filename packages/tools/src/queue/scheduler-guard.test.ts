import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * REQ-M5-01 源码守卫：**调度不判「数据是否到位」**。
 *
 * PRD 原文：「调度不写入『数据是否到位』的判断字段（**由 `get_market_data_status` 决定**）」。
 *
 * 理由：调度只该回答「什么时候跑」，不该回答「数据够不够」。
 * 一旦调度自己判断数据到位与否，就会出现**两套健康判定**——
 * 面板显示「数据不全」但调度照跑，或者反过来。用户无法判断该信哪个。
 */
const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const FORBIDDEN_IN_SCHEDULING = [
  'dataHealth',
  'hasData',
  'isReady',
  'dataReady',
  'isDataComplete',
  'get_market_data_status',
] as const;

describe('调度路径不判断「数据是否到位」', () => {
  for (const path of ['packages/tools/src/queue/jobs.ts', 'packages/tools/src/queue/context.ts']) {
    it(`${path} 不出现数据到位判定`, () => {
      const source = stripComments(read(path));
      for (const forbidden of FORBIDDEN_IN_SCHEDULING)
        expect(source, `${path} 不应出现 ${forbidden}`).not.toContain(forbidden);
    });
  }

  it('对照：`get_market_data_status` 工具本身当然可以判（它是那个唯一真源）', () => {
    // 这条是**反向确认**：禁止的是「调度自己判」，不是「没人能判」。
    const source = read('packages/tools/src/tools/get-market-data-status.ts');
    expect(source.length).toBeGreaterThan(0);
  });
});
