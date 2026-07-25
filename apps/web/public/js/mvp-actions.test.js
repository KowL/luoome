import { describe, expect, it } from 'vitest';

import { toolErrorText } from './mvp-actions.js';

describe('分组 / 盯盘方案 写操作错误提示', () => {
  it('permission_denied 显示服务端原因和 token 设置指引', () => {
    expect(
      toolErrorText({
        kind: 'permission_denied',
        required: 'write/external 操作需要有效 LUOOME_WEB_TOKEN',
      }),
    ).toBe(
      '权限校验失败：write/external 操作需要有效 LUOOME_WEB_TOKEN；请前往「设置」保存当前服务的 Web token。',
    );
  });

  it('permission_denied 缺 required 时回落到默认提示', () => {
    expect(toolErrorText({ kind: 'permission_denied' })).toBe(
      '权限校验失败：写操作需要有效 Web token；请前往「设置」保存当前服务的 Web token。',
    );
  });

  it('其他 error 带 message → 「kind：detail」', () => {
    expect(toolErrorText({ kind: 'invalid_input', message: 'stockIds 至少 1 项' })).toBe(
      'invalid_input：stockIds 至少 1 项',
    );
  });

  it('error 没有 message / cause 时退回 kind 字串', () => {
    expect(toolErrorText({ kind: 'internal' })).toBe('internal');
  });

  it('非对象 / null → 「提交失败」', () => {
    expect(toolErrorText(null)).toBe('提交失败');
    expect(toolErrorText('a string')).toBe('提交失败');
  });
});
