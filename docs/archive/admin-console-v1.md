# 运营管理页面 v1（用户与订阅额度管理）

> **已归档（2026-10-23）**：本文描述的是已下线的多租户托管形态，当前形态是单机版（见 docs/ddd/luoome-dsh-transformation-detailed-design.md 的 D9–D12）。仅作历史留存，不是当前行为说明。

> 状态：设计与实现；2026-10-15。
> 关联：[订阅定价 v1](./subscription-pricing-v1.md)、[支付渠道调研](./payment-channel-research.md)、[运行手册](./hosted-personal-subscription-runbook.md)。
> 约束：[CONTEXT](../../CONTEXT.md)、[SECURITY](../SECURITY.md)、[AGENTS](../../AGENTS.md)。

## 1. 目标与范围

在真实支付渠道上线前，运营需要能看见用户、看见额度、并能人工开通服务期。
本版交付一个登录 Web 内的管理页面（`#admin`），只读视图 + 两个写操作：

| 能力 | 说明 |
|---|---|
| 用户列表 | 邮箱、用户状态、注册时间、租户状态、当前服务期与到期时间、套餐、可用研究额度 |
| 用户详情 | 服务期历史、订单记录、近期用量流水 |
| 标记收款 / 赠送服务期 | 运营确认线下收款（或赠送）后，创建 `operator-manual` 订单并落已核实支付事实，服务期按既有支付管线语义顺延授予 |
| 停用 / 启用用户 | `active ↔ disabled`；`deleted` 为终态不可改 |

**不做**：按用户覆盖套餐额度（limits 属于不可变 PlanVersion，调额度 = 发布新套餐 + 授予服务期，
沿用现有 worker 路径）、退款（等真实支付渠道）、租户删除（已有独立删除管线与屏障）。

## 2. 身份与授权

- 管理员由服务配置 `HOSTED_ADMIN_EMAILS`（逗号分隔邮箱，小写规范化）声明；默认空 = 无管理员，管理路由不可用。
- 管理员仍是已登录用户：会话解析不变，`/api/admin/*` 路由在会话之上校验 emailKey 命中管理员名单，
  然后构造新的 principal kind `admin`（`{ userId, requestId, ipKey }`）。
- 平台工具新增 `actors: ['admin']` 的管理员工具；`user`/`worker`/`webhook` 不能调用，泛化 invoke 不暴露。
- 前端入口按 `/api/me` 返回的 `admin: true` 显示"管理"导航；非管理员直接访问 `#admin` 收到 403 提示。
- 停用用户后，其会话在既有 `resolveAuthSession` 校验下失效（用户状态非 active 拒绝），管理操作不受影响。

## 3. 平台工具（新增 `packages/tools/src/platform/admin.ts`）

| 工具 | sideEffect | 输入 | 输出 |
|---|---|---|---|
| `list_hosted_users` | read | `{ limit? }` | 用户 + 租户 + 当前权益（服务期/套餐/可用额度）数组 |
| `get_hosted_user_detail` | read | `{ tenantId }` | 用户、租户、全部服务期、订单、近 20 条用量 |
| `record_hosted_operator_payment` | write | `{ tenantId, planVersionId, amountMinor, reference, requestId }` | `{ order, period, event, replayed }` |
| `set_hosted_user_status` | write | `{ userId, status }` | 更新后的用户 |

### 3.1 标记收款 / 赠送的领域语义

不走 `HostedPaymentPort`（支付 provider 未装配时也必须可用），直接复用支付仓储管线：

1. `payments.createOrder`：`provider='operator-manual'`、`merchantId='operator'`、`merchantOrderId` 稳定派生、
   `providerCreateState='accepted'`（无外部请求）、`reconciliation='none'`、金额取运营实收（赠送为 0）。
2. `payments.applyVerifiedPaymentEvent`：落一条 `kind='paid'` 的已核实支付事实，
   `providerTransactionId=reference`（运营填写的收款凭证/说明，必填，可追溯）。
3. 服务期按既有语义授予：从该租户当前最新有效服务期的 `endsAt` 顺延，按套餐 `durationMonths` 与 anchorDay 计算。

这样赠送/人工收款与未来的真实 webhook 收款走**同一条审计与对账路径**，订单/支付事实/服务期账目完整可查；
worker 的支付对账轮询不会捞这些订单（状态直接 paid 且 reconciliation=none）。
`requestId` 幂等：同一 requestId 重复提交返回原订单，不重复授予。

### 3.2 用户状态变更

仓储新增 `auth.setUserStatus({ userId, status, now })`：仅允许 `active ↔ disabled`，`deleted` 终态不可变更；
drizzle 与 memory 双实现 + contract test。停用即阻断登录与会话解析（既有 active 校验），不删除任何数据。

## 4. 服务端与前端

- 配置：`hosted-config.ts` 增加 `adminEmails`（来源 `HOSTED_ADMIN_EMAILS`）；compose/运行手册同步。
- 路由（`hosted-server.ts`）：`GET /api/admin/users`、`GET /api/admin/users/:tenantId`、
  `POST /api/admin/users/:tenantId/operator-payments`、`POST /api/admin/users/:userId/status`。
  全部要求会话 + 管理员 emailKey + CSRF（沿用现有 mutation 中间件）。
- 前端：`hosted-admin.js` 新页面模块，`#admin` 路由；表格 + 行展开详情 + 操作表单；
  复用现有 `callApi`、样式类与 `hosted-settings.js` 的模式。导航"管理"项仅管理员可见。

## 5. 验收

- 非管理员/匿名访问四个路由一律 403/401；管理员名单大小写与空白规范化。
- 标记收款：订单 paid、服务期顺延正确（试用中标记 → 从试用结束顺延；已到期 → 从现在开始）；
  重复 requestId 返回原订单不重复授予；赠送（0 元）同样授予服务期。
- 停用用户后其会话立即失效；启用后恢复；deleted 用户不可变更。
- `bun run test:web` / `test:db` / `typecheck` / `lint` 通过；浏览器实际验证管理页列表、标记收款、停用全流程。
