// 组合回测面板的门禁态断言（REQ-M1-05 §4）。
//
// 断言的是 strict-backtest-view.js 的判定，不是组件的 if：组件依赖宿主注入的 `react`，
// 本仓没装，渲染不出来；把判定做成纯数据模块就是为了让这条能被自动测。
import { describe, expect, it } from 'vitest';

import { STRICT_BACKTEST_COPY, strictBacktestView } from './strict-backtest-view.js';

const gateItem = (key, status, reason) => ({ key, status, reason, evidenceRefs: [] });

const run = ({ gateStatus, metrics, resultAvailability = gateStatus, limitations }) => ({
  id: 'strict-backtest-fixture',
  status: 'complete',
  resultAvailability,
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
  it('partial 门禁 + resultAvailability complete + metrics → 指标渲染，limitations 同时可见', () => {
    const view = strictBacktestView(
      run({
        gateStatus: 'partial',
        resultAvailability: 'complete',
        metrics: 'present',
        limitations: ['未考虑分红送转：高股息标的总收益被低估；除权除息日的价格跳空被当成真实亏损。'],
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
    expect(view.blockers.join('\n')).toContain('未考虑分红送转');
  });

  it('resultAvailability 缺失时 metrics 为 null（fail-closed）', () => {
    const view = strictBacktestView(
      run({ gateStatus: 'partial', resultAvailability: undefined, metrics: 'present' }),
    );
    expect(view.metrics).toBeNull();
  });

  it('resultAvailability=partial 但残留 metrics → 不渲染（fail-closed）', () => {
    const view = strictBacktestView(
      run({ gateStatus: 'partial', resultAvailability: 'partial', metrics: 'present' }),
    );
    expect(view.metrics).toBeNull();
    const text = JSON.stringify(view);
    for (const banned of ['净收益', '18.4', '42']) expect(text).not.toContain(banned);
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
  });

  it('文案字典不含被摘除的旧名', () => {
    const text = JSON.stringify(STRICT_BACKTEST_COPY);
    // 旧名以码点写出：本文件要能判定它们，又不该自己被文案守卫扫到。
    expect(text).not.toContain('\u4e25\u683c\u56de\u6d4b');
    expect(text).not.toContain('\u6a21\u62df\u56de\u6d4b');
    expect(text).not.toContain('backtest');
  });
});
