# 行情数据源设置与状态展示优化设计

> 状态：已实施（2026-08-23；浏览器验收通过，见 §8）
> 日期：2026-08-23
> 范围：Web 设置页「行情数据源」分区——从源级开关列表升级为「源 × capability」的配置态 + 运行态视图
> 关联文档：[ARCHITECTURE.md §4.7](../ARCHITECTURE.md)、[数据源可插拔与统一观测设计](./source-pluggability-and-observation-design.md)（§4.3 观测状态机、§6.1 registry 契约）、[ruo 迁移设计 §8](./ruo-feature-migration-detailed-design.md)（数据健康读模型）

## 1. 目标

- 设置页每个行情源行内可直接看到该源下各 capability（实时快照 / 日 K / 搜索 / 指数……）的运行状态，不再只有开关和优先级。
- 配置态（启用 / 优先级 / 凭证就绪）与运行态（fresh / stale / unavailable / unknown）同屏呈现但来源分层清晰。
- 未启用源也能展示「该源可提供哪些服务、缺什么凭证」，不必先启用才知道能力边界。

非目标：

- 不引入观测落库、历史趋势、成功率统计（registry 观测维持进程内存态，UI 明确标注语义）。
- 不动 news / dragon-tiger / northbound 等非行情域的设置 UI（它们仍走 env，观测已在 `get_market_data_status` 的 datasets 里）。
- 不加自动轮询；状态随设置页加载刷新 + 手动刷新按钮。

## 2. 现状与缺口

现状（事实来源：`apps/web/src/market-settings.ts`、`apps/web/public/js/market-settings.js`、`packages/tools/src/tools/get-market-data-status.ts`、`packages/adapters/src/source-registry.ts`）：

- 设置页每源一行：rank、label、READY / NOT CONFIGURED badge、开关、↑↓；`MarketSettingsStore` 把 `LUOOME_MARKET_SOURCES` 原子写回 `$LUOOME_HOME/.env`，`POST /api/settings/market` 热替换 market + sentiment adapter。
- 运行态数据其实已存在：`MarketSourceRegistry.describe()` 产出每（source × capability）的 `MarketSourceStatus`（`lastAttemptAt / lastSuccessAt / dataAsOf / lastErrorKind`），`get_market_data_status` 的 `datasets` 已实现 §4.3 freshness 状态机（fresh / stale / unavailable / unknown）。
- 同页的「数据同步」panel（`market-sync.js`）已渲染 datasets 表，但与路由优先级列表分离，用户无法把「某行数据 stale」对应到「某个源的某项能力」。

缺口：

1. **设置视图无运行态**：`MarketSourceSettingsView` 只有配置字段，`sourceRow` 没有任何健康信息。
2. **配置态与运行态两套数据不互通**：`configured` 只在 Store 做 env 检查；registry 只有已启用源的 binding。未启用源的能力清单无处查询。
3. **展示分散**：仪表盘「数据健康」卡只消费 `providers`，完全丢弃 `datasets`；「数据同步」panel 有 datasets 但不按源聚合。

## 3. 设计原则

- **registry 仍是运行态唯一事实来源**；web 层只做聚合与投影，不复制 §4.3 状态机逻辑（freshness 推导复用 `get_market_data_status` 的输出）。
- **三层数据各司其职**：静态 manifest（源能提供什么）← adapters；配置态（启没启用、凭证在不在）← Store；运行态（最近调用结果）← registry。UI 把三层叠在一张表上。
- 未启用 / 未配置的源不造假状态：显示「未启用」或「未配置」，不显示 unknown 观测行。
- 观测是进程内存态，UI 文案写明「本次进程」（保存设置热替换 manager 后观测清零，回 unknown 是正确语义）。

## 4. 静态能力 manifest（adapters 层新增）

factory 目前只在源被启用时构建 binding，未启用源的能力边界无法得知。新增静态清单，与绑定代码同文件、同 PR 维护：

```ts
// packages/adapters/src/market/factory.ts（或独立 manifest.ts）
export interface MarketSourceManifestEntry {
  readonly capabilities: readonly MarketCapability[];       // 该源声明的能力全集
  readonly requiredEnv?: { readonly key: string; readonly label: string };
}
export const MARKET_SOURCE_MANIFEST: Readonly<Record<MarketSourceId, MarketSourceManifestEntry>>;
```

- manifest 是「该源实现了什么」的声明，与实际 binding 的一致性用单测钉住（遍历 manifest 逐源构建 binding，断言 capability 集合相等；tushare / fuyao 缺凭证时用注入假 config 绕过启动卡口）。
- `SOURCE_REQUIRED_ENV` 从 `market-settings.ts` 上收到 manifest，消除两处维护。

## 5. API：扩展 `GET /api/settings/market`

不新增端点。响应的每个 source 增加 `capabilities` 与行级摘要：

```ts
interface MarketCapabilityStatusView {
  readonly capability: MarketCapability;
  readonly label: string;                    // 中文词表：实时快照 / 批量快照 / 日 K / 搜索 / 全市场快照 / 实时指数 / 延时指数 / 当日分时 / 分钟 K
  readonly bound: boolean;                   // manifest 声明（静态能力边界）
  readonly state?: 'fresh' | 'stale' | 'unavailable' | 'unknown';  // 运行态，仅 enabled 源出现
  readonly lastAttemptAt?: string;           // ISO
  readonly lastSuccessAt?: string;
  readonly dataAsOf?: string;
  readonly lastErrorKind?: SourceErrorKind;
}

interface MarketSourceSettingsView {  // 现有字段不变，新增：
  readonly capabilities: readonly MarketCapabilityStatusView[];  // 按 manifest 全量列出，bound=false 表示该源不支持
  readonly health: 'fresh' | 'stale' | 'unavailable' | 'unknown' | 'off';  // 行级摘要：取各 bound capability 最差状态；disabled → 'off'
}
```

组装逻辑（server.ts 的 GET handler）：

1. `store.read()` 拿配置态（现状不变）；
2. `invokeTool('get_market_data_status', {})` 拿 `datasets`，按 `source` 过滤出五个行情源的行（复用 §4.3 freshness，不重新实现）；
3. 按 manifest 对每源展开 capability 全清单：有 dataset 行的填运行态，enabled 但尚无观测 → `unknown`，disabled 源只给 `bound` 不给 `state`。

失败语义：`get_market_data_status` 失败时不拖垮设置读取——降级为只返回配置态（`capabilities` 里全部无 `state`），与 `/api/market/indices` 的降级惯例一致。

## 6. 前端（market-settings.js）

- 每源行新增：行级健康点（绿 fresh / 黄 stale / 红 unavailable / 灰 unknown·off）+「展开」按钮；行内信息保持现有密度，不默认展开。
- 展开区渲染 capability 表：能力名、状态 badge（未支持的能力显示「—」，不画状态）、最近成功时间、数据时间（dataAsOf）、最近错误 kind。时间用相对格式（同仪表盘既有惯例），表头注明「运行态为本次进程观测」。
- 保存设置后重新 GET（热替换后观测清零，unknown 是正确展示）；加手动「刷新状态」按钮重新拉取，不轮询。
- 「数据同步」panel 本次保留不动：它承载 checkpoint / 同步语义，与源 × capability 视角互补；后续如需收敛另起变更。
- 顺带修复（小改，同 PR）：仪表盘「数据健康」卡（`pages.js` 渲染 `get_market_data_status` 处）目前丢弃 `datasets`，补一个折叠的 per-dataset 明细，与设置页共用状态词表和 badge 样式。

### 6.1 「测试」按钮：主动探测（2026-08-23 追加）

仅展示观测的局限：状态只能等真实调用发生后才变化。每源行加「测试」按钮，主动探测该源全部能力并立即刷新状态：

- **manager 层**：`MarketDataManager.probeSource(source)`——遍历 10 种 capability 的固定探测请求（quote/batch-quote/intraday/minute 用 `600519.SH`，search 用「茅台」，daily-bars 取近 14 天，index/snapshot 用沪深覆盖），对该源已绑定的能力逐项顺序执行 registry handle（观测由 handle 自动记录，§4.3 状态机自然生效），单项失败不中断；未绑定能力返回 `bound: false, ok: null` 不执行。不经过路由 / 缓存 / 限速。
- **端口**：core `MarketDataAdapterLike` 增加可选 `probeSource?`（对齐 `fetchMarketSnapshotEnvelope?` 先例），结果类型 `MarketSourceProbe`（capability 开放字符串，与 MarketSourceStatus 同原则）。
- **API**：`POST /api/settings/market/:id/test`（`external` 卡口）。只允许探测已启用源——未启用源不在当前 manager 的 registry 里，没有 handle 可执行；响应携带 `probes` 明细与叠加最新观测的完整设置视图，前端一次刷新。
- **前端**：按钮仅 enabled 源可用；探测中禁用全部测试按钮防并发；完成后用响应里的 settings 重绘，状态摘要写面板与 toast（N 项通过 / 失败项列 capability:errorKind）。
- 语义提醒：success 但 observationOf 无 dataAsOf 的能力（如 search），状态按 §4.3 仍是「未知」，最近成功列承载成功信号；不为探测修改状态机。

## 7. 变更点清单

| 层 | 文件 | 改动 |
|---|---|---|
| core | `context.ts` | `MarketSourceProbe` 类型 + 端口可选方法 `probeSource?` |
| adapters | `market/factory.ts`（或新 `manifest.ts`） | 导出 `MARKET_SOURCE_MANIFEST`；一致性单测 |
| adapters | `market/manager.ts` | `probeSource` 逐项探测实现 + 单测 |
| web server | `market-settings.ts` | `SOURCE_REQUIRED_ENV` 改用 manifest；视图类型扩展 + `withRuntimeStatus` |
| web server | `server.ts` GET `/api/settings/market` | 聚合 store + `get_market_data_status` datasets，组装 §5 视图；tool 失败降级 |
| web server | `server.ts` POST `/api/settings/market/:id/test` | 主动探测端点（external 卡口，仅已启用源），响应带 probes + 最新设置视图 |
| web 前端 | `market-settings.js`、样式 | 健康点、展开 capability 表、刷新按钮、测试按钮 |
| web 前端 | `pages.js` | 数据健康卡补 datasets 明细（顺带） |
| 测试 | `market-settings` 相关 server 测试、前端测试 | 聚合视图快照、降级路径、manifest 一致性、probe 卡口与回传 |

core / tools / registry 零改动：`SourceStatus` 字段与 freshness 状态机已够用。

## 8. 验收清单

- [x] 五个源全部展示能力清单；tushare / fuyao 未配凭证时行级显示「未配置」且保存仍拒绝启用（现有行为不回归，market-settings 单测锁定）；
- [x] 启用源触发行情调用后展开行显示对应 capability 状态（2026-08-23 实测：eastmoney batch-quote 失败 → 不可用 + network，tencent batch-quote → 过期 + dataAsOf）；
- [x] 保存设置（热替换 manager）后观测回 unknown（store 语义 + 前端保存后重拉）；
- [x] `get_market_data_status` 不可用时设置页配置态仍可读可写（GET 降级为纯配置态）；
- [x] `bun run test`（1645）/ `test:web`（305）/ `typecheck` / `lint` 全绿；playwright 实测设置页展开表与仪表盘数据集明细（`output/playwright/settings-sources-02-expanded.png`、`dashboard-health-02.png`）；
- [x] 「测试」按钮端到端（2026-08-23 playwright 实测，默认 eastmoney/tencent/tushare 路由）：点击东方财富测试 → 逐项探测后表格刷新（实时快照/实时指数 新鲜、批量快照 过期、日 K 不可用 + network），toast 汇总「6 项通过，1 项失败（daily-bars:network）」，未启用源按钮禁用（`output/playwright/settings-probe-01.png`）。
