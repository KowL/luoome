import { describe, expect, it } from 'vitest';

import { batchTools } from '../../packages/mcp/src/batch-tools.js';
import { BATCH_TOOL_NAMES } from './batch-tools.js';

/**
 * 批处理面契约：profile 里给 DSH 定时任务暴露的工具名，
 * 必须与 @luoome/mcp 实际注册的批处理工具一一对应，且都是写副作用。
 */
describe('批处理工具白名单', () => {
  it('名单与 MCP 批处理工具完全一致', () => {
    const registered = batchTools.map((tool) => tool.name).sort();
    expect([...BATCH_TOOL_NAMES].sort()).toEqual(registered);
  });

  it('批处理工具都是写副作用且无重复', () => {
    const names = new Set<string>();
    for (const tool of batchTools) {
      expect(tool.sideEffect).toBe('write');
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
    }
  });

  it('批处理工具不与领域工具重名', async () => {
    const { toolRegistry } = await import('../../packages/tools/src/registry.js');
    const registryNames = new Set(toolRegistry.all().map((tool) => tool.name));
    for (const tool of batchTools) {
      expect(registryNames.has(tool.name)).toBe(false);
    }
  });
});
