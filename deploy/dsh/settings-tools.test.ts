/**
 * 设置面白名单的守卫。
 *
 * 这份名单是「交互面允许写什么」的唯一事实来源：名单里的工具名一旦在领域层改名，
 * 这里必须跟着改，否则 DSH 会话里的配置操作会在运行时才失败。
 */
import { describe, expect, test } from 'vitest';
import { toolRegistry } from '../../packages/tools/src/registry.js';
import { SETTINGS_TOOL_NAMES } from './settings-tools.js';

const known = new Map(toolRegistry.all().map((tool) => [tool.name, tool]));

describe('设置面工具白名单', () => {
  test('每个名字都是真实存在且副作用为 write 的工具', () => {
    for (const name of SETTINGS_TOOL_NAMES) {
      const tool = known.get(name);
      expect(tool, `工具 ${name} 不在 registry 里`).toBeDefined();
      expect(tool?.sideEffect, `工具 ${name} 的副作用不是 write`).toBe('write');
    }
  });

  test('不放会丢历史记录的破坏性删除工具', () => {
    // delete_alert_plan 只删配置、保留 WatchTrigger 历史，属于设置操作；
    // 下面这几个会连带删掉记录本身，误判一次就找不回来。
    const destructive = [
      'delete_advice',
      'delete_report',
      'delete_strategy',
      'delete_stock_event',
      'delete_chat_session',
    ];
    for (const name of destructive) {
      expect(SETTINGS_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  test('不放分析队列写回与结论落库工具', () => {
    const forbidden = [
      'record_advice_outcome',
      'cancel_analysis_job',
      'requeue_analysis_job',
      'complete_strategy_observations',
      'create_strategy_observation_candidates',
      'run_fundamental_score',
      'record_strategy_evaluation_day',
      'confirm_strategy_autonomy_action',
      'reject_strategy_autonomy_action',
    ];
    for (const name of forbidden) {
      expect(SETTINGS_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  test('不放 chat 内部工具与下单能力', () => {
    for (const name of SETTINGS_TOOL_NAMES) {
      expect(name.startsWith('chat_'), `${name} 是 chat 内部工具`).toBe(false);
      expect(name.startsWith('create_chat'), `${name} 是 chat 内部工具`).toBe(false);
    }
    const tradeTools = toolRegistry
      .all()
      .filter((tool) => tool.sideEffect === 'trade' || tool.requiredCapabilities?.includes('trade'))
      .map((tool) => tool.name);
    for (const name of tradeTools) {
      expect(SETTINGS_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  test('名单无重复项', () => {
    expect(new Set(SETTINGS_TOOL_NAMES).size).toBe(SETTINGS_TOOL_NAMES.length);
  });
});
