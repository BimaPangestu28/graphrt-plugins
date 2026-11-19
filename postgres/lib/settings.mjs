/**
 * Reads the postgres plugin's environment: the connection (a URL or separate
 * parts) and the limits.
 *
 * The connection is resolved by the runner's `resolveAccessToken` hook, so a
 * node's `access_token` (from a secret) can carry its own `postgres://` URL.
 */
import { invalidInput, setupRequired } from "./errors.mjs";
import { readInteger, readOptInFlag, readText } from "./environment-readers.mjs";

export const URL_VARIABLE = "POSTGRES_URL";
export const TOOL_WRITES_VARIABLE = "POSTGRES_TOOL_ALLOW_WRITES";
export const ALLOW_SUPERUSER_VARIABLE = "POSTGRES_ALLOW_SUPERUSER";
export const CONNECTION_PART_VARIABLES = ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DATABASE", "POSTGRES_SSLMODE"];
export const LIMIT_VARIABLES = ["POSTGRES_STATEMENT_TIMEOUT_MS", "POSTGRES_CONNECT_TIMEOUT_MS", "POSTGRES_MAX_RESULT_BYTES", "POSTGRES_POOL_MAX"];
const URL_SCHEMES = new Set(["postgres:", "postgresql:"]);
const SSL_MODES = new Set(["disable", "require", "verify-full"]);
const HOSTNAME_PATTERN = /^(\/[^\0]*|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;

/**
 * Resolves the connection: a node's `access_token` URL, else POSTGRES_URL, else the POSTGRES_* parts.
 *
 * @param inputs - `{environment, nodeToken}` as passed to resolveAccessToken (object)
 * @returns `{connectionString}` or `{host, port, user, password, database, sslMode}`, plus `secrets` to redact (object)
 * @throws PluginError kind `setup_required` - When no connection is configured
 * @throws PluginError kind `invalid_input` - When the URL or a part is malformed (the message never shows the URL)
 */
export function resolveConnection({ environment, nodeToken }) {
  const connectionUrl = nodeToken || readText(environment, URL_VARIABLE);
  if (connectionUrl) return parseConnectionUrl(connectionUrl, nodeToken ? "the node's access_token" : URL_VARIABLE);
  const host = readText(environment, "POSTGRES_HOST");
  if (!host) {
    throw setupRequired(`No PostgreSQL connection: set ${URL_VARIABLE} (a postgres:// URL) or POSTGRES_HOST and the other POSTGRES_* parts, or pass a connection URL as the node's access_token`);
  }
  if (!HOSTNAME_PATTERN.test(host)) throw invalidInput(`POSTGRES_HOST must be a host name, an IP address or a socket directory, got ${JSON.stringify(host)}`);
  const password = environment.POSTGRES_PASSWORD ?? "";
  return {
    host,
    port: readInteger(environment, "POSTGRES_PORT", 5432, { minimum: 1, maximum: 65535 }),
    user: readText(environment, "POSTGRES_USER"),
    password: password || null,
    database: readText(environment, "POSTGRES_DATABASE"),
    sslMode: readSslMode(environment),
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
    statementTimeoutMs: readInteger(environment, "POSTGRES_STATEMENT_TIMEOUT_MS", 30000, { minimum: 100, maximum: 600000 }),
    connectTimeoutMs: readInteger(environment, "POSTGRES_CONNECT_TIMEOUT_MS", 10000, { minimum: 500, maximum: 120000 }),
    maxResultBytes: readInteger(environment, "POSTGRES_MAX_RESULT_BYTES", 1000000, { minimum: 1000, maximum: 8000000 }),
    poolMax: readInteger(environment, "POSTGRES_POOL_MAX", 4, { minimum: 1, maximum: 20 }),
  };
}

/**
 * Reads the agent policy switches.
 *
 * @param environment - Environment variables (object)
 * @returns `{allowSuperuser}`: true only when POSTGRES_ALLOW_SUPERUSER is "1" (object)
 */
export function resolvePolicy(environment) {
  return { allowSuperuser: readOptInFlag(environment, ALLOW_SUPERUSER_VARIABLE) };
}

function parseConnectionUrl(connectionUrl, sourceName) {
  let parsedUrl;
  try {
    parsedUrl = new URL(connectionUrl);
  } catch {
    throw invalidInput(`${sourceName} is not a valid URL; expected a postgres:// URL with user, password, host, port and database`);
  }
  if (!URL_SCHEMES.has(parsedUrl.protocol)) {
    throw invalidInput(`${sourceName} must start with postgres:// or postgresql://, got ${JSON.stringify(parsedUrl.protocol)}`);
  }
  const password = safeDecode(parsedUrl.password);
  return { connectionString: connectionUrl, secrets: [connectionUrl, parsedUrl.password, password].filter(Boolean) };
}

function safeDecode(encodedText) {
  try {
    return decodeURIComponent(encodedText);
  } catch {
    return encodedText;
  }
}

function readSslMode(environment) {
  const sslMode = readText(environment, "POSTGRES_SSLMODE")?.toLowerCase() ?? "disable";
  if (!SSL_MODES.has(sslMode)) throw invalidInput(`POSTGRES_SSLMODE must be disable, require or verify-full, got ${JSON.stringify(sslMode)}`);
  return sslMode;
}
