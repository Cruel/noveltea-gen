import {
  Kysely, PostgresDialect, sql,
  type DatabaseIntrospector, type DatabaseMetadataOptions, type TableMetadata,
} from 'kysely'

/** Kysely's stock Postgres introspector queries ALL accessible namespaces.
 * With concurrent disposable schemas, another fixture can DROP one while
 * Kysely is resolving metadata. Restrict the catalog query itself to the
 * selected search_path schema, not merely the returned table list. */
class StudioPostgresIntrospector implements DatabaseIntrospector {
  constructor(private readonly db: Kysely<any>) {}

  async getSchemas() {
    const result = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(this.db)
    const name = result.rows[0]?.name
    return name ? [{ name }] : []
  }

  async getTables(options?: DatabaseMetadataOptions): Promise<TableMetadata[]> {
    const rows = await sql<{
      tableName: string; tableType: string; schemaName: string
      columnName: string; notNull: boolean; hasDefault: boolean
      dataType: string; typeSchema: string
      comment: string | null; autoIncrementing: boolean
    }>`
      SELECT c.relname AS "tableName", c.relkind AS "tableType",
        ns.nspname AS "schemaName", a.attname AS "columnName",
        a.attnotnull AS "notNull", a.atthasdef AS "hasDefault",
        typ.typname AS "dataType", dtns.nspname AS "typeSchema",
        col_description(a.attrelid, a.attnum) AS comment,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          JOIN pg_catalog.pg_class seq ON seq.oid=dep.objid AND seq.relkind='S'
          WHERE dep.refobjid=c.oid AND dep.refobjsubid=a.attnum
            AND dep.deptype IN ('a','i')
        ) AS "autoIncrementing"
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
      JOIN pg_catalog.pg_namespace dtns ON dtns.oid=typ.typnamespace
      WHERE ns.nspname=current_schema()
        AND c.relkind IN ('r','v','p','f')
        AND a.attnum >= 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `.execute(this.db)
    const tables = new Map<string, TableMetadata>()
    for (const row of rows.rows) {
      if (!options?.withInternalKyselyTables &&
        (row.tableName === 'kysely_migration' || row.tableName === 'kysely_migration_lock'))
        continue
      let table = tables.get(row.tableName)
      if (!table) {
        table = {
          name: row.tableName, schema: row.schemaName,
          isView: row.tableType === 'v', isForeign: row.tableType === 'f',
          columns: [],
        }
        tables.set(row.tableName, table)
      }
      table.columns.push({
        name: row.columnName, dataType: row.dataType, dataTypeSchema: row.typeSchema,
        isNullable: !row.notNull, hasDefaultValue: row.hasDefault,
        isAutoIncrementing: row.autoIncrementing,
        ...(row.comment === null ? {} : { comment: row.comment }),
      })
    }
    return [...tables.values()]
  }
}

export class StudioPostgresDialect extends PostgresDialect {
  override createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new StudioPostgresIntrospector(db)
  }
}
