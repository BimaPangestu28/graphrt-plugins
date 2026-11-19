/**
 * Elasticsearch-specific pieces of the declarative plugin:
 *   - resolveClusterUrl: ELASTICSEARCH_URL validation (https, or http on localhost; no credentials, query or fragment);
 *   - authorizeElasticsearch: `Authorization: ApiKey` from ELASTICSEARCH_API_KEY (or a node's access_token), else Basic
 *     from ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD, else nothing (a local cluster without security);
 *   - restrictToolIndexNames: agent tools may not name system/hidden indices (`.security`, `.kibana`, ...) or
 *     underscore names that would turn an index path into another API (`_security`, `_nodes`). Workflow nodes are
 *     unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { decodePathRepeatedly } from "./tool-path-policy.mjs";

export const API_KEY_ENV = "ELASTICSEARCH_API_KEY";
export const USERNAME_ENV = "ELASTICSEARCH_USERNAME";
export const PASSWORD_ENV = "ELASTICSEARCH_PASSWORD";
export const URL_ENV = "ELASTICSEARCH_URL";
const DEFAULT_CLUSTER_URL = "http://localhost:9200";
// Index component selectors documented for multi-target expressions (data streams' failure store).
const ALLOWED_SELECTORS = new Set(["data", "failures"]);

/**
 * Resolves the cluster URL from ELASTICSEARCH_URL (default http://localhost:9200).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 * @throws Error - When the URL is not http(s), or has credentials, a query or a fragment
 *
 * @example
 * resolveClusterUrl({ ELASTICSEARCH_URL: "https://my-deploy.es.us-east-1.aws.elastic.cloud/" }); // "https://my-deploy.es.us-east-1.aws.elastic.cloud"
 */
export function resolveClusterUrl(environment) {
  const configuredUrl = environment[URL_ENV]?.trim() || DEFAULT_CLUSTER_URL;
  const parsedUrl = new URL(configuredUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error(`${URL_ENV} must be an https:// URL (http:// only on localhost)`);
  if (parsedUrl.username || parsedUrl.password) throw new Error(`${URL_ENV} must not contain credentials; use ${API_KEY_ENV} or ${USERNAME_ENV}/${PASSWORD_ENV}`);
  if (parsedUrl.search || parsedUrl.hash) throw new Error(`${URL_ENV} must not have a query or fragment`);
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, "")}`;
}

/**
 * Custom auth hook: ApiKey first, then Basic, then no header.
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Secrets to redact (string[])
 * @throws PluginError kind `auth_error` - When only one of username/password is set
 */
export function authorizeElasticsearch({ headers, credential, environment }) {
  const apiKey = credential || environment?.[API_KEY_ENV]?.trim();
  if (apiKey) {
    headers.authorization = `ApiKey ${apiKey}`;
    return [apiKey];
  }
  const username = environment?.[USERNAME_ENV]?.trim();
  const password = environment?.[PASSWORD_ENV];
  if (!username && !password) return [];
  if (!username || !password) {
    throw new PluginError(`Set both ${USERNAME_ENV} and ${PASSWORD_ENV} for basic auth (or ${API_KEY_ENV})`, { kind: "auth_error" });
  }
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  headers.authorization = `Basic ${encoded}`;
  return [encoded, password, encodeURIComponent(password)];
}

/**
 * Splits one index expression into `[cluster:]name[::selector]`, after percent-decoding it until stable.
 *
 * @param indexExpression - One comma-separated entry, e.g. "remote:logs-*::failures" (string)
 * @returns `{exclusion, cluster, name, selector}`; cluster and selector are undefined when absent (object)
 *
 * @example
 * parseIndexExpression(".security-7::data"); // { exclusion: false, cluster: undefined, name: ".security-7", selector: "data" }
 */
export function parseIndexExpression(indexExpression) {
  const entry = decodePathRepeatedly(String(indexExpression)).trim();
  const exclusion = entry.startsWith("-");
  const expression = exclusion ? entry.slice(1) : entry;
  const selectorAt = expression.indexOf("::");
  const target = selectorAt < 0 ? expression : expression.slice(0, selectorAt);
  const selector = selectorAt < 0 ? undefined : expression.slice(selectorAt + 2);
  const clusterAt = target.lastIndexOf(":");
  const cluster = clusterAt < 0 ? undefined : target.slice(0, clusterAt);
  return { exclusion, cluster, name: target.slice(clusterAt + 1), selector };
}

/**
 * Whether one index expression is off limits for agent tools:
 *   - dot (system/hidden) indices and `_` names other than `_all`, also behind a `cluster:` prefix or before a
 *     `::selector` suffix (`.security-7::data`, `remote:.security::failures`);
 *   - selectors other than `::data` and `::failures` (the only documented ones), and an empty name or selector;
 *   - date-math names (`<.security-{now}>`, also percent-encoded): their static prefix is not checked, so they are
 *     refused outright.
 * Exclusions (`-logs-old`) only narrow a search, so the dot/underscore check skips them.
 *
 * @param indexExpression - One comma-separated entry, e.g. "logs-*", ".security-7", "remote:.kibana" (string)
 * @returns Whether the entry is refused (boolean)
 *
 * @example
 * isRestrictedIndexName("remote:.security"); // true
 * isRestrictedIndexName("logs-*::failures"); // false
 */
export function isRestrictedIndexName(indexExpression) {
  const decoded = decodePathRepeatedly(String(indexExpression));
  if (/[<>]/.test(decoded)) return true;
  const { exclusion, cluster, name, selector } = parseIndexExpression(decoded);
  if (selector !== undefined && (!ALLOWED_SELECTORS.has(selector.toLowerCase()) || name === "")) return true;
  if (cluster !== undefined && name === "") return true;
  if (exclusion) return false;
  if (name.startsWith(".")) return true;
  return name.startsWith("_") && name !== "_all";
}

/**
 * Returns the definition with tool calls refusing restricted names in the `index` argument.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @returns A new definition (object)
 */
export function restrictToolIndexNames(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (!operation.parameters?.properties?.index) return operation;
    const run = (context) => {
      if (context.source === "tool") assertToolIndexAllowed(context.args?.index, operation.name);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function assertToolIndexAllowed(indexArgument, operationName) {
  if (typeof indexArgument !== "string") return;
  const restricted = indexArgument.split(",").find(isRestrictedIndexName);
  if (restricted === undefined) return;
  throw new PluginError(
    `\`${operationName}\` as an agent tool cannot use the index \`${restricted.trim()}\`: system/hidden (\`.\`) and \`_\` names are node only`,
    { kind: "permission_denied" },
  );
}
