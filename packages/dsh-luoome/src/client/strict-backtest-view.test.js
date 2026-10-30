// 组合回测面板的门禁态断言（REQ-M1-05 §4）。
//
// 断言的是 strict-backtest-view.js 的判定，不是组件的 if：组件依赖宿主注入的 `react`，
// 本仓没装，渲染不出来；把判定做成纯数据模块就是为了让这条能被自动测。
import { describe, expect, it } from 'vitest';

import { STRICT_BACKTEST_COPY, strictBacktestView } from './strict-backtest-view.js';

const gateItem = (key, status, reason) => ({ key, status, reason, evidenceRefs: [] });

const run = ({ gateStatus, metrics }) => ({
  id: 'strict-backtest-fixture',
  status: 'complete',
  resultAvailability: gateStatus,
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

describe('组合回测面板：门禁未 complete 时不得出现收益数字', () => {
  it('partial 门禁 + 残留 metrics → 面板视图不产出任何指标（含 — 占位）', () => {
    // 故意构造「门禁 partial 但 run 上残留 metrics」：仓库/DB 层不一致时以门禁为准。
    const view = strictBacktestView(run({ gateStatus: 'partial', metrics: 'present' }));
    expect(view.gateComplete).toBe(false);
    expect(view.gateLabel).toBe(STRICT_BACKTEST_COPY.gate.incomplete);
    expect(view.metrics).toBeNull();
    // 整份视图序列化后不得出现收益/回撤/Sharpe 字样，也不得出现 metrics 的数值。
    const text = JSON.stringify(view);
    for (const banned of ['收益率', '回撤', 'Sharpe', '净收益', '18.4', '9.3', '42'])
      expect(text).not.toContain(banned);
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

  it('门禁 complete 才渲染指标，且指标来源只有一份（本模块）', () => {
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
