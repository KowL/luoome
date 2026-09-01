export type StrategyRunSnapshotFormat = 'v3' | 'v2' | 'legacy';

export interface StrategyRunSnapshotDataCheckpoint {
  readonly id?: string;
  readonly dataAsOf?: Date;
  readonly checksum?: string;
}

export interface StrategyRunSnapshotView {
  readonly format: StrategyRunSnapshotFormat;
  readonly schemaVersion?: number;
  readonly strategyVersionId?: string;
  readonly definitionHash?: string;
  readonly evaluatorVersion?: string;
  readonly evaluatorCodeIdentity?: string;
  readonly scope?: 'operational' | 'evaluation';
  readonly universeKind?: 'full' | 'explicit';
  readonly stockIds: readonly string[];
  readonly requestedBy?: 'manual' | 'scheduled' | 'replay';
  readonly evaluationSessionId?: string;
  readonly dataCheckpoint?: StrategyRunSnapshotDataCheckpoint;
}

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const validDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const readStrategyRunSnapshot = (snapshot: unknown): StrategyRunSnapshotView => {
  const value = recordValue(snapshot);
  if (value === undefined) return { format: 'legacy', stockIds: [] };
  const schemaVersion =
    typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion)
      ? value.schemaVersion
      : undefined;
  const format: StrategyRunSnapshotFormat =
    schemaVersion === 3 ? 'v3' : schemaVersion === 2 ? 'v2' : 'legacy';
  const checkpoint = recordValue(value.dataCheckpoint);
  const checkpointId = nonEmptyString(checkpoint?.id);
  const checkpointDataAsOf = validDate(checkpoint?.dataAsOf);
  const checkpointChecksum = nonEmptyString(checkpoint?.checksum);
  const dataCheckpoint =
    checkpoint === undefined ||
    (checkpointId === undefined &&
      checkpointDataAsOf === undefined &&
      checkpointChecksum === undefined)
      ? undefined
      : {
          ...(checkpointId === undefined ? {} : { id: checkpointId }),
          ...(checkpointDataAsOf === undefined ? {} : { dataAsOf: checkpointDataAsOf }),
          ...(checkpointChecksum === undefined ? {} : { checksum: checkpointChecksum }),
        };
  const stockIds = Array.isArray(value.stockIds)
    ? value.stockIds.filter((stockId): stockId is string => typeof stockId === 'string')
    : [];
  const strategyVersionId = nonEmptyString(value.strategyVersionId);
  const definitionHash = nonEmptyString(value.definitionHash);
  const evaluatorVersion = nonEmptyString(value.evaluatorVersion);
  const evaluatorCodeIdentity = nonEmptyString(value.evaluatorCodeIdentity);
  const evaluationSessionId = nonEmptyString(value.evaluationSessionId);

  return {
    format,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(strategyVersionId === undefined ? {} : { strategyVersionId }),
    ...(definitionHash === undefined ? {} : { definitionHash }),
    ...(evaluatorVersion === undefined ? {} : { evaluatorVersion }),
    ...(evaluatorCodeIdentity === undefined ? {} : { evaluatorCodeIdentity }),
    ...(value.scope === 'operational' || value.scope === 'evaluation'
      ? { scope: value.scope }
      : {}),
    ...(value.universeKind === 'full' || value.universeKind === 'explicit'
      ? { universeKind: value.universeKind }
      : {}),
    stockIds,
    ...(value.requestedBy === 'manual' ||
    value.requestedBy === 'scheduled' ||
    value.requestedBy === 'replay'
      ? { requestedBy: value.requestedBy }
      : {}),
    ...(evaluationSessionId === undefined ? {} : { evaluationSessionId }),
    ...(dataCheckpoint === undefined ? {} : { dataCheckpoint }),
  };
};

export const strategyRunUsesEvaluator = (
  snapshot: unknown,
  expected: { readonly version: string; readonly codeIdentity: string },
): boolean => {
  const view = readStrategyRunSnapshot(snapshot);
  return (
    view.format === 'v3' &&
    view.evaluatorVersion === expected.version &&
    view.evaluatorCodeIdentity === expected.codeIdentity
  );
};
