/**
 * Zoho CRM credentials and data centers for the declarative zoho-crm plugin.
 *
 * Zoho differs from the layer's `oauth2` auth in two ways, so this is a `custom` auth:
 * - the header is `Authorization: Zoho-oauthtoken <token>`, not `Bearer`;
 * - the token URL depends on the data center (accounts.zoho.com, .eu, .in, .com.au, .jp, zohocloud.ca, .com.cn, .sa, .uk),
 *   as does the API host (www.zohoapis.<tld>). ZOHO_DATA_CENTER picks both from a fixed table, so the credential is
 *   only ever sent to Zoho hosts.
 *
 * Credentials, in order: a node's `access_token`; the refresh trio ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET +
 * ZOHO_REFRESH_TOKEN (access tokens are fetched with the shared OAuth token source, cached in memory until a minute
 * before `expires_in`, one hour at Zoho); ZOHO_ACCESS_TOKEN (a short-lived token used as is). Every secret is
 * returned to the layer for redaction.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createOAuthTokenSource } from "./shared/rest-oauth.mjs";

export const DATA_CENTER_ENV = "ZOHO_DATA_CENTER";
export const ACCESS_TOKEN_ENV = "ZOHO_ACCESS_TOKEN";
export const CLIENT_ID_ENV = "ZOHO_CLIENT_ID";
export const CLIENT_SECRET_ENV = "ZOHO_CLIENT_SECRET";
export const REFRESH_TOKEN_ENV = "ZOHO_REFRESH_TOKEN";
export const CRM_API_VERSION = "v8";
const REFRESH_TRIO = [CLIENT_ID_ENV, CLIENT_SECRET_ENV, REFRESH_TOKEN_ENV];
// https://www.zoho.com/crm/developer/docs/api/v8/multi-dc.html
const DATA_CENTERS = {
  us: { apiHost: "www.zohoapis.com", accountsHost: "accounts.zoho.com" },
  eu: { apiHost: "www.zohoapis.eu", accountsHost: "accounts.zoho.eu" },
  in: { apiHost: "www.zohoapis.in", accountsHost: "accounts.zoho.in" },
  au: { apiHost: "www.zohoapis.com.au", accountsHost: "accounts.zoho.com.au" },
  jp: { apiHost: "www.zohoapis.jp", accountsHost: "accounts.zoho.jp" },
  ca: { apiHost: "www.zohoapis.ca", accountsHost: "accounts.zohocloud.ca" },
  cn: { apiHost: "www.zohoapis.com.cn", accountsHost: "accounts.zoho.com.cn" },
  sa: { apiHost: "www.zohoapis.sa", accountsHost: "accounts.zoho.sa" },
  // accounts.zoho.uk is in Zoho's OAuth multi-DC list; the API host follows the www.zohoapis.<tld> pattern.
  uk: { apiHost: "www.zohoapis.uk", accountsHost: "accounts.zoho.uk" },
};
export const DATA_CENTER_NAMES = Object.keys(DATA_CENTERS);

const readEnv = (environment, envName) => (typeof environment?.[envName] === "string" ? environment[envName].trim() : "");

/**
 * Reads ZOHO_DATA_CENTER.
 *
 * @param environment - Environment variables (object)
 * @returns One of us, eu, in, au, jp, ca, cn, sa; `us` when unset (string)
 * @throws PluginError kind `invalid_input` - When the value is not a known data center
 */
export function readDataCenter(environment) {
  const dataCenter = readEnv(environment, DATA_CENTER_ENV).toLowerCase() || "us";
  if (!Object.hasOwn(DATA_CENTERS, dataCenter)) {
    throw new PluginError(`${DATA_CENTER_ENV} must be one of ${DATA_CENTER_NAMES.join(", ")} (the data center of your Zoho account)`, { kind: "invalid_input" });
  }
  return dataCenter;
}

/**
 * Builds the CRM API base URL (the plugin's `baseUrl` function).
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "https://www.zohoapis.eu/crm/v8" (string)
 * @throws PluginError kind `invalid_input` - Unknown data center
 */
export function buildApiBaseUrl(environment) {
  return `https://${DATA_CENTERS[readDataCenter(environment)].apiHost}/crm/${CRM_API_VERSION}`;
}

/**
 * Builds the OAuth token URL of a data center.
 *
 * @param dataCenter - From readDataCenter (string)
 * @returns e.g. "https://accounts.zoho.com/oauth/v2/token" (string)
 */
export function buildTokenUrl(dataCenter) {
  return `https://${DATA_CENTERS[dataCenter].accountsHost}/oauth/v2/token`;
}

/**
 * The definition's `resolveAccessToken`: picks the credential mode before any request.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns A token to send as is, or null when the refresh trio is used (string | null)
 * @throws PluginError kind `auth_error` - When no credential is configured (names the env vars)
 */
export function resolveZohoCredential({ environment, nodeToken }) {
  if (nodeToken) return nodeToken;
  if (REFRESH_TRIO.every((envName) => readEnv(environment, envName))) return null;
  const staticToken = readEnv(environment, ACCESS_TOKEN_ENV);
  if (staticToken) return staticToken;
  throw new PluginError(`No credential: set ${REFRESH_TRIO.join(", ")} (or a short-lived ${ACCESS_TOKEN_ENV}) and allow them in permissions.env`, { kind: "auth_error" });
}

/**
 * Builds the `auth` spec for defineRestPlugin.
 *
 * @returns `{type: "custom", env, authorize}` (object)
 *
 * @example
 * defineRestPlugin({ ..., auth: createZohoAuth() });
 */
export function createZohoAuth() {
  return {
    type: "custom",
    env: ACCESS_TOKEN_ENV,
    authorize: async ({ headers, credential, environment }) => {
      if (credential) {
        headers.authorization = `Zoho-oauthtoken ${credential}`;
        return [];
      }
      const tokenSource = createRefreshTokenSource(environment);
      headers.authorization = `Zoho-oauthtoken ${await tokenSource.getAccessToken()}`;
      return tokenSource.listSecrets();
    },
  };
}

function createRefreshTokenSource(environment) {
  const oauthSpec = {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl: buildTokenUrl(readDataCenter(environment)),
    clientIdEnv: CLIENT_ID_ENV,
    clientSecretEnv: CLIENT_SECRET_ENV,
    refreshTokenEnv: REFRESH_TOKEN_ENV,
  };
  // Read globalThis.fetch per request so tests can replace it.
  return createOAuthTokenSource(oauthSpec, environment, (...fetchArguments) => globalThis.fetch(...fetchArguments));
}

/**
 * Retries an operation once with a fresh token when Zoho answers INVALID_TOKEN to a cached access token from the
 * refresh trio (e.g. revoked before its expiry). The 401 means nothing was applied, so a write may be repeated.
 *
 * @param operation - Operation from defineRestPlugin (object)
 * @returns Operation with the same interface (object)
 */
export function retryAfterExpiredToken(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (error) {
        if (!isExpiredTokenError(error) || !usesRefreshTrio(context)) throw error;
        await createRefreshTokenSource(context.environment).refresh();
        return operation.run(context);
      }
    },
  };
}

function isExpiredTokenError(error) {
  return error?.kind === "auth_error" && /\(INVALID_TOKEN\)/.test(String(error.message));
}

function usesRefreshTrio({ environment, args, source }) {
  const nodeToken = source === "node" ? args?.access_token : undefined;
  return !nodeToken && REFRESH_TRIO.every((envName) => readEnv(environment, envName));
}

/**
 * Adds the Zoho credential resolver and env to a definition made by defineRestPlugin.
 *
 * @param definition - Plugin definition (object)
 * @returns Definition that accepts any of the Zoho credentials (object)
 */
export function withZohoCredentials(definition) {
  return {
    ...definition,
    resolveAccessToken: resolveZohoCredential,
    extraEnv: [...new Set([...definition.extraEnv, ...REFRESH_TRIO, DATA_CENTER_ENV])],
    operations: definition.operations.map(retryAfterExpiredToken),
  };
}
