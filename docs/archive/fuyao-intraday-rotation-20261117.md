# 扶摇盘中题材轮动数据核对

2026-11-17 核对同花顺扶摇公开文档。沪深 A 股累计成交额、题材日涨跌幅和成分股涨幅排行都有公开取数路径。“算力回落、机器人接力”可以从行情变化推断，两个题材之间实际转移的资金金额无法从这些数据识别。[官方文档索引](https://fuyao.aicubes.cn/llms.txt)

## 当日实测

使用项目凭证于上海时间 14:58:51–14:59:07 取样。概念目录返回 390 项；选用“算力租赁” `886050.TI` 和“机器人概念” `885517.TI`。两者成分各自过滤至沪深 A 股并去重后，分别有 186 只和 1,178 只，其中 58 只重叠。两轮指数快照均返回成交额，数据时间戳推进，两个指数的日涨幅在两次读数中分别保持 −1.805897% 和 −2.180778%。另从个股快照分页抽查 3 只，均返回涨幅与成交额。这次短时抽查验证了接口和字段；逐股延时、两市完整合计和全天轮动仍需独立验证。[指数接口契约](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/) · [个股接口契约](https://fuyao.aicubes.cn/docs/api-reference/prices/)

## 图上各指标怎么取

| 图上指标 | 来源与计算口径 |
| --- | --- |
| 沪深 A 股累计成交额 | 分页读取 `GET /api/a-share/prices/snapshot`，省略 `thscodes`，按 `limit`（默认 100）、`offset` 遍历股票代码表。按完整代码去重，只汇总沪、深 A 股的 `item[].turnover`（元），除以一亿显示亿元。分页期间行情可能变化，记录采样起止时间和返回覆盖数；缺页时显示“部分合计”。[股票行情](https://fuyao.aicubes.cn/docs/api-reference/prices/) |
| 昨日全天、昨日同时点 | 用上一交易日同口径收盘快照或沪深 A 股日线成交额汇总作全天基线。昨日同时点要有上一交易日在相同交易分钟留存的累计快照；缺历史采样就显示缺数。指数历史行情仅有日线，不能重建盘中曲线。[交易日历](https://fuyao.aicubes.cn/docs/api-reference/calendar/) · [股票行情](https://fuyao.aicubes.cn/docs/api-reference/prices/) · [指数行情](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/) |
| 题材涨幅柱 | `GET /api/a-share-index/catalog/ths-index-list?tag=cn_concept` 一次返回概念目录的 `thscode`、`name`。先明确算力、机器人各自对应哪个正式概念，再将其代码传给 `GET /api/a-share-index/prices/snapshot` 的 `thscodes` 批量参数。以 `price_change_ratio_pct` 画柱，1.74 表示 1.74%。指数快照也有 `turnover`；多个概念可含同一股票，跨概念加总会重复计量。[指数目录与行情](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/) |
| 柱内领涨股 | `GET /api/a-share-index/constituents/ths-stock-list?thscode=…` 每次查一个指数，获得当前成分股代码与名称。用完整代码匹配同轮个股快照，按 `price_change_ratio_pct` 降序，即为当时的涨幅榜。如已有全市场快照可直接复用；只跟踪几个题材时可按 `thscodes` 分批取并集。排行附有效成分数；历史回放使用当时留存的成分名单。[指数成分](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/) · [个股快照](https://fuyao.aicubes.cn/docs/api-reference/prices/) |

## “算力 → 机器人”的证据边界

正式作战室的板块日涨幅取有效成分股相对前收涨幅的等权均值，窗口涨幅按各成分窗口两端价格计算后等权。若柱子改用扶摇官方指数，应标明“同花顺概念指数涨幅”，回放沿用同一口径。[作战室板块榜](../../packages/toolkit/src/tools/market-room-sectors.ts) · [指数快照](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/)

沿用作战室的 5 分钟采集批次，比较同一连续交易时段内相邻、互不重叠的两个 15 分钟窗口。每个题材的窗口成交占比为有效成分成交额增量之和除以同期去重全市场成交额增量，占比环比按百分点计算。若算力占比下降、机器人占比上升，再检查窗口涨幅、上涨成分比例和领涨股换位是否支持这一方向。两端剔除共有股票后按同一市场分母复核；若方向消失，应显示“重叠成分影响”。分母无效、缺帧、跨午休或覆盖不可比时保留缺数。[作战室成交分布与窗口约束](../../packages/toolkit/src/tools/market-room-amount-distribution.ts) · [作战室板块榜](../../packages/toolkit/src/tools/market-room-sectors.ts)

建议只有双边证据一致时画“相对强弱轮动推断”箭头。线宽取来源题材占比下降百分点、目标题材占比上升百分点两者中的较小值，并在图例标注单位。仅一方价格变化时用涨幅柱表达。成交额记录成交规模，两端读数均未标识买卖双方账户或跨题材资金路径。[个股快照字段](https://fuyao.aicubes.cn/docs/api-reference/prices/)

主力资金接口 `/api/a-share/capital-flow/snapshot` 与 `/historical` **仅供同花顺 AI 客户端**。文档描述的是单只股票按订单规模统计的流入、流出、净额，历史支持分钟或日；即使有单股净额，也无法配对两个题材之间的资金。高频动向分时和市场成交额预测也限客户端；后者的 `predict_turnover` 指预测全天值。对外展示近 15 分钟的实际净流入或净流出，需要另有授权并定义口径的资金数据源。[主力资金](https://fuyao.aicubes.cn/docs/api-reference/capital-flow/) · [高频动向](https://fuyao.aicubes.cn/docs/api-reference/high-frequency/) · [成交额预测](https://fuyao.aicubes.cn/docs/api-reference/turnover-prediction/)

## 采样与限流

快照 `data.timestamp` 是该批次最新有效上游时间（毫秒，可能为 `null`）；各批和各股票未必同时更新。按上海交易时间记录源时间、实际采集时间及缺失项，保留最近一次成功值的原时间，回放只使用已采样帧。可缓存目录和成分名单，合并重复代码后分批请求。官方采用动态限流，HTTP 429 或信封 `code=4001` 均需降低并发、延后重试；文档未承诺固定刷新周期。[股票行情](https://fuyao.aicubes.cn/docs/api-reference/prices/) · [官方批量调用示例](https://fuyao.aicubes.cn/docs/mcp/overview/) · [接口总览](https://fuyao.aicubes.cn/docs/api-reference/overview/)
