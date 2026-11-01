// `pruneArchives` 依赖「文件名 = luoome-<ISO 日期>-<digest>.json，字典序即时间序」这一前提。
// 若将来有人改了 `dataArchiveFileName` 的命名形状（把日期挪到后面、换成非补零格式等），
// 清理会**按错顺序删除**——最坏情况是删掉最新的导出。这两个断言把前提钉死。
import { describe, expect, it } from 'vitest';

import { DATA_ARCHIVE_FILE_NAME_PATTERN, dataArchiveFileName } from './data-archive.js';

describe('dataArchiveFileName', () => {
  it('以 ISO 日期开头，且跨日期的字典序 === 时间序', () => {
    const days = ['2026-01-02T03:04:05Z', '2026-01-10T00:00:00Z', '2026-11-01T12:00:00Z'];
    const files = days.map((iso, index) =>
      dataArchiveFileName({ exportedAt: new Date(iso), digest: `${'a'.repeat(63)}${index}` }),
    );
    // 字典序 === 时间序（days 本身已按时间升序）
    expect([...files].sort()).toEqual(files);
    // 每份都匹配白名单（`pruneArchives` 的候选集判据）
    for (const file of files) expect(DATA_ARCHIVE_FILE_NAME_PATTERN.test(file)).toBe(true);
  });

  it('日期段用上海自然日：UTC 15:30 仍是当日、UTC 16:30 已跨到次日', () => {
    const digest = 'b'.repeat(12);
    // 2026-11-01T15:30Z = 上海 11-01 23:30 → 日期段 2026-11-01
    expect(dataArchiveFileName({ exportedAt: new Date('2026-11-01T15:30:00Z'), digest })).toBe(
      'luoome-2026-11-01-bbbbbbbbbbbb.json',
    );
    // 2026-11-01T16:30Z = 上海 11-02 00:30 → 日期段 2026-11-02
    expect(dataArchiveFileName({ exportedAt: new Date('2026-11-01T16:30:00Z'), digest })).toBe(
      'luoome-2026-11-02-bbbbbbbbbbbb.json',
    );
  });
});
