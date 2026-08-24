import { describe, expect, it } from 'vitest';
import { type AgentRouteContext, routeAgentMessage } from './route.js';

const EMPTY_CONTEXT: AgentRouteContext = {
  accountName: null,
  watchlistNames: [],
  strategyNames: [],
  alertPlanNames: [],
  holdingStockIds: [],
};

describe('routeAgentMessage', () => {
  it('关键词命中四类场景', () => {
    expect(routeAgentMessage('帮我复盘一下上月的建议准不准', EMPTY_CONTEXT).scenario).toBe(
      'review',
    );
    expect(routeAgentMessage('我现在持仓成本多少', EMPTY_CONTEXT).scenario).toBe('portfolio');
    expect(routeAgentMessage('最近有没有触发预警', EMPTY_CONTEXT).scenario).toBe('watch');
    expect(routeAgentMessage('帮我分析一下这家公司的基本面', EMPTY_CONTEXT).scenario).toBe(
      'research',
    );
  });

  it('无命中时落 general', () => {
    const route = routeAgentMessage('今天天气怎么样', EMPTY_CONTEXT);
    expect(route.scenario).toBe('general');
    expect(route.subjects).toEqual([]);
    expect(route.missingIdentifiers).toEqual([]);
  });

  it('多命中按 review > portfolio > watch > research 取首个', () => {
    // review + portfolio 同时命中 → review
    expect(routeAgentMessage('复盘一下我的持仓为什么亏', EMPTY_CONTEXT).scenario).toBe('review');
    // portfolio + research 同时命中 → portfolio
    expect(routeAgentMessage('分析一下我的持仓成本', EMPTY_CONTEXT).scenario).toBe('portfolio');
    // watch + research 同时命中 → watch
    expect(routeAgentMessage('这个策略的预警触发研究过没有', EMPTY_CONTEXT).scenario).toBe('watch');
  });

  it('Watchlist / AlertPlan 名称命中 → watch 并记入 subjects', () => {
    const context: AgentRouteContext = {
      ...EMPTY_CONTEXT,
      watchlistNames: ['超跌反弹'],
      alertPlanNames: ['盘中提醒'],
    };
    const route = routeAgentMessage('超跌反弹最近有什么动静', context);
    expect(route.scenario).toBe('watch');
    expect(route.subjects).toContain('超跌反弹');
    expect(routeAgentMessage('盘中提醒 还在生效吗', context).scenario).toBe('watch');
  });

  it('Strategy 名称命中：无 watch 语义 → research，有 watch 语义 → watch', () => {
    const context: AgentRouteContext = { ...EMPTY_CONTEXT, strategyNames: ['双均线'] };
    const research = routeAgentMessage('双均线的逻辑是什么', context);
    expect(research.scenario).toBe('research');
    expect(research.subjects).toContain('双均线');
    expect(routeAgentMessage('双均线的预警触发了吗', context).scenario).toBe('watch');
  });

  it('持仓股票代码命中 → portfolio；账户名命中 → portfolio', () => {
    const context: AgentRouteContext = {
      ...EMPTY_CONTEXT,
      accountName: '主账户',
      holdingStockIds: ['SZ300857'],
    };
    const byCode = routeAgentMessage('300857 现在怎么样', context);
    expect(byCode.scenario).toBe('portfolio');
    expect(byCode.subjects).toContain('SZ300857');
    expect(routeAgentMessage('主账户最近表现', context).scenario).toBe('portfolio');
  });

  it('识别建议与写入意图', () => {
    const advice = routeAgentMessage('这只票要不要买，给个建议', EMPTY_CONTEXT);
    expect(advice.needsAdvice).toBe(true);
    expect(advice.involvesWrite).toBe(false);
    const write = routeAgentMessage('帮我创建一个观察 Watchlist', EMPTY_CONTEXT);
    expect(write.involvesWrite).toBe(true);
    expect(write.needsAdvice).toBe(false);
  });

  it('确定性：同样输入同样输出', () => {
    const context: AgentRouteContext = {
      ...EMPTY_CONTEXT,
      watchlistNames: ['超跌反弹'],
      holdingStockIds: ['SZ300857'],
    };
    expect(routeAgentMessage('复盘 300857 和超跌反弹', context)).toEqual(
      routeAgentMessage('复盘 300857 和超跌反弹', context),
    );
  });
});
