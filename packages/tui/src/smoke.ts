// @luoome/tui headless 冒烟：用 @opentui/core/testing 的 createTestRenderer
// 在非 TTY 环境驱动与线上完全同一套 app 代码（createTuiApp + buildMockContext），
// 验证：首帧布局（免责声明 / 持仓 / 建议 / 快捷键栏）、[d] 详情弹层、
// [esc] 关闭、[s] 统计弹层、[q] 退出。
//
// 运行：bun packages/tui/src/smoke.ts

import { buildMockContext } from '@luoome/tools';
import { createTestRenderer } from '@opentui/core/testing';

import { createTuiApp } from './app.js';

const assert = (cond: boolean, message: string): void => {
  if (!cond) {
    process.stderr.write(`SMOKE FAIL: ${message}\n`);
    process.exit(1);
  }
};

const DECISION_WORDS = ['BUY', 'SELL', 'HOLD', 'WATCH', 'AVOID'] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const ctx = await buildMockContext();
const setup = await createTestRenderer({ width: 110, height: 32 });
const { renderer } = setup;

const frame = (): string => setup.captureCharFrame();

const done = createTuiApp(renderer, ctx);

// 1) 等待首屏数据加载完成（list_holdings + get_advice / analyze_stock）。
await setup.waitFor(
  () => frame().includes('比亚迪') && DECISION_WORDS.some((w) => frame().includes(w)),
  { maxPasses: 200 },
);

const first = frame();
assert(first.includes('不构成投资建议'), '顶部横幅应包含免责声明（STANDARD_DISCLAIMERS 前两条）');
assert(first.includes('决策需自行承担'), '顶部横幅应包含免责声明第二条');
assert(first.includes('持仓'), '左栏标题应为「持仓」');
assert(first.includes('今日建议'), '右栏标题应为「今日建议」');
assert(first.includes('比亚迪'), '持仓列表应包含 mock 持仓（比亚迪）');
assert(first.includes('贵州茅台'), '持仓列表应包含 mock 持仓（贵州茅台）');
assert(first.includes('合计'), '持仓列表应包含合计行');
assert(first.includes('[r] 刷新'), '底部快捷键栏应包含 [r] 刷新');
assert(first.includes('[q] 退出'), '底部快捷键栏应包含 [q] 退出');
assert(first.includes('[d] 建议详情'), '底部快捷键栏应包含 [d] 建议详情');
assert(first.includes('[s] 复盘统计'), '底部快捷键栏应包含 [s] 复盘统计');
process.stderr.write('smoke: 首屏布局 OK\n');

// 2) [d] 打开建议详情弹层（首行 002594.SZ 比亚迪必有建议）。
setup.mockInput.pressKey('d');
await setup.waitFor(() => frame().includes('核心论点'), { maxPasses: 50 });
const detail = frame();
assert(detail.includes('建议详情'), '[d] 弹层标题应为「建议详情」');
assert(detail.includes('核心论点'), '[d] 弹层应包含核心论点');
assert(detail.includes('反证'), '[d] 弹层应包含反证（counterEvidence）');
assert(detail.includes('风险提示'), '[d] 弹层应包含风险提示');
assert(detail.includes('免责声明'), '[d] 弹层应包含免责声明');
process.stderr.write('smoke: [d] 建议详情弹层 OK\n');

// 3) [esc] 关闭弹层（stdin 解析器对孤立 ESC 有消歧延迟，先等其派发再断言）。
setup.mockInput.pressEscape();
await sleep(200);
await setup.waitFor(() => !frame().includes('核心论点'), { maxPasses: 50 });
assert(!frame().includes('核心论点'), '[esc] 后详情弹层应关闭');
process.stderr.write('smoke: [esc] 关闭弹层 OK\n');

// 4) [s] 打开复盘统计弹层。
setup.mockInput.pressKey('s');
await setup.waitFor(() => frame().includes('总条数'), { maxPasses: 100 });
const stats = frame();
assert(stats.includes('复盘统计'), '[s] 弹层标题应为「复盘统计」');
assert(stats.includes('总条数'), '[s] 弹层应包含总条数');
assert(stats.includes('平均信心度'), '[s] 弹层应包含平均信心度');
assert(stats.includes('按决策分解'), '[s] 弹层应包含按决策分解');
process.stderr.write('smoke: [s] 复盘统计弹层 OK\n');

// 5) [esc] 关闭后 [q] 退出：done 必须 resolve。
setup.mockInput.pressEscape();
await sleep(200);
await setup.waitFor(() => !frame().includes('总条数'), { maxPasses: 50 });
setup.mockInput.pressKey('q');
await Promise.race([
  done,
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('[q] 退出超时：done 未 resolve')), 5000);
  }),
]);
assert(renderer.isDestroyed, '[q] 后 renderer 应已销毁');

process.stderr.write('SMOKE OK\n');
