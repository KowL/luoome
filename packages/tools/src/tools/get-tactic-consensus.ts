import { TacticSignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { dateInShanghai, isGroupStale } from '../internal/stock-group.js';

export const GetTacticConsensusInput = z.object({
  groupIds: z.array(z.string().min(1)).max(100).optional(),
  marketDate: z.string().date().optional(),
  minGroups: z.number().int().min(2).max(100).default(2),
  topN: z.number().int().min(1).max(100).default(20),
});

const ConsensusGroup = z.object({
  groupId: z.string(),
  refreshId: z.string(),
  dataAsOf: z.coerce.date(),
});

const ExcludedGroup = z.object({
  groupId: z.string(),
  reason: z.enum(['stale', 'different-market-date', 'unknown-coverage', 'failed']),
});

export const GetTacticConsensusOutput = z.object({
  marketDate: z.string().date(),
  dataAsOf: z.coerce.date(),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  groups: z.array(ConsensusGroup),
  matches: z.array(
    z.object({
      stockId: z.string(),
      rankScore: z.number().min(0).max(100),
      supportingSignals: z.array(TacticSignalSchema),
      opposingSignals: z.array(TacticSignalSchema),
      groupIds: z.array(z.string()),
    }),
  ),
  excludedGroups: z.array(ExcludedGroup),
});

type ExcludedReason = z.infer<typeof ExcludedGroup>['reason'];
type Signal = z.infer<typeof TacticSignalSchema>;

interface EligibleGroup {
  readonly groupId: string;
  readonly refreshId: string;
  readonly marketDate: string;
  readonly dataAsOf: Date;
  readonly members: readonly {
    readonly stockId: string;
    readonly signal: Signal;
  }[];
}

const clampScore = (value: number): number =>
  Math.round(Math.max(0, Math.min(100, value)) * 10_000) / 10_000;

export const getTacticConsensusTool = defineTool({
  name: 'get_tactic_consensus',
  description:
    '聚合同一交易日、同一沪深 A 股 coverage 的公式分组持久信号；排序分不表示胜率或置信度',
  sideEffect: 'read',
  input: GetTacticConsensusInput,
  output: GetTacticConsensusOutput,
  handler: async (input, ctx) => {
    const groups =
      input.groupIds === undefined
        ? (await ctx.repos.stockGroup.list(true)).filter(
            (group) => group.resolver.kind === 'formula',
          )
        : await Promise.all(
            [...new Set(input.groupIds)].map(async (groupId) => {
              const group = await ctx.repos.stockGroup.findById(groupId);
              if (group === null) return errNotFound('StockGroup', groupId);
              return group;
            }),
          );
    const missing = groups.find((group) => 'ok' in group);
    if (missing !== undefined && 'ok' in missing) return missing;

    const formulaGroups = groups.filter(
      (group) => !('ok' in group) && group.enabled && group.resolver.kind === 'formula',
    );
    const excludedGroups: Array<{ groupId: string; reason: ExcludedReason }> = [];
    const eligible: EligibleGroup[] = [];

    for (const group of formulaGroups) {
      if ('ok' in group || group.resolver.kind !== 'formula') continue;
      const members = await ctx.repos.groupMember.currentMembers(group.id);
      const latestRefreshAt = members[0]?.createdAt ?? null;
      if (latestRefreshAt === null) {
        excludedGroups.push({ groupId: group.id, reason: 'failed' });
        continue;
      }
      if (isGroupStale(group, latestRefreshAt, ctx.clock())) {
        excludedGroups.push({ groupId: group.id, reason: 'stale' });
        continue;
      }
      const tacticId = group.resolver.tacticId;
      if (
        members.some(
          (member) =>
            member.dataAsOf === undefined ||
            member.tacticSignalRef === undefined ||
            member.tacticSignalRef.tacticId !== tacticId,
        )
      ) {
        excludedGroups.push({ groupId: group.id, reason: 'unknown-coverage' });
        continue;
      }
      const dates = new Set(members.map((member) => dateInShanghai(member.dataAsOf as Date)));
      if (dates.size !== 1) {
        excludedGroups.push({ groupId: group.id, reason: 'unknown-coverage' });
        continue;
      }
      const persisted = await ctx.repos.tactic.signalsByTactic(tacticId);
      const memberSignals: Array<{ stockId: string; signal: Signal }> = [];
      let failed = false;
      for (const member of members) {
        const ref = member.tacticSignalRef;
        if (ref === undefined) {
          failed = true;
          break;
        }
        const signal = persisted.find(
          (item) =>
            item.stockId === member.stockId &&
            item.tacticId === ref.tacticId &&
            item.ts.getTime() === ref.ts.getTime(),
        );
        if (signal === undefined) {
          failed = true;
          break;
        }
        memberSignals.push({ stockId: member.stockId, signal: TacticSignalSchema.parse(signal) });
      }
      if (failed) {
        excludedGroups.push({ groupId: group.id, reason: 'failed' });
        continue;
      }
      const dataAsOf = new Date(
        Math.min(...members.map((member) => (member.dataAsOf as Date).getTime())),
      );
      eligible.push({
        groupId: group.id,
        refreshId: members[0]?.refreshId as string,
        marketDate: [...dates][0] as string,
        dataAsOf,
        members: memberSignals,
      });
    }

    const marketDate =
      input.marketDate ??
      eligible.map((group) => group.marketDate).sort((a, b) => b.localeCompare(a))[0];
    if (marketDate === undefined) {
      return errInvalidInput('没有可用于共振的同日公式分组快照');
    }
    const included = eligible.filter((group) => group.marketDate === marketDate);
    for (const group of eligible) {
      if (group.marketDate !== marketDate) {
        excludedGroups.push({ groupId: group.groupId, reason: 'different-market-date' });
      }
    }
    if (included.length === 0) {
      return errInvalidInput(`marketDate=${marketDate} 没有可用公式分组快照`);
    }

    const byStock = new Map<string, Array<{ readonly groupId: string; readonly signal: Signal }>>();
    for (const group of included) {
      for (const member of group.members) {
        const signals = byStock.get(member.stockId) ?? [];
        signals.push({ groupId: group.groupId, signal: member.signal });
        byStock.set(member.stockId, signals);
      }
    }
    const matches = [...byStock.entries()]
      .map(([stockId, entries]) => {
        const supporting = entries.filter((entry) => entry.signal.direction !== 'bearish');
        const opposing = entries.filter((entry) => entry.signal.direction === 'bearish');
        const supportingGroups = new Set(supporting.map((entry) => entry.groupId));
        if (supportingGroups.size < input.minGroups) return null;
        const supportAverage =
          supporting.reduce((total, entry) => total + entry.signal.score, 0) / supporting.length;
        const oppositionAverage =
          opposing.length === 0
            ? 0
            : opposing.reduce((total, entry) => total + entry.signal.score, 0) / opposing.length;
        const resonanceBonus = Math.min(15, (supportingGroups.size - 1) * 5);
        return {
          stockId,
          rankScore: clampScore(supportAverage - oppositionAverage * 0.5 + resonanceBonus),
          supportingSignals: supporting.map((entry) => entry.signal),
          opposingSignals: opposing.map((entry) => entry.signal),
          groupIds: [...new Set(entries.map((entry) => entry.groupId))].sort(),
        };
      })
      .filter((match): match is NonNullable<typeof match> => match !== null)
      .sort((a, b) => b.rankScore - a.rankScore || a.stockId.localeCompare(b.stockId))
      .slice(0, input.topN);

    return {
      marketDate,
      dataAsOf: new Date(Math.min(...included.map((group) => group.dataAsOf.getTime()))),
      coverage: 'CN_A_SHARES_SH_SZ' as const,
      groups: included
        .map(({ groupId, refreshId, dataAsOf }) => ({ groupId, refreshId, dataAsOf }))
        .sort((a, b) => a.groupId.localeCompare(b.groupId)),
      matches,
      excludedGroups: excludedGroups.sort((a, b) => a.groupId.localeCompare(b.groupId)),
    };
  },
});
