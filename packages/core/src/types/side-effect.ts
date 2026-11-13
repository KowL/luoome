/**
 * 副作用 5 级（ARCHITECTURE §2.6 / §7.1）。
 * trade 永不通过 MCP 暴露，这是硬约束。
 */
export type SideEffect = 'read' | 'write' | 'external' | 'advice' | 'trade';
