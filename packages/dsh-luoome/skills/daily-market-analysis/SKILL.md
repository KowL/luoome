---
name: daily-market-analysis
description: 用精确的市场 external 白名单刷新指数、市场宽度、情绪、要闻与行情状态，结合本地持仓与关注给出带来源、缺口和有效期的每日市场分析。
whenToUse: 用户问「今天市场怎么样」「给我今日分析」「盘面有什么变化」时。
---

# daily-market-analysis

每日市场分析先刷新真实市场事实，再结合个人上下文解释；事实、推断和缺口必须分开呈现。

本技能版本：daily-market-analysis-v1。

## 流程

1. **刷新市场事实**（只用当前已注册的工具：精确市场刷新面负责外部抓取，只读面负责本地事实；未注册或不可用就明说取不到，不绕路、不用模型记忆补）：
   - 指数：`fetch_index_quotes`；
   - 市场宽度与情绪：`get_ashare_sentiment`；
   - 要闻：`fetch_news`（只读工具；若当前面未注册，明确说明要闻不可用，不编造标题）；
   - 个股或持仓行情（仅场景需要时）：`fetch_quote`、`batch_quote`；
   - 数据健康与本地市场事实：`get_market_data_status`、`get_previous_closes`、`limit_up_ladder`、`dragon_tiger_list`、`northbound_flow`。
2. **每项保留来源与时间**：source、observedAt 或 dataAsOf、完整性、unavailable 或 partial 的原因。工具失败按 ToolResult 如实展示，不把 external 失败包装成空数据成功。
3. **读个人上下文**（只读，不用它推断全市场）：`list_holdings`、`get_account_facts`、`list_watchlists`、`list_watch_triggers`、`list_strategies`、`get_advice`。
4. **输出结构**：事实（逐项带 dataAsOf 与来源）、反面证据、风险、未知与缺口、有效期。有限样本只代表样本，不代表全市场；没有新闻或宽度数据就写 unavailable，不编造。
5. **日常分析留在会话**：MVP 不伪造 Report，不调用报告保存工具，不自动通知、不自动调度。
6. **若要落成 Advice**：
   - 先展示结论、反面证据、风险、有效期与将写回的内容，得到用户明确同意；一次分析请求不等于持久化授权；
   - 用 `get_analysis_context` 取 advice_market 的有效 context，subject 取 market（以工具 input schema 为准）；
   - context 缺少市场事实、或遇到 context_expired、stale_context 时：先刷新外部事实，再重取一次并逐项重新核对；仍不可用就明确告知用户当前无法落库，不重放旧结论、不把旧数据当新事实；
   - 经 DSH 原生确认操作 `luoome_confirmed_operation` 的 `record_advice` policy 提交冻结的 contextId、result 与 provenance；evidenceFactIds 只能落在 context.factIds 内；
   - provenance 使用真实生成信息：generatorKind 取 dsh-chat，skillVersion 取本技能版本，model 只在宿主提供真实标识时填写，未知就省略；生成时间由领域工具填写，不自行编造。

## 审批与授权纪律

- 写入 Advice 必须经 DSH 原生审批；模型不得自报 approved、callId、taskId 或 prompt 文本作为授权。
- 用户拒绝、取消、超时或切换账户时视为未执行，不重试写入。
- 审批后响应丢失：查询操作状态与业务回执核对，不重复推理、不重复写库。

## 边界

- 不把有限样本推断成全市场事实；数据缺失保留 unavailable，不做「看起来正常」的填充。
- 建议不等于交易；不承诺收益，不提供下单入口。
- 不调用 trade 能力；不自动创建 schedule、不自动发送通知。
- 不编造新闻、指数、情绪或行情数字，也不编造模型标识与生成时间。
