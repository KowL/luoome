import { describe, expect, it } from 'vitest';

import { DslEvalError, evaluateExpression, interpolate } from './dsl.js';

describe('tactic/dsl', () => {
  describe('evaluateExpression — 字面量与一元', () => {
    it('数字字面量', () => {
      expect(evaluateExpression('42', {})).toBe(42);
      expect(evaluateExpression('3.14', {})).toBeCloseTo(3.14);
      expect(evaluateExpression('-7', {})).toBe(-7);
    });

    it('布尔与 null / undefined', () => {
      expect(evaluateExpression('true', {})).toBe(true);
      expect(evaluateExpression('false', {})).toBe(false);
      expect(evaluateExpression('null', {})).toBeNull();
      expect(evaluateExpression('undefined', {})).toBeUndefined();
      expect(evaluateExpression('!true', {})).toBe(false);
      expect(evaluateExpression('!0', {})).toBe(true);
    });
  });

  describe('evaluateExpression — 算术与比较', () => {
    const ctx = { x: 10, y: 3 };

    it('四则运算 + 优先级', () => {
      expect(evaluateExpression('1 + 2 * 3', ctx)).toBe(7);
      expect(evaluateExpression('(1 + 2) * 3', ctx)).toBe(9);
      expect(evaluateExpression('x - y', ctx)).toBe(7);
      expect(evaluateExpression('x / y', ctx)).toBeCloseTo(3.333, 2);
      expect(evaluateExpression('x % y', ctx)).toBe(1);
    });

    it('比较 + 逻辑短路', () => {
      expect(evaluateExpression('x > y', ctx)).toBe(true);
      expect(evaluateExpression('x <= y', ctx)).toBe(false);
      expect(evaluateExpression('x > 0 && y > 0', ctx)).toBe(true);
      expect(evaluateExpression('x > 100 || y > 0', ctx)).toBe(true);
      expect(evaluateExpression('x === 10', ctx)).toBe(true);
      // 宽松等于在数字场景下的表现：0 == false 为 true（DSL 行为与 JS 弱类型一致）
      expect(evaluateExpression('0 == false', ctx)).toBe(true);
    });
  });

  describe('evaluateExpression — context 路径', () => {
    const ctx = {
      indicators: { ma5: 12, ma10: 11, ma20: 10, volRatio5_20: 1.8 },
      meta: { recentLimitUp: true, daysSinceLimitUp: 2 },
    };

    it('嵌套对象访问', () => {
      expect(evaluateExpression('indicators.ma5', ctx)).toBe(12);
      expect(evaluateExpression('indicators.volRatio5_20', ctx)).toBe(1.8);
      expect(evaluateExpression('meta.recentLimitUp', ctx)).toBe(true);
    });

    it('缺字段返回 undefined（不抛错）', () => {
      expect(evaluateExpression('indicators.rsi14', ctx)).toBeUndefined();
      expect(evaluateExpression('nope', ctx)).toBeUndefined();
      expect(evaluateExpression('indicators.ma5 > indicators.rsi14', ctx)).toBe(false);
    });

    it('undefined 与数字比较安全', () => {
      expect(evaluateExpression('indicators.rsi14 !== undefined', ctx)).toBe(false);
      expect(evaluateExpression('indicators.rsi14 === undefined', ctx)).toBe(true);
      expect(evaluateExpression('indicators.rsi14 >= 50', ctx)).toBe(false);
    });
  });

  describe('evaluateExpression — 白名单函数', () => {
    const ctx = { a: 1.5, b: 2.5, c: -3 };

    it('Math.min / max / abs', () => {
      expect(evaluateExpression('Math.min(a, b)', ctx)).toBe(1.5);
      expect(evaluateExpression('Math.max(a, b)', ctx)).toBe(2.5);
      expect(evaluateExpression('Math.abs(c)', ctx)).toBe(3);
      expect(evaluateExpression('Math.min(100, a * 10)', ctx)).toBe(15);
    });

    it('白名单之外的"函数调用"被拒绝', () => {
      expect(() => evaluateExpression('eval("1")', ctx)).toThrow(/禁用关键字|无法识别/);
      expect(() => evaluateExpression('Math.sin(0)', ctx)).toThrow(/白名单/);
    });
  });

  describe('evaluateExpression — 安全检查', () => {
    it('空表达式抛错', () => {
      expect(() => evaluateExpression('   ', {})).toThrow(DslEvalError);
    });

    it('禁用关键字触发安全错误', () => {
      expect(() => evaluateExpression('require("fs")', {})).toThrow(/禁用关键字/);
      expect(() => evaluateExpression('import("x")', {})).toThrow(/禁用关键字/);
      expect(() => evaluateExpression('new Date()', {})).toThrow(/禁用关键字/);
      expect(() => evaluateExpression('this.x', {})).toThrow(/禁用关键字/);
    });

    it('末尾多余 token 抛错', () => {
      expect(() => evaluateExpression('1 2', {})).toThrow(/多余 token/);
    });
  });

  describe('interpolate — 模板替换', () => {
    const ctx = { indicators: { ma5: 12.34, ma20: 10 }, meta: { sector: '新能源' } };

    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
    it('${expr} 替换为字符串结果', () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
      expect(interpolate('MA5=${indicators.ma5}', ctx)).toBe('MA5=12.34');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
      expect(interpolate('板块=${meta.sector}', ctx)).toBe('板块=新能源');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
      expect(interpolate('存在=${indicators.rsi14 !== undefined}', ctx)).toBe('存在=false');
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
    it('多个 ${} 全部替换', () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
      expect(interpolate('MA5=${indicators.ma5} > MA20=${indicators.ma20}', ctx)).toBe(
        'MA5=12.34 > MA20=10',
      );
    });

    it('整数不补 .0', () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: DSL placeholder syntax in tests
      expect(interpolate('x=${indicators.ma20}', ctx)).toBe('x=10');
    });
  });

  describe('战法内置表达式烟雾测试', () => {
    const ctx = {
      indicators: { ma5: 12, ma10: 11, ma20: 10, volRatio5_20: 1.8, close: 15, high20: 14 },
      meta: { recentLimitUp: true, daysSinceLimitUp: 2 },
    };

    it('放量突破 trigger', () => {
      const trigger =
        'indicators.volRatio5_20 !== undefined && indicators.volRatio5_20 >= 1.5 && indicators.close >= indicators.high20';
      expect(evaluateExpression(trigger, ctx)).toBe(true);
    });

    it('均线多头 trigger', () => {
      const trigger = 'indicators.ma5 > indicators.ma10 && indicators.ma10 > indicators.ma20';
      expect(evaluateExpression(trigger, ctx)).toBe(true);
    });

    it('放量突破 score', () => {
      expect(evaluateExpression('Math.min(100, indicators.volRatio5_20 * 30)', ctx)).toBe(54);
    });
  });
});
