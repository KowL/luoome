import { describe, expect, it } from 'bun:test';

import { trimLeadingChatWhitespace } from './chat.js';

describe('chat message whitespace', () => {
  it('移除 AI SDK / think 清理后残留的开头空行', () => {
    expect(trimLeadingChatWhitespace('\n\n  \n好的，我来查看。')).toBe('好的，我来查看。');
  });

  it('保留正文内部的换行和缩进', () => {
    expect(trimLeadingChatWhitespace('\n第一行\n\n  第二行')).toBe('第一行\n\n  第二行');
  });
});
