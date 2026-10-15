import { z } from 'zod';
import { HostedQuietHoursSchema } from '../hosted/notification.js';
import { DeliveryIntentSchema } from '../hosted/platform.js';
import type { AlertPlan } from './alert-plan.js';
import type { WatchTrigger } from './watch-trigger.js';
import type { Watchlist, WatchlistMember } from './watchlist.js';

/**
 * 通知（v0.3 起，ARCHITECTURE §5.1 扩字段 + plan-v0.2-v0.3 §2.5）。
 *
 * 设计要点：
 * - v0.3 只支持 feishu + log 两个 channel；email / wecom / slack 留 v0.4+。
 * - Notification 走持久化（notification 表）：审计 + 重试 + 失败排查。
 * - payload 是 discriminated union（按 channel 走不同 schema），但都含 title / content。
 *
 * 副作用等级：external（HTTP 调用第三方）。MCP 默认 opt-in 暴露。
 */

export type NotificationChannel = 'feishu' | 'log';

export const NotificationChannelSchema = z.enum(['feishu', 'log']);

export type NotificationLevel = 'info' | 'warn' | 'error' | 'success';

export const NotificationLevelSchema = z.enum(['info', 'warn', 'error', 'success']);

/** feishu payload：title + markdown content + 可选 atMobiles（@手机号）。 */
export const FeishuPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
  /** @ 的手机号列表（飞书卡片支持）；缺省不 @。 */
  atMobiles: z.array(z.string()).optional(),
});

/** log payload：title + content + level，logger.info / warn / error 自动按 level 路由。 */
export const LogPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
});

/** 联合 payload schema（按 channel 走对应 schema）。 */
export const NotificationPayloadSchema = z.union([FeishuPayloadSchema, LogPayloadSchema]);

export type FeishuPayload = z.infer<typeof FeishuPayloadSchema>;
export type LogPayload = z.infer<typeof LogPayloadSchema>;
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/** 发送结果（落库时用）。 */
export type NotificationResult = 'success' | 'failed' | 'suppressed';

export const NotificationResultSchema = z.enum(['success', 'failed', 'suppressed']);

/**
 * Notification 实体（v0.3 起；notification 表的 row）。
 * 关联字段（adviceId / tacticSignalId）是软关联（不强 FK），允许 null。
 */
export interface Notification {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly payload: NotificationPayload;
  readonly result: NotificationResult;
  /** 失败原因（result=failed 时必填）。 */
  readonly errorMessage?: string;
  /** 软关联：被通知的 Advice id（高信心度建议推送场景）。 */
  readonly adviceId?: string;
  /** 软关联：被通知的信号 id（列名为历史遗留；旧值为 TacticSignal id，新值为 StrategySignal / WatchTrigger id）。 */
  readonly tacticSignalId?: string;
  readonly sentAt: Date;
}

export const NotificationSchema = z.object({
  id: z.string().min(1),
  channel: NotificationChannelSchema,
  payload: NotificationPayloadSchema,
  result: NotificationResultSchema,
  errorMessage: z.string().optional(),
  adviceId: z.string().optional(),
  tacticSignalId: z.string().optional(),
  sentAt: z.coerce.date(),
});

export const FeishuWebhookUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'open.feishu.cn' &&
      /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, '仅支持飞书自定义机器人的 HTTPS Webhook');

export const WatchNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  webhookUrl: FeishuWebhookUrlSchema.nullable(),
  quietHours: HostedQuietHoursSchema,
  revision: z.number().int().nonnegative(),
  bindingVersion: z.number().int().positive(),
});
export type WatchNotificationSettings = z.infer<typeof WatchNotificationSettingsSchema>;
export const defaultWatchNotificationSettings = (): WatchNotificationSettings => ({
  enabled: true,
  webhookUrl: null,
  revision: 0,
  bindingVersion: 1,
  quietHours: { enabled: false, startMinutes: 1320, endMinutes: 480, timeZone: 'Asia/Shanghai' },
});

export const WatchDeliveryIntentSchema = DeliveryIntentSchema.omit({ channel: true }).extend({
  channel: z.literal('feishu'),
  executionOwner: z.string().min(1),
  notificationId: z.string().nullable(),
});
export type WatchDeliveryIntent = z.infer<typeof WatchDeliveryIntentSchema>;
export const isWatchAlertDeliveryEligible = (
  trigger: WatchTrigger,
  plan: Pick<AlertPlan, 'enabled' | 'logic' | 'rules'> | null | undefined,
  watchlist: Pick<Watchlist, 'enabled'> | null | undefined,
  member: Pick<WatchlistMember, 'stage'> | null | undefined,
): boolean =>
  plan?.enabled === true &&
  (trigger.ruleId === 'composite'
    ? plan.logic === 'ALL'
    : plan.rules.some((rule) => rule.id === trigger.ruleId)) &&
  watchlist?.enabled === true &&
  member !== null &&
  member !== undefined &&
  member.stage !== 'archived';

export interface WatchDeliveryRepository {
  settings(): Promise<WatchNotificationSettings>;
  saveSettings(input: {
    expectedRevision: number;
    enabled: boolean;
    webhookUrl: string | null;
    quietHours: WatchNotificationSettings['quietHours'];
    now: Date;
  }): Promise<WatchNotificationSettings>;
  prepare(input: {
    owner: string;
    tenantId: string;
    generation: number;
    triggerIds: readonly string[];
    now: Date;
  }): Promise<boolean>;
  claim(input: {
    owner: string;
    attemptId: string;
    triggerIds: readonly string[];
    now: Date;
  }): Promise<readonly WatchDeliveryIntent[] | null>;
  complete(input: {
    owner: string;
    attemptId: string;
    triggerIds: readonly string[];
    state: 'accepted' | 'failed' | 'unknown' | 'suppressed';
    notificationId: string;
    errorKind: string | null;
    now: Date;
  }): Promise<boolean>;
  recover(owner: string, now: Date): Promise<readonly WatchDeliveryIntent[]>;
  suppressPending(reason: string, now: Date): Promise<number>;
  list(): Promise<readonly WatchDeliveryIntent[]>;
}

// ---------- 不变量 ----------

export const assertNotificationInvariants = (n: Notification): void => {
  if (n.result === 'failed' && (n.errorMessage === undefined || n.errorMessage === '')) {
    throw new Error('result=failed 时 errorMessage 必填');
  }
  // payload 与 channel 必须匹配：feishu 走 feishu schema（@mobiles 可选），log 走 log schema
  // （zod union parse 已保证，这里再做运行时兜底）
  if (n.channel === 'feishu' && 'atMobiles' in n.payload && n.payload.atMobiles !== undefined) {
    for (const m of n.payload.atMobiles) {
      if (!/^1\d{10}$/.test(m)) {
        throw new Error(`atMobiles 必须是 11 位手机号: ${m}`);
      }
    }
  }
};

// ---------- 默认配置常量 ----------

/** LUOOME_FEISHU_WEBHOOK_URL 未配置时降级为 log channel。 */
export const DEFAULT_NOTIFICATION_CHANNEL: NotificationChannel = 'log';

/** 飞书卡片标题前缀（与 app 关联，方便用户在飞书群里辨认来源）。 */
export const NOTIFICATION_BRAND = 'luoome';

/** 通知只展示阅读摘要；内部身份仍保留在 Advice/Trigger/Report 的结构化引用中。 */
const notificationPartFilter =
  /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}|(?:StrategyResult|StrategySignal|SignalObservation)\s+(?!evidence)|(?:selected|rank|score|direction)=)/i;

const cleanNotificationPart = (part: string): string =>
  part
    .replace(/^(?:StrategyResult evidence:|evidence[=:])\s*/i, '')
    .replace(/-?\d+\.\d{3,}/g, (value) => String(Number(Number(value).toFixed(2))))
    .replace(/[*_`<>[\]]/g, '')
    .trim();

/**
 * 分段摘要：超出 limit 时优先保留完整分段，而不是在句子中间截断
 * （例：反证/风险按「；」写多条，截断后不能出现半句 `…bollPosition20=0…`）。
 * 单段本身就超限时才退化为按字数硬截断。
 */
export const notificationText = (text: string, limit = 120): string => {
  const parts = text
    .split(/[；;\n]+/)
    .filter((part) => !notificationPartFilter.test(part))
    .map(cleanNotificationPart)
    .filter((part) => part.length > 0);
  const clean = parts.join('；');
  if (clean.length <= limit) return clean;
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const next = kept.length === 0 ? part.length : length + 1 + part.length;
    if (next > limit) break;
    kept.push(part);
    length = next;
  }
  const joined = kept.join('；');
  return joined.length > 0 ? joined : `${clean.slice(0, limit - 1)}…`;
};

export const notificationTime = (date: Date): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
