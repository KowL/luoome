/** `schema_migrations` 的只读投影：诊断只关心「哪些迁移已应用、何时应用」。 */
export interface SchemaMigrationRecord {
  readonly id: string;
  readonly appliedAt: Date;
}

export interface SchemaMigrationRepository {
  list(): Promise<readonly SchemaMigrationRecord[]>;
}
