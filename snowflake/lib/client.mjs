/**
 * Snowflake SQL API v2 client (https://<account>.snowflakecomputing.com/api/v2/statements).
 *
 * Auth: a key-pair JWT (X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT) built from the configured private key,
 * or a node's `access_token` sent as an OAuth token (type OAUTH). The JWT, the key's passphrase and PEM text are
 * redacted from every error.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createHash } from "node:crypto";
import { buildKeyPairJwt, JWT_LIFETIME_SECONDS, loadPrivateKey } from "./key-pair-jwt.mjs";
import { readVariable, resolveSettings } from "./settings.mjs";

const KIND_BY_STATUS = { 401: "auth_error", 403: "permission_denied", 404: "not_found", 408: "api_error", 422: "invalid_input", 429: "rate_limited" };
const NOT_FOUND_CODES = new Set(["002003", "002043"]);

/**
 * Picks the credential for one run. Used as the plugin's `resolveAccessToken` hook.
 *
 * @param inputs - `{environment, nodeToken}` (object)
 * @returns `{tokenType: "OAUTH", token}` or `{tokenType: "KEYPAIR_JWT", keySource: {pemText, keyPath, passphrase}}` (object)
 * @throws PluginError kind `auth_error` - When neither a node token nor a private key is configured
 */
export function resolveSnowflakeCredentials({ environment, nodeToken }) {
  if (nodeToken) return { tokenType: "OAUTH", token: nodeToken };
  const keySource = {
    pemText: readVariable(environment, "SNOWFLAKE_PRIVATE_KEY"),
    keyPath: readVariable(environment, "SNOWFLAKE_PRIVATE_KEY_PATH"),
    passphrase: readVariable(environment, "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"),
  };
  if (!keySource.pemText && !keySource.keyPath) {
    throw new PluginError("No private key: set SNOWFLAKE_PRIVATE_KEY_PATH (PEM file) or SNOWFLAKE_PRIVATE_KEY, or pass an OAuth `access_token` on the node", { kind: "auth_error" });
  }
  return { tokenType: "KEYPAIR_JWT", keySource };
}

/**
 * Maps a Snowflake error body (`{code, message, sqlState, statementHandle}`).
 *
 * @param status - HTTP status (number)
 * @param body - Parsed body (object)
 * @returns `{message, kind}` (object)
 */
export function parseSnowflakeError(status, body) {
  // HTML pages (unknown account host, proxies) are summarized, never echoed.
  if (typeof body?.text === "string" && body.code === undefined) {
    const accountHint = status === 403 || status === 404 ? ": check SNOWFLAKE_ACCOUNT (or SNOWFLAKE_HOST); this host has no SQL API for that account" : "";
    return { message: `Snowflake answered with a non-JSON page${accountHint}`, kind: KIND_BY_STATUS[status] ?? (status >= 500 ? "api_error" : undefined) };
  }
  const detail = [body?.message, body?.code ? `code ${body.code}` : undefined, body?.sqlState ? `SQL state ${body.sqlState}` : undefined, body?.statementHandle ? `statement ${body.statementHandle}` : undefined].filter(Boolean).join(", ");
  const kind = status === 422 && NOT_FOUND_CODES.has(body?.code) ? "not_found" : (KIND_BY_STATUS[status] ?? (status >= 500 ? "api_error" : undefined));
  return { message: detail || undefined, kind };
}

/**
 * Creates the client the operations receive.
 *
 * @param runnerInputs - `{accessToken, environment, fetchImpl}`; accessToken comes from resolveSnowflakeCredentials (object)
 * @param dependencies - `{readFileImpl, now}` for tests (object, optional)
 * @returns `{settings, request, requestWithHeaders, environment}` (object)
 */
export function createSnowflakeClient({ accessToken: credentials, environment, fetchImpl }, dependencies = {}) {
  const settings = resolveSettings(environment);
  const authorize = createAuthorizer(credentials, settings, dependencies);
  const apiClient = createApiClient({ baseUrl: `https://${settings.host}`, authorize, parseError: parseSnowflakeError, fetchImpl, defaultHeaders: { "user-agent": "graphrt-snowflake/0.1.0" } });
  return { ...apiClient, settings, environment };
}

function createAuthorizer(credentials, settings, { readFileImpl, now = () => Date.now() }) {
  return async ({ headers }) => {
    if (credentials.tokenType === "OAUTH") {
      Object.assign(headers, { authorization: `Bearer ${credentials.token}`, "x-snowflake-authorization-token-type": "OAUTH" });
      return [credentials.token];
    }
    const jwt = await getCachedJwt(credentials.keySource, settings, { readFileImpl, nowMs: now() });
    Object.assign(headers, { authorization: `Bearer ${jwt}`, "x-snowflake-authorization-token-type": "KEYPAIR_JWT" });
    return [jwt, credentials.keySource.passphrase, credentials.keySource.pemText].filter(Boolean);
  };
}

// The plugin process is long-lived: one JWT (and one key read) serves every call until 5 minutes before it expires.
const cachedJwts = new Map();
const JWT_RENEW_MARGIN_MS = 5 * 60 * 1000;

async function getCachedJwt(keySource, settings, { readFileImpl, nowMs }) {
  const cacheKey = createHash("sha256").update([settings.jwtAccount, settings.user, keySource.keyPath, keySource.pemText, keySource.passphrase].map((part) => part ?? "").join("\u0000")).digest("hex");
  const cached = cachedJwts.get(cacheKey);
  if (cached && cached.expiresAtMs - JWT_RENEW_MARGIN_MS > nowMs) return cached.jwt;
  const privateKey = await loadPrivateKey(keySource, readFileImpl);
  const jwt = buildKeyPairJwt({ privateKey, jwtAccount: settings.jwtAccount, user: settings.user, nowMs });
  cachedJwts.set(cacheKey, { jwt, expiresAtMs: nowMs + JWT_LIFETIME_SECONDS * 1000 });
  return jwt;
}
