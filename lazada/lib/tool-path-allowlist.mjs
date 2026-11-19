/**
 * Read-path allowlist for `api_request` when an agent calls it as a tool. The Lazada gateway takes the API name
 * from the path, not the HTTP method, so a signed GET to a write API (e.g. /order/cancel) may be accepted; the
 * layer's GET-only rule is therefore not enough. Paths are lowercased and must match one of TOOL_READ_PATHS
 * (the client already refuses anything but plain `/segment/segment` paths, so there are no dot or encoded segments
 * to resolve). /auth/* (token APIs) never matches. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_READ_PATHS = [
  /^\/seller\/get$/,
  /^\/products\/get$/,
  /^\/product\/item\/get$/,
  /^\/orders\/get$/,
  /^\/order\/get$/,
  /^\/order\/items\/get$/,
  /^\/orders\/items\/get$/,
  /^\/finance(\/[a-z0-9_]+)*\/get$/,
];

/**
 * Whether an agent may reach this API path through api_request.
 *
 * @param path - api_request `path` (string)
 * @returns True for allowlisted read paths (boolean)
 *
 * @example
 * isToolReadPath("/finance/transaction/details/get"); // true
 * isToolReadPath("/order/cancel"); // false
 */
export function isToolReadPath(path) {
  if (typeof path !== "string" || /[?#%\\]|\/\.{1,2}(\/|$)/.test(path)) return false;
  const normalizedPath = path.toLowerCase().replace(/\/+$/, "");
  if (normalizedPath.startsWith("/auth")) return false;
  return TOOL_READ_PATHS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Returns the definition with api_request tool calls limited to isToolReadPath.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function limitToolApiPaths(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (operation.name !== "api_request") return operation;
    const run = (context) => {
      if (context.source === "tool" && !isToolReadPath(context.args?.path)) {
        throw new PluginError(`api_request cannot reach ${JSON.stringify(context.args?.path)} as an agent tool: only seller, product, order and finance reads are allowed; use a workflow node`, { kind: "permission_denied" });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
