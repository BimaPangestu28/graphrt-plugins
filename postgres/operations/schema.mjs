/**
 * Schema operations: list_tables and describe_table. Names are passed as
 * query parameters, never written into the SQL.
 */
import { notFound } from "../lib/errors.mjs";

const LIST_TABLES_SQL = `
SELECT table_schema AS schema, table_name AS name, CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' WHEN 'FOREIGN' THEN 'foreign' ELSE lower(table_type) END AS type
FROM information_schema.tables
WHERE (CASE WHEN $1::text IS NULL
         THEN table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_toast%' AND table_schema NOT LIKE 'pg\\_temp%'
         ELSE table_schema::text = $1::text END)
  AND ($2::boolean OR table_type = 'BASE TABLE')
ORDER BY table_schema, table_name`;

const DESCRIBE_TABLE_SQL = `
WITH target AS (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname::text = $2::text AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND (CASE WHEN $1::text IS NULL THEN n.nspname = ANY (current_schemas(false)) ELSE n.nspname::text = $1::text END)
  ORDER BY array_position(current_schemas(false)::text[], n.nspname::text) NULLS LAST
  LIMIT 1
)
SELECT t.schema_name AS schema, t.table_name AS name,
  CASE t.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'foreign table' END AS type,
  obj_description(t.oid, 'pg_class') AS comment,
  (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid), 'comment', col_description(a.attrelid, a.attnum)) ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT coalesce(json_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)), '[]'::json)
     FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = t.oid AND i.indisprimary) AS primary_key,
  (SELECT coalesce(json_agg(json_build_object('name', ic.relname, 'unique', i.indisunique, 'definition', pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname), '[]'::json)
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = t.oid) AS indexes,
  (SELECT coalesce(json_agg(json_build_object('name', con.conname, 'definition', pg_get_constraintdef(con.oid)) ORDER BY con.conname), '[]'::json)
     FROM pg_constraint con WHERE con.conrelid = t.oid AND con.contype = 'f') AS foreign_keys
FROM target t`;

const SCHEMA_PARAMETER = { type: "string", minLength: 1, description: "Schema name, exactly as stored (case-sensitive)" };

const listTablesOperation = {
  name: "list_tables",
  title: "List tables",
  description: "Lists tables (and views) you can access, with their schema. Without `schema`, all non-system schemas",
  parameters: {
    type: "object",
    properties: {
      schema: { ...SCHEMA_PARAMETER, description: "Only this schema (case-sensitive). Default: every non-system schema" },
      include_views: { type: "boolean", default: true, description: "Include views and foreign tables" },
      max_rows: { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Most tables to return" },
    },
  },
  run: async ({ client, args, signal, source }) => {
    const result = await client.readOnly({
      sql: LIST_TABLES_SQL,
      params: [args.schema ?? null, args.include_views],
      maxRows: args.max_rows,
      maxBytes: client.limits.maxResultBytes,
      timeoutMs: client.limits.statementTimeoutMs,
      signal,
      source,
    });
    return { data: { tables: result.rows, row_count: result.row_count, truncated: result.truncated } };
  },
};

const describeTableOperation = {
  name: "describe_table",
  title: "Describe a table",
  description: "Columns (type, nullable, default, comment), primary key, indexes and foreign keys of one table or view",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string", minLength: 1, description: "Table or view name, exactly as stored (case-sensitive, no schema prefix)" },
      schema: { ...SCHEMA_PARAMETER, description: "Schema of the table. Default: the first schema on the search_path that has it" },
    },
    required: ["table"],
  },
  run: async ({ client, args, signal, source }) => {
    const result = await client.readOnly({
      sql: DESCRIBE_TABLE_SQL,
      params: [args.schema ?? null, args.table],
      maxRows: 1,
      maxBytes: client.limits.maxResultBytes,
      timeoutMs: client.limits.statementTimeoutMs,
      signal,
      source,
    });
    if (result.rows.length === 0) throw notFound(`No table or view named ${JSON.stringify(args.table)}${args.schema ? ` in schema ${JSON.stringify(args.schema)}` : " on the search_path"}`);
    return { data: result.rows[0] };
  },
};

export const schemaOperations = [listTablesOperation, describeTableOperation];
