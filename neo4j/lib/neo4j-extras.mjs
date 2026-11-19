/**
 * Neo4j-specific pieces of the declarative plugin:
 *   - resolveServerUrl / resolveDatabaseUrl: NEO4J_URL (https, or http on localhost) and NEO4J_DATABASE (one database
 *     per plugin configuration, validated, so agent tools cannot pick `system`);
 *   - withRecords: query results also as `records`, one object per row keyed by the result fields, because the
 *     Query API returns `data.fields` and `data.values` (rows as arrays).
 */
export const URL_ENV = "NEO4J_URL";
export const DATABASE_ENV = "NEO4J_DATABASE";
const DEFAULT_SERVER_URL = "http://localhost:7474";
const DEFAULT_DATABASE = "neo4j";
// Neo4j database names: ASCII letters, digits, dots and dashes, starting with a letter (3-63 characters).
const DATABASE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9.-]{2,62}$/;

/**
 * Resolves the server root URL from NEO4J_URL (default http://localhost:7474).
 *
 * @param environment - Environment variables (object)
 * @returns Root URL without a trailing slash (string)
 * @throws Error - When the URL is not http(s), has credentials, a query or a fragment
 *
 * @example
 * resolveServerUrl({ NEO4J_URL: "https://abcd1234.databases.neo4j.io" }); // "https://abcd1234.databases.neo4j.io"
 */
export function resolveServerUrl(environment) {
  const configuredUrl = environment[URL_ENV]?.trim() || DEFAULT_SERVER_URL;
  const parsedUrl = new URL(configuredUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`${URL_ENV} must be the HTTP(S) address (https://<id>.databases.neo4j.io or http://localhost:7474), not neo4j:// or bolt://`);
  }
  if (parsedUrl.username || parsedUrl.password) throw new Error(`${URL_ENV} must not contain credentials; use NEO4J_USERNAME and NEO4J_PASSWORD`);
  if (parsedUrl.search || parsedUrl.hash) throw new Error(`${URL_ENV} must not have a query or fragment`);
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, "")}`;
}

/**
 * Resolves the database URL `<server>/db/<NEO4J_DATABASE>` (default database `neo4j`).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL for the Query API of one database (string)
 * @throws Error - When NEO4J_DATABASE is not a valid database name, or NEO4J_URL is invalid
 */
export function resolveDatabaseUrl(environment) {
  const databaseName = environment[DATABASE_ENV]?.trim() || DEFAULT_DATABASE;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) throw new Error(`${DATABASE_ENV} must be a database name such as neo4j (letters, digits, dots, dashes)`);
  return `${resolveServerUrl(environment)}/db/${encodeURIComponent(databaseName)}`;
}

/**
 * Adds `records` (rows as objects) next to the Query API's `data.fields`/`data.values`.
 *
 * @param queryResult - Query API response body (object)
 * @returns `{records, fields, ...rest}` without the original `data` (object), or the input when it has no data
 *
 * @example
 * zipRecords({ data: { fields: ["name"], values: [["Alice"]] }, queryType: "r" }); // { records: [{name: "Alice"}], fields: ["name"], queryType: "r" }
 */
export function zipRecords(queryResult) {
  const fields = queryResult?.data?.fields;
  const values = queryResult?.data?.values;
  if (!Array.isArray(fields) || !Array.isArray(values)) return queryResult;
  const { data: _rawData, ...rest } = queryResult;
  const records = values.map((row) => Object.fromEntries(fields.map((field, column) => [field, row[column]])));
  return { records, fields, ...rest };
}

/**
 * Returns the definition with the given operations' results reshaped by zipRecords.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - Query operations (string[])
 * @returns A new definition (object)
 */
export function withRecords(pluginDefinition, operationNames) {
  const reshaped = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!reshaped.has(operation.name)) return operation;
    const run = async (context) => {
      const result = await operation.run(context);
      return { ...result, data: zipRecords(result.data) };
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
