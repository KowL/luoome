/* apps/web/public/js/form-kit.test.js —— 共享表单小件与错误文案的纯函数测试。
 * DOM 构造（input/select/字段/操作行）由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import {
  parseNonNegativeInt,
  parseNonNegativeNumber,
  parsePositiveInt,
  parsePositiveNumber,
} from './form-kit.js';
import { resultErrorText, toolErrorText } from './ui.js';

describe('数值解析小件', () => {
  it('正整数只接受 > 0 的整数', () => {
    expect(parsePositiveInt('5')).toBe(5);
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-1')).toBeNull();
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
  });

  it('非负整数接受 0，拒绝负数与小数', () => {
    expect(parseNonNegativeInt('0')).toBe(0);
    expect(parseNonNegativeInt('100')).toBe(100);
    expect(parseNonNegativeInt('-1')).toBeNull();
    expect(parseNonNegativeInt('2.5')).toBeNull();
  });

  it('正数 / 非负数按数值解析，拒绝 NaN 与空串', () => {
    expect(parsePositiveNumber('1.5')).toBe(1.5);
    expect(parsePositiveNumber('0')).toBeNull();
    expect(parsePositiveNumber('')).toBeNull();
    expect(parseNonNegativeNumber('0')).toBe(0);
    expect(parseNonNegativeNumber('60000.5')).toBe(60000.5);
    expect(parseNonNegativeNumber('-0.1')).toBeNull();
    expect(parseNonNegativeNumber('x')).toBeNull();
  });
});

describe('统一错误文案', () => {
  it('权限失败统一说明缺哪个能力', () => {
    expect(toolErrorText({ kind: 'permission_denied', required: 'write 操作未开启' })).toBe(
      '权限校验失败：write 操作未开启',
    );
    expect(toolErrorText({ kind: 'permission_denied' })).toBe('权限校验失败：当前操作未开启');
  });

  it('保留「kind：detail」前缀，便于定位', () => {
    expect(toolErrorText({ kind: 'invalid_input', message: '数量必须是正整数' })).toBe(
      'invalid_input：数量必须是正整数',
    );
    expect(toolErrorText({ kind: 'not_found', entity: 'Stock' })).toBe('not_found');
  });

  it('按 message → cause → required 取第一个可用细节', () => {
    expect(toolErrorText({ kind: 'adapter_error', cause: '上游超时' })).toBe(
      'adapter_error：上游超时',
    );
    expect(toolErrorText({ kind: 'invalid_input', required: '缺少参数' })).toBe(
      'invalid_input：缺少参数',
    );
  });

  it('非对象或空错误回落到调用方给的兜底文案', () => {
    expect(toolErrorText(null)).toBe('操作失败');
    expect(toolErrorText(undefined, '写入失败')).toBe('写入失败');
    expect(toolErrorText('boom', '写入失败')).toBe('写入失败');
    expect(resultErrorText({ ok: false }, '研究索引不可用')).toBe('研究索引不可用');
    expect(resultErrorText({ ok: false, error: { kind: 'internal', message: '崩了' } })).toBe(
      'internal：崩了',
    );
  });
});
