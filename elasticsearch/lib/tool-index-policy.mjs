/**
 * Index checks for agent tools beyond the `index` argument (see restrictToolIndexNames):
 *   - restrictToolApiRequestIndices: api_request paths may not name a system/hidden index anywhere, also inside a
 *     comma-separated list (`/logs,.security-7/_search`) or behind a `cluster:` prefix, and may only widen wildcards
 *     with `expand_wildcards` open/closed (hidden/all would let `*` match `.security*`);
 *   - restrictToolEsql: with ELASTICSEARCH_TOOL_ALLOW_ESQL=1, the sources of FROM, TS and LOOKUP JOIN must pass the same
 *     index check, and no name in the query may start with a dot.
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { isRestrictedIndexName } from "./elasticsearch-extras.mjs";
import { decodePathRepeatedly, normalizeApiPath } from "./tool-path-policy.mjs";

export const ESQL_OPT_IN_ENV = "ELASTICSEARCH_TOOL_ALLOW_ESQL";
const ALLOWED_EXPAND_WILDCARDS = new Set(["open", "closed"]);
// Cypher-style tricks apply to ES|QL too: control and non-ASCII characters are treated as separators before matching.
const NON_PRINTABLE_ASCII = /[^\x21-\x7e]/g;
const COMMENTS = /\/\*[\s\S]*?(\*\/|$)|\/\/[^\n\r]*/g;
// A name that starts with a dot right after a separator: `.security`, `".kibana"`, `remote:.tasks`, `` `.x` ``.
const DOT_NAME = /(^|[\s,"'`:(|=[<])\.[A-Za-z0-9_*\-]/;
// Endpoints of the tool allowlist that accept expand_wildcards (normalized paths; see withOpenClosedWildcards).
const INDEX_SEGMENT = "[^/_][^/]*";
const WILDCARD_ENDPOINTS = [
  "/_cat/(indices|aliases)(/[^/]+)?",
  "/_cluster/health(/[^/]+)?",
  "/_(alias|aliases|mapping|settings|stats|field_caps|search|count)",
  "/_resolve/index/[^/]+",
  `/${INDEX_SEGMENT}`,
  `/${INDEX_SEGMENT}/_(mapping|settings|alias|count|search|stats|field_caps)`,
].map((pattern) => new RegExp(`^${pattern}$`));
const SOURCE_LIST =/\b(?:FROM|TS|JOIN)\s+(.*?)(?=\||\sMETADATA\s|\sON\s|$)/gis;

const refuse = (message) => {
  throw new PluginError(message, { kind: "permission_denied" });
};

/**
 * Returns the definition with tool api_request calls refused when the path names a restricted index or the query
 * widens wildcards beyond open/closed.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function restrictToolApiRequestIndices(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (operation.name !== "api_request") return operation;
    const run = (context) => {
      if (context.source !== "tool" || typeof context.args?.path !== "string") return operation.run(context);
      assertPathIndicesAllowed(context.args.path);
      assertExpandWildcardsAllowed(context.args.path, context.args.query);
      return operation.run({ ...context, args: withOpenClosedWildcards(context.args) });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Adds `expand_wildcards=open,closed` to a tool api_request on an endpoint that lists or expands index names, when
 * the caller set none. Several of them (`_cat/indices`, `_cat/aliases`, `_alias`, `_cluster/health`) default to
 * `all`, which would list hidden and system index names.
 *
 * @param args - api_request arguments `{path, query}` (object)
 * @returns The arguments, with the default added where it applies (object)
 *
 * @example
 * withOpenClosedWildcards({ path: "/_cat/indices" }).query; // { expand_wildcards: "open,closed" }
 */
export function withOpenClosedWildcards(args) {
  const normalizedPath = normalizeApiPath(args.path);
  if (!WILDCARD_ENDPOINTS.some((pattern) => pattern.test(normalizedPath)) || hasExpandWildcards(args.path, args.query)) return args;
  return { ...args, query: { ...args.query, expand_wildcards: "open,closed" } };
}

function hasExpandWildcards(rawPath, query) {
  const queryText = String(rawPath).split("#")[0].split("?").slice(1).join("&");
  const pathKeys = [...new URLSearchParams(queryText).keys()].map(decodePathRepeatedly);
  return pathKeys.includes("expand_wildcards") || Object.hasOwn(query ?? {}, "expand_wildcards");
}

/**
 * Refuses a path with a restricted index in any comma-separated list or behind a `cluster:` prefix.
 *
 * @param rawPath - api_request path, possibly with a query (string)
 * @throws PluginError kind `permission_denied` - When a restricted name is found
 */
export function assertPathIndicesAllowed(rawPath) {
  for (const segment of normalizeApiPath(rawPath).split("/").filter(Boolean)) {
    const names = segment.split(",");
    const checked = names.length > 1 ? names : names.filter((name) => /[:<>]/.test(name));
    const restricted = checked.find(isRestrictedIndexName);
    if (restricted !== undefined) refuse(`api_request as an agent tool cannot name the index \`${restricted.trim()}\`: system/hidden (\`.\`) and \`_\` names are node only`);
  }
}

/**
 * Refuses expand_wildcards values other than open/closed, in the query object or the path's query string.
 *
 * @param rawPath - api_request path (string)
 * @param query - api_request query object (object, optional)
 * @throws PluginError kind `permission_denied` - When hidden, all or none is asked for
 */
export function assertExpandWildcardsAllowed(rawPath, query) {
  const values = [];
  const queryText = String(rawPath).split("#")[0].split("?").slice(1).join("&");
  for (const [key, value] of new URLSearchParams(queryText)) if (decodePathRepeatedly(key) === "expand_wildcards") values.push(value);
  for (const [key, value] of Object.entries(query ?? {})) if (key === "expand_wildcards") values.push(...[value].flat());
  const refused = values.flatMap((value) => String(value).split(",")).map((value) => decodePathRepeatedly(value).trim().toLowerCase()).find((value) => !ALLOWED_EXPAND_WILDCARDS.has(value));
  if (refused !== undefined) refuse(`api_request as an agent tool may only use expand_wildcards open or closed, not \`${refused}\` (hidden indices are node only)`);
}

/**
 * Refuses an ES|QL query that reads a restricted index.
 *
 * @param esqlQuery - ES|QL text (string)
 * @throws PluginError kind `permission_denied` - When a source is a system/hidden or `_` index, or a dot name appears
 *
 * @example
 * assertEsqlSourcesAllowed("FROM logs-* | LIMIT 5"); // passes
 */
export function assertEsqlSourcesAllowed(esqlQuery) {
  const spaced = String(esqlQuery).replace(NON_PRINTABLE_ASCII, " ");
  const withoutComments = spaced.replace(COMMENTS, " ");
  if (DOT_NAME.test(spaced) || DOT_NAME.test(withoutComments)) refuse("`esql_query` as an agent tool cannot read system/hidden indices (names starting with `.`)");
  for (const [, sourceList] of withoutComments.matchAll(SOURCE_LIST)) {
    const restricted = sourceList.split(",").map((name) => name.replace(/["`]/g, "").trim()).filter(Boolean).find(isRestrictedIndexName);
    if (restricted !== undefined) refuse(`\`esql_query\` as an agent tool cannot read the index \`${restricted}\`: system/hidden (\`.\`) and \`_\` names are node only`);
  }
}

/**
 * Returns the definition with opted-in tool ES|QL queries checked by assertEsqlSourcesAllowed. Without the opt-in the
 * layer's toolPolicy refusal applies.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function restrictToolEsql(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (operation.name !== "esql_query") return operation;
    const run = (context) => {
      if (context.source === "tool" && context.environment?.[ESQL_OPT_IN_ENV] === "1") assertEsqlSourcesAllowed(context.args?.query);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
