import { createHash } from 'node:crypto';
import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import type { ThemeLibraryMember, ThemeLibraryTheme } from './theme-library.js';

/**
 * 系统题材库自动维护：每个交易日盘后从涨停池的涨停原因归入已维护题材，未覆盖的明确方向才建库。
 *
 * 分工与边界：
 * - 本文件是版本化的纯领域定义（零 IO）：分类规则、原因解析、自动建库证据门槛、执行审计形状；
 *   外部数据（涨停池 / 精选概念）与写库由 tool 与 repository 负责；
 * - 分类规则以「原类名」为键：题材稳定 id 由原类名 SHA256 前 16 位派生，人工改名不改 id，
 *   因此规则只依赖仓库内可复现的文本，不读取本机目录或私有 DB；
 * - 一只股票只按「主催化」归入一个题材：原因按 `+` 拆词后按出现顺序取第一条命中规则的方向，
 *   不因为拼接了多个标签而同时塞进多个题材；
 * - 自动建库要求同一方向至少 `THEME_LIBRARY_AUTO_NEW_THEME_MIN_STOCKS` 只不同涨停股独立印证，
 *   并要求本地精选概念里存在同名事实；单股长句、泛标签与无法核实的原因只进待核对清单；
 * - 自动关系用 `origin='auto'` 标记；人工删除后（区间已结束）不由后续自动任务加回。
 */

export const THEME_LIBRARY_AUTO_SOURCE = 'fuyao-limit-up-market';
export const THEME_LIBRARY_AUTO_RULE_VERSION = 'theme-library-auto@2026-11-26.1';
/** 自动建库门槛：同一方向至少两只不同涨停股独立印证。 */
export const THEME_LIBRARY_AUTO_NEW_THEME_MIN_STOCKS = 2;
/** 收盘后自动任务的生效时点：当日收盘（15:00 Asia/Shanghai），回放不回灌盘中。 */
export const THEME_LIBRARY_AUTO_EFFECTIVE_TIME = '15:00:00+08:00';

export const ThemeLibraryAutoRuleSchema = z.object({
  /** 原始分类名：只用于派生稳定题材 id，不随人工改名变化。 */
  key: z.string().trim().min(1).max(60),
  /** 自动建库时的默认显示名（库内已有同 id 题材时以库内名称为准）。 */
  name: z.string().trim().min(1).max(40),
  /** 命中规则的正则源码；对原因拆分后的单个词做 search，与词表顺序一致。 */
  patterns: z.array(z.string().trim().min(1)).min(1),
});
export type ThemeLibraryAutoRule = z.infer<typeof ThemeLibraryAutoRuleSchema>;

/**
 * 分类规则表：涨停原因词 → 已维护题材方向。
 * 键是原类名，稳定 id = `nov26-` + SHA256(原类名) 前 16 位；改名只改 name/显示名。
 */
export const THEME_LIBRARY_AUTO_RULES: readonly ThemeLibraryAutoRule[] = [
  {
    key: '机器人与具身智能',
    name: '机器人',
    patterns: [
      '机器人|具身|物理AI|减速器|灵巧手|电子皮肤|滚珠丝杠|机器视觉|六维力|柔性传感|数据采集手套',
    ],
  },
  {
    key: '短剧与影视',
    name: '短剧影视',
    patterns: ['漫剧|短剧|影视|院线|电影|AI视频|智能内容制作'],
  },
  { key: '游戏与数字娱乐', name: '游戏', patterns: ['游戏|手游|元宇宙'] },
  {
    key: 'AI应用与软件',
    name: 'AI应用',
    patterns: [
      'AI营销|AIGC|AI应用|人工智能应用|AI大模型|大模型|词元|AI智能体|AI医疗|AI出版|AI安全|AI建造|AI矿山|AI视听|AI教育|AI职业|数据要素|数据库',
    ],
  },
  {
    key: '端侧AI与消费电子',
    name: '消费电子',
    patterns: ['AI眼镜|AI玩具|端侧AI|AI PC|VR/MR|消费电子|苹果产业链|荣耀700|eSIM'],
  },
  {
    key: 'PCB与电子材料',
    name: 'PCB产业链',
    patterns: ['PCB|覆铜板|HDI|印制电路|电路板|电子布|高速电子树脂'],
  },
  {
    key: '光通信与光模块',
    name: '光通信',
    patterns: ['光模块|光通信|光纤|磷化铟|光芯片|MPO|AOI签订'],
  },
  {
    key: '算力供电与散热',
    name: '算力配套',
    patterns: ['液冷|服务器电源|智算中心电源|数据中心配电|数据中心电源|AIDC燃气轮机'],
  },
  {
    key: '商业航天与卫星',
    name: '商业航天',
    patterns: ['商业航天|太空|卫星|星载|低轨|航天紧固'],
  },
  {
    key: '算力与数据中心',
    name: 'AI算力',
    patterns: ['算力|智算|数据中心|AI服务器|华为昇腾|东数西算'],
  },
  {
    key: '光刻与半导体材料',
    name: '半导体材料',
    patterns: [
      '光刻|光引发剂|湿电子|电子化学品|电子特气|半导体前驱|半导体靶材|半导体钽材|掩模|碳化硅衬底',
    ],
  },
  {
    key: '芯片与半导体设备',
    name: '半导体',
    patterns: ['芯片|半导体|GPU|HBM|集成电路|晶圆|先进封装|玻璃基板|存储设备|中昊芯英|洁净室'],
  },
  { key: '光伏', name: '光伏', patterns: ['光伏|BIPV'] },
  { key: '电池与储能', name: '电池储能', patterns: ['固态电池|储能|锂电|电解液|电池|铝塑膜'] },
  {
    key: '电力与电网',
    name: '电力产业链',
    patterns: ['电力|电网|国网|输变电|断路器|电磁线|电线电缆'],
  },
  { key: '风电与其他新能源', name: '新能源', patterns: ['核电|风电|氢能'] },
  { key: '油气与煤炭', name: '传统能源', patterns: ['天然气|燃气|石油|成品油|煤炭|焦炭'] },
  {
    key: '黄金与有色金属',
    name: '有色金属',
    patterns: ['黄金|金矿|白银|贵金属|金属镍|铟|铁精粉|铂网'],
  },
  { key: '冰雪与文旅', name: '冰雪文旅', patterns: ['冰雪|旅游|景区|酒店服务|旅游演艺'] },
  { key: '零售与商贸', name: '商贸零售', patterns: ['零售|商贸|免税|大宗电商|商业物业'] },
  {
    key: '食品饮料',
    name: '食品饮料',
    patterns: ['白酒|保健酒|听花酒|食品|预制菜|饮品|矿泉水|油脂|乳制品|粮油'],
  },
  {
    key: '农林牧渔',
    name: '农林牧渔',
    patterns: ['生猪|猪饲料|饲料|养殖|海参|水产|捕捞|种业|农业'],
  },
  {
    key: '创新药与医疗',
    name: '医药医疗',
    patterns: [
      '医药|创新药|流感|中药|减肥药|CXO|CRO|医疗|创口贴|新药|血竭|康养|胶原蛋白|脑机接口|GMP',
    ],
  },
  {
    key: '化工与新材料',
    name: '化工材料',
    patterns: [
      '化工|氧化锆|复合肥|尿素|农药|百草枯|MOFs|氯化|甲醇|染料|环氧丙烷|聚乳酸|钛白粉|聚酰胺|醋酸纤维|PTFE|陶瓷纤维|纳米炭铁',
    ],
  },
  {
    key: '重整与并购',
    name: '并购重组',
    patterns: ['重整|重组|入主|收购|要约|控制权|并购|股权转让|资产注入|资产剥离|股份转让'],
  },
  {
    key: '风险警示与摘帽',
    name: 'ST概念',
    patterns: ['摘帽|撤销.*警示|撤销退市|退市|ST板块|风险警示'],
  },
  { key: '业绩与股东增持', name: '业绩回购增持', patterns: ['季报|扭亏|业绩|回购|增持'] },
  { key: '名称联动', name: '名称联动', patterns: ['羊.*字辈|东方系|^“东方”$'] },
  { key: '钢铁与金属加工', name: '钢铁', patterns: ['钢材产品|特钢转型'] },
  { key: '物联网与智能终端', name: '物联网', patterns: ['AIoT|智慧空间'] },
  { key: '充电设施', name: '充电设施', patterns: ['重卡超充|华为超充'] },
  { key: '环保与资源利用', name: '环保', patterns: ['蓝藻治理|碳汇'] },
  { key: '轻工与日用消费', name: '日用轻工', patterns: ['口腔护理|自行车|日用玻璃|造纸'] },
  {
    key: '军工与低空经济',
    name: '国防军工',
    patterns: ['航展|航空|低空|弹药|航材|军工|深海装备'],
  },
  { key: '汽车与智能驾驶', name: '汽车产业链', patterns: ['汽车|驾驶|车载|轮胎|无人环卫'] },
  { key: '家电与家居', name: '家居家电', patterns: ['家电|厨电|家居|空调|清洁电器'] },
  {
    key: '纺织服装',
    name: '纺织服装',
    patterns: ['纺织|服装|女装|男装|牛仔布|职业装|羊毛|羽绒|棉花|筒子纱|皮鞋'],
  },
  {
    key: '地产基建与建材',
    name: '地产基建',
    patterns: ['地产|基建|城市更新|建筑|水泥|混凝土|PCCP|轨道扣件|工程设计'],
  },
  {
    key: '工业装备与制造',
    name: '工业装备',
    patterns: [
      '工业母机|工程机械|机床|燃机|燃气轮机|压缩机|阀门|装备|物料输送|成套设备|3D打印|民爆|滑动轴承',
    ],
  },
  {
    key: '电子元器件与显示',
    name: '电子元件',
    patterns: ['MLCC|OLED|LED|显示|偏光片|石英晶体|连接器|电连接|电极箔'],
  },
  { key: '金融科技与券商', name: '券商金融科技', patterns: ['金融科技|证券|券商'] },
  {
    key: '文化传媒与教育',
    name: '文化传媒',
    patterns: ['传媒|营销|出版|文创|教育|潮玩'],
  },
];

/** 题材稳定 id：`nov26-` + 原类名 SHA256 前 16 位（与已部署库同口径，改名不改 id）。 */
export const themeLibraryRuleThemeId = (key: string): string =>
  `nov26-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

/** 自动新建题材的稳定 id：方向规范化名称 SHA256 前 16 位。 */
export const themeLibraryAutoThemeId = (name: string): string =>
  `auto-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;

const RULE_KEYS = new Set(THEME_LIBRARY_AUTO_RULES.map((rule) => rule.key));
if (RULE_KEYS.size !== THEME_LIBRARY_AUTO_RULES.length) {
  throw new InvariantError('自动维护分类规则的原类名必须唯一');
}

/** 规则源码合法性在模块加载时就暴露：非法正则是定义错误，不是运行时分支。 */
for (const rule of THEME_LIBRARY_AUTO_RULES) new RegExp(rule.patterns.join('|'), 'i');

/** 涨停原因拆词：上游用 `+` 拼接多个催化，按出现顺序保留，不去重合并语义。 */
export const splitLimitUpReason = (reason: string | null): readonly string[] => {
  if (reason === null) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of reason.split(/[+＋]/)) {
    const token = raw.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
};

/** 方向名规范化：全角转半角、去空白与包裹标点、去「概念 / 板块 / 题材 / 产业链」后缀。 */
export const normalizeThemeLabel = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/[\s\u3000]/g, '')
    .replace(/^[“”"'‘’《》【】()（）[\]]+/u, '')
    .replace(/[“”"'‘’《》【】()（）[\]]+$/u, '')
    .replace(/[·•.,，、。;；:：!！?？]/gu, '')
    .replace(/(?:概念|板块|题材|产业链)$/u, '')
    .trim();

/** 泛标签：市场状态、交易制度、股东行为与财报词，不构成题材方向。 */
const GENERIC_LABEL_PATTERNS: readonly RegExp[] = [
  /^(?:s?\*?st|st板块|风险警示)$/i,
  /^(?:摘帽|撤销退市|撤销.*警示|退市)$/,
  /^(?:融资融券|沪股通|深股通|新股|次新股|注册制次新股|科创次新股|新股与次新股)$/,
  /^(?:高送转|分红|回购|增持|减持|举牌|解禁|股权激励|员工持股)$/,
  /^(?:一季报|中报|三季报|年报|业绩|业绩预告|业绩预增|业绩预减|预盈|预亏|扭亏)$/,
  /^(?:国资|地方国资|央企|中字头|中字头股票|专精特新|国家大基金持股|证金持股)$/,
  /^(?:同花顺.*|中国ai\d+|\d{4}.*)$/i,
];

/** 句子式原因（公告、项目、订单长句）：不做题材，只进待核对。 */
const SENTENCE_MARKERS =
  /(?:公司|子公司|控股|签订|签署|合同|中标|获批|拟|公告|预计|订单|项目|关于|以及|及其)/;
const MAX_DIRECTION_LENGTH = 14;
const MIN_DIRECTION_LENGTH = 2;

export type ThemeLibraryAutoDirectionRejection =
  | 'generic_label'
  | 'sentence'
  | 'too_short'
  | 'too_long';

/** 方向名是否可作为题材：过滤泛标签、公告长句与过长 / 过短词。 */
export const themeLibraryDirectionRejection = (
  label: string,
): ThemeLibraryAutoDirectionRejection | null => {
  const normalized = normalizeThemeLabel(label);
  if (normalized.length < MIN_DIRECTION_LENGTH) return 'too_short';
  if (GENERIC_LABEL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'generic_label';
  if (SENTENCE_MARKERS.test(normalized)) return 'sentence';
  if (normalized.length > MAX_DIRECTION_LENGTH) return 'too_long';
  return null;
};

/** 精选概念方向：只保留目录身份与名称，归属由本地概念目录决定。 */
export const ThemeLibraryAutoConceptSchema = z.object({
  /** 目录内部标识（不是供应商代码），用于写入题材来源映射。 */
  sectorId: z.string().trim().min(1).max(64),
  vendorCode: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(100),
});
export type ThemeLibraryAutoConcept = z.infer<typeof ThemeLibraryAutoConceptSchema>;

export const ThemeLibraryAutoPendingKindSchema = z.enum([
  'no_reason',
  'unmatched',
  'generic_label',
  'sentence',
  'too_long',
  'no_concept',
  'single_stock',
  'archived_theme',
]);
export type ThemeLibraryAutoPendingKind = z.infer<typeof ThemeLibraryAutoPendingKindSchema>;

/** 待核对：日期、理由、来源都保留，供人在管理页逐条判断，不自动建库。 */
export const ThemeLibraryAutoPendingSchema = z.object({
  kind: ThemeLibraryAutoPendingKindSchema,
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  label: z.string().max(100).nullable(),
  stockId: z.string().min(1).nullable(),
  stockName: z.string().max(40).nullable(),
  /** 涨停原因原文，不改写。 */
  reason: z.string().max(200).nullable(),
  source: z.string().min(1),
  note: z.string().max(120),
});
export type ThemeLibraryAutoPending = z.infer<typeof ThemeLibraryAutoPendingSchema>;

export const ThemeLibraryAutoStockSchema = z.object({
  stockId: z.string().min(1),
  name: z.string().max(40).nullable(),
  reason: z.string().max(200).nullable(),
  /** 命中的原因词（主催化），用于人工核对归类依据。 */
  token: z.string().max(100),
});
export type ThemeLibraryAutoStock = z.infer<typeof ThemeLibraryAutoStockSchema>;

export const ThemeLibraryAutoAdditionSchema = z.object({
  themeId: z.string().min(1),
  themeName: z.string().min(1),
  stocks: z.array(ThemeLibraryAutoStockSchema),
});
export type ThemeLibraryAutoAddition = z.infer<typeof ThemeLibraryAutoAdditionSchema>;

export const ThemeLibraryAutoNewThemeSchema = z.object({
  themeId: z.string().min(1),
  name: z.string().min(1),
  /** 事实依据：命中的本地精选概念（分类规则方向为空）。 */
  sourceConcept: ThemeLibraryAutoConceptSchema.nullable(),
  stocks: z.array(ThemeLibraryAutoStockSchema),
});
export type ThemeLibraryAutoNewTheme = z.infer<typeof ThemeLibraryAutoNewThemeSchema>;

export const ThemeLibraryAutoPlanSchema = z.object({
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(1),
  ruleVersion: z.string().min(1),
  poolCount: z.number().int().nonnegative(),
  classifiedCount: z.number().int().nonnegative(),
  alreadyMemberCount: z.number().int().nonnegative(),
  suppressedCount: z.number().int().nonnegative(),
  additions: z.array(ThemeLibraryAutoAdditionSchema),
  newThemes: z.array(ThemeLibraryAutoNewThemeSchema),
  pending: z.array(ThemeLibraryAutoPendingSchema),
  warnings: z.array(z.string()),
});
export type ThemeLibraryAutoPlan = z.infer<typeof ThemeLibraryAutoPlanSchema>;

export const ThemeLibraryAutoRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'skipped',
]);
export type ThemeLibraryAutoRunStatus = z.infer<typeof ThemeLibraryAutoRunStatusSchema>;

export const ThemeLibraryAutoSkipReasonSchema = z.enum([
  'not_enabled',
  'before_close',
  'non_trading_day',
  'future_date',
  'pool_unavailable',
  'empty_pool',
  'no_reason',
  'incomplete_pool',
]);
export type ThemeLibraryAutoSkipReason = z.infer<typeof ThemeLibraryAutoSkipReasonSchema>;

export const ThemeLibraryAutoRunSchema = z.object({
  tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(1),
  status: ThemeLibraryAutoRunStatusSchema,
  /** 同一交易日 + 源的执行次数；失败 / 跳过后的重试会 +1。 */
  attempt: z.number().int().positive(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  /** 自动新增关系的生效时间（当日收盘）；回放不回灌盘中。 */
  effectiveFrom: z.coerce.date().nullable(),
  appliedAt: z.coerce.date().nullable(),
  createdThemes: z.number().int().nonnegative(),
  createdMembers: z.number().int().nonnegative(),
  skippedMembers: z.number().int().nonnegative(),
  poolCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  plan: ThemeLibraryAutoPlanSchema.nullable(),
  pending: z.array(ThemeLibraryAutoPendingSchema),
  skipReason: ThemeLibraryAutoSkipReasonSchema.nullable(),
  errorKind: z.string().nullable(),
  errorMessage: z.string().max(400).nullable(),
});
export type ThemeLibraryAutoRun = z.infer<typeof ThemeLibraryAutoRunSchema>;

export const ThemeLibraryAutoSettingsSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.coerce.date().nullable(),
});
export type ThemeLibraryAutoSettings = z.infer<typeof ThemeLibraryAutoSettingsSchema>;

export const THEME_LIBRARY_AUTO_DISABLED_SETTINGS: ThemeLibraryAutoSettings = {
  enabled: false,
  updatedAt: null,
};

export const ThemeLibraryAutoRunSummarySchema = ThemeLibraryAutoRunSchema.pick({
  tradingDay: true,
  status: true,
  attempt: true,
  startedAt: true,
  finishedAt: true,
  createdThemes: true,
  createdMembers: true,
  pendingCount: true,
  skipReason: true,
  errorMessage: true,
});
export type ThemeLibraryAutoRunSummary = z.infer<typeof ThemeLibraryAutoRunSummarySchema>;

export const ThemeLibraryAutoStatusSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.coerce.date().nullable(),
  lastRun: ThemeLibraryAutoRunSummarySchema.nullable(),
  lastSucceededDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  recentRuns: z.array(ThemeLibraryAutoRunSummarySchema),
  /** 最近一次执行留下的待核对项（保留日期、理由、来源）。 */
  pending: z.array(ThemeLibraryAutoPendingSchema),
  pendingFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
export type ThemeLibraryAutoStatus = z.infer<typeof ThemeLibraryAutoStatusSchema>;

const summaryOf = (run: ThemeLibraryAutoRun): ThemeLibraryAutoRunSummary => ({
  tradingDay: run.tradingDay,
  status: run.status,
  attempt: run.attempt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdThemes: run.createdThemes,
  createdMembers: run.createdMembers,
  pendingCount: run.pendingCount,
  skipReason: run.skipReason,
  errorMessage: run.errorMessage,
});

/** 管理页状态：最近执行、最近成功日、最近 7 次执行与待核对项。 */
export const buildThemeLibraryAutoStatus = (input: {
  readonly settings: ThemeLibraryAutoSettings;
  readonly runs: readonly ThemeLibraryAutoRun[];
}): ThemeLibraryAutoStatus => {
  const ordered = [...input.runs].sort(
    (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
  );
  const succeeded = ordered.find((run) => run.status === 'succeeded') ?? null;
  const pendingRun = ordered.find((run) => run.pending.length > 0) ?? null;
  return {
    enabled: input.settings.enabled,
    enabledAt: input.settings.updatedAt,
    lastRun: ordered[0] === undefined ? null : summaryOf(ordered[0]),
    lastSucceededDay: succeeded?.tradingDay ?? null,
    recentRuns: ordered.slice(0, 7).map(summaryOf),
    pending: pendingRun?.pending ?? [],
    pendingFrom: pendingRun?.tradingDay ?? null,
  };
};

export interface ThemeLibraryAutoPoolEntry {
  readonly stockId: string;
  readonly name: string | null;
  readonly reason: string | null;
}

export interface ThemeLibraryAutoPlanInput {
  readonly tradingDate: string;
  readonly source: string;
  readonly pool: readonly ThemeLibraryAutoPoolEntry[];
  readonly themes: readonly ThemeLibraryTheme[];
  /** 全部成分区间（含已结束）：已结束区间代表人工删除，自动任务不得加回。 */
  readonly members: readonly ThemeLibraryMember[];
  /** 本地精选概念；作为新建题材的事实依据。 */
  readonly concepts: readonly ThemeLibraryAutoConcept[];
  readonly rules?: readonly ThemeLibraryAutoRule[];
  readonly minNewThemeStocks?: number;
  readonly warnings?: readonly string[];
}

const pairKey = (themeId: string, stockId: string): string => `${themeId}\u0000${stockId}`;

interface QueuedStock {
  readonly themeId: string;
  readonly themeName: string;
  readonly sourceConcept: ThemeLibraryAutoConcept | null;
  readonly isNewTheme: boolean;
  readonly stock: ThemeLibraryAutoStock;
}

/**
 * 生成某交易日的自动维护计划（纯函数，不写库）。
 *
 * 归类顺序：主催化命中分类规则 → 否则用原因词匹配本地精选概念作为新方向 → 其余进待核对。
 * 已在生效区间内的关系不重复写；曾结束过的关系视为人工删除，永不再加回。
 */
export const buildThemeLibraryAutoPlan = (
  input: ThemeLibraryAutoPlanInput,
): ThemeLibraryAutoPlan => {
  const rules = input.rules ?? THEME_LIBRARY_AUTO_RULES;
  const minStocks = input.minNewThemeStocks ?? THEME_LIBRARY_AUTO_NEW_THEME_MIN_STOCKS;

  const themesById = new Map(input.themes.map((theme) => [theme.id, theme]));
  const themesByNormalizedName = new Map(
    input.themes.map((theme) => [normalizeThemeLabel(theme.name), theme]),
  );
  const openPairs = new Set<string>();
  const knownPairs = new Set<string>();
  for (const member of input.members) {
    const key = pairKey(member.themeId, member.stockId);
    knownPairs.add(key);
    if (member.effectiveTo === null) openPairs.add(key);
  }
  const conceptsByLabel = new Map<string, ThemeLibraryAutoConcept>();
  for (const concept of input.concepts) {
    const label = normalizeThemeLabel(concept.name);
    if (label.length === 0 || conceptsByLabel.has(label)) continue;
    conceptsByLabel.set(label, concept);
  }

  const rulePatterns = rules.map((rule) => ({
    themeId: themeLibraryRuleThemeId(rule.key),
    name: rule.name,
    pattern: new RegExp(rule.patterns.join('|'), 'i'),
  }));

  const pending: ThemeLibraryAutoPending[] = [];
  const alreadyMember = new Set<string>();
  const suppressed = new Set<string>();
  const queued = new Map<string, QueuedStock>();
  const queuedSuppressed: string[] = [];
  let classified = 0;

  const pushPending = (entry: Omit<ThemeLibraryAutoPending, 'tradingDate' | 'source'>): void => {
    pending.push({ ...entry, tradingDate: input.tradingDate, source: input.source });
  };

  const stockOf = (entry: ThemeLibraryAutoPoolEntry, token: string): ThemeLibraryAutoStock => ({
    stockId: entry.stockId,
    name: entry.name,
    reason: entry.reason,
    token,
  });

  /** 已归类方向：库内已有题材 → 补成分；方向缺题材 → 进入建库候选。 */
  const assign = (
    entry: ThemeLibraryAutoPoolEntry,
    token: string,
    target: { themeId: string; name: string; sourceConcept: ThemeLibraryAutoConcept | null },
  ): void => {
    classified += 1;
    const theme = themesById.get(target.themeId);
    const key = pairKey(target.themeId, entry.stockId);
    if (theme !== undefined && theme.state === 'archived') {
      pushPending({
        kind: 'archived_theme',
        label: theme.name,
        stockId: entry.stockId,
        stockName: entry.name,
        reason: entry.reason,
        note: `题材「${theme.name}」已归档，未自动加回`,
      });
      return;
    }
    if (openPairs.has(key)) {
      alreadyMember.add(key);
      return;
    }
    if (knownPairs.has(key)) {
      suppressed.add(key);
      queuedSuppressed.push(key);
      return;
    }
    queued.set(key, {
      themeId: target.themeId,
      themeName: theme?.name ?? target.name,
      sourceConcept: target.sourceConcept,
      isNewTheme: theme === undefined,
      stock: stockOf(entry, token),
    });
  };

  /** 原因词 → 精选概念方向；精确同名优先，其次概念名被词包含（长度 >= 3）。 */
  const conceptOf = (token: string): ThemeLibraryAutoConcept | null => {
    const label = normalizeThemeLabel(token);
    if (label.length === 0) return null;
    const exact = conceptsByLabel.get(label);
    if (exact !== undefined) return exact;
    for (const [conceptLabel, concept] of conceptsByLabel) {
      if (conceptLabel.length >= 3 && label.includes(conceptLabel)) return concept;
    }
    return null;
  };

  for (const entry of input.pool) {
    const tokens = splitLimitUpReason(entry.reason);
    if (tokens.length === 0) {
      pushPending({
        kind: 'no_reason',
        label: null,
        stockId: entry.stockId,
        stockName: entry.name,
        reason: entry.reason,
        note: '涨停池没有涨停原因，未归类',
      });
      continue;
    }
    // 主催化 = 原因里第一条命中规则的方向；后面的标签不改变归属。
    const primary = tokens
      .map((token) => ({ token, rule: rulePatterns.find((rule) => rule.pattern.test(token)) }))
      .find((hit) => hit.rule !== undefined);
    if (primary?.rule !== undefined) {
      const rule = primary.rule;
      assign(entry, primary.token, {
        themeId: rule.themeId,
        name: rule.name,
        sourceConcept: null,
      });
      continue;
    }
    let directed = false;
    for (const token of tokens) {
      const rejection = themeLibraryDirectionRejection(token);
      if (rejection !== null) continue;
      const concept = conceptOf(token);
      if (concept === null) continue;
      const existingTheme = themesByNormalizedName.get(normalizeThemeLabel(concept.name));
      const themeId =
        existingTheme?.id ?? themeLibraryAutoThemeId(normalizeThemeLabel(concept.name));
      const name = existingTheme?.name ?? normalizeThemeLabel(concept.name);
      assign(entry, token, {
        themeId,
        name,
        sourceConcept: existingTheme === undefined ? concept : null,
      });
      directed = true;
      break;
    }
    if (directed) continue;
    const rejection = tokens
      .map((token) => themeLibraryDirectionRejection(token))
      .find((value) => value !== null);
    pushPending({
      kind:
        rejection === 'sentence' || rejection === 'too_long'
          ? 'sentence'
          : rejection === 'generic_label'
            ? 'generic_label'
            : 'unmatched',
      label: tokens[0] ?? null,
      stockId: entry.stockId,
      stockName: entry.name,
      reason: entry.reason,
      note:
        rejection === 'generic_label'
          ? '泛标签不构成题材方向'
          : rejection === 'sentence' || rejection === 'too_long'
            ? '公告式长句不作为题材方向'
            : '本地精选概念里没有对应事实，只计入待核对',
    });
  }

  // 方向 → 股票；建库需同一方向至少 minStocks 只不同涨停股独立印证。
  const byTheme = new Map<string, QueuedStock[]>();
  for (const item of queued.values()) {
    const list = byTheme.get(item.themeId) ?? [];
    list.push(item);
    byTheme.set(item.themeId, list);
  }

  const additions: ThemeLibraryAutoAddition[] = [];
  const newThemes: ThemeLibraryAutoNewTheme[] = [];
  const warnings = [...(input.warnings ?? [])];
  for (const [themeId, items] of [...byTheme].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const head = items[0];
    if (head === undefined) continue;
    const stocks = items
      .map((item) => item.stock)
      .sort((left, right) => left.stockId.localeCompare(right.stockId));
    const distinct = new Set(stocks.map((stock) => stock.stockId));
    const isNew = head.isNewTheme;
    if (isNew) {
      if (distinct.size < minStocks) {
        for (const item of items) {
          pushPending({
            kind: 'single_stock',
            label: item.themeName,
            stockId: item.stock.stockId,
            stockName: item.stock.name,
            reason: item.stock.reason,
            note: `同方向仅 ${distinct.size} 只涨停股印证，未达建库门槛 ${minStocks} 只`,
          });
        }
        continue;
      }
      const duplicate = input.themes.find(
        (theme) => normalizeThemeLabel(theme.name) === normalizeThemeLabel(head.themeName),
      );
      if (duplicate !== undefined) {
        warnings.push(`duplicate_theme_name: ${head.themeName}`);
        continue;
      }
      newThemes.push({
        themeId,
        name: head.themeName,
        sourceConcept: head.sourceConcept,
        stocks,
      });
      continue;
    }
    additions.push({ themeId, themeName: head.themeName, stocks });
  }

  if (queuedSuppressed.length > 0) {
    warnings.push(`manual_removal_respected: ${queuedSuppressed.length}`);
  }

  const plan: ThemeLibraryAutoPlan = {
    tradingDate: input.tradingDate,
    source: input.source,
    ruleVersion: THEME_LIBRARY_AUTO_RULE_VERSION,
    poolCount: input.pool.length,
    classifiedCount: classified,
    alreadyMemberCount: alreadyMember.size,
    suppressedCount: new Set(queuedSuppressed).size,
    additions: additions.sort((left, right) => left.themeId.localeCompare(right.themeId)),
    newThemes: newThemes.sort((left, right) => left.themeId.localeCompare(right.themeId)),
    pending,
    warnings,
  };
  assertThemeLibraryAutoPlanInvariants(plan);
  return plan;
};

export const assertThemeLibraryAutoPlanInvariants = (plan: ThemeLibraryAutoPlan): void => {
  const targets = new Map<string, string>();
  for (const addition of plan.additions) {
    for (const stock of addition.stocks) {
      const previous = targets.get(stock.stockId);
      if (previous !== undefined) {
        throw new InvariantError(
          `自动维护一只股票只能归入一个题材：${stock.stockId} → ${previous} / ${addition.themeId}`,
        );
      }
      targets.set(stock.stockId, addition.themeId);
    }
  }
  for (const theme of plan.newThemes) {
    if (theme.stocks.length < THEME_LIBRARY_AUTO_NEW_THEME_MIN_STOCKS) {
      throw new InvariantError(`新建题材 ${theme.themeId} 的证据少于门槛`);
    }
    for (const stock of theme.stocks) {
      const previous = targets.get(stock.stockId);
      if (previous !== undefined) {
        throw new InvariantError(
          `自动维护一只股票只能归入一个题材：${stock.stockId} → ${previous} / ${theme.themeId}`,
        );
      }
      targets.set(stock.stockId, theme.themeId);
    }
  }
  for (const addition of plan.additions) {
    if (addition.stocks.length === 0) {
      throw new InvariantError(`题材 ${addition.themeId} 没有可新增成分，不应进入计划`);
    }
  }
  if (plan.poolCount < plan.classifiedCount) {
    throw new InvariantError('自动维护归类数不得多于涨停池条数');
  }
};
