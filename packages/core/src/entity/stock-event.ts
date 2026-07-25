import { z } from 'zod';

import { InvariantError } from '../error/index.js';

/**
 * 公司事件（ruo 能力迁移 Phase 1B，docs/ddd/ruo-feature-migration-detailed-design.md §3.2）。
 *
 * 事实层：财报 / 解禁 / 分红 / 股东大会 / 公告 / 手工事件。与 ResearchNote（观点）解耦。
 *
 * - source='external' → provider / externalId 必填；(provider, externalId) 唯一（幂等 upsert）。
 * - source='manual' → provider / externalId 为空（SQLite 唯一索引天然放行多 NULL）。
 * - allDay=true 的 occursAt 统一存 Asia/Shanghai 当日 00:00，比较只按日期部分。
 * - provider 抓取失败保留旧数据时置 stale=true（数据可能过期）。
 */

export const StockEventKindSchema = z.enum([
  'earnings',
  'unlock',
  'dividend',
  'shareholder-meeting',
  'announcement',
  'manual',
]);
export type StockEventKind = z.infer<typeof StockEventKindSchema>;

export const EventImportanceSchema = z.enum(['urgent', 'important', 'normal']);
export type EventImportance = z.infer<typeof EventImportanceSchema>;

export const StockEventStatusSchema = z.enum(['scheduled', 'occurred', 'cancelled']);
export type StockEventStatus = z.infer<typeof StockEventStatusSchema>;

export const StockEventSourceSchema = z.enum(['manual', 'external']);
export type StockEventSource = z.infer<typeof StockEventSourceSchema>;

export const StockEventSchema = z.object({
  /** evt_${uuid8}。 */
  id: z.string().min(1),
  stockId: z.string().min(1),
  kind: StockEventKindSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  occursAt: z.coerce.date(),
  allDay: z.boolean().default(true),
  importance: EventImportanceSchema,
  status: StockEventStatusSchema.default('scheduled'),
  source: StockEventSourceSchema,
  provider: z.string().optional(),
  externalId: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  /** 事件实际对应时间（≠ 抓取时间）。 */
  observedAt: z.coerce.date().optional(),
  fetchedAt: z.coerce.date().optional(),
  /** provider 失败后保留旧数据时置 true。 */
  stale: z.boolean().default(false),
  /** 事件级提醒窗口（天）；空数组 = 用规则默认。 */
  remindBeforeDays: z.array(z.number().int().min(0).max(90)).max(8).default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type StockEvent = z.infer<typeof StockEventSchema>;

/**
 * 公司事件不变量（docs/.../§3.2）。
 *
 * - source='external' → provider / externalId 必填（唯一约束的组成）
 * - updatedAt ≥ createdAt
 */
export const assertStockEventInvariants = (event: StockEvent): void => {
  if (event.updatedAt.getTime() < event.createdAt.getTime()) {
    throw new InvariantError('stock event updatedAt < createdAt');
  }
  if (event.source === 'external') {
    if (event.provider === undefined || event.provider.length === 0) {
      throw new InvariantError('external 事件必须有 provider');
    }
    if (event.externalId === undefined || event.externalId.length === 0) {
      throw new InvariantError('external 事件必须有 externalId');
    }
  }
};

/** 事件重要性 → 告警优先级（urgent→urgent / important→important / normal→normal）。 */
export const eventImportanceToPriority = (
  importance: EventImportance,
): 'urgent' | 'important' | 'normal' => importance;
