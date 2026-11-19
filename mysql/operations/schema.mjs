/**
 * Schema operations: list_tables and describe_table, from information_schema.
 * Names are passed as statement parameters, never written into the SQL.
 * Without `schema`, the connection's default database (DATABASE()) is used.
 */
import { notFound } from "../lib/errors.mjs";

const SYSTEM_SCHEMAS = "'mysql', 'information_schema', 'performance_schema', 'sys'";

const LIST_TABLES_SQL = `
SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
  CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE LOWER(TABLE_TYPE) END AS type,
  TABLE_ROWS AS approximate_rows, TABLE_COMMENT AS comment
FROM information_schema.TABLES
WHERE (CASE WHEN COALESCE(?, DATABASE()) IS NULL THEN TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS}) ELSE TABLE_SCHEMA = COALESCE(?, DATABASE()) END)
  AND (? = 1 OR TABLE_TYPE = 'BASE TABLE')
ORDER BY TABLE_SCHEMA, TABLE_NAME`;

const TABLE_SQL = `
SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
  CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE LOWER(TABLE_TYPE) END AS type,
  ENGINE AS engine, TABLE_COMMENT AS comment
FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`;

const COLUMNS_SQL = `
SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`,
  COLUMN_KEY AS \`key\`, EXTRA AS extra, COLUMN_COMMENT AS comment
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION`;

const INDEXES_SQL = `
SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, COLUMN_NAME AS column_name, SEQ_IN_INDEX AS position
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
ORDER BY INDEX_NAME, SEQ_IN_INDEX`;

const FOREIGN_KEYS_SQL = `
SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name, REFERENCED_TABLE_SCHEMA AS referenced_schema,
  REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

const SCHEMA_PARAMETER = { type: "string", minLength: 1, description: "Database (schema) name. Default: the connection's database" };

const listTablesOperation = {
  name: "list_tables",
  title: "List tables",
  description: "Lists tables (and views) in a database with approximate row counts. Without `schema`, the connection's database, or every non-system database when there is none",
  parameters: {
    type: "object",
    properties: {
      schema: SCHEMA_PARAMETER,
      include_views: { type: "boolean", default: true, description: "Include views" },
      max_rows: { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Most tables to return" },
    },
  },
  run: async ({ client, args, signal }) => {
    const schemaName = args.schema ?? null;
    const result = await client.readOnly(buildSchemaRequest(client, LIST_TABLES_SQL, [schemaName, schemaName, args.include_views], args.max_rows, signal));
    return { data: { tables: result.rows, row_count: result.row_count, truncated: result.truncated } };
  },
};

const describeTableOperation = {
  name: "describe_table",
  title: "Describe a table",
  description: "Columns (type, nullable, default, key, extra, comment), primary key, indexes and foreign keys of one table or view",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", minLength: 1, description: "Table or view name" },
      schema: SCHEMA_PARAMETER,
    },
    required: ["table"],
  },
  run: async ({ client, args, signal }) => {
    const nameParams = [args.schema ?? null, args.table];
    const tableResult = await client.readOnly(buildSchemaRequest(client, TABLE_SQL, nameParams, 1, signal));
    if (tableResult.rows.length === 0) {
      throw notFound(`No table or view named ${JSON.stringify(args.table)} in ${args.schema ? `database ${JSON.stringify(args.schema)}` : "the connection's database"}`);
    }
    const columns = await client.readOnly(buildSchemaRequest(client, COLUMNS_SQL, nameParams, 5000, signal));
    const indexRows = await client.readOnly(buildSchemaRequest(client, INDEXES_SQL, nameParams, 5000, signal));
    const foreignKeyRows = await client.readOnly(buildSchemaRequest(client, FOREIGN_KEYS_SQL, nameParams, 5000, signal));
    const indexes = groupColumns(indexRows.rows, (row) => ({ name: row.name, unique: Boolean(Number(row.unique)) }));
    return {
      data: {
        ...tableResult.rows[0],
        columns: columns.rows.map((column) => ({ ...column, nullable: Boolean(Number(column.nullable)) })),
        primary_key: indexes.find((index) => index.name === "PRIMARY")?.columns ?? [],
        indexes,
        foreign_keys: groupColumns(foreignKeyRows.rows, (row) => ({ name: row.name, referenced_schema: row.referenced_schema, referenced_table: row.referenced_table }), "referenced_column"),
      },
    };
  },
};

function buildSchemaRequest(client, sql, params, maxRows, signal) {
  return { sql, params, maxRows, maxBytes: client.limits.maxResultBytes, timeoutMs: client.limits.statementTimeoutMs, signal };
}

// Index and foreign key rows come one per column; this folds them into one entry per name.
function groupColumns(rows, describeGroup, referencedColumnKey = null) {
  const groupsByName = new Map();
  for (const row of rows) {
    if (!groupsByName.has(row.name)) groupsByName.set(row.name, { ...describeGroup(row), columns: [], ...(referencedColumnKey ? { referenced_columns: [] } : {}) });
    const group = groupsByName.get(row.name);
    group.columns.push(row.column_name);
    if (referencedColumnKey) group.referenced_columns.push(row[referencedColumnKey]);
  }
  return [...groupsByName.values()];
}

export const schemaOperations = [listTablesOperation, describeTableOperation];
