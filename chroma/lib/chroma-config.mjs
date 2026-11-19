/**
 * Chroma-specific configuration for the declarative definition:
 * - the server root comes from CHROMA_URL (default http://localhost:8000; Chroma Cloud https://api.trychroma.com),
 *   and record and collection operations are scoped to one database: CHROMA_TENANT / CHROMA_DATABASE (defaults
 *   default_tenant / default_database), each encoded as one path segment. Agents cannot reach other databases.
 * - the token is optional (a local server usually runs without auth). When set it is sent as `x-chroma-token`, or as
 *   `Authorization: Bearer` with CHROMA_AUTH_HEADER=authorization (servers configured for bearer tokens).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const CHROMA_URL_ENV = "CHROMA_URL";
export const CHROMA_TOKEN_ENV = "CHROMA_API_KEY";
export const CHROMA_TENANT_ENV = "CHROMA_TENANT";
export const CHROMA_DATABASE_ENV = "CHROMA_DATABASE";
export const CHROMA_AUTH_HEADER_ENV = "CHROMA_AUTH_HEADER";
const DEFAULT_CHROMA_URL = "http://localhost:8000";
const DEFAULT_TENANT = "default_tenant";
const DEFAULT_DATABASE = "default_database";
const AUTH_HEADERS = new Set(["x-chroma-token", "authorization"]);

function readEnv(environment, envName) {
  return typeof environment?.[envName] === "string" ? environment[envName].trim() : "";
}

/**
 * The server root, without a trailing slash.
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "http://localhost:8000" (string)
 */
export function resolveChromaRootUrl(environment) {
  return (readEnv(environment, CHROMA_URL_ENV) || DEFAULT_CHROMA_URL).replace(/\/+$/, "");
}

/**
 * The database-scoped base URL: `<root>/api/v2/tenants/<tenant>/databases/<database>`.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - CHROMA_TENANT or CHROMA_DATABASE is "." or ".."
 *
 * @example
 * resolveChromaDatabaseUrl({}); // "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database"
 */
export function resolveChromaDatabaseUrl(environment) {
  const tenant = encodeSegment(CHROMA_TENANT_ENV, readEnv(environment, CHROMA_TENANT_ENV) || DEFAULT_TENANT);
  const database = encodeSegment(CHROMA_DATABASE_ENV, readEnv(environment, CHROMA_DATABASE_ENV) || DEFAULT_DATABASE);
  return `${resolveChromaRootUrl(environment)}/api/v2/tenants/${tenant}/databases/${database}`;
}

function encodeSegment(envName, value) {
  if (value === "." || value === "..") throw new Error(`${envName} must be a tenant or database name, not ${JSON.stringify(value)}`);
  return encodeURIComponent(value);
}

/**
 * Credential resolver that allows running without a token: the node's access_token, else CHROMA_API_KEY, else null.
 *
 * @param input - `{environment, nodeToken}` (object)
 * @returns The token, or null (string | null)
 */
export function resolveOptionalToken({ environment, nodeToken }) {
  return nodeToken || readEnv(environment, CHROMA_TOKEN_ENV) || null;
}

/**
 * Custom-auth hook: sets the token header only when there is a token (the layer redacts the credential).
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Extra secrets to redact (string[])
 * @throws PluginError kind `invalid_input` - CHROMA_AUTH_HEADER is neither x-chroma-token nor authorization
 */
export function authorizeWithOptionalToken({ headers, credential, environment }) {
  if (!credential) return [];
  const headerName = (readEnv(environment, CHROMA_AUTH_HEADER_ENV) || "x-chroma-token").toLowerCase();
  if (!AUTH_HEADERS.has(headerName)) throw new PluginError(`${CHROMA_AUTH_HEADER_ENV} must be x-chroma-token or authorization`, { kind: "invalid_input" });
  headers[headerName] = headerName === "authorization" ? `Bearer ${credential}` : credential;
  return [];
}
