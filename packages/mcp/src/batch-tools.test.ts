import { batchTools as shared } from '@luoome/batch';
import { selectExposedTools } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { batchTools } from './batch-tools.js';

describe('MCP batch compatibility', () => {
  it('reuses the native batch implementation', () => {
    expect(batchTools).toBe(shared);
  });

  it('requires both write and external opt-ins', () => {
    expect(selectExposedTools(batchTools, new Set(['read', 'write']))).toEqual([]);
    expect(selectExposedTools(batchTools, new Set(['read', 'external']))).toEqual([]);
    expect(selectExposedTools(batchTools, new Set(['read', 'write', 'external']))).toHaveLength(5);
  });
});
