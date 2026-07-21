import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * LUOOME_HOME 数据目录解析（CLI 共享）。
 *
 * - 默认 `${HOME}/.luoome`（AGENTS.md 快速接入示例口径）
 * - 通过 `LUOOME_HOME` env 覆盖
 *
 * 此函数无副作用、可在模块顶层缓存；适合 holiday 日历、版本自检等需要
 * LUOOME_HOME 但不需要初始化 DB / adapters 的场合。
 */
export const luoomeHome = (): string => process.env.LUOOME_HOME ?? join(homedir(), '.luoome');
