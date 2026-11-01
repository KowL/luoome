import type {
  AnnouncementDisclosure,
  DisclosureSource,
  VendorSnapshot,
} from './disclosure-source.js';

/**
 * 夹具披露源（REQ-M4-05）。
 *
 * ## ⚠️ **不是真实数据**
 *
 * `name` 以 `mock:` 开头，`isMock: true`。任何把它当真实财报用的输出
 * 都必须带上 `describeDisclosureSource()` 的说明。
 *
 * ## 夹具数据来自 spike 实测（`output/dsh-brainstorm/revision-spike.md` §2）
 *
 * 康美药业 600518.SH / 2017 年度营业收入三个版本 —— 这三组值是**真实披露值**，
 * 差额 `−8,898,352,337.51` 与 2019-04-30 差错更正公告「累计影响金额」精确到分一致。
 * 用它做夹具的好处是：**校验逻辑可以对着一组已知正确的数字跑**。
 */
export const KANGMEI_2017_REVENUE_VINTAGES = Object.freeze([
  { version: 'v1', value: 26_476_970_977.57, announcedAt: '2018-04-26' },
  { version: 'v2', value: 17_578_618_640.06, announcedAt: '2019-04-30' },
  { version: 'v3', value: 16_173_969_211.76, announcedAt: '2020-06-18' },
] as const);

/** spike 实测：差错更正公告给出的累计影响金额（元）。 */
export const KANGMEI_2017_CORRECTION_DELTA = -8_898_352_337.51;

export interface MockDisclosureOptions {
  readonly announcements?: readonly AnnouncementDisclosure[];
  readonly snapshots?: readonly VendorSnapshot[];
}

/**
 * 创建夹具源。
 *
 * 默认夹具 = 康美 2017A 的三个版本 + 一条数据商快照。
 * 测试可以通过 options 覆盖成任意形态（例如「缺 announcementTime」、「只有一版」）。
 */
export const mockDisclosureSource = (options: MockDisclosureOptions = {}): DisclosureSource => {
  const announcements = options.announcements ?? [
    {
      announcementId: '1204793690',
      announcementTime: new Date('2018-04-26T00:00:00+08:00'),
      title: '2017年年度报告',
      kind: 'periodic-report' as const,
    },
    {
      announcementId: '1206168278',
      announcementTime: new Date('2019-04-30T00:00:00+08:00'),
      title: '关于前期会计差错更正的公告',
      kind: 'correction-notice' as const,
    },
    {
      announcementId: '1207936073',
      announcementTime: new Date('2020-06-18T00:00:00+08:00'),
      title: '2019年年度报告（调整后比较数）',
      kind: 'correction-notice' as const,
    },
  ];
  const snapshots = options.snapshots ?? [
    {
      stockId: '600518.SH',
      metricId: 'revenue',
      periodEnd: new Date('2017-12-31T00:00:00+08:00'),
      // spike 实测：东财停在 v2（缺 v3）—— 这本身就是「漏报」的证据
      value: 17_578_618_640.06,
      vendorUpdatedAt: new Date('2019-04-30T00:00:00+08:00'),
    },
  ];

  return {
    // **前缀写死 `mock:`**：任何日志/输出里出现它，用户立刻能看出不是真数据。
    name: 'mock:disclosure-source',
    isMock: true,
    async listAnnouncements(input) {
      // 夹具不区分报告期，一律返回同一组（测试按需覆盖）。
      void input;
      return announcements;
    },
    async fetchVendorSnapshot(input) {
      return (
        snapshots.find(
          (item) =>
            item.stockId === input.stockId &&
            item.metricId === input.metricId &&
            item.periodEnd.getTime() === input.periodEnd.getTime(),
        ) ?? null
      );
    },
  };
};
