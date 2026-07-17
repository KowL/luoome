import { z } from 'zod';

/**
 * 副作用 5 级（ARCHITECTURE §2.6 / §7.1）。
 * trade 永不通过 MCP 暴露，这是硬约束。
 */
export type SideEffect = 'read' | 'write' | 'external' | 'advice' | 'trade';

export const SIDE_EFFECTS: readonly SideEffect[] = ['read', 'write', 'external', 'advice', 'trade'];

export const SideEffectSchema = z.enum(['read', 'write', 'external', 'advice', 'trade']);
