import { describe, expect, it } from 'bun:test';

import {
  clearBackgroundImage,
  getBackgroundImage,
  getFollowSystem,
  getPanelOpacity,
  getTheme,
  getThemes,
  setBackgroundImage,
  setFollowSystem,
  setPanelOpacity,
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

  it('DOM shim 缺少 querySelectorAll 时设置主题不抛出异常', () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          getAttribute: () => 'teal',
          setAttribute: () => {},
        },
      },
    });

    try {
      expect(() => setTheme('teal')).not.toThrow();
    } finally {
      if (documentDescriptor === undefined) delete globalThis.document;
      else Object.defineProperty(globalThis, 'document', documentDescriptor);
    }
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

  it('面板透明度取值被约束在 30~100，null 恢复默认', () => {
    expect(setPanelOpacity(60)).toBe(60);
    expect(setPanelOpacity(150)).toBe(100);
    expect(setPanelOpacity(10)).toBe(30);
    expect(setPanelOpacity('abc')).toBeNull();
    expect(setPanelOpacity(null)).toBeNull();
  });

  it('无 DOM 时面板透明度读写不抛出异常', () => {
    expect(getPanelOpacity()).toBeNull();
    expect(() => setPanelOpacity(80)).not.toThrow();
  });

  it('无 DOM 时跟随系统开关读写不抛出异常', () => {
    expect(getFollowSystem()).toBe(false);
    expect(() => setFollowSystem(true)).not.toThrow();
    expect(() => setFollowSystem(false)).not.toThrow();
  });

  it('关闭跟随系统时持久化当前主题，刷新后不会恢复旧主题', () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map([
      ['luoome-theme', 'crimson'],
      ['luoome-theme-follow-system', '1'],
    ]);

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          getAttribute: () => 'teal',
        },
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        removeItem: (key) => values.delete(key),
        setItem: (key, value) => values.set(key, value),
      },
    });

    try {
      setFollowSystem(false);
      expect(values.get('luoome-theme')).toBe('teal');
      expect(values.has('luoome-theme-follow-system')).toBe(false);
    } finally {
      if (documentDescriptor === undefined) delete globalThis.document;
      else Object.defineProperty(globalThis, 'document', documentDescriptor);
      if (storageDescriptor === undefined) delete globalThis.localStorage;
      else Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    }
  });
});
