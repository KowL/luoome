import {
  type AShareSentimentSnapshot,
  AShareSentimentSnapshotSchema,
  assertAShareSentimentSnapshotInvariants,
  type DataProvenance,
  dateInShanghai,
  type IndexQuote,
  investmentMarketEvidenceValidUntil,
  isHoliday,
  isInvestmentMarketEvidenceCurrent,
  isWeekend,
  type MarketInvestmentDirection,
  type MarketInvestmentEvidence,
  previousTradingDate,
  type ToolContext,
} from '@luoome/core';
import { fetchIndexQuotesTool } from '../tools/fetch-index-quotes.js';
import { getAShareSentimentTool } from '../tools/get-ashare-sentiment.js';

export interface InvestmentMarketProposal {
  readonly id: string;
  readonly name: string;
  readonly source: MarketInvestmentDirection['source'];
  readonly coverage: MarketInvestmentDirection['coverage'];
  readonly evidenceIds: readonly string[];
  readonly dataAsOf: Date;
  readonly validUntil: Date;
}

const CN_INDEX_CODES = new Set([
  '000001',
  '399001',
  '399006',
  '000300',
  '000688',
  '000016',
  '399005',
]);

// 现有 Eastmoney 指数 ts 是抓取时间；只有显式上游时间或已核对的 Tencent 上游 ts 可作事实时点。
const indexObservedAt = (quote: IndexQuote): Date | undefined =>
  quote.timestampSource === 'upstream'
    ? (quote.observedAt ?? quote.ts)
    : quote.timestampSource === undefined && quote.source === 'tencent'
      ? quote.ts
      : undefined;
const unavailable = (now: Date, provider: string) => ({
  status: 'unavailable' as const,
  provenance: [
    {
      provider,
      observedAt: now,
      fetchedAt: now,
      freshness: 'unavailable' as const,
      errorKind: 'not_available',
    },
  ],
  warnings: ['source-unavailable'],
});

const cleanProvenance = (provenance: readonly DataProvenance[]): DataProvenance[] =>
  provenance.map(({ errorMessage: _message, ...value }) => value);

export const collectInvestmentMarketFacts = async (
  ctx: ToolContext,
): Promise<{
  readonly marketSnapshot: { readonly id: string; readonly snapshot: AShareSentimentSnapshot };
  readonly proposals: readonly InvestmentMarketProposal[];
  readonly evidence: readonly MarketInvestmentEvidence[];
  readonly limitations: readonly string[];
}> => {
  let now = ctx.clock();
  const today = dateInShanghai(now);
  const date =
    isWeekend(now) || isHoliday(now) || now < new Date(`${today}T09:30:00+08:00`)
      ? previousTradingDate(now)
      : today;
  const limitations = [
    '市场方向依据可核验的广度、指数或情绪事实，不要求预设策略；不是全市场个股机会排名。',
    '未核验新闻、公告、政策催化与财务PIT；不从板块名称推断公司受益或个股归属。',
    '涨停/炸板池行业分布只代表该事件池，不代表完整行业板块行情或可跟踪股票池。',
  ];
  let snapshot: AShareSentimentSnapshot | undefined;
  if (ctx.ashareSentiment !== undefined) {
    const result = await getAShareSentimentTool.execute({ date }, ctx);
    if (result.ok) snapshot = result.data.snapshot;
    else limitations.push('情绪快照读取失败，保留其它可用维度；没有催化判断。');
  } else limitations.push('未装配情绪 manager；只研究其它时间合格的市场事实。');
  if (snapshot !== undefined && snapshot.date !== date) {
    snapshot = undefined;
    limitations.push('情绪快照交易日与本次研究不符，未作为依据。');
  }
  if (snapshot === undefined) {
    const result = await fetchIndexQuotesTool.execute({}, ctx);
    now = ctx.clock();
    const rows = result.ok
      ? result.data.indices.flatMap((quote) => {
          const at = indexObservedAt(quote);
          return at !== undefined && dateInShanghai(at) === date && CN_INDEX_CODES.has(quote.code)
            ? [{ quote, at }]
            : [];
        })
      : [];
    const values = rows.map((row) => row.quote);
    snapshot = AShareSentimentSnapshotSchema.parse({
      date,
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf:
        rows.length === 0 ? now : new Date(Math.min(...rows.map((row) => row.at.getTime()))),
      indexes:
        values.length === 0
          ? unavailable(now, 'market-index')
          : {
              status: 'partial',
              values,
              provenance: rows.map(({ quote, at }) => ({
                provider: quote.source,
                observedAt: at,
                fetchedAt: now,
                freshness: 'fresh',
              })),
              warnings: ['only-returned-cn-equity-indexes'],
            },
      breadth: unavailable(now, 'market-breadth'),
      limitUp: unavailable(now, 'limit-up-pools'),
      themes: unavailable(now, 'pool-industries'),
    });
  }
  now = ctx.clock();
  assertAShareSentimentSnapshotInvariants(snapshot);
  const qualifiedIndexes = (snapshot.indexes.values ?? []).flatMap((quote) => {
    const at = indexObservedAt(quote);
    return CN_INDEX_CODES.has(quote.code) &&
      at !== undefined &&
      dateInShanghai(at) === date &&
      isInvestmentMarketEvidenceCurrent(at, now) &&
      (quote.fetchedAt === undefined || quote.fetchedAt <= now)
      ? [{ quote, at }]
      : [];
  });
  snapshot = {
    ...snapshot,
    indexes:
      qualifiedIndexes.length === 0
        ? unavailable(now, 'market-index-observation-time-unavailable')
        : {
            status: 'partial',
            values: qualifiedIndexes.map((row) => row.quote),
            provenance: qualifiedIndexes.map(({ quote, at }) => ({
              provider: quote.source,
              observedAt: at,
              fetchedAt: quote.fetchedAt ?? now,
              freshness: 'fresh',
            })),
            warnings: ['only-qualified-returned-cn-equity-indexes'],
          },
  };
  // 成功响应中的供应商诊断也可能包含 URL；保留状态/错误码，不把诊断原文存为私人研究证据。
  snapshot = {
    ...snapshot,
    indexes: {
      ...snapshot.indexes,
      provenance: cleanProvenance(snapshot.indexes.provenance),
      warnings: snapshot.indexes.warnings.length ? ['source-warning-present'] : [],
    },
    breadth: {
      ...snapshot.breadth,
      provenance: cleanProvenance(snapshot.breadth.provenance),
      warnings: snapshot.breadth.warnings.length ? ['source-warning-present'] : [],
    },
    limitUp: {
      ...snapshot.limitUp,
      provenance: cleanProvenance(snapshot.limitUp.provenance),
      warnings: snapshot.limitUp.warnings.length ? ['source-warning-present'] : [],
    },
    themes: {
      ...snapshot.themes,
      provenance: cleanProvenance(snapshot.themes.provenance),
      warnings: snapshot.themes.warnings.length ? ['source-warning-present'] : [],
    },
  };
  const id = `market-snapshot-${globalThis.crypto.randomUUID()}`;
  const evidence: MarketInvestmentEvidence[] = [];
  const proposals: InvestmentMarketProposal[] = [];
  const qualify = (
    label: string,
    dimension: { status: string; provenance: readonly DataProvenance[] },
  ): DataProvenance[] | null => {
    if (
      dimension.status === 'unavailable' ||
      dimension.provenance.length === 0 ||
      dimension.provenance.some(
        (item) =>
          item.freshness !== 'fresh' ||
          dateInShanghai(item.observedAt) !== date ||
          !isInvestmentMarketEvidenceCurrent(item.observedAt, now) ||
          item.fetchedAt > now,
      )
    ) {
      limitations.push(`${label}：缺失、时间未知、过期或跨交易日，不作为本次方向依据。`);
      return null;
    }
    return [...dimension.provenance];
  };
  const add = (input: {
    subject: string;
    name: string;
    kind: MarketInvestmentEvidence['kind'];
    text: string;
    value: Record<string, unknown>;
    provenance: DataProvenance[];
    coverage: MarketInvestmentDirection['coverage'];
  }) => {
    const dataAsOf = new Date(
      Math.min(...input.provenance.map((item) => item.observedAt.getTime())),
    );
    const source = { kind: 'market-snapshot' as const, snapshotId: id, subject: input.subject };
    const factId = `${id}:${input.subject}`;
    evidence.push({
      id: factId,
      source,
      kind: input.kind,
      text: input.text,
      value: input.value,
      provenance: input.provenance,
      dataAsOf,
    });
    proposals.push({
      id: input.subject,
      name: input.name,
      source,
      coverage: input.coverage,
      evidenceIds: [factId],
      dataAsOf,
      validUntil: investmentMarketEvidenceValidUntil(dataAsOf),
    });
  };
  const breadthProvenance = qualify('市场广度', snapshot.breadth);
  if (breadthProvenance !== null && snapshot.breadth.value !== undefined) {
    const value = snapshot.breadth.value;
    const complete = snapshot.breadth.status === 'complete';
    const text = `${complete ? '沪深A股完整快照' : '沪深A股已返回子集'}共 ${value.total} 只：上涨 ${value.advancing}、下跌 ${value.declining}、平盘 ${value.unchanged}；${complete ? '只描述这次完整快照' : '覆盖不完整，不能外推全市场'}。`;
    add({
      subject: 'market-breadth',
      name: '沪深涨跌广度与参与节奏',
      kind: 'market-breadth',
      text,
      value,
      provenance: breadthProvenance,
      coverage: {
        kind: 'market-facts',
        scope: 'CN_A_SHARES_SH_SZ',
        observedCount: value.total,
        unit: 'stocks',
        dataHealth: complete ? 'complete' : 'partial',
        description: text,
      },
    });
  }
  const indexDimensionProvenance = qualify('指数', snapshot.indexes);
  if (indexDimensionProvenance !== null) {
    const rows = (snapshot.indexes.values ?? []).flatMap((quote) => {
      const at = indexObservedAt(quote);
      return CN_INDEX_CODES.has(quote.code) &&
        at !== undefined &&
        dateInShanghai(at) === date &&
        isInvestmentMarketEvidenceCurrent(at, now) &&
        (quote.fetchedAt === undefined || quote.fetchedAt <= now)
        ? [{ quote, at }]
        : [];
    });
    const values = rows.map((row) => row.quote);
    if (values.length > 0) {
      const text =
        `只比较返回的 ${values.length} 个A股指数：${values.map((quote) => `${quote.name}(${quote.code}) ${quote.close}点、涨跌${quote.changePct}%`).join('；')}。指数变化不代表全部个股或主题受益。`.slice(
          0,
          2000,
        );
      add({
        subject: 'cn-equity-indexes',
        name: 'A股指数走势与等待方向',
        kind: 'market-indexes',
        text,
        value: {
          indexes: rows.map(({ quote, at }) => ({
            code: quote.code,
            name: quote.name,
            close: quote.close,
            change: quote.change,
            changePct: quote.changePct,
            source: quote.source,
            observedAt: at.toISOString(),
          })),
        },
        provenance: rows.map(({ quote, at }) => ({
          provider: quote.source,
          observedAt: at,
          fetchedAt: quote.fetchedAt ?? now,
          freshness: 'fresh',
        })),
        coverage: {
          kind: 'market-facts',
          scope: 'cn-equity-indexes',
          observedCount: values.length,
          unit: 'indexes',
          dataHealth: 'partial',
          description: '只覆盖本次返回且时间合格的A股指数，不代表全市场股票或行业板块。',
        },
      });
    } else limitations.push('指数：未返回时间合格的A股指数，未生成指数方向。');
  }
  const limitProvenance = qualify('封板/炸板情绪', snapshot.limitUp);
  if (limitProvenance !== null && snapshot.limitUp.value !== undefined) {
    const value = snapshot.limitUp.value;
    const count = value.sealedCount + value.brokenCount;
    add({
      subject: 'limit-up-risk',
      name: '封板与炸板风险观察',
      kind: 'market-sentiment',
      text: `事件池记录封板 ${value.sealedCount}、炸板 ${value.brokenCount}，最高连板 ${value.maxLadderLevel}；炸板率 ${value.brokenRate === null ? '未知' : `${(value.brokenRate * 100).toFixed(2)}%`}。仅描述事件池，不证明短线策略收益。`,
      value,
      provenance: limitProvenance,
      coverage: {
        kind: 'market-facts',
        scope: 'limit-up-and-broken-board-pools',
        observedCount: count,
        unit: 'pool-stocks',
        dataHealth: snapshot.limitUp.status === 'complete' ? 'complete' : 'partial',
        description:
          '只覆盖已返回的封板和炸板事件池；不代表全市场股票，不能把池内股票直接作为买入候选。',
      },
    });
  }
  const themeProvenance = qualify('事件池行业分布', snapshot.themes);
  if (themeProvenance !== null && snapshot.themes.value !== undefined) {
    for (const industry of [...snapshot.themes.value.industries]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 3)) {
      add({
        subject: `pool-industry:${industry.name}`.slice(0, 100),
        name: `${industry.name.slice(0, 40)}事件池分布观察`,
        kind: 'market-pool-industry',
        text: `供应商封板/炸板池的行业字段记录「${industry.name}」${industry.count}只。只说明已返回池内的行业计数，不代表完整板块强弱、公司催化或未返回个股的主题归属。`.slice(
          0,
          2000,
        ),
        value: { industry: industry.name, count: industry.count },
        provenance: themeProvenance,
        coverage: {
          kind: 'market-facts',
          scope: 'limit-up-and-broken-board-pools',
          observedCount: industry.count,
          unit: 'pool-stocks',
          dataHealth: 'partial',
          description:
            '仅依据供应商事件池的行业字段计数；不是完整行业板块行情，也不推断具体股票与主题的关系。',
        },
      });
    }
  }
  return { marketSnapshot: { id, snapshot }, proposals, evidence, limitations };
};
