import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import type { LimitUpLadder } from './limit-up-ladder.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  SectorVendorCodeSchema,
  type StockSectorMembership,
} from './sector-catalog.js';
import {
  buildSectorDayMetric,
  buildSectorLimitUpBlock,
  buildSectorLimitUpMetric,
  buildSectorTurnoverMetric,
  buildSectorTurnoverWindow,
  buildSectorWindowMetric,
  resolveSectorWindow,
  SECTOR_EMPTY_REASON_TEXT,
  SECTOR_INTRADAY_WINDOWS,
  SECTOR_TURNOVER_METHOD,
  SectorDayMetricSchema,
  type SectorIntradaySort,
  SectorIntradaySortSchema,
  SectorLimitUpBlockSchema,
  SectorLimitUpMetricSchema,
  SectorRankingAnchorSchema,
  type SectorRankingEmptyReason,
  SectorRankingEmptyReasonSchema,
  SectorTurnoverMetricSchema,
  SectorTurnoverWindowSchema,
  type SectorWindowKey,
  SectorWindowKeySchema,
  SectorWindowMetricSchema,
  type SectorWindowRef,
  SectorWindowRefSchema,
  sectorRankingAnchorSummary,
} from './sector-intraday-ranking.js';

/**
 * 主流题材地图（v1）：把「供应商概念目录」与「产品主流题材」拆成两层。
 *
 * - 本文件是版本化的纯领域定义：固定父板块、标准题材与扶摇 vendorCode 映射，零 IO；
 *   供应商目录 / 成分与行情仍由既有批次与 sector catalog 提供；
 * - 标准题材行情 = 所映射原始概念的 active 成分股票并集；父板块行情 = 子题材成分并集，
 *   同一股票只计一次，不平均子题材指标、不重复计股；
 * - 主流方向的存在性由分类定义决定，与当日涨跌、成交额排名无关；涨幅 / 成交榜只影响排序；
 * - 映射优先使用 vendorCode；名称只用于人工核对，不参与正式归属；
 * - 缺失样本、分母无效、窗口不可比一律 null + 原因，绝不补零。
 */

export const MAINSTREAM_THEME_RULE_VERSION = 'mainstream-themes@2026-11-25.1';

const stableId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]*$/, '稳定 id 只能是小写字母、数字与连字符');

export const MainstreamParentSectorSchema = z.object({
  id: stableId,
  name: z.string().trim().min(1).max(40),
  /** 固定展示顺序；父板块不按当日涨跌重排。 */
  order: z.number().int().nonnegative(),
});
export type MainstreamParentSector = z.infer<typeof MainstreamParentSectorSchema>;

export const MainstreamThemeDefinitionSchema = z.object({
  id: stableId,
  parentId: stableId,
  name: z.string().trim().min(1).max(40),
  /** 扶摇概念 vendorCode 列表；一个概念只归属一个标准题材，避免同一股票在同一父板块重复计入。 */
  vendorCodes: z.array(SectorVendorCodeSchema).min(1),
});
export type MainstreamThemeDefinition = z.infer<typeof MainstreamThemeDefinitionSchema>;

export const MAINSTREAM_PARENT_SECTORS: readonly MainstreamParentSector[] = [
  { id: 'tech', name: '科技', order: 0 },
  { id: 'new-energy', name: '新能源', order: 1 },
  { id: 'auto', name: '汽车与智能出行', order: 2 },
  { id: 'healthcare', name: '医药医疗', order: 3 },
  { id: 'consumer', name: '消费', order: 4 },
  { id: 'cyclical', name: '周期资源', order: 5 },
  { id: 'finance', name: '金融', order: 6 },
  { id: 'defense', name: '军工与高端制造', order: 7 },
  { id: 'real-estate-infra', name: '地产基建', order: 8 },
  { id: 'utilities-transport', name: '公用事业与交通运输', order: 9 },
  { id: 'agriculture', name: '农业', order: 10 },
];

export const MAINSTREAM_THEMES: readonly MainstreamThemeDefinition[] = [
  {
    id: 'ai-computing',
    parentId: 'tech',
    name: 'AI与算力',
    vendorCodes: [
      '885728.TI',
      '886108.TI',
      '886100.TI',
      '886019.TI',
      '886099.TI',
      '886050.TI',
      '885887.TI',
      '885957.TI',
      '886033.TI',
      '886044.TI',
      '886073.TI',
      '886062.TI',
      '886031.TI',
      '886090.TI',
      '886058.TI',
      '886094.TI',
      '886068.TI',
      '886074.TI',
      '886048.TI',
      '885362.TI',
      '885977.TI',
      '886036.TI',
      '885730.TI',
      '886040.TI',
      '885759.TI',
      '885772.TI',
      '885797.TI',
      '885611.TI',
      '885779.TI',
    ],
  },
  {
    id: 'semiconductor',
    parentId: 'tech',
    name: '半导体',
    vendorCodes: [
      '885756.TI',
      '886042.TI',
      '886009.TI',
      '885908.TI',
      '885945.TI',
      '885864.TI',
      '886054.TI',
      '886111.TI',
      '885925.TI',
      '885897.TI',
      '885843.TI',
      '886112.TI',
    ],
  },
  {
    id: 'software',
    parentId: 'tech',
    name: '软件与信创',
    vendorCodes: [
      '886013.TI',
      '885923.TI',
      '885980.TI',
      '885982.TI',
      '885844.TI',
      '885459.TI',
      '885942.TI',
      '885956.TI',
      '886080.TI',
      '886039.TI',
      '885881.TI',
      '885976.TI',
      '886023.TI',
      '886041.TI',
      '885378.TI',
      '885820.TI',
      '885950.TI',
      '885757.TI',
      '886017.TI',
      '885933.TI',
      '886034.TI',
      '885791.TI',
      '885975.TI',
      '885943.TI',
    ],
  },
  {
    id: 'consumer-electronics',
    parentId: 'tech',
    name: '消费电子',
    vendorCodes: [
      '885800.TI',
      '885454.TI',
      '886085.TI',
      '886070.TI',
      '886071.TI',
      '885868.TI',
      '885771.TI',
      '885376.TI',
      '885786.TI',
      '885785.TI',
      '885738.TI',
      '885875.TI',
      '885987.TI',
      '885809.TI',
      '885953.TI',
      '885959.TI',
      '885774.TI',
      '885709.TI',
      '886046.TI',
      '886049.TI',
      '885934.TI',
      '885423.TI',
    ],
  },
  {
    id: 'robotics',
    parentId: 'tech',
    name: '机器人/智能制造',
    vendorCodes: ['885517.TI', '886069.TI', '886008.TI', '886002.TI', '885946.TI', '885783.TI'],
  },
  {
    id: 'communications',
    parentId: 'tech',
    name: '通信与网络',
    vendorCodes: [
      '885556.TI',
      '886037.TI',
      '885998.TI',
      '885940.TI',
      '886084.TI',
      '886055.TI',
      '886043.TI',
      '885312.TI',
    ],
  },
  {
    id: 'huawei',
    parentId: 'tech',
    name: '华为产业链',
    vendorCodes: ['885806.TI', '886091.TI'],
  },
  {
    id: 'solar',
    parentId: 'new-energy',
    name: '光伏',
    vendorCodes: [
      '885531.TI',
      '886007.TI',
      '885878.TI',
      '886053.TI',
      '886006.TI',
      '885958.TI',
      '886011.TI',
      '885920.TI',
      '886026.TI',
    ],
  },
  {
    id: 'wind',
    parentId: 'new-energy',
    name: '风电',
    vendorCodes: ['885641.TI'],
  },
  {
    id: 'battery-storage',
    parentId: 'new-energy',
    name: '储能与电池',
    vendorCodes: [
      '885921.TI',
      '886032.TI',
      '885928.TI',
      '885710.TI',
      '886003.TI',
      '885886.TI',
      '885944.TI',
      '885922.TI',
      '886020.TI',
      '885935.TI',
    ],
  },
  {
    id: 'hydrogen-nuclear',
    parentId: 'new-energy',
    name: '氢能与核电',
    vendorCodes: ['885823.TI', '885775.TI', '885571.TI', '886065.TI'],
  },
  {
    id: 'power-grid',
    parentId: 'new-energy',
    name: '电网设备',
    vendorCodes: [
      '885311.TI',
      '885425.TI',
      '885948.TI',
      '886004.TI',
      '885819.TI',
      '886010.TI',
      '886093.TI',
    ],
  },
  {
    id: 'smart-driving',
    parentId: 'auto',
    name: '智能驾驶',
    vendorCodes: ['885736.TI', '885662.TI', '886035.TI', '885545.TI', '886059.TI', '885999.TI'],
  },
  {
    id: 'nev',
    parentId: 'auto',
    name: '新能源汽车',
    vendorCodes: [
      '885431.TI',
      '885997.TI',
      '885789.TI',
      '885467.TI',
      '885834.TI',
      '886064.TI',
      '886061.TI',
      '886000.TI',
      '885902.TI',
    ],
  },
  {
    id: 'charging',
    parentId: 'auto',
    name: '充电与换电',
    vendorCodes: ['885461.TI', '885938.TI', '886001.TI'],
  },
  {
    id: 'low-altitude',
    parentId: 'auto',
    name: '低空经济与飞行汽车',
    vendorCodes: ['886067.TI', '886066.TI', '885564.TI'],
  },
  {
    id: 'mobility',
    parentId: 'auto',
    name: '出行服务',
    vendorCodes: ['885753.TI', '885747.TI', '885974.TI'],
  },
  {
    id: 'innovative-drug',
    parentId: 'healthcare',
    name: '创新药',
    vendorCodes: ['886015.TI', '885856.TI', '886051.TI', '885900.TI'],
  },
  {
    id: 'medical-device',
    parentId: 'healthcare',
    name: '医疗器械与服务',
    vendorCodes: [
      '885539.TI',
      '885402.TI',
      '885490.TI',
      '885838.TI',
      '885926.TI',
      '885913.TI',
      '885985.TI',
      '885981.TI',
      '885947.TI',
      '885661.TI',
      '886047.TI',
      '886028.TI',
      '886018.TI',
    ],
  },
  {
    id: 'biotech',
    parentId: 'healthcare',
    name: '生物科技',
    vendorCodes: [
      '885769.TI',
      '885955.TI',
      '885578.TI',
      '886077.TI',
      '885845.TI',
      '885927.TI',
      '886056.TI',
    ],
  },
  {
    id: 'tcm-epidemic',
    parentId: 'healthcare',
    name: '中药与防疫',
    vendorCodes: [
      '885879.TI',
      '885989.TI',
      '885952.TI',
      '885994.TI',
      '885508.TI',
      '885882.TI',
      '885852.TI',
      '885805.TI',
    ],
  },
  {
    id: 'senior-care',
    parentId: 'healthcare',
    name: '养老与生育医疗',
    vendorCodes: ['885522.TI', '885909.TI', '885968.TI'],
  },
  {
    id: 'food-beverage',
    parentId: 'consumer',
    name: '食品饮料',
    vendorCodes: [
      '885525.TI',
      '885780.TI',
      '885462.TI',
      '885951.TI',
      '885406.TI',
      '886081.TI',
      '885904.TI',
      '885839.TI',
      '885851.TI',
      '885899.TI',
    ],
  },
  {
    id: 'home-appliance',
    parentId: 'consumer',
    name: '家电家居',
    vendorCodes: ['885543.TI', '885478.TI'],
  },
  {
    id: 'new-consumer',
    parentId: 'consumer',
    name: '新消费',
    vendorCodes: [
      '885898.TI',
      '885768.TI',
      '885629.TI',
      '885642.TI',
      '886012.TI',
      '885990.TI',
      '885825.TI',
      '885615.TI',
      '886095.TI',
      '885937.TI',
      '885540.TI',
      '885497.TI',
      '885888.TI',
      '885580.TI',
    ],
  },
  {
    id: 'media-games',
    parentId: 'consumer',
    name: '传媒与游戏',
    vendorCodes: [
      '885418.TI',
      '885603.TI',
      '885457.TI',
      '885874.TI',
      '885737.TI',
      '886060.TI',
      '885876.TI',
      '885890.TI',
      '885918.TI',
      '886098.TI',
      '885910.TI',
    ],
  },
  {
    id: 'education',
    parentId: 'consumer',
    name: '教育',
    vendorCodes: ['885586.TI', '885480.TI'],
  },
  {
    id: 'metals',
    parentId: 'cyclical',
    name: '有色金属',
    vendorCodes: [
      '885343.TI',
      '885552.TI',
      '885973.TI',
      '885970.TI',
      '885971.TI',
      '885969.TI',
      '885865.TI',
      '885530.TI',
      '885428.TI',
    ],
  },
  {
    id: 'energy-chemical',
    parentId: 'cyclical',
    name: '能源化工',
    vendorCodes: [
      '885914.TI',
      '885398.TI',
      '885430.TI',
      '885372.TI',
      '885748.TI',
      '885863.TI',
      '885551.TI',
      '885903.TI',
      '885829.TI',
      '885633.TI',
      '885652.TI',
      '885912.TI',
      '885960.TI',
    ],
  },
  {
    id: 'new-materials',
    parentId: 'cyclical',
    name: '新材料',
    vendorCodes: [
      '885355.TI',
      '885650.TI',
      '886063.TI',
      '885901.TI',
      '885972.TI',
      '885781.TI',
      '886038.TI',
      '885931.TI',
    ],
  },
  {
    id: 'bank-insurance',
    parentId: 'finance',
    name: '银行保险',
    vendorCodes: ['885835.TI', '885623.TI'],
  },
  {
    id: 'securities-diversified',
    parentId: 'finance',
    name: '券商与多元金融',
    vendorCodes: ['885620.TI', '885570.TI', '885814.TI', '885413.TI', '885740.TI'],
  },
  {
    id: 'fintech',
    parentId: 'finance',
    name: '金融科技',
    vendorCodes: ['885456.TI', '885866.TI', '885333.TI', '885966.TI', '885767.TI', '885749.TI'],
  },
  {
    id: 'defense-equipment',
    parentId: 'defense',
    name: '军工装备',
    vendorCodes: [
      '885700.TI',
      '885743.TI',
      '885795.TI',
      '886076.TI',
      '886030.TI',
      '885860.TI',
      '886101.TI',
    ],
  },
  {
    id: 'aerospace',
    parentId: 'defense',
    name: '航天与卫星',
    vendorCodes: ['886078.TI', '885574.TI', '885566.TI', '885884.TI'],
  },
  {
    id: 'advanced-manufacturing',
    parentId: 'defense',
    name: '高端装备与工业母机',
    vendorCodes: ['885427.TI', '885930.TI', '885537.TI', '886057.TI', '885426.TI'],
  },
  {
    id: 'real-estate',
    parentId: 'real-estate-infra',
    name: '房地产',
    vendorCodes: ['885915.TI', '885758.TI'],
  },
  {
    id: 'infrastructure',
    parentId: 'real-estate-infra',
    name: '基建',
    vendorCodes: [
      '885572.TI',
      '885692.TI',
      '885760.TI',
      '885386.TI',
      '886087.TI',
      '885991.TI',
      '885690.TI',
      '885782.TI',
      '885750.TI',
      '885963.TI',
    ],
  },
  {
    id: 'power',
    parentId: 'utilities-transport',
    name: '电力',
    vendorCodes: ['885936.TI', '885996.TI', '886005.TI', '886105.TI'],
  },
  {
    id: 'environmental',
    parentId: 'utilities-transport',
    name: '环保',
    vendorCodes: [
      '885412.TI',
      '885410.TI',
      '885854.TI',
      '885962.TI',
      '886052.TI',
      '885919.TI',
      '885555.TI',
      '885961.TI',
      '885986.TI',
    ],
  },
  {
    id: 'transport',
    parentId: 'utilities-transport',
    name: '交通运输',
    vendorCodes: ['885733.TI', '885562.TI', '885502.TI', '885861.TI', '885770.TI'],
  },
  {
    id: 'planting',
    parentId: 'agriculture',
    name: '种植与种业',
    vendorCodes: [
      '885812.TI',
      '885811.TI',
      '885810.TI',
      '885877.TI',
      '885505.TI',
      '885967.TI',
      '885640.TI',
      '885439.TI',
      '885818.TI',
    ],
  },
  {
    id: 'livestock',
    parentId: 'agriculture',
    name: '养殖',
    vendorCodes: ['885573.TI', '885808.TI', '885846.TI'],
  },
  {
    id: 'agri-service',
    parentId: 'agriculture',
    name: '农业服务',
    vendorCodes: ['885706.TI', '885995.TI', '886016.TI', '885842.TI', '885705.TI'],
  },
];

const SOURCE_ORDER: readonly StockSectorMembership['memberStatus'][] = [
  'delisted',
  'suspended',
  'unknown',
  'listed',
];

/** 同一股票同时属于多个概念时，取最可交易的状态；停牌 / 退市只在全部来源都不可交易时成立。 */
const mergeMemberStatus = (
  left: StockSectorMembership['memberStatus'],
  right: StockSectorMembership['memberStatus'],
): StockSectorMembership['memberStatus'] =>
  SOURCE_ORDER.indexOf(left) >= SOURCE_ORDER.indexOf(right) ? left : right;

const dedupeMembers = (
  members: readonly StockSectorMembership[],
): readonly StockSectorMembership[] => {
  const merged = new Map<string, StockSectorMembership>();
  for (const membership of members) {
    if (membership.state !== 'active') continue;
    const current = merged.get(membership.stockId);
    if (current === undefined) {
      merged.set(membership.stockId, membership);
      continue;
    }
    merged.set(membership.stockId, {
      ...current,
      memberStatus: mergeMemberStatus(current.memberStatus, membership.memberStatus),
      firstSeenAt:
        current.firstSeenAt.getTime() <= membership.firstSeenAt.getTime()
          ? current.firstSeenAt
          : membership.firstSeenAt,
      lastSeenAt:
        current.lastSeenAt.getTime() >= membership.lastSeenAt.getTime()
          ? current.lastSeenAt
          : membership.lastSeenAt,
    });
  }
  return [...merged.values()];
};

const byStockId = (left: StockSectorMembership, right: StockSectorMembership): number =>
  left.stockId.localeCompare(right.stockId);

/** 标准题材来源：当前目录里实际存在的原始概念。 */
export const MainstreamThemeSourceSchema = z.object({
  vendorCode: SectorVendorCodeSchema,
  sectorId: z.string().min(1),
  name: z.string().min(1),
  memberCount: z.number().int().nonnegative(),
});
export type MainstreamThemeSource = z.infer<typeof MainstreamThemeSourceSchema>;

export const MainstreamThemeRowSchema = z.object({
  themeId: z.string().min(1),
  parentId: z.string().min(1),
  name: z.string().min(1),
  vendorCodes: z.array(SectorVendorCodeSchema),
  sources: z.array(MainstreamThemeSourceSchema),
  /** 分类定义里有、当前目录里缺失的 vendorCode：不伪装成完整映射。 */
  missingVendorCodes: z.array(SectorVendorCodeSchema),
  day: SectorDayMetricSchema,
  window5: SectorWindowMetricSchema,
  window15: SectorWindowMetricSchema,
  turnover: SectorTurnoverMetricSchema,
  limitUp: SectorLimitUpMetricSchema,
});
export type MainstreamThemeRow = z.infer<typeof MainstreamThemeRowSchema>;

export const MainstreamParentRowSchema = z.object({
  parentId: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int().nonnegative(),
  day: SectorDayMetricSchema,
  window5: SectorWindowMetricSchema,
  window15: SectorWindowMetricSchema,
  turnover: SectorTurnoverMetricSchema,
  limitUp: SectorLimitUpMetricSchema,
  themes: z.array(MainstreamThemeRowSchema),
});
export type MainstreamParentRow = z.infer<typeof MainstreamParentRowSchema>;

export const MainstreamThemeCoverageSchema = z.object({
  ruleVersion: z.string().min(1),
  parentCount: z.number().int().nonnegative(),
  themeCount: z.number().int().nonnegative(),
  /** 当前时点生效的原始概念目录条目数。 */
  catalogConceptCount: z.number().int().nonnegative(),
  /** 分类定义里的 vendorCode 总数。 */
  mappedVendorCodeCount: z.number().int().nonnegative(),
  /** 分类定义映射到、且当前目录里存在的 vendorCode 数。 */
  matchedVendorCodeCount: z.number().int().nonnegative(),
  /** 分类定义里有、当前目录里缺失的 vendorCode 数。 */
  missingVendorCodeCount: z.number().int().nonnegative(),
  /** 当前目录里未纳入任何标准题材的概念数；保留在原始概念视图，不静默伪装完整。 */
  unmappedConceptCount: z.number().int().nonnegative(),
  unmappedConcepts: z.array(
    z.object({ vendorCode: SectorVendorCodeSchema, name: z.string().min(1) }),
  ),
});
export type MainstreamThemeCoverage = z.infer<typeof MainstreamThemeCoverageSchema>;

export const MainstreamThemeMapSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorRankingEmptyReasonSchema.optional(),
  sort: SectorIntradaySortSchema,
  window: SectorWindowKeySchema,
  ruleVersion: z.string().min(1),
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  anchor: SectorRankingAnchorSchema.nullable(),
  windows: z.object({ w5: SectorWindowRefSchema, w15: SectorWindowRefSchema }),
  turnover: SectorTurnoverWindowSchema,
  limitUp: SectorLimitUpBlockSchema,
  coverage: MainstreamThemeCoverageSchema,
  parents: z.array(MainstreamParentRowSchema),
  notes: z.array(z.string()),
});
export type MainstreamThemeMap = z.infer<typeof MainstreamThemeMapSchema>;

const THEME_MAP_NOTES: readonly string[] = [
  '主流题材由固定父板块与标准题材定义决定，当日涨跌与成交排名只影响排序，不决定方向是否存在。',
  '标准题材行情 = 所映射原始概念的 active 成分股票并集；父板块行情 = 子题材成分并集，同一股票只计一次。',
  '映射优先使用扶摇 vendorCode；未映射概念保留在原始概念视图，不伪装成已覆盖。',
  '缺失样本、分母无效与跨午休不可比一律记为缺失，不补零；封板数无天梯快照时为缺失而不是 0。',
];

const definitionVendorCodes = (): readonly string[] =>
  MAINSTREAM_THEMES.flatMap((theme) => theme.vendorCodes);

/** 分类定义自检：父板块顺序固定、题材归属有效、vendorCode 全局唯一。 */
export const assertMainstreamThemeDefinitions = (): void => {
  const parentIds = new Set<string>();
  let expectedOrder = 0;
  for (const parent of MAINSTREAM_PARENT_SECTORS) {
    if (parentIds.has(parent.id)) throw new InvariantError(`主流父板块 id 重复：${parent.id}`);
    if (parent.order !== expectedOrder) {
      throw new InvariantError(`主流父板块顺序必须连续：${parent.id} 期望 ${expectedOrder}`);
    }
    parentIds.add(parent.id);
    expectedOrder += 1;
  }
  const themeIds = new Set<string>();
  const vendorOwners = new Map<string, string>();
  for (const theme of MAINSTREAM_THEMES) {
    if (themeIds.has(theme.id)) throw new InvariantError(`标准题材 id 重复：${theme.id}`);
    themeIds.add(theme.id);
    if (!parentIds.has(theme.parentId)) {
      throw new InvariantError(`标准题材 ${theme.id} 的父板块 ${theme.parentId} 不存在`);
    }
    for (const vendorCode of theme.vendorCodes) {
      const owner = vendorOwners.get(vendorCode);
      if (owner !== undefined) {
        throw new InvariantError(
          `vendorCode ${vendorCode} 同时映射到 ${owner} 与 ${theme.id}，同一概念只允许一个标准题材`,
        );
      }
      vendorOwners.set(vendorCode, theme.id);
    }
  }
  if (vendorOwners.size !== definitionVendorCodes().length) {
    throw new InvariantError('主流题材 vendorCode 存在重复');
  }
};

const emptyWindowRef = (key: SectorWindowKey, reason: string): SectorWindowRef => ({
  key,
  minutes: SECTOR_INTRADAY_WINDOWS[key],
  status: 'unavailable',
  targetSampledAt: null,
  startSampledAt: null,
  spanMs: null,
  reason,
  warnings: [],
});

/** 空态：保留请求口径与原因，不返回任何父板块（没有批次就没有行情）。 */
export const buildMainstreamThemeMapEmpty = (input: {
  readonly sort: SectorIntradaySort;
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): MainstreamThemeMap => {
  if ((input.reason === 'no_batch') !== (input.latest === null)) {
    throw new InvariantError('主流题材地图空态原因与最近批次状态不一致');
  }
  const reasonText = `${input.reason}: ${SECTOR_EMPTY_REASON_TEXT[input.reason]}`;
  const parsed = MainstreamThemeMapSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    sort: input.sort,
    window: input.window,
    ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : sectorRankingAnchorSummary(input.latest),
    windows: {
      w5: emptyWindowRef('w5', reasonText),
      w15: emptyWindowRef('w15', reasonText),
    },
    turnover: {
      window: input.window,
      status: 'unavailable',
      reason: reasonText,
      marketAmountDelta: null,
      marketSampleCount: 0,
      marketTotalCount: 0,
      method: SECTOR_TURNOVER_METHOD,
      warnings: [],
    },
    limitUp: {
      status: 'unavailable',
      reason: reasonText,
      tradingDate: null,
      source: null,
      total: null,
      maxLevel: null,
      method: '封板数 = 当日连板天梯中出现的板块 active 成分数；无天梯快照时缺失，不写 0',
      warnings: [],
    },
    coverage: {
      ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
      parentCount: MAINSTREAM_PARENT_SECTORS.length,
      themeCount: MAINSTREAM_THEMES.length,
      catalogConceptCount: 0,
      mappedVendorCodeCount: definitionVendorCodes().length,
      matchedVendorCodeCount: 0,
      missingVendorCodeCount: definitionVendorCodes().length,
      unmappedConceptCount: 0,
      unmappedConcepts: [],
    },
    parents: [],
    notes: [...THEME_MAP_NOTES],
  });
  assertMainstreamThemeMapInvariants(parsed);
  return parsed;
};

const sortValueOf = (row: MainstreamThemeRow, sort: SectorIntradaySort): number | null =>
  sort === 'day' ? row.day.value : sort === 'window5' ? row.window5.value : row.window15.value;

/** 题材按请求口径降序，缺失排最后；同值按定义顺序（sort 稳定）。 */
const compareThemes =
  (sort: SectorIntradaySort) => (left: MainstreamThemeRow, right: MainstreamThemeRow) => {
    const leftValue = sortValueOf(left, sort);
    const rightValue = sortValueOf(right, sort);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  };

/** 标准题材成分并集的唯一计算入口：地图与核心股读模型必须共用，避免两套并集口径。 */
export interface MainstreamThemeMemberIndex {
  readonly concepts: readonly SectorCatalogEntry[];
  readonly conceptByVendorCode: ReadonlyMap<string, SectorCatalogEntry>;
  readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
  readonly themeMembers: ReadonlyMap<string, readonly StockSectorMembership[]>;
  readonly missingVendorCodesByTheme: ReadonlyMap<string, readonly string[]>;
}

export const buildMainstreamThemeMemberIndex = (input: {
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
}): MainstreamThemeMemberIndex => {
  const concepts = input.sectors
    .filter((sector) => sector.kind === 'concept' && sector.state === 'active')
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const conceptByVendorCode = new Map<string, SectorCatalogEntry>();
  for (const sector of concepts) {
    if (!conceptByVendorCode.has(sector.vendorCode)) {
      conceptByVendorCode.set(sector.vendorCode, sector);
    }
  }

  const membersBySector = new Map<string, StockSectorMembership[]>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const list = membersBySector.get(membership.sectorId) ?? [];
    list.push(membership);
    membersBySector.set(membership.sectorId, list);
  }

  const themeMembers = new Map<string, readonly StockSectorMembership[]>();
  const missingVendorCodesByTheme = new Map<string, readonly string[]>();
  for (const theme of MAINSTREAM_THEMES) {
    const collected: StockSectorMembership[] = [];
    const missing: string[] = [];
    for (const vendorCode of theme.vendorCodes) {
      const concept = conceptByVendorCode.get(vendorCode);
      if (concept === undefined) {
        missing.push(vendorCode);
        continue;
      }
      collected.push(...(membersBySector.get(concept.id) ?? []));
    }
    themeMembers.set(theme.id, dedupeMembers(collected).slice().sort(byStockId));
    missingVendorCodesByTheme.set(theme.id, missing);
  }

  return {
    concepts,
    conceptByVendorCode,
    membersBySector,
    themeMembers,
    missingVendorCodesByTheme,
  };
};

export interface MainstreamThemeMapInput {
  readonly sort: SectorIntradaySort;
  readonly window: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  readonly windowStarts: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  /** 当前时点生效的概念目录（kind=concept）。 */
  readonly sectors: readonly SectorCatalogEntry[];
  /** 当前时点生效的成分关系；state=missing 会被忽略。 */
  readonly members: readonly StockSectorMembership[];
  readonly limitUp: LimitUpLadder | null;
  readonly limitUpError: string | null;
}

export const buildMainstreamThemeMap = (input: MainstreamThemeMapInput): MainstreamThemeMap => {
  const windows = {
    w5: resolveSectorWindow({
      key: 'w5',
      anchor: input.anchor,
      start: input.windowStarts.w5,
    }),
    w15: resolveSectorWindow({
      key: 'w15',
      anchor: input.anchor,
      start: input.windowStarts.w15,
    }),
  };
  const anchorItems = new Map(input.anchor.items.map((item) => [item.id, item]));
  const startItems = {
    w5: new Map((input.windowStarts.w5?.items ?? []).map((item) => [item.id, item])),
    w15: new Map((input.windowStarts.w15?.items ?? []).map((item) => [item.id, item])),
  };
  const turnoverBlock = buildSectorTurnoverWindow({
    window: input.window,
    windowRef: windows[input.window],
    anchor: input.anchor,
    start: input.windowStarts[input.window],
  });
  const limitUpBlock = buildSectorLimitUpBlock({
    limitUp: input.limitUp,
    limitUpError: input.limitUpError,
  });
  const ladderCodes = new Set<string>();
  for (const level of input.limitUp?.levels ?? []) {
    for (const entry of level.stocks) ladderCodes.add(entry.code);
  }

  const memberIndex = buildMainstreamThemeMemberIndex({
    sectors: input.sectors,
    members: input.members,
  });
  const { concepts, conceptByVendorCode, membersBySector } = memberIndex;

  const metricsOf = (members: readonly StockSectorMembership[]) => ({
    day: buildSectorDayMetric({ members, items: anchorItems }),
    window5: buildSectorWindowMetric({
      key: 'w5',
      window: windows.w5,
      members,
      items: anchorItems,
      startItems: startItems.w5,
    }),
    window15: buildSectorWindowMetric({
      key: 'w15',
      window: windows.w15,
      members,
      items: anchorItems,
      startItems: startItems.w15,
    }),
    turnover: buildSectorTurnoverMetric({
      denominator: turnoverBlock,
      members,
      items: anchorItems,
      startItems: startItems[input.window],
    }),
    limitUp: buildSectorLimitUpMetric({ members, block: limitUpBlock, codes: ladderCodes }),
  });

  const parentIds = new Set(MAINSTREAM_PARENT_SECTORS.map((parent) => parent.id));
  const themesByParent = new Map<string, MainstreamThemeDefinition[]>();
  for (const theme of MAINSTREAM_THEMES) {
    if (!parentIds.has(theme.parentId)) {
      throw new InvariantError(`标准题材 ${theme.id} 的父板块 ${theme.parentId} 不存在`);
    }
    const list = themesByParent.get(theme.parentId) ?? [];
    list.push(theme);
    themesByParent.set(theme.parentId, list);
  }

  const mappedVendorCodes = new Set(definitionVendorCodes());
  const matchedVendorCodes = new Set<string>();
  const parentRows: MainstreamParentRow[] = [];
  for (const parent of [...MAINSTREAM_PARENT_SECTORS].sort(
    (left, right) => left.order - right.order,
  )) {
    const themeRows: MainstreamThemeRow[] = [];
    const parentMembers: StockSectorMembership[] = [];
    for (const theme of themesByParent.get(parent.id) ?? []) {
      const sources: MainstreamThemeSource[] = [];
      const missingVendorCodes = [...(memberIndex.missingVendorCodesByTheme.get(theme.id) ?? [])];
      for (const vendorCode of theme.vendorCodes) {
        const concept = conceptByVendorCode.get(vendorCode);
        if (concept === undefined) continue;
        matchedVendorCodes.add(vendorCode);
        const sectorMembers = membersBySector.get(concept.id) ?? [];
        sources.push({
          vendorCode,
          sectorId: concept.id,
          name: concept.name,
          memberCount: dedupeMembers(sectorMembers).length,
        });
      }
      const dedupedThemeMembers = memberIndex.themeMembers.get(theme.id) ?? [];
      parentMembers.push(...dedupedThemeMembers);
      themeRows.push({
        themeId: theme.id,
        parentId: parent.id,
        name: theme.name,
        vendorCodes: [...theme.vendorCodes],
        sources,
        missingVendorCodes,
        ...metricsOf(dedupedThemeMembers),
      });
    }
    themeRows.sort(compareThemes(input.sort));
    parentRows.push({
      parentId: parent.id,
      name: parent.name,
      order: parent.order,
      ...metricsOf(dedupeMembers(parentMembers).slice().sort(byStockId)),
      themes: themeRows,
    });
  }

  const unmappedConcepts = concepts
    .filter((sector) => !mappedVendorCodes.has(sector.vendorCode))
    .map((sector) => ({ vendorCode: sector.vendorCode, name: sector.name }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'zh-Hans-CN') ||
        left.vendorCode.localeCompare(right.vendorCode),
    );

  const parsed = MainstreamThemeMapSchema.parse({
    state: 'ready',
    sort: input.sort,
    window: input.window,
    ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
    tradingDate: input.anchor.tradingDate,
    anchor: sectorRankingAnchorSummary(input.anchor),
    windows,
    turnover: turnoverBlock,
    limitUp: limitUpBlock,
    coverage: {
      ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
      parentCount: parentRows.length,
      themeCount: parentRows.reduce((sum, parent) => sum + parent.themes.length, 0),
      catalogConceptCount: concepts.length,
      mappedVendorCodeCount: mappedVendorCodes.size,
      matchedVendorCodeCount: matchedVendorCodes.size,
      missingVendorCodeCount: mappedVendorCodes.size - matchedVendorCodes.size,
      unmappedConceptCount: unmappedConcepts.length,
      unmappedConcepts,
    },
    parents: parentRows,
    notes: [...THEME_MAP_NOTES],
  });
  assertMainstreamThemeMapInvariants(parsed);
  return parsed;
};

export const assertMainstreamThemeMapInvariants = (map: MainstreamThemeMap): void => {
  if (map.ruleVersion !== MAINSTREAM_THEME_RULE_VERSION) {
    throw new InvariantError('主流题材地图必须携带当前分类版本');
  }
  if (map.coverage.ruleVersion !== map.ruleVersion) {
    throw new InvariantError('主流题材地图覆盖统计的分类版本必须与响应一致');
  }
  if (map.state === 'empty') {
    if (map.emptyReason === undefined) throw new InvariantError('主流题材地图空态必须给出原因');
    if (map.parents.length > 0) throw new InvariantError('主流题材地图空态不得返回父板块');
    return;
  }
  if (map.emptyReason !== undefined) {
    throw new InvariantError('主流题材地图 ready 不得携带空态原因');
  }
  if (map.anchor === null || map.tradingDate === null) {
    throw new InvariantError('主流题材地图 ready 必须基于已发布批次');
  }
  if (map.parents.length !== MAINSTREAM_PARENT_SECTORS.length) {
    throw new InvariantError('主流题材地图必须固定展示全部父板块');
  }
  let expectedOrder = 0;
  let themeCount = 0;
  let matched = 0;
  let missing = 0;
  for (const [index, parent] of map.parents.entries()) {
    const definition = MAINSTREAM_PARENT_SECTORS[index];
    if (definition === undefined || parent.parentId !== definition.id) {
      throw new InvariantError('主流题材地图父板块顺序必须与固定定义一致');
    }
    if (parent.order !== expectedOrder) {
      throw new InvariantError('主流题材地图父板块顺序必须连续');
    }
    expectedOrder += 1;
    const parentThemes = MAINSTREAM_THEMES.filter((theme) => theme.parentId === parent.parentId);
    if (parent.themes.length !== parentThemes.length) {
      throw new InvariantError(`父板块 ${parent.parentId} 必须展示全部标准题材`);
    }
    for (const theme of parent.themes) {
      const themeDefinition = parentThemes.find((entry) => entry.id === theme.themeId);
      if (themeDefinition === undefined) {
        throw new InvariantError(`父板块 ${parent.parentId} 出现未定义题材 ${theme.themeId}`);
      }
      if (theme.vendorCodes.length !== themeDefinition.vendorCodes.length) {
        throw new InvariantError(`标准题材 ${theme.themeId} 的 vendorCode 列表必须与定义一致`);
      }
      if (
        theme.sources.length + theme.missingVendorCodes.length !==
        themeDefinition.vendorCodes.length
      ) {
        throw new InvariantError(`标准题材 ${theme.themeId} 的来源与缺失必须覆盖全部 vendorCode`);
      }
      if (
        theme.day.memberCount !==
        theme.day.sampleCount + theme.day.missingCount + theme.day.nonTradableCount
      ) {
        throw new InvariantError(`标准题材 ${theme.themeId} 日涨幅样本数不自洽`);
      }
      matched += theme.sources.length;
      missing += theme.missingVendorCodes.length;
      themeCount += 1;
    }
    if (
      parent.day.memberCount !==
      parent.day.sampleCount + parent.day.missingCount + parent.day.nonTradableCount
    ) {
      throw new InvariantError(`父板块 ${parent.parentId} 日涨幅样本数不自洽`);
    }
  }
  if (map.coverage.themeCount !== themeCount) {
    throw new InvariantError('主流题材地图题材计数与行不一致');
  }
  if (map.coverage.parentCount !== map.parents.length) {
    throw new InvariantError('主流题材地图父板块计数与行不一致');
  }
  if (map.coverage.matchedVendorCodeCount !== matched) {
    throw new InvariantError('主流题材地图已匹配来源计数与行不一致');
  }
  if (map.coverage.missingVendorCodeCount !== missing) {
    throw new InvariantError('主流题材地图缺失来源计数与行不一致');
  }
  if (
    map.coverage.unmappedConceptCount !== map.coverage.unmappedConcepts.length ||
    map.coverage.catalogConceptCount <
      map.coverage.unmappedConceptCount + map.coverage.matchedVendorCodeCount
  ) {
    throw new InvariantError('主流题材地图未映射概念统计不自洽');
  }
  if (map.turnover.window !== map.window) {
    throw new InvariantError('主流题材地图占比窗口必须与请求口径一致');
  }
};

export const mainstreamThemesOf = (parentId: string): readonly MainstreamThemeDefinition[] =>
  MAINSTREAM_THEMES.filter((theme) => theme.parentId === parentId);

export const mainstreamThemeByVendorCode = (
  vendorCode: string,
): MainstreamThemeDefinition | undefined =>
  MAINSTREAM_THEMES.find((theme) => theme.vendorCodes.includes(vendorCode));

export const MAINSTREAM_THEME_STATISTICS = {
  parentCount: MAINSTREAM_PARENT_SECTORS.length,
  themeCount: MAINSTREAM_THEMES.length,
  mappedVendorCodeCount: definitionVendorCodes().length,
} as const;
