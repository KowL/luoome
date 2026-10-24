import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { QUEUE_TOOL_NAMES } from './names.js';

const consumerToolNames = (): string[] =>
  toolRegistry
    .all()
    .filter((tool) => tool.sideEffect === 'queue' || /^(get|list)_analysis_/.test(tool.name))
    .map((tool) => tool.name)
    .sort();

describe('队列工具名单', () => {
  it('与消费者工作流的工具集合完全一致', () => {
    expect([...QUEUE_TOOL_NAMES].sort()).toEqual(consumerToolNames());
  });

  it('名单里的工具都存在', () => {
    const names = new Set(toolRegistry.all().map((tool) => tool.name));
    for (const name of QUEUE_TOOL_NAMES) {
      expect(names.has(name), `${name} 不在工具库存中`).toBe(true);
    }
  });

  it('写面的队列工具不在名单里', () => {
    const writeQueueTools = toolRegistry
      .all()
      .filter((tool) => tool.sideEffect === 'write' && /analysis/.test(tool.name))
      .map((tool) => tool.name);
    for (const name of writeQueueTools) {
      expect(QUEUE_TOOL_NAMES).not.toContain(name);
    }
  });
});
