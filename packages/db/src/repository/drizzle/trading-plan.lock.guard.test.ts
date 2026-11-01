import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 守卫（决策 3-A）：乐观锁的比较**必须**发生在事务句柄 `tx` 上。
 *
 * ## 为什么需要这条测试，而不是只写注释
 *
 * 这是「假锁」最典型的形态：代码**看起来**有锁，实际没有。
 * `latestByPlanId` 绑在 `this.db` 上——在 `this.db.transaction((tx) => …)` 的闭包里
 * 调用它，读的是**事务外**的连接，那正好等价于「分两步读再写」。
 * 下一个人为了「复用代码」把它改回 `this.latestByPlanId(...)`，锁会**悄悄**失效，
 * 而所有功能测试依然全绿。所以这里用源码级断言把它钉住。
 */
const source = readFileSync(fileURLToPath(new URL('./trading-plan.ts', import.meta.url)), 'utf8');

/**
 * 去掉注释再断言。
 *
 * 守卫必须只看**代码**：注释里会出现「不要用 `this.latestByPlanId`」这类说明，
 * 把注释算进去会让守卫自己误报（第一版就踩了这个坑）。
 * 反过来说，把违规模式写进注释并不危险——危险的是它出现在可执行代码里。
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出 `save` 方法体（从 `async save(` 到 `saveIfBudgetAvailable` 之前）。 */
const saveBody = (): string => {
  const start = source.indexOf('async save(');
  const end = source.indexOf('async saveIfBudgetAvailable(');
  if (start < 0 || end < 0 || end <= start) throw new Error('找不到 save 方法体');
  return stripComments(source.slice(start, end));
};

/** 取出 `saveIfBudgetAvailable` 方法体（到文件末尾的 `findByVersionId` 之前）。 */
const budgetSaveBody = (): string => {
  const start = source.indexOf('async saveIfBudgetAvailable(');
  const end = source.indexOf('async findByVersionId(');
  if (start < 0 || end < 0 || end <= start) throw new Error('找不到 saveIfBudgetAvailable 方法体');
  return stripComments(source.slice(start, end));
};

describe('TradingPlan 乐观锁的事务守卫', () => {
  it('save 的比较与写入在同一个 this.db.transaction 内', () => {
    const body = saveBody();
    expect(body).toContain('this.db.transaction(');
    // 事务之外不得出现插入：写入必须在闭包内。
    const [beforeTransaction] = body.split('this.db.transaction(');
    expect(beforeTransaction).not.toContain('.insert(');
  });

  it('save 的事务闭包内不得读 this.*（任何事务外读取都会让锁失效）', () => {
    const body = saveBody();
    const transaction = body.slice(body.indexOf('this.db.transaction('));
    // 去掉 `this.db.transaction(` 那一处合法调用本身。
    const inner = transaction.replace('this.db.transaction(', '');
    // 只列 `this.latestByPlanId` 是不够的：改个名字（如 `this.latestVersionIdOutsideTx`）
    // 就绕过去了——第一版守卫正是这样漏掉的。这里禁止闭包内出现**任何** `this.`。
    const thisReads = [...inner.matchAll(/this\.[A-Za-z_$]+/g)].map((match) => match[0]);
    expect(thisReads).toEqual([]);
  });

  it('save 用 tx 作用域的查询取最新版（latestRowInTransaction 的第一个参数是 tx）', () => {
    const body = saveBody();
    expect(body).toContain('latestRowInTransaction(tx,');
  });

  it('latestRowInTransaction 只接受事务句柄，不使用 this.db', () => {
    const start = source.indexOf('const latestRowInTransaction');
    expect(start).toBeGreaterThan(-1);
    const helper = source.slice(start, source.indexOf('export class DrizzleTradingPlanRepository'));
    expect(helper).toContain('tx: DrizzleTransaction');
    expect(helper).not.toContain('this.db');
  });

  it('saveIfBudgetAvailable 同样在事务内比对，闭包内不读 this.*', () => {
    const body = budgetSaveBody();
    expect(body).toContain('this.db.transaction(');
    expect(body).toContain('latestRowInTransaction(tx,');
    const transaction = body.slice(body.indexOf('this.db.transaction('));
    const inner = transaction.replace('this.db.transaction(', '');
    const thisReads = [...inner.matchAll(/this\.[A-Za-z_$]+/g)].map((match) => match[0]);
    expect(thisReads).toEqual([]);
  });
});
