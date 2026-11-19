/**
 * Salesforce org settings for the declarative salesforce plugin: the instance URL, the REST API version and the
 * OAuth grant and token URL, all read from the environment.
 *
 * The declarative layer takes a fixed OAuth token URL and grant, but Salesforce's depend on the org: a refresh
 * token can be redeemed at login.salesforce.com (test.salesforce.com for sandboxes) or the org's My Domain, while
 * the client credentials flow only works at the My Domain. So the plugin defines its spec once per (grant, token
 * URL) and routes each run's client and credential check to the matching definition (the same pattern as
 * microsoft-graph's lib/graph-tenant.mjs). Every URL from the environment must be an https Salesforce host
 * (`*.salesforce.com`, which covers `*.my.salesforce.com` and sandboxes) with no path, so the credential is never
 * sent elsewhere.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { defineRestPlugin } from "./shared/rest-plugin.mjs";

export const INSTANCE_URL_ENV = "SALESFORCE_INSTANCE_URL";
export const LOGIN_URL_ENV = "SALESFORCE_LOGIN_URL";
export const API_VERSION_ENV = "SALESFORCE_API_VERSION";
export const CLIENT_ID_ENV = "SALESFORCE_CLIENT_ID";
export const CLIENT_SECRET_ENV = "SALESFORCE_CLIENT_SECRET";
export const REFRESH_TOKEN_ENV = "SALESFORCE_REFRESH_TOKEN";
export const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
// Spring '26. Every org runs it; set SALESFORCE_API_VERSION for newer (or older) versions.
export const DEFAULT_API_VERSION = "v66.0";
export const SALESFORCE_HOST_SUFFIX = ".salesforce.com";
const API_VERSION_PATTERN = /^v?(\d{2,3})(?:\.0)?$/;
const LOCATOR_IN_URL_PATTERN = /\/query(?:All)?\/([^/?#]+)$/;

const refuseConfiguration = (message) => {
  throw new PluginError(message, { kind: "invalid_input" });
};

/**
 * Reads an env URL that must be the origin of an https Salesforce host.
 *
 * @param value - e.g. "https://acme.my.salesforce.com" (string)
 * @param envName - Env name for the message (string)
 * @returns The origin, without a trailing slash (string)
 * @throws PluginError kind `invalid_input` - Not https, not a *.salesforce.com host, or with a path, port, query or user info
 *
 * @example
 * readSalesforceOrigin("https://acme.my.salesforce.com/", "SALESFORCE_INSTANCE_URL"); // "https://acme.my.salesforce.com"
 */
export function readSalesforceOrigin(value, envName) {
  const problem = `${envName} must be your org's https Salesforce URL with no path, e.g. https://acme.my.salesforce.com`;
  let parsedUrl;
  try {
    parsedUrl = new URL(String(value).trim());
  } catch {
    return refuseConfiguration(problem);
  }
  const hasExtras = parsedUrl.port || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== "/";
  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(SALESFORCE_HOST_SUFFIX) || hasExtras) refuseConfiguration(problem);
  return parsedUrl.origin;
}

/**
 * Reads SALESFORCE_API_VERSION.
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "v66.0" (string)
 * @throws PluginError kind `invalid_input` - When the value is not a version like 66.0 or v66.0
 */
export function readApiVersion(environment) {
  const configured = environment?.[API_VERSION_ENV]?.trim();
  if (!configured) return DEFAULT_API_VERSION;
  const match = API_VERSION_PATTERN.exec(configured);
  if (!match) refuseConfiguration(`${API_VERSION_ENV} must be a REST API version like v66.0`);
  return `v${match[1]}.0`;
}

/**
 * Builds the REST base URL from the environment (the plugin's `baseUrl` function).
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "https://acme.my.salesforce.com/services/data/v66.0" (string)
 * @throws Error - When SALESFORCE_INSTANCE_URL is unset or invalid (the layer reports it as invalid_input)
 */
export function buildInstanceBaseUrl(environment) {
  const instanceUrl = environment?.[INSTANCE_URL_ENV]?.trim();
  if (!instanceUrl) throw new Error(`set ${INSTANCE_URL_ENV} to your org's URL, e.g. https://acme.my.salesforce.com`);
  return `${readSalesforceOrigin(instanceUrl, INSTANCE_URL_ENV)}/services/data/${readApiVersion(environment)}`;
}

/**
 * Picks the OAuth grant and token URL: the refresh token flow when SALESFORCE_REFRESH_TOKEN is set (or when nothing
 * is set, so the missing-credential error names it), otherwise the client credentials flow. The token URL is
 * SALESFORCE_LOGIN_URL, else login.salesforce.com for refresh tokens and the instance URL (My Domain) for client
 * credentials.
 *
 * @param environment - Environment variables (object)
 * @returns `{grant, tokenUrl}` (object)
 * @throws PluginError kind `invalid_input` - When a configured URL is not a Salesforce host
 */
export function readOAuthVariant(environment) {
  const readEnv = (envName) => environment?.[envName]?.trim() || undefined;
  const grant = readEnv(REFRESH_TOKEN_ENV) || !readEnv(CLIENT_ID_ENV) ? "refresh_token" : "client_credentials";
  const loginUrl = readEnv(LOGIN_URL_ENV) ? readSalesforceOrigin(readEnv(LOGIN_URL_ENV), LOGIN_URL_ENV) : undefined;
  const instanceUrl = grant === "client_credentials" && readEnv(INSTANCE_URL_ENV) ? readSalesforceOrigin(readEnv(INSTANCE_URL_ENV), INSTANCE_URL_ENV) : undefined;
  return { grant, tokenUrl: `${loginUrl ?? instanceUrl ?? DEFAULT_LOGIN_URL}/services/oauth2/token` };
}

/**
 * Takes a query locator, or the `nextRecordsUrl` of a query response, and returns the locator.
 *
 * @param value - "01g...-2000" or "/services/data/v66.0/query/01g...-2000" (string)
 * @returns The locator; values that are neither are returned unchanged for the path checks (string)
 */
export function extractQueryLocator(value) {
  const text = String(value ?? "").trim();
  return LOCATOR_IN_URL_PATTERN.exec(text)?.[1] ?? text;
}

/**
 * Defines the plugin from a spec builder and routes each run (client and credential check) to the definition of
 * the environment's OAuth variant.
 *
 * @param buildSpec - `({grant, tokenUrl}) => spec` for defineRestPlugin (function)
 * @returns Plugin definition; `restSpec` uses the default variant (refresh token at login.salesforce.com) (object)
 */
export function defineOrgAwarePlugin(buildSpec) {
  const definitionsByVariant = new Map();
  const definitionFor = (variant) => {
    const variantKey = `${variant.grant}\n${variant.tokenUrl}`;
    if (!definitionsByVariant.has(variantKey)) definitionsByVariant.set(variantKey, defineRestPlugin(buildSpec(variant)));
    return definitionsByVariant.get(variantKey);
  };
  const defaultDefinition = definitionFor(readOAuthVariant({}));
  return {
    ...defaultDefinition,
    resolveAccessToken: (options) => definitionFor(readOAuthVariant(options.environment)).resolveAccessToken(options),
    createClient: (clientOptions) => definitionFor(readOAuthVariant(clientOptions.environment)).createClient(clientOptions),
  };
}
