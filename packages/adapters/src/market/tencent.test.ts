import { stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { TencentAdapter, TencentAdapterError } from './tencent.js';

describe('market/tencent', () => {
  describe('fetchQuote', () => {
    // 真实 API 形状（2026-07 实测）：data 以 prefixed code 为 key，
    // 内层 data.data 是 "HHMM price volume amount" 分钟行数组
    const minuteBody = (code: string) =>
      JSON.stringify({
        code: 0,
        data: {
          [code]: {
            data: { date: '20260724', data: ['0930 375 100 37500.00', '1530 380 120 45600.00'] },
          },
        },
      });

    it('解析 minute 接口；source=tencent', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('hk00700'), { status: 200 })) as never,
        clock: () => new Date('2026-07-24T08:00:00.000Z'),
      });
      const q = await adapter.fetchQuote('00700');
      expect(q.close).toBe(380);
      expect(q.open).toBe(375);
      expect(q.high).toBe(380);
      expect(q.low).toBe(375);
      expect(q.volume).toBe(12_000); // 分钟量为累计口径：末行 120 手 × 100 = 股
      expect(q.amount).toBe(45600); // 分钟额同为累计口径：末行第四列（元）
      expect(q.source).toBe('tencent');
      expect(q.observedAt).toEqual(new Date('2026-07-24T07:30:00.000Z'));
      expect(q.fetchedAt).toEqual(new Date('2026-07-24T08:00:00.000Z'));
      expect(q.timestampSource).toBe('upstream');
    });

    it('缺价抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('00700')).rejects.toBeInstanceOf(TencentAdapterError);
    });

    it('qt 快照第 4 段为昨收、第 38 段为换手率 → 填充；qt 失败 → 两字段缺省不抛错', async () => {
      const segments = Array.from({ length: 39 }, () => '');
      segments[0] = '1';
      segments[1] = '贵州茅台';
      segments[2] = '600519';
      segments[4] = '370';
      segments[38] = '0.35';
      const rtBody = (code: string) => `v_${code}="${segments.join('~')}";`;
      const withRt = new TencentAdapter({
        fetchImpl: ((url: string) =>
          Promise.resolve(
            new Response(
              String(url).includes('qt.gtimg.cn') ? rtBody('sh600519') : minuteBody('sh600519'),
              { status: 200 },
            ),
          )) as never,
      });
      const q1 = await withRt.fetchQuote('600519');
      expect(q1.prevClose).toBe(370);
      expect(q1.turnoverRatePct).toBe(0.35);

      const rtDown = new TencentAdapter({
        fetchImpl: ((url: string) =>
          String(url).includes('qt.gtimg.cn')
            ? Promise.reject(new Error('rt down'))
            : Promise.resolve(new Response(minuteBody('sh600519'), { status: 200 }))) as never,
      });
      const q2 = await rtDown.fetchQuote('600519');
      expect(q2.close).toBe(380);
      expect(q2.prevClose).toBeUndefined();
      expect(q2.turnoverRatePct).toBeUndefined();
    });

    it('港股代码 → hk 前缀', async () => {
      const capturedUrls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrls.push(String(url));
          return Promise.resolve(new Response(minuteBody('hk00700'), { status: 200 }));
        }) as never,
      });
      await adapter.fetchQuote('00700');
      expect(capturedUrls[0]).toContain('code=hk00700');
    });

    it('SH 代码 → sh 前缀', async () => {
      const capturedUrls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrls.push(String(url));
          return Promise.resolve(new Response(minuteBody('sh600519'), { status: 200 }));
        }) as never,
      });
      await adapter.fetchQuote('600519');
      expect(capturedUrls[0]).toContain('code=sh600519');
    });
  });

  describe('fetchIntradayMinutes', () => {
    const minuteBody = (
      code: string,
      rows: string[] = ['0930 375 100 37500.00', '1530 380 120 45600.00'],
    ) =>
      JSON.stringify({
        code: 0,
        data: { [code]: { data: { date: '20260724', data: rows } } },
      });

    it('分钟行整行保留累计口径；time 由 date+HHMM 投影（上海时区）', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('sh600519'), { status: 200 })) as never,
      });
      const points = await adapter.fetchIntradayMinutes('600519');
      expect(points).toHaveLength(2);
      expect(points[0]).toMatchObject({
        stockId: '600519',
        price: 375,
        cumVolume: 10_000, // 100 手 × 100 = 股
        cumAmount: 37500,
        source: 'tencent',
      });
      expect(points[0]?.time).toEqual(new Date('2026-07-24T01:30:00.000Z'));
      expect(points[1]?.cumVolume).toBe(12_000);
    });

    it('空分钟数组 → 空序列（盘前 / 非交易日合法空态，不抛错）', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('sz002594', []), { status: 200 })) as never,
      });
      await expect(adapter.fetchIntradayMinutes('002594')).resolves.toEqual([]);
    });

    it('时间 / 价格非法的行丢弃', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(
            minuteBody('sh600519', [
              '09 375 100 37500.00',
              '0930 0 100 37500.00',
              '0931 376 101 37856.00',
            ]),
            {
              status: 200,
            },
          )) as never,
      });
      const points = await adapter.fetchIntradayMinutes('600519');
      expect(points).toHaveLength(1);
      expect(points[0]?.price).toBe(376);
    });
  });

  describe('fetchDailyBars', () => {
    it('解析 fqkline day 字段；按 range 过滤', async () => {
      // 真实 API 形状（2026-07 实测）：data 以 code 为 key，元素为字符串数组
      const data = {
        sh600519: {
          qfqday: [
            ['2026-07-01', '100', '105', '110', '95', '1234560'],
            ['2026-07-02', '105', '108', '109', '104', '1500000'],
            ['2026-06-30', '99', '100', '102', '98', '800000'], // 早于 range.start
          ],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('600519', range);
      expect(bars).toHaveLength(2);
      expect(bars[0]?.date.toISOString()).toContain('2026-07-01');
      expect(bars.every((bar) => bar.adjustment === 'qfq')).toBe(true);
    });

    it('qfqday 优先于 day', async () => {
      const data = {
        sh600519: {
          qfqday: [['2026-07-01', '100', '105', '110', '95', '100']],
          day: [['2026-07-01', '99', '99', '99', '99', '1']], // 不应被使用
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('600519', range);
      expect(bars[0]?.volume).toBe(10_000); // 100 手 × 100 = 股
    });

    it('只有 raw day 时拒绝伪装为 qfq', async () => {
      const data = {
        sh600519: {
          day: [['2026-07-01', '99', '99', '99', '99', '1']],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toThrow(
        /unsupported_adjustment/,
      );
    });

    it('指数只有 raw day 时按指数真实口径接受', async () => {
      const data = {
        sh000300: {
          day: [['2026-07-01', '3900', '3910', '3920', '3890', '1000']],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('000300.SH', range);
      expect(bars).toHaveLength(1);
      expect(bars[0]).toMatchObject({ stockId: '000300.SH', close: 3910, adjustment: 'qfq' });
    });

    it('data 缺 code 节点 → 空数据抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toBeInstanceOf(
        TencentAdapterError,
      );
    });

    it('code != 0 抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: -1 }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toBeInstanceOf(
        TencentAdapterError,
      );
    });
  });

  describe('fetchMarketSnapshotEnvelope', () => {
    const universe = {
      name: 'test-universe',
      coverage: ['CN_A_SHARES_SH_SZ'] as const,
      fetchStockUniverse: async () => ({
        source: 'test-universe',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: new Date('2026-08-13T07:30:00.000Z'),
        complete: true as const,
        reportedTotal: 2,
        entries: [
          {
            stockId: '600519.SH',
            code: stockCode('600519'),
            exchange: 'SH' as const,
            name: '贵州茅台',
            listingStatus: 'unknown' as const,
          },
          {
            stockId: '000001.SZ',
            code: stockCode('000001'),
            exchange: 'SZ' as const,
            name: '平安银行',
            listingStatus: 'unknown' as const,
          },
        ],
      }),
    };

    const snapshotLine = (exchange: string, code: string, close: string, changePct: string) => {
      const fields = Array.from({ length: 33 }, () => '');
      fields[0] = exchange === 'sh' ? '1' : '51';
      fields[1] = 'ignored by directory';
      fields[2] = code;
      fields[3] = close;
      fields[30] = '20260813161452';
      fields[32] = changePct;
      return `v_${exchange}${code}="${fields.join('~')}";`;
    };

    it('按真实目录批量请求并生成完整 envelope', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        stockUniverse: universe,
        marketSnapshotChunkSize: 1,
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          const body = String(url).includes('sh600519')
            ? snapshotLine('sh', '600519', '1355.29', '0.92')
            : snapshotLine('sz', '000001', '11.25', '0');
          return Promise.resolve(new Response(body, { status: 200 }));
        }) as never,
      });
      const snapshot = await adapter.fetchMarketSnapshotEnvelope();
      expect(snapshot.source).toBe('tencent');
      expect(snapshot.completeness).toEqual({
        expectedCount: 2,
        receivedCount: 2,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      });
      expect(snapshot.items).toEqual([
        expect.objectContaining({ id: '600519.SH', close: 1355.29, changePct: 0.92 }),
        expect.objectContaining({ id: '000001.SZ', close: 11.25, changePct: 0 }),
      ]);
      expect(urls).toHaveLength(2);
      expect(urls.every((url) => url.startsWith('https://qt.gtimg.cn/q='))).toBe(true);
    });

    it('报价缺失时保留 partial envelope，不填充 0', async () => {
      const adapter = new TencentAdapter({
        stockUniverse: universe,
        fetchImpl: (async () =>
          new Response(snapshotLine('sh', '600519', '1355.29', '0.92'), { status: 200 })) as never,
      });
      const snapshot = await adapter.fetchMarketSnapshotEnvelope();
      expect(snapshot.completeness).toMatchObject({
        expectedCount: 2,
        receivedCount: 1,
        missingCount: 1,
        complete: false,
      });
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]).not.toHaveProperty('close', 0);
    });
  });

  describe('fetchBatchQuotes（原生批量）', () => {
    /** qt 文本行：字段布局 [3]最新价 [6]成交量(手) [30]行情时间 [32]涨跌幅%；其余空。 */
    const batchLine = (exchange: string, code: string, close: string, changePct: string) => {
      const fields = Array.from({ length: 39 }, () => '');
      fields[0] = exchange === 'sh' ? '1' : '51';
      fields[2] = code;
      fields[3] = close;
      fields[30] = '20260813161452';
      fields[32] = changePct;
      return `v_${exchange}${code}="${fields.join('~')}";`;
    };

    it('单次请求取整批；无对应行 / 非法代码只丢弃该只', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          const body = [
            batchLine('sh', '600519', '1355.29', '0.92'),
            batchLine('sz', '000001', '11.25', '0'),
          ].join('\n');
          return Promise.resolve(new Response(body, { status: 200 }));
        }) as never,
        clock: () => new Date('2026-08-13T08:20:00.000Z'),
      });
      const quotes = await adapter.fetchBatchQuotes(['600519', '000001', '999999']);
      // 一次请求、两只返回；999999 无对应行被丢弃
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('sh600519,sz000001,sh999999');
      expect(quotes).toHaveLength(2);
      expect(quotes.map((q) => q.stockId)).toEqual(['600519', '000001']);
      expect(quotes.find((q) => q.stockId === '600519')?.close).toBe(1355.29);
    });
  });

  describe('fetchIndexQuotes', () => {
    /**
     * qt.gtimg.cn 返回 GBK 字节流；Node 无 GBK encoder，测试直接拼字节：
     * ASCII 段走 TextEncoder，中文名用手工 GBK 字节序列。
     * 字段布局 [1]名称 [3]最新点位 [4]昨收 [30]行情时间 [31]涨跌额 [32]涨跌幅%。
     */
    const GBK_NAME = {
      上证指数: [0xc9, 0xcf, 0xd6, 0xa4, 0xd6, 0xb8, 0xca, 0xfd],
      深证成指: [0xc9, 0xee, 0xd6, 0xa4, 0xb3, 0xc9, 0xd6, 0xb8],
      创业板指: [0xb4, 0xb4, 0xd2, 0xb5, 0xb0, 0xe5, 0xd6, 0xb8],
      沪深300: [0xbb, 0xa6, 0xc9, 0xee, 0x33, 0x30, 0x30],
      科创50: [0xbf, 0xc6, 0xb4, 0xb4, 0x35, 0x30],
      恒生指数: [0xba, 0xe3, 0xc9, 0xfa, 0xd6, 0xb8, 0xca, 0xfd],
    } as const;

    interface IndexLineSpec {
      readonly prefixed: string;
      readonly name: keyof typeof GBK_NAME;
      readonly close: string;
      readonly prevClose: string;
      readonly change: string;
      readonly changePct: string;
    }

    const gbkBody = (lines: readonly IndexLineSpec[]): Response => {
      const encoder = new TextEncoder();
      const bytes: number[] = [];
      for (const line of lines) {
        const fields = Array.from({ length: 39 }, () => '');
        fields[3] = line.close;
        fields[4] = line.prevClose;
        fields[30] = '20260813161452';
        fields[31] = line.change;
        fields[32] = line.changePct;
        const head = `v_${line.prefixed}="${fields.slice(0, 1).join('~')}~`;
        const tail = `~${fields.slice(2).join('~')}";\n`;
        bytes.push(...encoder.encode(head), ...GBK_NAME[line.name], ...encoder.encode(tail));
      }
      return new Response(Uint8Array.from(bytes), { status: 200 });
    };

    const ALL_INDICES: readonly IndexLineSpec[] = [
      {
        prefixed: 'sh000001',
        name: '上证指数',
        close: '3905.20',
        prevClose: '3903.72',
        change: '1.48',
        changePct: '0.04',
      },
      {
        prefixed: 'sz399001',
        name: '深证成指',
        close: '13100.50',
        prevClose: '13050.10',
        change: '50.40',
        changePct: '0.39',
      },
      {
        prefixed: 'sz399006',
        name: '创业板指',
        close: '3150.20',
        prevClose: '3140.00',
        change: '10.20',
        changePct: '0.32',
      },
      {
        prefixed: 'sh000300',
        name: '沪深300',
        close: '4600.10',
        prevClose: '4590.00',
        change: '10.10',
        changePct: '0.22',
      },
      {
        prefixed: 'sh000688',
        name: '科创50',
        close: '1380.00',
        prevClose: '1370.00',
        change: '10.00',
        changePct: '0.73',
      },
      {
        prefixed: 'hkHSI',
        name: '恒生指数',
        close: '26500.00',
        prevClose: '26400.00',
        change: '100.00',
        changePct: '0.38',
      },
    ];

    it('单次请求取全部 6 只指数；source=tencent；时间按上游', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          return Promise.resolve(gbkBody(ALL_INDICES));
        }) as never,
        clock: () => new Date('2026-08-13T08:20:00.000Z'),
      });
      const indices = await adapter.fetchIndexQuotes();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('sh000001,sz399001,sz399006,sh000300,sh000688,hkHSI');
      expect(indices).toHaveLength(6);
      expect(indices[0]).toEqual({
        code: '000001',
        name: '上证指数',
        close: 3905.2,
        change: 1.48,
        changePct: 0.04,
        ts: new Date('2026-08-13T08:14:52.000Z'),
        source: 'tencent',
      });
      expect(indices.at(-1)?.code).toBe('HSI');
      expect(indices.at(-1)?.name).toBe('恒生指数');
    });

    it('涨跌额 / 涨跌幅缺失时按昨收回算', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          gbkBody([
            {
              prefixed: 'sh000001',
              name: '上证指数',
              close: '3905.20',
              prevClose: '3903.72',
              change: '',
              changePct: '',
            },
          ])) as never,
      });
      const indices = await adapter.fetchIndexQuotes();
      expect(indices).toHaveLength(1);
      expect(indices[0]?.change).toBeCloseTo(1.48);
      expect(indices[0]?.changePct).toBeCloseTo(0.038, 2);
    });

    it('单只缺失只跳过该只；全部缺失抛 TencentAdapterError', async () => {
      const partial = new TencentAdapter({
        fetchImpl: (async () => gbkBody([ALL_INDICES[0] as IndexLineSpec])) as never,
      });
      await expect(partial.fetchIndexQuotes()).resolves.toHaveLength(1);

      const empty = new TencentAdapter({
        fetchImpl: (async () => new Response('', { status: 200 })) as never,
      });
      await expect(empty.fetchIndexQuotes()).rejects.toBeInstanceOf(TencentAdapterError);
    });

    it('HTTP 错误抛 TencentAdapterError', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response('x', { status: 500 })) as never,
      });
      await expect(adapter.fetchIndexQuotes()).rejects.toBeInstanceOf(TencentAdapterError);
    });
  });

  describe('fetchMinuteBars', () => {
    /** mkline 真实形状（2026-10-05 实盘）：[YYYYMMDDHHMM, open, close, high, low, volume(手), {}, …]。 */
    const mklineBody = (code: string, freq: string, rows: readonly (readonly string[])[]) =>
      JSON.stringify({ code: 0, data: { [code]: { [freq]: rows } } });

    const M5_ROWS = [
      // 前一交易日的桶：应被过滤掉
      ['202609291455', '1250.00', '1251.00', '1252.00', '1249.00', '100.00'],
      ['202609301455', '1256.05', '1258.62', '1259.20', '1256.00', '555.00'],
      ['202609301500', '1258.60', '1258.62', '1258.62', '1256.05', '979.00'],
    ] as const;

    it('按最新交易日过滤；标签为桶结束时间；volume 手 → 股；source=tencent', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          return Promise.resolve(
            new Response(mklineBody('sh600519', 'm5', M5_ROWS), { status: 200 }),
          );
        }) as never,
        clock: () => new Date('2026-09-30T08:00:00.000Z'), // 16:00 +08:00，收盘后
      });
      const bars = await adapter.fetchMinuteBars('600519.SH', '5m');
      expect(urls[0]).toContain('param=sh600519,m5,,400');
      expect(bars).toHaveLength(2);
      expect(bars[0]).toMatchObject({
        stockId: '600519.SH',
        interval: '5m',
        open: 1256.05,
        close: 1258.62,
        high: 1259.2,
        low: 1256.0,
        volume: 55_500, // 555 手 × 100
        adjustment: 'raw',
        source: 'tencent',
        completeness: 'closed',
      });
      expect(bars[0]?.endedAt).toEqual(new Date('2026-09-30T06:55:00.000Z')); // 14:55 +08:00
      expect(bars[1]?.endedAt).toEqual(new Date('2026-09-30T07:00:00.000Z')); // 15:00 +08:00
    });

    it('末桶在一个周期内 → live；未收盘桶（标签晚于 fetchedAt）丢弃', async () => {
      const rows = [
        ['202609301455', '1256.05', '1258.62', '1259.20', '1256.00', '555.00'],
        ['202609301500', '1258.60', '1258.62', '1258.62', '1256.05', '979.00'], // 尚未收盘
      ];
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(mklineBody('sh600519', 'm5', rows), { status: 200 })) as never,
        clock: () => new Date('2026-09-30T06:56:30.000Z'), // 14:56:30 +08:00，末收盘桶 90s 前
      });
      const bars = await adapter.fetchMinuteBars('600519', '5m');
      expect(bars).toHaveLength(1);
      expect(bars[0]?.completeness).toBe('live');
    });

    it('interval → 频率参数映射（60m → m60）', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          return Promise.resolve(
            new Response(
              mklineBody('sz002594', 'm60', [
                ['202609301500', '100.00', '101.00', '102.00', '99.00', '10.00'],
              ]),
              { status: 200 },
            ),
          );
        }) as never,
        clock: () => new Date('2026-09-30T08:00:00.000Z'),
      });
      const bars = await adapter.fetchMinuteBars('002594.SZ', '60m');
      expect(urls[0]).toContain('param=sz002594,m60,,400');
      expect(bars[0]?.interval).toBe('60m');
    });

    it('缺频率节点 / 空响应 / code!=0 → TencentAdapterError', async () => {
      const missing = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data: { sh600519: {} } }), {
            status: 200,
          })) as never,
      });
      await expect(missing.fetchMinuteBars('600519', '5m')).rejects.toBeInstanceOf(
        TencentAdapterError,
      );

      const emptyRows = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(mklineBody('sh600519', 'm5', []), { status: 200 })) as never,
      });
      await expect(emptyRows.fetchMinuteBars('600519', '5m')).rejects.toBeInstanceOf(
        TencentAdapterError,
      );

      const upstream = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: -1 }), { status: 200 })) as never,
      });
      await expect(upstream.fetchMinuteBars('600519', '5m')).rejects.toBeInstanceOf(
        TencentAdapterError,
      );
    });

    it('非法价格行跳过；违反 OHLC 不变量 → invalid_payload', async () => {
      const skipped = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(
            mklineBody('sh600519', 'm5', [
              ['202609301455', 'abc', '1258.62', '1259.20', '1256.00', '555.00'],
              ['202609301500', '1258.60', '1258.62', '1258.62', '1256.05', '979.00'],
            ]),
            { status: 200 },
          )) as never,
        clock: () => new Date('2026-09-30T08:00:00.000Z'),
      });
      await expect(skipped.fetchMinuteBars('600519', '5m')).resolves.toHaveLength(1);

      const violated = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(
            mklineBody('sh600519', 'm5', [
              ['202609301500', '1258.60', '1258.62', '1250.00', '1256.05', '979.00'], // high < close
            ]),
            { status: 200 },
          )) as never,
        clock: () => new Date('2026-09-30T08:00:00.000Z'),
      });
      await expect(violated.fetchMinuteBars('600519', '5m')).rejects.toThrow(/invalid_payload/);
    });
  });
});
