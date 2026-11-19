/**
 * Query limits for the generated `api_request` when an agent calls it as a tool.
 *
 * WordPress turns a GET into any other request through query parameters: `_method=POST|PUT|DELETE` (also spelled
 * `.method`, ` method` or `[method`, which PHP rewrites to `_method`) overrides the HTTP method, and `rest_route`
 * selects another REST route. A GET to `/orders/42/refunds?_method=POST&amount=10` is a real refund. So for tool
 * calls the `path` may not carry a query string at all, and `query` keys must come from an ALLOWLIST of read
 * filters (a denylist would miss PHP's name rewriting). api_request takes no headers, so `X-HTTP-Method-Override`
 * cannot be sent. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_QUERY_KEYS = new Set([
  "per_page",
  "page",
  "search",
  "status",
  "orderby",
  "order",
  "after",
  "before",
  "include",
  "exclude",
  "sku",
  "category",
  "customer",
  "product",
  "parent",
  "offset",
  "context",
]);

function refuse(problem) {
  throw new PluginError(`api_request as an agent tool: ${problem}; use a dedicated operation or a workflow node`, { kind: "permission_denied" });
}

function decodeFully(text) {
  let decodedText = text;
  for (let round = 0; round < 5; round += 1) {
    let nextText;
    try {
      nextText = decodeURIComponent(decodedText);
    } catch {
      return decodedText;
    }
    if (nextText === decodedText) break;
    decodedText = nextText;
  }
  return decodedText;
}

/**
 * Checks an api_request tool call: no query or fragment in `path`, and only allowlisted `query` keys.
 *
 * @param args - api_request arguments `{path, query}` (object)
 * @throws PluginError kind `permission_denied` - A query in the path or a key outside TOOL_QUERY_KEYS
 */
export function assertToolQueryAllowed(args) {
  if (typeof args.path === "string" && /[?#]/.test(decodeFully(args.path))) refuse("`path` may not contain a query string; pass read filters in `query`");
  if (args.query === undefined || args.query === null) return;
  if (typeof args.query !== "object" || Array.isArray(args.query)) refuse("`query` must be an object");
  const refusedKey = Object.keys(args.query).find((key) => !TOOL_QUERY_KEYS.has(key));
  if (refusedKey !== undefined) refuse(`query key ${JSON.stringify(refusedKey)} is not allowed (allowed: ${[...TOOL_QUERY_KEYS].join(", ")})`);
}

/**
 * Returns the definition with api_request tool calls checked by assertToolQueryAllowed.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function limitToolApiQuery(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (operation.name !== "api_request") return operation;
    const run = (context) => {
      if (context.source === "tool") assertToolQueryAllowed(context.args ?? {});
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
