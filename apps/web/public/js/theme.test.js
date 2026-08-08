import { describe, expect, it } from 'bun:test';

import {
  clearBackgroundImage,
  getBackgroundImage,
  getTheme,
  getThemes,
  setBackgroundImage,
  setTheme,
} from './theme.js';

describe('主题皮肤', () => {
  it('提供 8 个预定义主题', () => {
    expect(getThemes().map((theme) => theme.id)).toEqual([
      'teal',
      'crimson',
      'blue',
      'violet',
      'rose',
      'amber',
      'sage',
      'slate',
      'dark',
    ]);
  });

  it('无 DOM 时 getTheme 返回默认主题', () => {
    expect(getTheme()).toBe('teal');
  });

  it('设置未知主题不抛出异常', () => {
    expect(() => setTheme('unknown')).not.toThrow();
    expect(getTheme()).toBe('teal');
  });

  it('非图片 data URL 不生效', () => {
    expect(setBackgroundImage('data:text/plain;base64,aGk=')).toBe(false);
    expect(setBackgroundImage(null)).toBe(false);
  });

  it('无 DOM 时背景读写不抛出异常', () => {
    expect(getBackgroundImage()).toBeNull();
    expect(
      typeof setBackgroundImage(
        'data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=',
      ),
    ).toBe('boolean');
    expect(() => clearBackgroundImage()).not.toThrow();
  });
});
