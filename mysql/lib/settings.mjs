/**
 * Reads the mysql plugin's environment: the connection (a URL or separate
 * parts) and the limits.
 *
 * The URL is parsed here rather than by mysql2: mysql2 would copy every query
 * parameter into its options (including `multipleStatements=true`), so only
 * `ssl-mode` / `sslmode` is honoured.
 */
import { invalidInput, setupRequired } from "./errors.mjs";
import { readInteger, readText } from "./environment-readers.mjs";

export const URL_VARIABLE = "MYSQL_URL";
export const TOOL_WRITES_VARIABLE = "MYSQL_TOOL_ALLOW_WRITES";
export const CONNECTION_PART_VARIABLES = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE", "MYSQL_SSL_MODE"];
export const LIMIT_VARIABLES = ["MYSQL_STATEMENT_TIMEOUT_MS", "MYSQL_CONNECT_TIMEOUT_MS", "MYSQL_MAX_RESULT_BYTES", "MYSQL_POOL_MAX"];
const URL_SCHEMES = new Set(["mysql:", "mariadb:"]);
const SSL_MODES = new Set(["disable", "require", "verify-full"]);
const HOSTNAME_PATTERN = /^([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;

/**
 * Resolves the connection: a node's `access_token` URL, else MYSQL_URL, else the MYSQL_* parts.
 *
 * @param inputs - `{environment, nodeToken}` as passed to resolveAccessToken (object)
 * @returns `{host, port, user, password, database, sslMode, secrets}` (object)
 * @throws PluginError kind `setup_required` - When no connection is configured
 * @throws PluginError kind `invalid_input` - When the URL or a part is malformed (the message never shows the URL)
 */
export function resolveConnection({ environment, nodeToken }) {
  const connectionUrl = nodeToken || readText(environment, URL_VARIABLE);
  if (connectionUrl) return parseConnectionUrl(connectionUrl, nodeToken ? "the node's access_token" : URL_VARIABLE, environment);
  const host = readText(environment, "MYSQL_HOST");
  if (!host) {
    throw setupRequired(`No MySQL connection: set ${URL_VARIABLE} (a mysql:// URL) or MYSQL_HOST and the other MYSQL_* parts, or pass a connection URL as the node's access_token`);
  }
  const password = environment.MYSQL_PASSWORD ?? "";
  return {
    host: checkHost(host, "MYSQL_HOST"),
    port: readInteger(environment, "MYSQL_PORT", 3306, { minimum: 1, maximum: 65535 }),
    user: readText(environment, "MYSQL_USER"),
    password: password || null,
    database: readText(environment, "MYSQL_DATABASE"),
    sslMode: readSslMode(readText(environment, "MYSQL_SSL_MODE"), "MYSQL_SSL_MODE"),
    secrets: password ? [password] : [],
  };
}

/**
 * Reads the limits that apply to every call.
 *
 * @param environment - Environment variables (object)
 * @returns `{statementTimeoutMs, connectTimeoutMs, maxResultBytes, poolMax}` (object)
 * @throws PluginError kind `invalid_input` - When a limit is out of range
 */
export function resolveLimits(environment) {
  return {
    statementTimeoutMs: readInteger(environment, "MYSQL_STATEMENT_TIMEOUT_MS", 30000, { minimum: 100, maximum: 600000 }),
    connectTimeoutMs: readInteger(environment, "MYSQL_CONNECT_TIMEOUT_MS", 10000, { minimum: 500, maximum: 120000 }),
    maxResultBytes: readInteger(environment, "MYSQL_MAX_RESULT_BYTES", 1000000, { minimum: 1000, maximum: 8000000 }),
    poolMax: readInteger(environment, "MYSQL_POOL_MAX", 4, { minimum: 1, maximum: 20 }),
  };
}

function parseConnectionUrl(connectionUrl, sourceName, environment) {
  let parsedUrl;
  try {
    parsedUrl = new URL(connectionUrl);
  } catch {
    throw invalidInput(`${sourceName} is not a valid URL; expected a mysql:// URL with user, password, host, port and database`);
  }
  if (!URL_SCHEMES.has(parsedUrl.protocol)) {
    throw invalidInput(`${sourceName} must start with mysql:// or mariadb://, got ${JSON.stringify(parsedUrl.protocol)}`);
  }
  const password = safeDecode(parsedUrl.password);
  const databaseName = safeDecode(parsedUrl.pathname.replace(/^\//, ""));
  const urlSslMode = parsedUrl.searchParams.get("ssl-mode") ?? parsedUrl.searchParams.get("sslmode");
  return {
    host: checkHost(parsedUrl.hostname || "localhost", sourceName),
    port: parsedUrl.port ? Number(parsedUrl.port) : 3306,
    user: safeDecode(parsedUrl.username) || null,
    password: password || null,
    database: databaseName || null,
    sslMode: readSslMode(urlSslMode ?? readText(environment, "MYSQL_SSL_MODE"), `${sourceName} ssl-mode`),
    secrets: [connectionUrl, parsedUrl.password, password].filter(Boolean),
  };
}

function checkHost(host, sourceName) {
  if (!HOSTNAME_PATTERN.test(host)) throw invalidInput(`${sourceName}: the host must be a host name or an IP address`);
  return host.replace(/^\[(.*)\]$/, "$1");
}

function safeDecode(encodedText) {
  try {
    return decodeURIComponent(encodedText);
  } catch {
    return encodedText;
  }
}

// MySQL's own names (DISABLED, REQUIRED, VERIFY_IDENTITY) are accepted too.
function readSslMode(rawMode, sourceName) {
  const aliases = { disabled: "disable", required: "require", verify_identity: "verify-full", "verify-identity": "verify-full" };
  const lowered = (rawMode ?? "disable").toLowerCase();
  const sslMode = aliases[lowered] ?? lowered;
  if (!SSL_MODES.has(sslMode)) throw invalidInput(`${sourceName} must be disable, require or verify-full, got ${JSON.stringify(rawMode)}`);
  return sslMode;
}
