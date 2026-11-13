import { describe, expect, it, vi } from 'vitest';
import { parseFuyaoEnvelope } from '../fuyao/envelope.js';
import { SourceExecutionError } from '../source-error.js';
import {
  FuyaoDragonTigerFlowSource,
  parseDragonTigerBoardPayload,
  parseTradingDaysPayload,
} from './fuyao.js';

const boardBody = (stocks: unknown[], tradeDate = '2026-11-11'): unknown => ({
  code: 0,
  message: 'success',
  request_id: 'req-1',
  data: { timestamp: 1794326400000, board_type: 'all', trade_date: tradeDate, stock_items: stocks },
});

const stockRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  thscode: '000678.SZ',
  ticker: '000678',
  name: '襄阳轴承',
  change: 0.100208,
  concept_list: [{ name: '减速器' }, { name: ' 农机 ' }, { name: null }, { name: '减速器' }],
  net_value: 69001099.23,
  buy_value: 413469943.11,
  sell_value: 344468843.88,
  amount: 1000000000,
  range_days: 1,
  org_net_value: 68337058.45,
  hot_money_net_value: -42217286.68,
  ...overrides,
});

describe('parseDragonTigerBoardPayload', () => {
  it('映射代码 / 金额 / 概念（去空去重去空白）', () => {
    const day = parseDragonTigerBoardPayload(
      parseFuyaoEnvelope(boardBody([stockRow()])),
      '2026-11-11',
      1,
    );
    expect(day.date).toBe('2026-11-11');
    expect(day.stocks).toHaveLength(1);
    expect(day.stocks[0]).toMatchObject({
      code: '000678',
      name: '襄阳轴承',
      netAmount: 69001099.23,
      orgNetAmount: 68337058.45,
      hotNetAmount: -42217286.68,
      concepts: ['减速器', '农机'],
    });
  });

  it('range_days 过滤：仅保留请求区间，同一代码不重复', () => {
    const day = parseDragonTigerBoardPayload(
      parseFuyaoEnvelope(
        boardBody([
          stockRow({ range_days: 1 }),
          stockRow({ range_days: 3 }),
          stockRow({ range_days: 1, ticker: '600001', thscode: '600001.SH' }),
        ]),
      ),
      '2026-11-11',
      1,
    );
    expect(day.stocks.map((s) => s.code)).toEqual(['000678', '600001']);
  });

  it('ticker 缺失时回退 thscode 前缀；代码非法则跳过', () => {
    const day = parseDragonTigerBoardPayload(
      parseFuyaoEnvelope(
        boardBody([
          stockRow({ ticker: null, thscode: '301052.SZ' }),
          stockRow({ ticker: 'bad', thscode: null }),
        ]),
      ),
      '2026-11-11',
      1,
    );
    expect(day.stocks.map((s) => s.code)).toEqual(['301052']);
  });

  it('trade_date 与请求日不一致 → invalid_payload，不静默改挂', () => {
    try {
      parseDragonTigerBoardPayload(
        parseFuyaoEnvelope(boardBody([stockRow()], '2026-11-10')),
        '2026-11-11',
        1,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SourceExecutionError);
      expect((error as SourceExecutionError).kind).toBe('invalid_payload');
      expect((error as SourceExecutionError).message).toContain('日期错配');
    }
  });

  it('缺字段按 0 归一（org / hot / 金额），不抛错', () => {
    const day = parseDragonTigerBoardPayload(
      parseFuyaoEnvelope(
        boardBody([
          stockRow({
            org_net_value: null,
            hot_money_net_value: null,
            buy_value: null,
            sell_value: null,
            amount: null,
            change: null,
          }),
        ]),
      ),
      '2026-11-11',
      1,
    );
    expect(day.stocks[0]).toMatchObject({
      orgNetAmount: 0,
      hotNetAmount: 0,
      buyAmount: 0,
      sellAmount: 0,
      amount: 0,
      changePct: 0,
    });
  });

  it('code=1002（非交易日 / 参数错）→ upstream_error', () => {
    try {
      parseDragonTigerBoardPayload(
        parseFuyaoEnvelope({ code: 1002, message: 'not trading day', data: null }),
        '2026-11-11',
        1,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as SourceExecutionError).kind).toBe('upstream_error');
    }
  });
});

describe('parseTradingDaysPayload', () => {
  it('yyyyMMdd → yyyy-MM-dd 升序', () => {
    const raw = {
      code: 0,
      message: 'success',
      data: {
        timestamp: 1748275200000,
        item: [
          { date_ms: 1748188800000, date: '20250526' },
          { date_ms: 1747929600000, date: '20250523' },
        ],
      },
    };
    expect(parseTradingDaysPayload(parseFuyaoEnvelope(raw))).toEqual(['2025-05-23', '2025-05-26']);
  });
});

describe('FuyaoDragonTigerFlowSource', () => {
  it('fetchTradingDays / fetchBoard 走 get 信封并解析 data', async () => {
    const get = vi.fn(async (path: string) =>
      parseFuyaoEnvelope(
        path.includes('calendar')
          ? {
              code: 0,
              data: { item: [{ date: '20261110' }, { date: '20261111' }] },
            }
          : boardBody([stockRow()]),
      ),
    );
    const source = new FuyaoDragonTigerFlowSource({ client: { get } });
    await expect(source.fetchTradingDays('2026-11-10', '2026-11-11')).resolves.toEqual([
      '2026-11-10',
      '2026-11-11',
    ]);
    const day = await source.fetchBoard('2026-11-11', 1);
    expect(day.stocks[0]?.code).toBe('000678');
    expect(get).toHaveBeenCalledWith('/api/a-share/special-data/dragon-tiger-list', {
      board_type: 'all',
      date: '2026-11-11',
    });
  });
});
