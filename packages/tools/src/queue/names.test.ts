import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { INTERACTIVE_ANALYSIS_TOOL_NAMES, QUEUE_TOOL_NAMES } from './names.js';

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

describe('交互式分析面工具名单', () => {
  const registry = new Map(toolRegistry.all().map((tool) => [tool.name, tool]));

  it('三个名字都在公共 registry，且副作用符合交互写回语义', () => {
    expect([...INTERACTIVE_ANALYSIS_TOOL_NAMES]).toEqual([
      'get_analysis_context',
      'record_advice',
      'record_analysis_result',
    ]);
    for (const name of INTERACTIVE_ANALYSIS_TOOL_NAMES) {
      expect(registry.get(name), `${name} 不在工具库存中`).toBeDefined();
    }
    expect(registry.get('get_analysis_context')?.sideEffect).toBe('read');
    expect(registry.get('record_advice')?.sideEffect).toBe('queue');
    expect(registry.get('record_analysis_result')?.sideEffect).toBe('queue');
  });

  it('不放 worker 的 claim / complete / fail 与队列管理工具', () => {
    const workerOnly = [
      'claim_analysis_jobs',
      'complete_analysis_job',
      'fail_analysis_job',
      'requeue_analysis_job',
      'cancel_analysis_job',
      'get_analysis_metrics',
      'list_analysis_jobs',
      'get_analysis_job',
    ];
    for (const name of workerOnly) {
      expect(INTERACTIVE_ANALYSIS_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('不放用户反馈、报告持久化、决策复盘与任何 trade 工具', () => {
    const forbidden = [
      'record_advice_outcome',
      'save_report',
      'save_decision_review',
      'record_decision_trade',
    ];
    for (const name of forbidden) {
      expect(INTERACTIVE_ANALYSIS_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
    for (const name of INTERACTIVE_ANALYSIS_TOOL_NAMES) {
      expect(registry.get(name)?.sideEffect).not.toBe('trade');
    }
  });

  it('与 worker 名单是两份独立名单', () => {
    expect([...INTERACTIVE_ANALYSIS_TOOL_NAMES]).not.toEqual([...QUEUE_TOOL_NAMES]);
    expect(INTERACTIVE_ANALYSIS_TOOL_NAMES.length).toBeLessThan(QUEUE_TOOL_NAMES.length);
  });
});
