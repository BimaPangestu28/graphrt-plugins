/**
 * Qontak credentials and hosts. Two schemes exist:
 *
 * - "hmac" (Qontak's current recommendation, used whenever QONTAK_CLIENT_ID and QONTAK_CLIENT_SECRET are set):
 *   a Mekari Developer application signs each request (lib/mekari-hmac.mjs) on the api.mekari.com gateway:
 *   chat at https://api.mekari.com/qontak/chat/v1, CRM at https://api.mekari.com/qontak/crm. CRM requests also get
 *   X-Crm-User-Sso-Id when QONTAK_CRM_USER_SSO_ID is set (the CRM user the action is done as).
 * - "bearer" (the older hosts): QONTAK_CHAT_TOKEN (Omnichannel API token, valid one year) on
 *   https://service-chat.qontak.com/api/open/v1 and QONTAK_CRM_TOKEN (CRM API token) on
 *   https://app.qontak.com/api/v3.1.
 *
 * QONTAK_AUTH_MODE (hmac | bearer) forces one. A node's `access_token` is a bearer token, so it is only accepted in
 * bearer mode (it replaces QONTAK_CHAT_TOKEN / QONTAK_CRM_TOKEN); in HMAC mode it is refused, because the gateway
 * expects signed requests and would only reject it. Every secret
 * (client secret, signatures, tokens) is returned to the layer for redaction.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { signMekariRequest } from "./mekari-hmac.mjs";

export const CLIENT_ID_ENV = "QONTAK_CLIENT_ID";
export const CLIENT_SECRET_ENV = "QONTAK_CLIENT_SECRET";
export const CHAT_TOKEN_ENV = "QONTAK_CHAT_TOKEN";
export const CRM_TOKEN_ENV = "QONTAK_CRM_TOKEN";
export const AUTH_MODE_ENV = "QONTAK_AUTH_MODE";
export const CRM_USER_SSO_ID_ENV = "QONTAK_CRM_USER_SSO_ID";
export const QONTAK_AUTH_ENV = [CLIENT_ID_ENV, CHAT_TOKEN_ENV, CRM_TOKEN_ENV, AUTH_MODE_ENV, CRM_USER_SSO_ID_ENV];

const BASE_URLS = {
  hmac: { chat: "https://api.mekari.com/qontak/chat/v1", crm: "https://api.mekari.com/qontak/crm" },
  bearer: { chat: "https://service-chat.qontak.com/api/open/v1", crm: "https://app.qontak.com/api/v3.1" },
};
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SSO_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const readEnv = (environment, envName) => (typeof environment?.[envName] === "string" ? environment[envName].trim() : "");

/**
 * Which scheme the environment configures.
 *
 * @param environment - Environment variables (object)
 * @returns "hmac" or "bearer" (string)
 * @throws Error - QONTAK_AUTH_MODE is neither hmac nor bearer
 */
export function resolveAuthMode(environment) {
  const forcedMode = readEnv(environment, AUTH_MODE_ENV).toLowerCase();
  if (forcedMode !== "" && !Object.hasOwn(BASE_URLS, forcedMode)) throw new Error(`${AUTH_MODE_ENV} must be hmac or bearer`);
  if (forcedMode) return forcedMode;
  return readEnv(environment, CLIENT_ID_ENV) && readEnv(environment, CLIENT_SECRET_ENV) ? "hmac" : "bearer";
}

/**
 * Base URL of one product for the configured scheme (used as `baseUrl` functions).
 *
 * @param product - "chat" or "crm" (string)
 * @returns `(environment) => url` (function)
 */
export function baseUrlFor(product) {
  return (environment) => BASE_URLS[resolveAuthMode(environment)][product];
}

const isCrmUrl = (url) => {
  const parsedUrl = new URL(url);
  return parsedUrl.pathname.startsWith("/qontak/crm/") || parsedUrl.host === "app.qontak.com";
};

/**
 * The definition's `resolveAccessToken`: refuses a run without any credential; passes a node token on.
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns The node token, or null (string | null)
 * @throws PluginError kind `auth_error` - Neither the HMAC pair nor a bearer token is set
 * @throws PluginError kind `invalid_input` - A node token in HMAC mode, or an unknown QONTAK_AUTH_MODE
 */
export function resolveQontakNodeToken({ environment, nodeToken }) {
  const mode = resolveSafeMode(environment);
  if (nodeToken && mode === "hmac") {
    throw new PluginError(
      `A node access_token is a bearer token, but Qontak is in HMAC mode (${CLIENT_ID_ENV} + ${CLIENT_SECRET_ENV} set): remove access_token, or set ${AUTH_MODE_ENV}=bearer to use it on the older hosts`,
      { kind: "invalid_input" },
    );
  }
  if (nodeToken) return nodeToken;
  if (mode === "hmac" && readEnv(environment, CLIENT_ID_ENV) && readEnv(environment, CLIENT_SECRET_ENV)) return null;
  if (mode === "bearer" && (readEnv(environment, CHAT_TOKEN_ENV) || readEnv(environment, CRM_TOKEN_ENV))) return null;
  throw new PluginError(
    `No Qontak credentials: set ${CLIENT_ID_ENV} + ${CLIENT_SECRET_ENV} (Mekari API HMAC, recommended) or ${CHAT_TOKEN_ENV} / ${CRM_TOKEN_ENV} (bearer tokens), and allow them in permissions.env`,
    { kind: "auth_error" },
  );
}

function resolveSafeMode(environment) {
  try {
    return resolveAuthMode(environment);
  } catch (modeError) {
    throw new PluginError(modeError.message, { kind: "invalid_input" });
  }
}

function authorizeBearer({ url, headers, environment }) {
  const tokenEnv = isCrmUrl(url) ? CRM_TOKEN_ENV : CHAT_TOKEN_ENV;
  const token = readEnv(environment, tokenEnv);
  if (!token) throw new PluginError(`No credential for this Qontak product: set ${tokenEnv}`, { kind: "auth_error" });
  headers.authorization = `Bearer ${token}`;
  return [token];
}

function authorizeHmac({ method, url, headers, body, environment }) {
  const clientSecret = readEnv(environment, CLIENT_SECRET_ENV);
  const bodyText = BODY_METHODS.has(method.toUpperCase()) && typeof body === "string" ? body : undefined;
  const { date, authorization, signature, digest } = signMekariRequest({ method, url, clientId: readEnv(environment, CLIENT_ID_ENV), clientSecret, date: new Date(), body: bodyText });
  headers.date = date;
  headers.authorization = authorization;
  if (digest) headers.digest = digest;
  const ssoId = readEnv(environment, CRM_USER_SSO_ID_ENV);
  if (ssoId && isCrmUrl(url)) {
    if (!SSO_ID_PATTERN.test(ssoId)) throw new PluginError(`${CRM_USER_SSO_ID_ENV} must be the user's SSO id (letters, digits and -)`, { kind: "invalid_input" });
    headers["x-crm-user-sso-id"] = ssoId;
  }
  return [clientSecret, signature];
}

/**
 * The layer's `custom` auth spec.
 *
 * @returns `{type: "custom", env, authorize}` (object)
 */
export function createQontakAuth() {
  return {
    type: "custom",
    env: CLIENT_SECRET_ENV,
    authorize: (request) => {
      if (request.credential) {
        request.headers.authorization = `Bearer ${request.credential}`;
        return [request.credential];
      }
      return resolveSafeMode(request.environment) === "hmac" ? authorizeHmac(request) : authorizeBearer(request);
    },
  };
}
