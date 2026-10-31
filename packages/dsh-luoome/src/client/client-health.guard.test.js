// REQ-M3-09 S5 的 **client 侧静态守卫**。
//
// client `.js` 不在 typecheck 覆盖内（见 m3b-backlog D10），DOM 级断言只能进
// `infra/dsh/panels-browser-acceptance.ts`（不在 `test:all`、需本机 Chrome）。
// 所以「每个面板都渲染了角标」「client 不写第二份日期比较」这类要求必须在这里用
// **源码断言**钉住——否则它们只是口头约定。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname);
const read = (file) => readFileSync(resolve(ROOT, file), 'utf8');

/**
 * 客户端实际渲染的面板清单：**从 `app.js` 的 `VIEWS` 推导**，不写死数量。
 *
 * 新增一个视图时这里自动覆盖到——写死 `5` 或 `PANEL_NAMES.length` 都会让新面板漏检。
 */
const clientPanelFiles = () => {
  const app = read('app.js');
  const imports = [...app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)\.js'/g)];
  const files = [];
  for (const [, names, file] of imports) {
    // 只要**视图组件**（`OverviewPanel` 这类），不要 `Panel` 这个布局原语。
    const isView = names
      .split(',')
      .map((name) => name.trim())
      .some((name) => /^[A-Z]\w+Panel$/.test(name));
    if (isView) files.push(`${file}.js`);
  }
  return [...new Set(files)];
};

/** 只查代码，不查注释：注释里保留「为什么这样做」的说明是有价值的。 */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const clientSources = () =>
  readdirSync(ROOT)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
    .map((file) => [file, read(file)]);

describe('S5 client 静态守卫', () => {
  it('客户端面板清单从 VIEWS 推导，且每个面板顶层都渲染了健康角标', () => {
    const files = clientPanelFiles();
    // 自检：清单必须非空且确实来自 app.js，否则下面的循环会「全绿」地空转。
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('overview.js');

    // 必须**渲染**（`h(PanelHealthBadge, …)`），只 import 不算——import 了不用是死代码。
    const missing = files.filter((file) => !read(file).includes('h(PanelHealthBadge'));
    expect(missing, '这些面板没有渲染健康角标').toEqual([]);
  });

  it('角标引用的 health 必须在文件里真的绑定过（`.js` 没有 typecheck，未定义变量不会红）', () => {
    for (const file of clientPanelFiles()) {
      const source = read(file);
      const call = /h\(PanelHealthBadge, \{ key: 'health', health(?:: ([^}]+))?\s*\}/.exec(source);
      expect(call, `${file} 的角标调用形态不符合约定`).not.toBeNull();
      const expression = (call?.[1] ?? 'health').trim();
      // `indices.health` 这类成员访问：只要求根标识符在文件里出现过绑定。
      const root = expression.split(/[.\s?]/)[0];
      const bound = new RegExp(
        `(const|let|var)\\s+(\\{[^}]*\\b${root}\\b|${root}\\b)|\\b${root}\\b\\s*=`,
      ).test(source);
      expect(bound, `${file} 用了未绑定的 ${root}（会 ReferenceError）`).toBe(true);
    }
  });

  it('角标只有一个实现：面板都从 primitives 的 PanelHealthBadge 渲染', () => {
    const primitives = read('primitives.js');
    expect(primitives).toContain('export const PanelHealthBadge');
    // 三档文案与配色映射只能存在于 projection.js（纯函数）：别处出现 HEALTH_LABEL
    // 就是第二份实现。primitives 只负责渲染 projection 的产物。
    const owners = clientSources()
      .filter(([, source]) => source.includes('HEALTH_LABEL'))
      .map(([file]) => file);
    expect(owners).toEqual(['projection.js']);
    expect(primitives).toContain('panelHealthBadge');
  });

  it('client 不写第二份日期比较 / 不引 core（语义全在服务端）', () => {
    for (const [file, source] of clientSources()) {
      const code = codeOf(source);
      expect(code, `${file} 直接引了 @luoome/core`).not.toContain('@luoome/core');
      for (const forbidden of [
        'marketObservationScope',
        'marketObservationLabel',
        'dateInShanghai',
        'classifyMarketObservation',
      ])
        expect(code, `${file} 出现了第二份日期/观察判定：${forbidden}`).not.toContain(forbidden);
    }
  });

  it('BreadthCard 渲染服务端给的 label（三档措辞不在 client 拼）', () => {
    const overview = read('overview.js');
    expect(overview).toContain('marketObservationOf');
    expect(overview).toContain('marketObservation.label');
    expect(overview).toContain('data-market-observation');
    for (const wording of ['上一交易日收盘观察', '历史观察', '观测于'])
      expect(overview, `client 自己拼了市场观察措辞：${wording}`).not.toContain(wording);
  });

  it('review 面板消费 get_advice.cards，blocked 保留 warning 行（不整条消失）', () => {
    const review = read('review.js');
    expect(review).toContain('adviceCardEntriesOf');
    expect(review).toContain('AdviceCardRow');
    // blocked 分支必须返回一个 tr（有条目），而不是 null/不渲染。
    const blockedBranch = review.slice(
      review.indexOf("if (entry.status === 'blocked')"),
      review.indexOf("data-advice-card': 'renderable'"),
    );
    expect(blockedBranch).toContain("'data-advice-card': 'blocked'");
    expect(blockedBranch).toContain('entry.text');
    expect(blockedBranch).toContain('entry.missing.join');
  });

  it('Kpi / Stat 有时点槽，缺时点渲染「时点未知」而不是省略', () => {
    const primitives = read('primitives.js');
    expect(primitives).toContain('TimeSlot');
    expect(primitives).toContain('metricTimeText');
    const projection = read('projection.js');
    expect(projection).toContain("UNKNOWN_TIME_TEXT = '时点未知'");
  });
});

// ── task-30：持仓报价时点必须被渲染（不是只加进输出就完事）─────────────────────
//
// `list_holdings` 的 `quoteObservedAt` / `quoteFreshness` 是服务端算好的结论，
// 但如果 client 不渲染它，用户看到的仍是「有数字但不知道多旧」——**输出有、界面无，等于没做**。
// 这里扫源码而不是渲染，理由见文件头：client `.js` 无 typecheck、DOM 断言不在 `test:all`。
describe('task-30 · 持仓报价时点', () => {
  it('overview 的持仓表格渲染 holdingQuoteView（不是只 import）', () => {
    const overview = read('overview.js');
    expect(overview.includes('holdingQuoteView')).toBe(true);
    // 括号是关键：`h(holdingQuoteView` 之外还必须真的调用它。
    // 只 import 不用、或只在注释里提到，都不算渲染（第一版守卫就栽在 import 上）。
    expect(/holdingQuoteView\s*\(/.test(overview)).toBe(true);
  });

  it('client 不自己判断报价是否陈旧（阈值只在 core）', () => {
    // 判据必须来自服务端 `quoteFreshness.tone`；client 出现日期/时刻比较即为第二份判定。
    const sources = readdirSync(ROOT)
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
      .map((name) => read(name));
    const offenders = sources.filter(
      (code) =>
        /quoteObservedAt[\s\S]{0,200}(getHours|15:\s*00|09:\s*30)/.test(code) ||
        /observedAt\s*[<>]=?\s*Date\.now\(\)/.test(code),
    );
    expect(offenders).toEqual([]);
  });

  it('持仓卡片的 meta 渲染 staleCount 汇总（用户不必逐行扫）', () => {
    const overview = read('overview.js');
    expect(/holdingsStaleSummary\s*\(/.test(overview)).toBe(true);
  });
});
