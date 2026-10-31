// 组合回测面板的门禁态断言（REQ-M1-05 §4）。
//
// 断言的是 strict-backtest-view.js 的判定，不是组件的 if：组件依赖宿主注入的 `react`，
// 本仓没装，渲染不出来；把判定做成纯数据模块就是为了让这条能被自动测。
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  METRICS_UNAVAILABLE_COPY,
  STRICT_BACKTEST_COPY,
  strictBacktestView,
} from './strict-backtest-view.js';

const gateItem = (key, status, reason) => ({ key, status, reason, evidenceRefs: [] });

// `resultAvailability: null` 表示「旧 run 没有这个字段」——整个键都不出现；
// 传字符串则原样写入，省略则跟随门禁态。
const run = ({ gateStatus, metrics, resultAvailability, limitations }) => ({
  id: 'strict-backtest-fixture',
  status: 'complete',
  ...(resultAvailability === null ? {} : { resultAvailability: resultAvailability ?? gateStatus }),
  spec: {
    from: '2026-01-05',
    to: '2026-01-09',
    benchmark: { stockId: '000300.SH' },
    initialCash: 1_000_000,
    execution: { maxPositions: 20 },
  },
  gateAudit: {
    status: gateStatus,
    assessedAt: '2026-01-10T00:00:00.000Z',
    items: [
      gateItem('pit-universe', 'complete', 'PIT universe 与逐日运行完整'),
      gateItem(
        'daily-bar-revisions',
        gateStatus === 'complete' ? 'complete' : 'partial',
        '至少一个 evaluation day 的 DailyBar vintage/cutoff 不可用',
      ),
      gateItem(
        'tradability',
        gateStatus === 'complete' ? 'complete' : 'unavailable',
        '缺少停牌/涨跌停/退市可交易性事实',
      ),
      gateItem(
        'benchmark',
        gateStatus === 'complete' ? 'complete' : 'partial',
        'benchmark revision/cutoff 覆盖不完整',
      ),
    ],
  },
  ...(limitations === undefined ? {} : { limitations }),
  ...(metrics === undefined
    ? {}
    : {
        metrics: {
          netReturnPct: 0.184,
          maxDrawdownPct: -0.093,
          benchmarkReturnPct: 0.021,
          tradeCount: 42,
        },
      }),
});

describe('组合回测面板：结果可用性与缺口披露分离（T22 语义）', () => {
  it('partial 门禁 + resultAvailability complete + metrics → 指标渲染，limitations 进 disclosures', () => {
    const view = strictBacktestView(
      run({
        gateStatus: 'partial',
        resultAvailability: 'complete',
        metrics: 'present',
        limitations: [
          '未考虑分红送转：高股息标的总收益被低估；除权除息日的价格跳空被当成真实亏损。',
        ],
      }),
    );
    expect(view.gateComplete).toBe(false);
    expect(view.gateLabel).toBe(STRICT_BACKTEST_COPY.gate.incomplete);
    expect(view.metrics?.map((metric) => metric.label)).toEqual([
      '净收益',
      '最大回撤',
      '基准收益',
      '成交笔数',
    ]);
    expect(view.metrics?.find((metric) => metric.key === 'netReturn')?.value).toContain('18.4');
    // 验收①：披露只在 disclosures，blockers 不得混入。
    expect(view.disclosures.join('\n')).toContain('未考虑分红送转');
    expect(view.blockers.join('\n')).not.toContain('未考虑分红送转');
    expect(view.blockers).toEqual([
      '至少一个 evaluation day 的 DailyBar vintage/cutoff 不可用',
      '缺少停牌/涨跌停/退市可交易性事实',
      'benchmark revision/cutoff 覆盖不完整',
    ]);
    // 有指标就不该有「为什么没有指标」的文案。
    expect(view.metricsUnavailableReason).toBeUndefined();
  });

  it('resultAvailability 缺失时 metrics 为 null（fail-closed）且给出可见原因', () => {
    const view = strictBacktestView(
      run({ gateStatus: 'partial', resultAvailability: null, metrics: 'present' }),
    );
    expect(view.metrics).toBeNull();
    // 验收③：不能只是空白，原因必须是具体文案。
    expect(view.metricsUnavailableReason).toBe(METRICS_UNAVAILABLE_COPY.missingAvailability);
    expect(typeof view.metricsUnavailableReason).toBe('string');
    expect(view.metricsUnavailableReason).not.toBe('');
    expect(view.metricsUnavailableReason).toContain('resultAvailability');
    expect(view.metricsUnavailableReason).toContain('无法判定');
  });

  it('resultAvailability=partial 但残留 metrics → 不渲染（fail-closed），原因指向实际取值', () => {
    const view = strictBacktestView(
      run({ gateStatus: 'partial', resultAvailability: 'partial', metrics: 'present' }),
    );
    expect(view.metrics).toBeNull();
    expect(view.metricsUnavailableReason).toContain('partial');
    expect(view.metricsUnavailableReason).not.toBe(METRICS_UNAVAILABLE_COPY.missingAvailability);
    const text = JSON.stringify(view);
    for (const banned of ['净收益', '18.4', '42']) expect(text).not.toContain(banned);
  });

  it('门禁 complete 也不能替 resultAvailability 作证：缺字段照样 fail-closed', () => {
    // 捷径「门禁完备所以结果可用」必须不成立——旧 run 没写 resultAvailability 时，
    // 门禁 complete 只说明缺口检查通过，不说明这次运行产出了结果。
    const view = strictBacktestView(
      run({ gateStatus: 'complete', resultAvailability: null, metrics: 'present' }),
    );
    expect(view.gateComplete).toBe(true);
    expect(view.metrics).toBeNull();
    expect(view.metricsUnavailableReason).toBe(METRICS_UNAVAILABLE_COPY.missingAvailability);
  });

  it('resultAvailability=complete 但缺 metrics → 仍 fail-closed，原因区分于「缺字段」', () => {
    const view = strictBacktestView(
      run({ gateStatus: 'partial', resultAvailability: 'complete', metrics: undefined }),
    );
    expect(view.metrics).toBeNull();
    expect(view.metricsUnavailableReason).toBe(METRICS_UNAVAILABLE_COPY.missingMetrics);
    expect(view.metricsUnavailableReason).toContain('metrics');
  });

  it('partial 门禁只给门禁审计表与阻塞项清单，且阻塞项 ≥1 条具体事实', () => {
    const view = strictBacktestView(run({ gateStatus: 'partial', metrics: 'present' }));
    expect(view.auditRows).toHaveLength(4);
    expect(view.auditRows.map((row) => row.key)).toEqual([
      'pit-universe',
      'daily-bar-revisions',
      'tradability',
      'benchmark',
    ]);
    expect(view.blockers).toEqual([
      '至少一个 evaluation day 的 DailyBar vintage/cutoff 不可用',
      '缺少停牌/涨跌停/退市可交易性事实',
      'benchmark revision/cutoff 覆盖不完整',
    ]);
    expect(view.blockers.length).toBeGreaterThan(0);
    expect(view.disclosures).toEqual([]);
  });

  it('门禁真有阻塞项时 blockers 携带该项 reason（验收②）', () => {
    const view = strictBacktestView({
      id: 'strict-backtest-one-blocker',
      status: 'complete',
      resultAvailability: 'complete',
      gateAudit: {
        status: 'partial',
        assessedAt: '2026-01-10T00:00:00.000Z',
        items: [
          gateItem('pit-universe', 'complete', 'PIT universe 与逐日运行完整'),
          gateItem('corporate-actions', 'unavailable', '缺少分红送转事实，无法还原除权除息'),
        ],
      },
      limitations: ['未考虑分红送转：高股息标的总收益被低估。'],
      metrics: {
        netReturnPct: 0.184,
        maxDrawdownPct: -0.093,
        benchmarkReturnPct: 0.021,
        tradeCount: 42,
      },
    });
    expect(view.blockers).toEqual(['缺少分红送转事实，无法还原除权除息']);
    expect(view.disclosures).toEqual(['未考虑分红送转：高股息标的总收益被低估。']);
    // 两类清单不得互相渗透：门禁原因不进披露，披露不进阻塞。
    expect(view.disclosures.join('\n')).not.toContain('无法还原除权除息');
    expect(view.blockers.join('\n')).not.toContain('被低估');
  });

  it('审计项缺失时仍要给出 ≥1 条阻塞项，而不是空列表假装完备', () => {
    const view = strictBacktestView({
      id: 'strict-backtest-no-audit',
      status: 'queued',
      gateAudit: undefined,
    });
    expect(view.gateComplete).toBe(false);
    expect(view.auditRows).toEqual([]);
    expect(view.blockers).toEqual([STRICT_BACKTEST_COPY.gate.missing]);
    expect(view.disclosures).toEqual([]);
  });

  it('门禁 complete 也渲染指标，且指标来源只有一份（本模块）', () => {
    const view = strictBacktestView(run({ gateStatus: 'complete', metrics: 'present' }));
    expect(view.gateComplete).toBe(true);
    expect(view.metrics.map((metric) => metric.label)).toEqual([
      '净收益',
      '最大回撤',
      '基准收益',
      '成交笔数',
    ]);
    expect(view.blockers).toEqual([]);
    // 验收④：正常渲染时不得残留「为什么没有指标」的文案。
    expect(view.metricsUnavailableReason).toBeUndefined();
  });

  it('阻塞项与披露在 UI 上可区分：标题不同且都不为空', () => {
    expect(STRICT_BACKTEST_COPY.blockerTitle).not.toBe(STRICT_BACKTEST_COPY.disclosureTitle);
    expect(STRICT_BACKTEST_COPY.blockerTitle.trim()).not.toBe('');
    expect(STRICT_BACKTEST_COPY.disclosureTitle.trim()).not.toBe('');
  });

  it('文案字典不含被摘除的旧名', () => {
    const text = JSON.stringify(STRICT_BACKTEST_COPY);
    // 旧名以码点写出：本文件要能判定它们，又不该自己被文案守卫扫到。
    expect(text).not.toContain('\u4e25\u683c\u56de\u6d4b');
    expect(text).not.toContain('\u6a21\u62df\u56de\u6d4b');
    expect(text).not.toContain('backtest');
  });
});

// 组件依赖宿主注入的 `react`，本仓没装，渲染不出来；这里只能做源码结构守卫
// （同 apps/web/public/js/entry-points.test.js 的做法），保证组件真的消费了
// 新字段、且披露与阻塞挂在各自的标题下。它不能证明排版效果，见交付说明。
describe('组合回测面板：组件消费新字段（源码结构守卫）', () => {
  const source = readFileSync(new URL('./research-results.js', import.meta.url), 'utf8');

  // 找到某个标题所在的那次 ResearchLimitations 调用，回看它绑定的 items 字段。
  const itemsForTitle = (titleKey) => {
    const at = source.indexOf(`title: STRICT_BACKTEST_COPY.${titleKey}`);
    if (at < 0) return null;
    const nearby = source.slice(Math.max(0, at - 240), at);
    const matches = [...nearby.matchAll(/items: view\.(\w+)/g)];
    return matches.at(-1)?.[1] ?? null;
  };

  it('披露与阻塞各挂各的标题，字段不互换', () => {
    expect(itemsForTitle('blockerTitle')).toBe('blockers');
    expect(itemsForTitle('disclosureTitle')).toBe('disclosures');
  });

  it('指标缺失时渲染 metricsUnavailableReason，而不是什么都不显示', () => {
    expect(source).toContain('view.metricsUnavailableReason');
  });
});
