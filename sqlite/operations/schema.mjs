/**
 * Schema operations: list_tables and describe_table. Table names are bound as
 * parameters of SQLite's table-valued pragma functions, never written into the SQL.
 */
import { notFound } from "../lib/errors.mjs";
import { DATABASE_PARAMETER } from "./statements.mjs";

const LIST_TABLES_SQL = `
SELECT name, type, sql AS definition FROM sqlite_schema
WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND (?1 = 1 OR type = 'table')
ORDER BY name`;
const TABLE_SQL = "SELECT name, type, sql AS definition FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?1";
const COLUMNS_SQL = 'SELECT name, type, "notnull" = 0 AS nullable, dflt_value AS "default", pk AS primary_key_position, hidden FROM pragma_table_xinfo(?1) ORDER BY cid';
const INDEXES_SQL = `
SELECT il.name AS name, il."unique" AS is_unique, il.origin AS origin, ii.name AS column_name
FROM pragma_index_list(?1) AS il JOIN pragma_index_info(il.name) AS ii ORDER BY il.name, ii.seqno`;
const FOREIGN_KEYS_SQL = 'SELECT id, "table" AS referenced_table, "from" AS column_name, "to" AS referenced_column, on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq';

const listTablesOperation = {
  name: "list_tables",
  title: "List tables",
  description: "Lists the tables (and views) in a SQLite database file with their CREATE statements",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PARAMETER,
      include_views: { type: "boolean", default: true, description: "Include views" },
      max_rows: { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Most tables to return" },
    },
  },
  run: async ({ client, args, signal }) => {
    const statement = { sql: LIST_TABLES_SQL, params: [args.include_views ? 1 : 0], maxRows: args.max_rows, maxBytes: client.limits.maxResultBytes };
    const { results } = await client.run({ database: args.database, mode: "read", statements: [statement], timeoutMs: client.limits.statementTimeoutMs, signal });
    return { data: { tables: results[0].rows, row_count: results[0].row_count, truncated: results[0].truncated } };
  },
};

const describeTableOperation = {
  name: "describe_table",
  title: "Describe a table",
  description: "Columns (type, nullable, default, primary key position), primary key, indexes and foreign keys of one table or view",
  parameters: {
    type: "object",
    properties: {
      database: DATABASE_PARAMETER,
      table: { type: "string", minLength: 1, description: "Table or view name, exactly as stored" },
    },
    required: ["table"],
  },
  run: async ({ client, args, signal }) => {
    const statements = [TABLE_SQL, COLUMNS_SQL, INDEXES_SQL, FOREIGN_KEYS_SQL].map((sql) => ({ sql, params: [args.table], maxRows: 5000, maxBytes: client.limits.maxResultBytes }));
    const { results } = await client.run({ database: args.database, mode: "read", statements, timeoutMs: client.limits.statementTimeoutMs, signal });
    const [tableResult, columnResult, indexResult, foreignKeyResult] = results;
    if (tableResult.rows.length === 0) throw notFound(`No table or view named ${JSON.stringify(args.table)}`);
    const columns = columnResult.rows.map(({ hidden, primary_key_position: primaryKeyPosition, nullable, ...column }) => ({
      ...column,
      nullable: Boolean(nullable),
      primary_key_position: primaryKeyPosition,
      ...(hidden ? { hidden: true } : {}),
    }));
    return {
      data: {
        ...tableResult.rows[0],
        columns,
        primary_key: columns.filter((column) => column.primary_key_position > 0).sort((left, right) => left.primary_key_position - right.primary_key_position).map((column) => column.name),
        indexes: groupRows(indexResult.rows, "name", (row) => ({ name: row.name, unique: Boolean(row.is_unique), origin: row.origin })),
        foreign_keys: groupRows(foreignKeyResult.rows, "id", (row) => ({ referenced_table: row.referenced_table, on_update: row.on_update, on_delete: row.on_delete })),
      },
    };
  },
};

// Index and foreign key rows come one per column; this folds them into one entry per key.
function groupRows(rows, groupKey, describeGroup) {
  const groupsByKey = new Map();
  for (const row of rows) {
    if (!groupsByKey.has(row[groupKey])) groupsByKey.set(row[groupKey], { ...describeGroup(row), columns: [], referenced_columns: [] });
    const group = groupsByKey.get(row[groupKey]);
    group.columns.push(row.column_name);
    if (row.referenced_column !== undefined) group.referenced_columns.push(row.referenced_column);
  }
  return [...groupsByKey.values()].map(({ referenced_columns: referencedColumns, ...group }) => (referencedColumns.length ? { ...group, referenced_columns: referencedColumns } : group));
}

export const schemaOperations = [listTablesOperation, describeTableOperation];
