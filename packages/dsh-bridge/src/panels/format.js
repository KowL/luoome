/** 面板格式化：只做显示层，不重算任何业务数字。 */

const fmtMoney2 = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtMoney0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const fmtInt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

const SHANGHAI = 'Asia/Shanghai';
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const clockFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const weekdayFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI,
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const asDate = (value) => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};

export const money = (value) => (isNum(value) ? fmtMoney2.format(value) : '—');
export const money0 = (value) => (isNum(value) ? fmtMoney0.format(value) : '—');
export const int = (value) => (isNum(value) ? fmtInt.format(value) : '—');
/** 大额金额（成交额 / 封单）：亿 / 万 缩写，只用于展示。 */
export const bigMoney = (value) => {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万`;
  return fmtMoney2.format(value);
};
export const signedMoney = (value) => {
  if (!isNum(value)) return '—';
  return `${value > 0 ? '+' : ''}${fmtMoney2.format(value)}`;
};

/** 比率 → 百分比（0.0734 → 7.34%）。 */
export const ratio = (value, digits = 2, withSign = true) => {
  if (!isNum(value)) return '—';
  const pct = value * 100;
  return `${withSign && pct > 0 ? '+' : ''}${pct.toFixed(digits)}%`;
};
/** 已经是百分数的值（指数涨跌幅、confidence）→ 百分比。 */
export const points = (value, digits = 2, withSign = true) => {
  if (!isNum(value)) return '—';
  return `${withSign && value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

export const toneOf = (value) => {
  if (!isNum(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
};
export const toneClass = (value) => `luo-${toneOf(value)}`;

export const when = (value) => {
  const date = asDate(value);
  return date ? dateTimeFmt.format(date) : '—';
};
export const clock = (value) => {
  const date = asDate(value);
  return date ? clockFmt.format(date) : '—';
};
export const day = (value) => {
  const date = asDate(value);
  return date ? weekdayFmt.format(date) : '—';
};
export const relative = (value, now = Date.now()) => {
  const date = asDate(value);
  if (!date) return '—';
  const delta = now - date.getTime();
  if (delta < 0) return `${when(date)}`;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return when(date).slice(0, 5).replace(/\//g, '-');
};

export const DECISION = {
  buy: { label: '买入', tone: 'up' },
  sell: { label: '卖出', tone: 'down' },
  hold: { label: '持有', tone: 'accent' },
  watch: { label: '观察', tone: 'warn' },
  avoid: { label: '回避', tone: 'quiet' },
};
export const HORIZON = {
  intraday: '日内',
  short: '短期',
  medium: '中期',
  long: '长期',
};
export const PRIORITY = {
  urgent: { label: '紧急', tone: 'urgent' },
  important: { label: '重要', tone: 'important' },
  normal: { label: '一般', tone: 'normal' },
};
export const RULE_KIND = {
  tactic: '战法',
  'strategy-signal': '策略信号',
  'cost-threshold': '成本阈值',
  'price-change': '涨跌幅',
  'price-level': '价位',
  'event-date': '事件日',
};
export const DELIVERY = {
  'not-requested': '未请求',
  'suppressed-cooldown': '冷却抑制',
  'suppressed-daily-limit': '日限抑制',
  pending: '待发送',
  sent: '已发送',
  failed: '发送失败',
  'fallback-log': '仅记录',
  expired: '已过期',
  unverifiable: '不可核验',
  invalidated: '已失效',
};
export const STRATEGY_STATUS = {
  draft: { label: '草稿', tone: 'quiet' },
  active: { label: '启用', tone: 'ok' },
  paused: { label: '暂停', tone: 'warn' },
  archived: { label: '归档', tone: 'quiet' },
};
export const OWNER = { builtin: '内置', user: '自建' };
export const WATCHLIST_KIND = {
  personal: '个人',
  strategy: '策略',
  portfolio: '持仓',
  system: '系统',
};
export const WATCH_STATE = {
  never: { label: '从未运行', tone: 'quiet' },
  running: { label: '运行中', tone: 'accent' },
  healthy: { label: '健康', tone: 'ok' },
  stale: { label: '心跳过期', tone: 'warn' },
  failed: { label: '最近失败', tone: 'bad' },
};
/** 观察周期是持久化枚举 t1/t3/t5/t20，不是日数字。 */
export const OBSERVATION_HORIZON = {
  t1: 'T+1',
  t3: 'T+3',
  t5: 'T+5',
  t20: 'T+20',
};
export const OBSERVATION_STATUS = {
  pending: '待补',
  complete: '已完成',
  unavailable: '不可用',
};
export const RUN_STATUS = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
};
export const MARKET_SESSION = {
  'pre-open': '盘前',
  trading: '交易中',
  'midday-break': '午间休市',
  closed: '已收盘',
  'non-trading-day': '非交易日',
};
export const SUBJECT_KIND = {
  stock: '个股',
  portfolio: '组合',
  market: '大盘',
  sector: '板块',
};

/** 版本 id 只取结尾的 vN；没有版本号再退回短 id。 */
export const versionTag = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const matched = /-v(\d+)$/.exec(value);
  if (matched) return `v${matched[1]}`;
  return shortId(value);
};

export const subjectTitle = (advice) => {
  if (advice?.stockName) return advice.stockName;
  if (advice?.subjectKind === 'market') return '大盘观点';
  if (advice?.subjectKind === 'portfolio') return '组合观点';
  if (advice?.subjectKind === 'sector') return advice.subjectId ?? '板块';
  return advice?.subjectId ?? '—';
};

export const shortId = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const parts = value.split('-');
  return parts.length > 1 ? parts.slice(-2).join('-') : value.slice(0, 10);
};

export const stockName = (item) =>
  item?.stockName ?? item?.stock?.name ?? item?.name ?? item?.stockId ?? '—';
