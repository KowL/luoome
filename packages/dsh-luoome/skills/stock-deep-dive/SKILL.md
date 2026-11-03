---
name: stock-deep-dive
description: 个股深度研究——基于事实包与研究库输出可证伪的研究报告，必要时落为建议。
whenToUse: 用户点名某个标的问「这只票怎么样」「深度分析一下」时。
---

# stock-deep-dive

针对单个标的做深度研究。

本技能版本：stock-deep-dive-v1。

## 流程

1. 先取事实，再下结论：
   - `get_analysis_context` 取该标的的事实包（有 analysis context 时）；
   - 无 context 时用只读工具补齐：行情、指标、基本面评分、持仓与成本、该标的的既有建议与研究文档。
2. 研究检索：读研究库与已归档的研究文档，标明来源与时间；没有就明说没有，不要补记忆里的财报数字。
3. 输出结构固定五段：
   - **事实**：数字与 `dataAsOf`，逐位来自工具；
   - **反面证据**：最可能证伪多头逻辑的三条；
   - **结论**：方向性判断 + 适用条件；
   - **观察条件**：可证伪的价位、量能、失效条件；
   - **风险与有效期**：风险点、来源、有效期。
4. 需要落库时：
   - 只给观察计划、不构成建议 → 不写 Advice；
   - 明确形成建议 → 先向用户展示结论、反面证据、风险、有效期和准备写回的内容，得到用户明确确认；
     再用 `get_analysis_context` 取有效 context，并调用
     `record_advice` 写回。

## 多角色审查

- 用户要求多空与风控联合审查时，先取得同一份 `get_analysis_context` 快照。`run_triangle_analysis` 是 `external` 工具，另需 `queue` 能力；通过精确 Operation 确认执行，不自动或定时运行。
- 执行前列出四个角色各自的 provider/model、`estimatedTokenRange` 和 `estimatedDurationMs`，取得成本确认。缺少模型路由或调用能力时明确报告缺口。
- 该工具会向宿主模型服务发送四个独立、无工具权限的请求。`record_triangle_review` 仅校验并记录已有四角色输出，不代表执行了模型调用。
- 结果 `blocked` 非空时展示具体条件；风险官 veto 按账户与标的持续生效，重取 context 或新的 pass 都不解除。
- 人工推翻仅走宿主认证的人工入口，需明确原因以及否决之后新快照中的新 `factIds`；主 agent 不调用人工解除入口，也不自行声明人工身份。
- 用量没有 provider 实际报告时保留 `null`，不得用预估替代实耗。角色审查本身不写 Advice，建议写回仍按下述独立确认流程。

## 目标式长跑

- 用户明确要求持续研究到某个目标时，使用 `start_goal_run`；它是 `external`，同时需要 `write` 和 `external` 能力，经精确 Operation 执行，不定时自动启动。
- 明确 goal、kind/subject、provider/model、maxRounds（1–10），列出 estimatedTokens、estimatedDurationMs 与预算上限，取得成本确认后传 confirmed=true。单目标最多 15 分钟；每轮最多一次修订，每次模型请求没有工具权限。
- 用 `get_goal_run` 查询持久化进度；attempts 里 output 非空且 needsRevision=false 的记录才是该轮最终产出。每份产出必须引用同轮持久化 context 中的 factIds，并保留 dataAsOf。无效草稿和修订失败只作为审计，不算完成轮次。
- blocked 时逐字展示具体条件。轮次或预算耗尽表示目标尚未达成，不报告研究完成；provider 没有报告用量时保留 null，不用预估填充。
- 用户要求停止时调用 `cancel_goal_run`，保留已产出的证据。进程重启后可查历史和取消遗留状态，不自动重放模型请求。
- 长跑只保存研究进度，不写 Advice、策略或成交。需要建议写回时仍走下述独立流程；不把宿主 job 完成等同于研究目标达成。

## 写回确认

- 一次分析请求不是持久化授权：不得因为用户说了「分析一下」就自行落库。
- 用户确认前不调用任何 `record_advice` / `record_analysis_result`；只确认研究结论、没有确认写回时同样不写。
- 展示待写回内容至少包含：decision、confidence、horizon、有效期、核心论点、支持证据、
  反面证据、风险点与免责声明。
- 用户拒绝或只要看结论时不写库，也不保留待写草案。

## 写回约定

- `record_advice` 返回 `context_expired` 或 `stale_context` 时，必须先用
  `get_analysis_context` 重取事实包并重试一次；重试仍失败才向用户报告。
- 重取后要按新事实包重新核对数字，不要沿用旧事实包。
- 写回路径：`get_analysis_context` 落 `AnalysisContext` 审计快照，`record_advice` 落 `Advice`；
  两者都在 luoome 事实库，不经工作区文件。交互分析直接写回，不创建队列分析任务
  （插件形态没有 queue 生产者），也不要改用手动 worker 命名空间。

## 边界

- 事实包之外的信息不得作为证据；研究检索结果只作背景，不能替代事实包里的数字与 `factIds`。
- **买入建议必须给区间** `targetPositionPctRange: {min,max}`（百分点），且 `min < max`；
  `{10,10}` 这类点估计会被 `record_advice` 拒绝——真有把握就给紧区间（如 9.5–10.5），不要用点估计冒充区间。
  非买入 action（sell/hold/watch/avoid）可给单值 `targetPositionPct`（"清仓"就是 0）。
  区间会按 H4 纪律被系统对称收窄并记录 `rangeAdjustment`，超出上限不是错误，但收窄结果会在计划里可见。
- 缺口逐条引用 `missingFacts`（`kind` / `subjectId` / `reason` / `asOf`），不要只写自由文本；
  `kind` 是枚举值，`quote-unavailable` / `quote-stale` / `account-facts-unavailable` /
  `strategy-run-unavailable` 属「缺事实导致不可判」，其余（如 `news-unavailable`）属「部分缺但仍可判」。
  旧字段 `limitations` 仍原样展示，两者不要互相替代。
- 建议不等于成交，不得出现「已买入/已卖出」。
- 不要凭记忆报价格、涨跌幅、财报数字；取不到就直说取不到。
- 先给反面证据，再给结论，最后给可证伪的观察条件。
