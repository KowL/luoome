import { describe, expect, it } from 'vitest';
import { diagnosticDate, diagnosticRows, diagnosticsSummary } from './diagnostics.js';

const finding = (code, table, field, at, severity, message) => ({
  code,
  severity,
  table,
  field,
  at,
  message,
});

describe('T14 诊断展示层', () => {
  it('缺行情：结论带表名、字段名与日期', () => {
    const rows = diagnosticRows({
      findings: [
        finding(
          'market-quote-missing',
          'price_snapshots',
          'observed_at',
          '2026-10-28T06:00:00.000Z',
          'warn',
          '表 price_snapshots 最近行情时间 2026-10-28 06:00:00',
        ),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: '缺行情',
      subject: 'price_snapshots.observed_at',
      at: '2026-10-28 06:00:00',
      severity: 'warn',
    });
    expect(rows[0].message).toContain('price_snapshots');
  });

  it('迁移未完成：结论带 schema_migrations.id 与最近应用日期', () => {
    const rows = diagnosticRows({
      findings: [
        finding(
          'migration-incomplete',
          'schema_migrations',
          'id',
          '2026-10-20T01:02:03.000Z',
          'bad',
          '表 schema_migrations 缺少 id=m1-06-signal-observation-vintage-v1',
        ),
      ],
    });
    expect(rows[0]).toMatchObject({
      label: '迁移未完成',
      subject: 'schema_migrations.id',
      at: '2026-10-20 01:02:03',
      severity: 'bad',
      severityLabel: '阻断',
    });
  });

  it('连接失败：结论带表名、last_error_kind 与尝试时间', () => {
    const rows = diagnosticRows({
      findings: [
        finding(
          'source-unavailable',
          'stock_universe_sync_runs',
          'last_error_kind',
          '2026-10-30T14:00:00.000Z',
          'bad',
          '数据源 eastmoney（dataset=stock-universe）最近一次尝试失败：lastErrorKind=network',
        ),
      ],
    });
    expect(rows[0]).toMatchObject({
      label: '连接失败',
      subject: 'stock_universe_sync_runs.last_error_kind',
      at: '2026-10-30 14:00:00',
    });
  });

  it('无日期显示「从未」，空结果给出正常摘要', () => {
    expect(diagnosticDate(null)).toBe('从未');
    expect(diagnosticDate('')).toBe('从未');
    expect(diagnosticsSummary({ findings: [] })).toEqual({
      tone: 'ok',
      text: '未发现数据问题。',
    });
    expect(
      diagnosticsSummary({
        findings: [finding('daily-bar-stale', 'daily_bars', 'trade_date', null, 'bad', 'x')],
      }),
    ).toMatchObject({ tone: 'bad' });
  });
});
