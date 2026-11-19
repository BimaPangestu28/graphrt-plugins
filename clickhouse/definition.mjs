/**
 * clickhouse plugin definition: ClickHouse over its HTTP interface (https://clickhouse.com/docs/interfaces/http),
 * self-hosted or ClickHouse Cloud. Metadata reads are declarative (fixed SQL with typed `param_` values, sent as GET,
 * which ClickHouse runs read-only); `query`, `insert_rows` and `execute` are hand-written
 * (lib/clickhouse-operations.mjs) because their query parameter names come from the caller.
 *
 * Agent policy: `query` always runs with readonly=1 and limits; `insert_rows` needs CLICKHOUSE_TOOL_ALLOW_WRITES=1
 * for tools; `execute` (DDL, mutations, DROP) is node only; there is no api_request, because a GET with a `query`
 * runs any SQL at readonly=2, which still allows SET and table functions such as url() and s3().
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { mapOperationErrors } from "./lib/clickhouse-errors.mjs";
import { sqlOperations, WRITE_OPT_IN_ENV } from "./lib/clickhouse-operations.mjs";

const URL_ENV = "CLICKHOUSE_URL";
const USER_ENV = "CLICKHOUSE_USER";
const PASSWORD_ENV = "CLICKHOUSE_PASSWORD";
const DEFAULT_URL = "http://localhost:8123";

/**
 * Resolves the server URL: https, or http on localhost; no query, fragment or credentials.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 * @throws Error - A malformed CLICKHOUSE_URL, or one with a query or credentials
 */
function resolveServerUrl(environment) {
  const serverUrl = new URL(environment[URL_ENV]?.trim() || DEFAULT_URL);
  if (serverUrl.search || serverUrl.hash) throw new Error(`${URL_ENV} must not contain a query or fragment; settings are sent per request`);
  if (serverUrl.username || serverUrl.password) throw new Error(`${URL_ENV} must not contain credentials; use ${USER_ENV} and ${PASSWORD_ENV}`);
  return `${serverUrl.origin}${serverUrl.pathname.replace(/\/+$/, "")}`;
}

// X-ClickHouse-User / X-ClickHouse-Key; a passwordless user (local default) sends no key.
function authorizeClickHouse({ headers, credential, environment }) {
  headers["x-clickhouse-user"] = environment[USER_ENV]?.trim() || "default";
  const password = credential ?? environment[PASSWORD_ENV] ?? "";
  if (password !== "") headers["x-clickhouse-key"] = password;
  return password === "" ? [] : [password, encodeURIComponent(password)];
}

const fixedQuery = (sql) => ({ query: { query: `${sql} FORMAT JSON` } });
const databaseParam = { in: "query", type: "string", wireName: "param_database", default: "default", description: "Database name" };

const metadataOperations = [
  {
    name: "ping",
    title: "Ping server",
    description: 'Health check: "Ok." when the server is up (no authentication needed)',
    path: "/ping",
  },
  {
    name: "server_info",
    title: "Server info",
    description: "Server version, uptime, time zone, current user and default database",
    path: "/",
    constants: fixedQuery("SELECT version() AS version, uptime() AS uptime_seconds, timezone() AS timezone, currentUser() AS current_user, currentDatabase() AS current_database"),
    response: { dataPath: "data" },
  },
  {
    name: "list_databases",
    title: "List databases",
    description: "Databases with their engine and comment",
    path: "/",
    constants: fixedQuery("SELECT name, engine, comment FROM system.databases ORDER BY name"),
    response: { dataPath: "data" },
  },
  {
    name: "list_tables",
    title: "List tables",
    description: "Tables of a database with engine, row and byte counts, sorting key and comment",
    path: "/",
    params: { database: databaseParam },
    constants: fixedQuery(
      "SELECT name, engine, total_rows, total_bytes, sorting_key, comment FROM system.tables WHERE database = {database:String} AND NOT is_temporary ORDER BY name",
    ),
    response: { dataPath: "data" },
  },
  {
    name: "describe_table",
    title: "Describe table",
    description: "Columns of a table: name, type, default, comment, and whether it is in the primary or sorting key",
    path: "/",
    params: { database: databaseParam, table: { in: "query", type: "string", required: true, wireName: "param_table", description: "Table name" } },
    constants: fixedQuery(
      "SELECT name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
    ),
    response: { dataPath: "data" },
  },
];

const restDefinition = defineRestPlugin({
  name: "clickhouse",
  version: "0.1.0",
  description: "ClickHouse HTTP interface: read-only parameterised queries (readonly=1, time and result caps), databases, tables and columns, JSONEachRow inserts; DDL node only",
  apiName: "ClickHouse HTTP interface",
  limits: { timeout_ms: 150000 },
  baseUrl: resolveServerUrl,
  auth: { type: "custom", authorize: authorizeClickHouse },
  extraEnv: [URL_ENV, USER_ENV, PASSWORD_ENV, WRITE_OPT_IN_ENV],
  // Errors are plain text ("Code: 60. DB::Exception: ..."), read as {text}; lib/clickhouse-errors.mjs maps the code.
  errors: { messagePath: "text" },
  apiRequest: false,
  operations: metadataOperations,
});

export const pluginDefinition = mapOperationErrors({ ...restDefinition, operations: [...restDefinition.operations, ...sqlOperations] });
