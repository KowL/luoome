import type { Context, Hono } from 'hono';
import { jsonResult } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerMarketRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const { callTool, invokeTool, invokeIndexQuotes, requireMutationCapabilities, serveFile } = deps;

  const intQuery = (raw: string | undefined, fallback: number, min: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) return fallback;
    return n;
  };

  const enumQuery = <T extends string>(
    raw: string | undefined,
    fallback: T,
    allowed: readonly T[],
  ): T => {
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };

  /** 连板天梯 / 对比共用 query 解析；compare 的校验顺序保持先 date 后 prevDate。 */
  const parseLimitUpQuery = (
    c: Context,
    { requirePrevDate }: { requirePrevDate: boolean },
  ): { input: Record<string, unknown> } | { response: Response } => {
    const date = c.req.query('date');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        response: jsonResult({
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'date 必填且为 YYYY-MM-DD',
            issues: [],
          },
        }),
      };
    }
    const input: Record<string, unknown> = { date };
    if (requirePrevDate) {
      const prevDate = c.req.query('prevDate');
      if (typeof prevDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(prevDate)) {
        return {
          response: jsonResult({
            ok: false,
            error: { kind: 'invalid_input', message: 'prevDate 必填且为 YYYY-MM-DD', issues: [] },
          }),
        };
      }
      input.prevDate = prevDate;
    }
    input.days = intQuery(c.req.query('days'), 15, 1);
    input.source = enumQuery(c.req.query('source'), 'eastmoney', ['eastmoney']);
    input.includeStar = c.req.query('includeStar') === 'true';
    input.includeBse = c.req.query('includeBse') === 'true';
    input.includeST = c.req.query('includeST') === 'true';
    input.includeUncategorized = c.req.query('includeUncategorized') === 'true';
    return { input };
  };

  /**
   * 连板天梯（Phase 2，docs/ddd/limit-up-ladder-detailed-design.md §11）。
   *
   * 参数：
   *   date (必填) YYYY-MM-DD
   *   days, includeStar, includeBse, includeST, includeUncategorized (可选)
   *
   * 缓存：Manager 自带 LRU + 分时段 TTL;web 层不再加二级。
   * 上游不可达：tool 返回 internal；web 包成 HTTP 502。
   */
  app.get('/api/market/limit-up', async (c) => {
    const parsed = parseLimitUpQuery(c, { requirePrevDate: false });
    if ('response' in parsed) return parsed.response;
    const r = await invokeTool('limit_up_ladder', parsed.input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 连板天梯对比（Phase 2，docs/ddd/limit-up-ladder-detailed-design.md §8.2）。
   * 用 limit_up_ladder_compare tool，复用同一 cache。
   */
  app.get('/api/market/limit-up/compare', async (c) => {
    const parsed = parseLimitUpQuery(c, { requirePrevDate: true });
    if ('response' in parsed) return parsed.response;
    const r = await invokeTool('limit_up_ladder_compare', parsed.input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // HTML route for SPA shell
  app.get('/market/limit-up', serveFile('index.html', 'text/html; charset=utf-8'));

  /**
   * 行业板块行情（fetch_sector_quotes tool；实时快照，无缓存）。
   *
   * 参数：
   *   sort (可选) changePct | amount，默认 changePct
   *   limit (可选) 1-200，默认 50；all=true 时按上游 total 加载完整集合
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/market/sectors', async (c) => {
    const input: Record<string, unknown> = {};
    const sort = c.req.query('sort');
    if (sort !== undefined) input.sort = sort;
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number.parseInt(limit, 10);
    const all = c.req.query('all');
    if (all !== undefined) input.all = all === 'true';
    const r = await invokeTool('fetch_sector_quotes', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // HTML route for SPA shell
  app.get('/market/sectors', serveFile('index.html', 'text/html; charset=utf-8'));

  /**
   * 财经要闻（fetch_news tool；7×24 滚动流，无缓存）。
   *
   * 参数：
   *   limit (可选) 1-100，默认 30
   *   page (可选) 从 1 开始，默认 1
   *   category / keyword (可选) 透传 tool
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/news', async (c) => {
    const input: Record<string, unknown> = {};
    const limit = c.req.query('limit');
    if (limit !== undefined) input.limit = Number.parseInt(limit, 10);
    const page = c.req.query('page');
    if (page !== undefined) input.page = Number.parseInt(page, 10);
    const category = c.req.query('category');
    if (category !== undefined) input.category = category;
    const keyword = c.req.query('keyword');
    if (keyword !== undefined) input.keyword = keyword;
    const source = c.req.query('source');
    if (source !== undefined) input.source = source;
    const r = await invokeTool('fetch_news', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 龙虎榜（dragon_tiger_list tool；Manager 自带缓存与节假日历）。
   *
   * 参数：
   *   date (可选) YYYY-MM-DD；缺省时 manager 自动回溯最近交易日
   *
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  app.get('/api/dragon-tiger', async (c) => {
    const input: Record<string, unknown> = {};
    const date = c.req.query('date');
    if (date !== undefined) input.date = date;
    const r = await invokeTool('dragon_tiger_list', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 龙虎榜资金流向拓扑（dragon_tiger_flow tool；同花顺龙虎榜的概念 / 机构 / 游资字段）。
   *
   * 参数：
   *   date (可选) YYYY-MM-DD；缺省最近交易日，非交易日向前对齐并在 warnings 里标注
   *   days (可选) 5 / 10 / 20，缺省 10
   *   board (可选) all / org / hot，缺省 all
   *   rangeDays (可选) 1 / 3，缺省 1（1 日榜与 3 日榜不可混算）
   *
   * 未配置 FUYAO_API_KEY：tool 返回 invalid_input → 200（前端提示去设置页配置）；
   * 上游不可达：tool 返回 adapter_error → 502。缓存与并发由 manager 负责。
   */
  app.get('/api/dragon-tiger/flow', async (c) => {
    const input: Record<string, unknown> = {};
    const date = c.req.query('date');
    if (date !== undefined) input.date = date;
    const days = Number.parseInt(c.req.query('days') ?? '', 10);
    if (Number.isFinite(days)) input.days = days;
    const rangeDays = Number.parseInt(c.req.query('rangeDays') ?? '', 10);
    if (Number.isFinite(rangeDays)) input.rangeDays = rangeDays;
    const board = c.req.query('board');
    if (board !== undefined) input.board = board;
    const r = await invokeTool('dragon_tiger_flow', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // ruo 迁移 §8：数据健康读模型 + workflow 运行审计（供仪表盘 / 设置页消费）。
  app.get('/api/market-data-status', () => callTool('get_market_data_status', {}));

  /**
   * 盘中全市场批次（ticket #35）。
   *
   * GET 只读最近已发布批次：刷新与跨页读取都不触发采集；
   * POST 手动驱动一次采集并发布，要求 write + external 显式开启（同源 Origin 校验）。
   */
  app.get('/api/market/room/snapshot', () => callTool('get_market_snapshot_batch', {}));

  app.post('/api/market/room/collect', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    return callTool('collect_market_snapshot', {});
  });

  /**
   * 作战室总览（ticket #36）：只读最近已发布批次 + 既有情绪 / 指数契约。
   * 刷新只读，不触发采集；各维度独立标注完整性与缺失原因。
   */
  app.get('/api/market/room/overview', () => callTool('get_market_room_overview', {}));

  /**
   * 作战室板块盘中榜（ticket #38）：行业 / 概念可切换，日涨幅与 5 / 15 分钟窗口涨幅分别排序。
   *
   * 参数：
   *   kind (可选) industry | concept，默认 industry
   *   sort (可选) day | window5 | window15，默认 day
   *   window (可选) w5 | w15，选择成交占比使用的窗口，默认 w15
   *   at (可选) ISO 时间；给定时取该时点及之前最近的已发布批次，缺省读最近批次
   *
   * 只读；参数不合法按既有模型返回 invalid_input（400），其余错误包成 502。
   */
  app.get('/api/market/room/sectors', async (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['kind', 'sort', 'window', 'at'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.trim() !== '') input[key] = value;
    }
    const r = await invokeTool('get_market_room_sectors', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 作战室成交分布（ticket #40）：按 5 / 15 分钟窗口给出板块成交占比、百分点环比与 CR3。
   *
   * 参数：
   *   kind (可选) industry | concept，默认 industry
   *   window (可选) w5 | w15，默认 w15
   *   at (可选) ISO 时间；给定时取该时点及之前最近的已发布批次，缺省读最近批次
   *
   * 只读；分母无效 / 窗口不可比按缺失返回，不补零；参数不合法按既有模型返回
   * invalid_input（400），其余错误包成 502。
   */
  app.get('/api/market/room/amount-distribution', async (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['kind', 'window', 'at'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.trim() !== '') input[key] = value;
    }
    const r = await invokeTool('get_market_room_amount_distribution', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 作战室板块详情（ticket #39）：走势、成分明细与多板块对照。
   *
   * 参数：
   *   sectorId (必填) 板块内部标识
   *   at (可选) ISO 时间；给定时取该时点及之前最近的已发布批次
   *   window (可选) w5 | w15，窗口涨幅与成交占比口径，默认 w15
   *   compare (可选) 逗号分隔或重复出现的对照板块标识
   *
   * 只读；参数不合法按既有模型返回 invalid_input（400），其余错误包成 502。
   */
  app.get('/api/market/room/sector-detail', async (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['sectorId', 'window', 'at'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.trim() !== '') input[key] = value;
    }
    const compare = (c.req.queries('compare') ?? [])
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (compare.length > 0) input.compareSectorIds = compare;
    const r = await invokeTool('get_market_room_sector_detail', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  /**
   * 作战室核心股（ticket #41）：三个核心角色、入选证据与换位时间线。
   *
   * 参数：
   *   sectorId (必填) 板块内部标识
   *   at (可选) ISO 时间；给定时取该时点及之前最近的已发布批次
   *   kind (可选) ignition | turnover | height；只筛选从核心股反查的题材范围
   *
   * 只读；证据不足时角色为空或并列，不补零；参数不合法按既有模型返回
   * invalid_input（400），其余错误包成 502。
   */
  app.get('/api/market/room/core-stocks', async (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['sectorId', 'kind', 'at'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.trim() !== '') input[key] = value;
    }
    const r = await invokeTool('get_market_room_core_stocks', input);
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // 作战室页面（总览 / 板块追踪 / 成交分布三视图，SPA shell）
  app.get('/market/room', serveFile('index.html', 'text/html; charset=utf-8'));

  // 行情页指数条：与 /api/dashboard 共用 invokeIndexQuotes 缓存（15s TTL + 60s stale），
  // 失败按 dashboard 语义降级为空数组，不拖垮行情页。
  app.get('/api/market/indices', async () => {
    const indexQuotes = await invokeIndexQuotes();
    if (indexQuotes.ok) return jsonResult({ ok: true, data: indexQuotes.data });
    return jsonResult({ ok: true, data: { indices: [] } });
  });

  /**
   * 指数当日分时（fetch_intraday_minutes tool；tencent 分钟端点仅沪深，恒指不支持）。
   *
   * 参数：code (必填) 指数代码，白名单见 INDEX_INTRADAY_STOCK_IDS
   * 降级：数据源不支持 → { ok: true, data: { supported: false, points: [] } }（200）；
   * 上游不可达：tool 返回 adapter_error；web 包成 HTTP 502。
   */
  const INDEX_INTRADAY_STOCK_IDS: Readonly<Record<string, string>> = {
    '000001': '000001.SH', // 上证指数
    '399001': '399001.SZ', // 深证成指
    '399006': '399006.SZ', // 创业板指
    '000300': '000300.SH', // 沪深300
    '000688': '000688.SH', // 科创50
  };
  app.get('/api/market/indices/intraday', async (c) => {
    const code = c.req.query('code') ?? '';
    const stockId = INDEX_INTRADAY_STOCK_IDS[code];
    if (stockId === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `不支持的指数 code: ${code === '' ? '(空)' : code}（可选 ${Object.keys(INDEX_INTRADAY_STOCK_IDS).join('/')}）`,
          issues: [],
        },
      });
    }
    const r = await invokeTool('fetch_intraday_minutes', { stockId });
    if (r.ok) return jsonResult(r);
    if (r.error.kind === 'invalid_input') return jsonResult(r);
    // 解析 / 上游错误 → 502
    return new Response(JSON.stringify(r), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // S4.1b：App Service 直执行（非 34 tool 不再经通用 /api/tools/:name/call）。
  app.get('/api/market/sentiment', (c) => {
    const date = c.req.query('date');
    return callTool('get_ashare_sentiment', {
      ...(date === undefined ? {} : { date }),
      includeIndexes: c.req.query('includeIndexes') === 'true',
    });
  });

  app.post('/api/market/sync/universe', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    return callTool('sync_stock_universe', {});
  });

  app.post('/api/market/sync/daily-bars', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    return callTool('sync_daily_bars', {});
  });

  app.get('/api/stocks/:id/minute-bars', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external', 'write']);
    if (denied !== null) return jsonResult(denied);
    const date = c.req.query('date');
    const interval = c.req.query('interval');
    const r = await invokeTool('get_stock_minute_bars', {
      stockId: c.req.param('id'),
      ...(interval === undefined ? {} : { interval }),
      ...(date === undefined ? {} : { date }),
    });
    return jsonResult(r);
  });

  app.get('/api/stocks/search', async (c) => {
    const q = c.req.query('q');
    const limitRaw = c.req.query('limit');
    // 契约：default 20、max 50（防御性上限，避免 agent 误传超大值把上游拖垮）。
    const limit = limitRaw === undefined ? 20 : Math.max(1, Math.min(50, Number(limitRaw) || 20));
    if (typeof q !== 'string' || q.trim().length === 0) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '缺少搜索参数 q',
          issues: [],
        },
      });
    }

    return jsonResult(await invokeTool('search_stocks', { query: q.trim(), limit }));
  });
};
