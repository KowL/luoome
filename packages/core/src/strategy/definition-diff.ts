import { z } from 'zod';

import { type StrategyDslV1, StrategyDslV1Schema } from '../entity/strategy.js';

export const StrategyDefinitionDiffChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['added', 'removed', 'changed']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export type StrategyDefinitionDiffChange = z.infer<typeof StrategyDefinitionDiffChangeSchema>;

export const StrategyDefinitionDiffSchema = z.object({
  changed: z.boolean(),
  fromHash: z.string().regex(/^[a-f0-9]{64}$/),
  toHash: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(StrategyDefinitionDiffChangeSchema),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
  }),
});

export type StrategyDefinitionDiff = z.infer<typeof StrategyDefinitionDiffSchema>;

type JsonObject = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const pathFor = (parent: string, key: string | number): string =>
  parent.length === 0
    ? String(key)
    : typeof key === 'number'
      ? `${parent}[${key}]`
      : `${parent}.${key}`;

const walk = (
  from: unknown,
  to: unknown,
  path: string,
  changes: StrategyDefinitionDiffChange[],
): void => {
  if (sameValue(from, to)) return;
  if (isObject(from) && isObject(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const key of keys) {
      const childPath = pathFor(path, key);
      if (!(key in from)) {
        changes.push({ path: childPath, kind: 'added', after: to[key] });
      } else if (!(key in to)) {
        changes.push({ path: childPath, kind: 'removed', before: from[key] });
      } else {
        walk(from[key], to[key], childPath, changes);
      }
    }
    return;
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const length = Math.max(from.length, to.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = pathFor(path, index);
      if (index >= from.length) changes.push({ path: childPath, kind: 'added', after: to[index] });
      else if (index >= to.length)
        changes.push({ path: childPath, kind: 'removed', before: from[index] });
      else walk(from[index], to[index], childPath, changes);
    }
    return;
  }
  changes.push({ path: path.length === 0 ? '$' : path, kind: 'changed', before: from, after: to });
};

/** 对两个 DSL 做稳定、可审计的结构差异计算；不修改输入，也不访问 IO。 */
export const diffStrategyDefinitions = (
  from: StrategyDslV1,
  to: StrategyDslV1,
  fromHash: string,
  toHash: string,
): StrategyDefinitionDiff => {
  const left = StrategyDslV1Schema.parse(from);
  const right = StrategyDslV1Schema.parse(to);
  const changes: StrategyDefinitionDiffChange[] = [];
  walk(left, right, '', changes);
  const summary = {
    added: changes.filter((change) => change.kind === 'added').length,
    removed: changes.filter((change) => change.kind === 'removed').length,
    changed: changes.filter((change) => change.kind === 'changed').length,
  };
  return StrategyDefinitionDiffSchema.parse({
    changed: changes.length > 0,
    fromHash,
    toHash,
    changes,
    summary,
  });
};
