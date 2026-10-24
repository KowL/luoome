import { z } from 'zod';

/**
 * 副作用 5 级（ARCHITECTURE §2.6 / §7.1）。
 * trade 永不通过 MCP 暴露，这是硬约束。
 * DSH 瘦身（docs/ddd/luoome-dsh-transformation-detailed-design.md）后内置 AI 下线，
 * 原 advice 级（读数据 + 调 LLM + 落建议）随之删除；存量 Advice 数据实体保留。
 */
export type SideEffect = 'read' | 'write' | 'external' | 'queue' | 'trade';

export const SIDE_EFFECTS: readonly SideEffect[] = ['read', 'write', 'external', 'queue', 'trade'];

export const SideEffectSchema = z.enum(['read', 'write', 'external', 'queue', 'trade']);
