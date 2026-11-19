/**
 * 从 Drizzle schema 生成 ensureSchema 使用的建表/索引 DDL。
 *
 * 手写 DDL 与 schema 双写是这个仓库最容易漂移的一处：列类型、NOT NULL、默认值、
 * 索引任何一边改动都要人工同步。这里以 schema 为唯一来源生成 SQL，client.ts 只
 * 负责按序执行。`WITHOUT ROWID` 等 schema 表达不了的特性由 client.ts 手写保留。
 *
 * 用法：bun run schema:ddl（在 packages/db 下）
 */
import { SQL } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/schema/index.js';

/** schema 无法表达 WITHOUT ROWID，按表名补充；其余建表一律由此脚本生成。 */
const WITHOUT_ROWID_TABLES = new Set([
  'adjustment_factors',
  'limit_up_board_history',
  'signal_observations',
]);

const literal = (value: unknown): string => {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof SQL) {
    return value.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        const named = chunk as { value?: unknown; name?: unknown };
        if (named.value !== undefined) return String(named.value);
        if (named.name !== undefined) return String(named.name);
        return '';
      })
      .join('');
  }
  return '';
};

const tables = Object.values(schema as Record<string, unknown>)
  .filter(
    (value): value is Parameters<typeof getTableConfig>[0] =>
      typeof value === 'object' && value !== null && Symbol.for('drizzle:IsDrizzleTable') in value,
  )
  .map((table) => getTableConfig(table))

  .sort((left, right) => left.name.localeCompare(right.name));

const statements: string[] = [];
const indexes: string[] = [];

for (const config of tables) {
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}" ${column.getSQLType()}`];
    const isSinglePrimary = column.primary && config.primaryKeys.length === 0;
    if (isSinglePrimary) parts.push('PRIMARY KEY');
    if (isSinglePrimary && (column as { autoIncrement?: boolean }).autoIncrement === true) {
      parts.push('AUTOINCREMENT');
    }
    if (column.notNull && !isSinglePrimary) parts.push('NOT NULL');
    if (column.hasDefault) {
      const value = literal((column as { default?: unknown }).default);
      if (value !== '') parts.push(`DEFAULT ${value}`);
    }
    return parts.join(' ');
  });
  for (const primaryKey of config.primaryKeys) {
    const names = primaryKey.columns.map((column) => `"${column.name}"`).join(', ');
    columns.push(`PRIMARY KEY (${names})`);
  }
  const suffix = WITHOUT_ROWID_TABLES.has(config.name) ? ' WITHOUT ROWID' : '';
  statements.push(
    `CREATE TABLE IF NOT EXISTS "${config.name}" (\n  ${columns.join(',\n  ')}\n)${suffix}`,
  );
  for (const index of config.indexes) {
    const name = index.config.name;
    const names = index.config.columns.map((column) => `"${column.name}"`).join(', ');
    const where = index.config.where;
    const clause = where === undefined ? '' : ` WHERE ${literal(where)}`;
    indexes.push(
      `CREATE ${index.config.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${config.name}" (${names})${clause}`,
    );
  }
}

const body = [...statements, ...indexes]
  .flatMap((statement) => statement.split('\n'))
  .map((line) => line)
  .join('\n');

const emit = (list: readonly string[]): string =>
  list
    .map((statement) => `\n  \`${statement.replaceAll('`', '\\`').replaceAll('${', '\\${')}\`,`)
    .join('');

const output = `// 由 scripts/generate-schema-ddl.ts 从 src/schema 生成，不要手工编辑。
// 重新生成：bun run schema:ddl
// 表与索引分开：先建表（迁移需要表存在），补列/迁移完成后再建索引（索引可能引用新补的列）。
export const SCHEMA_TABLES: readonly string[] = [${emit(statements)}
];

export const SCHEMA_INDEXES: readonly string[] = [${emit(indexes)}
];
`;

await Bun.write(new URL('../src/schema-ddl.generated.ts', import.meta.url), output);
console.log(
  `generated ${statements.length} tables + ${indexes.length} indexes (${body.length} chars)`,
);
