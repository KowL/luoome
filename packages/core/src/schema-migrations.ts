/**
 * 本仓当前已知的、必须落 `schema_migrations` 的启动迁移 id。
 *
 * 单一事实来源：`@luoome/db` 的迁移函数用这些常量写行，诊断读模型用同一份清单判断
 * 「迁移未完成」。两边各写一份就会漂移——那正是「名实不符」的来源。
 */
export const EXPECTED_SCHEMA_MIGRATIONS = [
  'mvp3-legacy-explicit-trade-links-v1',
  'm1-06-signal-observation-vintage-v1',
] as const;
export type ExpectedSchemaMigration = (typeof EXPECTED_SCHEMA_MIGRATIONS)[number];
