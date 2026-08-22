/* apps/web/public/js/index-defs.js —— 核心指数定义（看盘页卡片与指数页共用）。
 *
 * code 与 eastmoney f57 返回一致（'000001' / 'HSI' 等）；
 * intradayStockId 为 fetch_intraday_minutes 用的个股代码约定（tencent 分钟端点仅沪深），
 * null 表示无分时数据（恒指）。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

const INDEX_DEFS = [
  { code: '000001', name: '上证指数', intradayStockId: '000001.SH' },
  { code: '399001', name: '深证成指', intradayStockId: '399001.SZ' },
  { code: '399006', name: '创业板指', intradayStockId: '399006.SZ' },
  { code: '000300', name: '沪深300', intradayStockId: '000300.SH' },
  { code: '000688', name: '科创50', intradayStockId: '000688.SH' },
  { code: 'HSI', name: '恒生指数', intradayStockId: null },
];

/** 看盘页固定展示的 4 只（上证 / 深成 / 创业板 / 科创50）。 */
const DASHBOARD_INDEX_CODES = ['000001', '399001', '399006', '000688'];

export { DASHBOARD_INDEX_CODES, INDEX_DEFS };
