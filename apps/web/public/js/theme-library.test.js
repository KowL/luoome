/* apps/web/public/js/theme-library.test.js —— 设置页题材库纯函数。 */

import { describe, expect, it } from 'bun:test';

import {
  sortThemeItems,
  themeAutoIssue,
  themeAutoPendingRows,
  themeAutoSummary,
  themeImportNotice,
  themeMemberSummary,
} from './theme-library.js';

const item = (input) => ({
  theme: {
    id: input.id,
    name: input.name,
    state: input.state ?? 'active',
    sortOrder: input.sortOrder,
  },
  sourceCount: input.sourceCount ?? 0,
  memberCount: input.memberCount ?? 0,
  activeMemberCount: input.activeMemberCount ?? 0,
});

describe('theme library management helpers', () => {
  it('sorts active themes by fixed order and keeps archived after them', () => {
    const items = [
      item({ id: 'b', name: '乙', sortOrder: 1 }),
      item({ id: 'archived', name: '归档', sortOrder: 0, state: 'archived' }),
      item({ id: 'a', name: '甲', sortOrder: 0 }),
    ];
    expect(sortThemeItems(items).map((entry) => entry.theme.id)).toEqual(['a', 'b', 'archived']);
  });

  it('summarises active members, history and source concepts', () => {
    expect(
      themeMemberSummary(
        item({ id: 'a', name: '甲', sourceCount: 3, memberCount: 5, activeMemberCount: 2 }),
      ),
    ).toBe('2 只生效 · 5 段历史 · 3 个来源概念');
  });

  it('explains import availability and retry semantics', () => {
    expect(themeImportNotice({ canManage: false })).toContain('LUOOME_EXPOSE_WRITE=true');
    expect(themeImportNotice({ canManage: true, initialized: false })).toContain('首版种子');
    expect(themeImportNotice({ canManage: true, initialized: true })).toContain('只补缺失题材');
  });
});

const autoRun = (input = {}) => ({
  tradingDay: '2026-11-26',
  status: 'succeeded',
  attempt: 1,
  startedAt: '2026-11-26T08:05:00.000Z',
  finishedAt: '2026-11-26T08:05:00.000Z',
  createdThemes: 1,
  createdMembers: 3,
  pendingCount: 2,
  skipReason: null,
  errorMessage: null,
  ...input,
});

describe('theme library auto maintenance helpers', () => {
  it('summarises enable state, last run and pending count', () => {
    expect(themeAutoSummary(null)).toContain('未知');
    expect(themeAutoSummary({ enabled: false, lastRun: null })).toContain('未启用');
    expect(themeAutoSummary({ enabled: true, lastRun: null })).toContain('尚未执行');
    const text = themeAutoSummary({ enabled: true, lastRun: autoRun() });
    expect(text).toContain('2026-11-26');
    expect(text).toContain('新增 1 题材 / 3 成分');
    expect(text).toContain('待核对 2');
    expect(
      themeAutoSummary({
        enabled: true,
        lastRun: autoRun({ createdThemes: 0, createdMembers: 0, pendingCount: 0 }),
      }),
    ).toContain('新增 0 题材 / 0 成分');
  });

  it('shows the skip reason for a skipped run', () => {
    const text = themeAutoSummary({
      enabled: true,
      lastRun: autoRun({
        status: 'skipped',
        skipReason: 'empty_pool',
        createdThemes: 0,
        createdMembers: 0,
      }),
    });
    expect(text).toContain('跳过');
    expect(text).toContain('涨停池为空');
  });

  it('reports failures with the attempt number and message', () => {
    expect(themeAutoIssue({ lastRun: autoRun() })).toBeNull();
    expect(
      themeAutoIssue({
        lastRun: autoRun({ status: 'failed', attempt: 2, errorMessage: '上游超时' }),
      }),
    ).toBe('第 2 次执行失败：上游超时');
    expect(
      themeAutoIssue({ lastRun: autoRun({ status: 'skipped', skipReason: 'incomplete_pool' }) }),
    ).toContain('数据不完整');
  });

  it('turns pending items into dated review rows', () => {
    const rows = themeAutoPendingRows([
      {
        kind: 'single_stock',
        tradingDate: '2026-11-26',
        label: '钙钛矿',
        stockId: '300011.SZ',
        stockName: '甲',
        reason: '钙钛矿',
        source: 'fuyao-limit-up-market',
        note: '同方向仅 1 只涨停股印证',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('仅一只印证');
    expect(rows[0].text).toContain('2026-11-26');
    expect(rows[0].text).toContain('钙钛矿');
    expect(rows[0].note).toContain('1 只');
    expect(themeAutoPendingRows(undefined)).toEqual([]);
  });
});
