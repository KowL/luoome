/**
 * CLI 输出工具：宽字符表格、百分比/金额格式化、flag 解析。
 * 抽到独立模块是为了不与 index.ts 的 main() 互相依赖。
 */

const isWideCodePoint = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xa3ff) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd);

export const displayWidth = (s: string): number => {
  let width = 0;
  for (const ch of s) width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
};

export const padDisplay = (s: string, width: number): string => {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
};

export const truncateDisplay = (s: string, max: number): string => {
  if (displayWidth(s) <= max) return s;
  return `${[...s].slice(0, Math.max(1, max - 1)).join('')}…`;
};

export const renderTable = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string => {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => r[i] ?? '').map(displayWidth)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => padDisplay(c, widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => '─'.repeat(Math.max(1, w)))),
    ...rows.map(line),
  ].join('\n');
};

export const flagString = (
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
): string | undefined => {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
};
