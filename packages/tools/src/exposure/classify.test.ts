import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import {
  classifyTool,
  classifyTools,
  EXPOSURE_CLASSES,
  EXPOSURE_EXCEPTIONS,
  exposureOf,
  namesInExposure,
  unknownExposureExceptions,
} from './classify.js';
import { privateResearchTools } from './judge.js';

const all = toolRegistry.all();
const result = classifyTools(all);

describe('工具暴露面五类归类', () => {
  it('每个工具恰好一条标签，五类并集等于 registry 全部工具名（集合相等）', () => {
    expect(result.tools).toHaveLength(all.length);
    expect(new Set(result.tools.map((item) => item.name)).size).toBe(all.length);
    const union = new Set(result.tools.map((item) => item.name));
    expect(union).toEqual(new Set(all.map((tool) => tool.name)));
    const sum = EXPOSURE_CLASSES.reduce((total, exposure) => total + result.counts[exposure], 0);
    expect(sum).toBe(all.length);
  });

  it('没有工具落在五类之外（未归类 = 0）', () => {
    const classified = new Set(result.tools.map((item) => item.exposure));
    for (const exposure of classified) expect(EXPOSURE_CLASSES).toContain(exposure);
    expect(result.tools.filter((item) => item.exposure === undefined)).toEqual([]);
    expect(EXPOSURE_CLASSES.reduce((total, exposure) => total + result.counts[exposure], 0)).toBe(
      result.tools.length,
    );
  });

  it('主体由 sideEffect 推导：read → 只读面，write/external → 可写面，queue/trade → 不暴露面', () => {
    for (const item of result.tools) {
      if (item.derivedFrom !== 'side-effect') continue;
      const expected = {
        read: 'read-surface',
        write: 'write-surface',
        external: 'write-surface',
        queue: 'queue-worker',
        trade: 'queue-worker',
      } as const;
      expect(item.exposure).toBe(expected[item.sideEffect]);
    }
  });

  it('trade 与带 trade capability 的声明落不暴露面（不暴露、不摘除），不得是废弃', () => {
    const tradeTools = result.tools.filter(
      (item) => item.sideEffect === 'trade' || item.requiredCapabilities.includes('trade'),
    );
    expect(tradeTools.length).toBeGreaterThan(0);
    for (const item of tradeTools) {
      expect(item.exposure).not.toBe('retired');
      expect(item.exposure).toBe('queue-worker');
      expect(item.reason).toContain('永不暴露');
      expect(item.reason).toContain('不摘除');
      expect(item.reason).toContain('不经 MCP');
    }
    expect(exposureOf(result, 'record_decision_trade')).toBe('queue-worker');
  });

  it('废弃面本轮为空：H1 不摘除任何工具，retired 只表示已从 registry 摘除', () => {
    expect(namesInExposure(result, 'retired')).toEqual([]);
    expect(result.counts.retired).toBe(0);
    expect(classifyTool({ name: 'future_trade_tool', sideEffect: 'trade' }).exposure).toBe(
      'queue-worker',
    );
  });

  it('私人研究复用 privateResearchTools 单一真源，全部落 opt-in 面', () => {
    for (const name of privateResearchTools)
      expect(exposureOf(result, name)).toBe('private-research');
    expect([...namesInExposure(result, 'private-research')].sort()).toEqual(
      [...privateResearchTools].sort(),
    );
  });

  it('例外名单不腐烂：每条都指向真实工具，覆盖 chat 面 6 个工具，且不收录 trade（靠推导）', () => {
    expect(unknownExposureExceptions(all)).toEqual([]);
    for (const exception of EXPOSURE_EXCEPTIONS)
      expect(exposureOf(result, exception.name)).toBe(exception.exposure);
    expect(namesInExposure(result, 'queue-worker')).toEqual(
      expect.arrayContaining(EXPOSURE_EXCEPTIONS.map((exception) => exception.name)),
    );
    expect(EXPOSURE_EXCEPTIONS.map((exception) => exception.name)).not.toContain(
      'record_decision_trade',
    );
    // 第 3 类的构成可复算：queue 声明的工具 + chat 例外 + trade 专用人工入口。
    expect(EXPOSURE_EXCEPTIONS).toHaveLength(6);
    const queueDeclared = result.tools.filter((item) => item.sideEffect === 'queue').length;
    const tradeDeclared = result.tools.filter((item) => item.sideEffect === 'trade').length;
    expect(result.counts['queue-worker']).toBe(
      queueDeclared + EXPOSURE_EXCEPTIONS.length + tradeDeclared,
    );
  });

  it('推导不依赖字面量表：新工具按声明自动归类', () => {
    expect(classifyTool({ name: 'future_read_tool', sideEffect: 'read' }).exposure).toBe(
      'read-surface',
    );
    expect(classifyTool({ name: 'future_write_tool', sideEffect: 'write' }).exposure).toBe(
      'write-surface',
    );
    expect(classifyTool({ name: 'future_queue_tool', sideEffect: 'queue' }).exposure).toBe(
      'queue-worker',
    );
    expect(
      classifyTool({
        name: 'future_mixed_tool',
        sideEffect: 'write',
        requiredCapabilities: ['write', 'external'],
      }).exposure,
    ).toBe('write-surface');
  });
});
