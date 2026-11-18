/**
 * Turns validated operation arguments into a shared-client request for a declarative REST operation:
 * path params (each encoded as one segment), query params, header params, a JSON / form / raw body, and the
 * generated `limit`/`cursor` mapped to the API's own pagination names.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { writePath } from "./object-path.mjs";
import { pathSegment } from "./path.mjs";

const READ_METHODS = new Set(["GET", "HEAD"]);
const IDEMPOTENT_FLAGS = { read: undefined, idempotent: true, unsafe: false };

/**
 * Builds the request for one operation call.
 *
 * @param operation - Normalized operation spec (object)
 * @param args - Arguments validated against the operation's schema (object)
 * @returns `{method, path, query, headers, json?, form?, idempotent}` for client.request (object)
 * @throws PluginError kind `invalid_input` - A path param is "." / ".." or a cursor is malformed
 */
export function buildRestRequest(operation, args) {
  const request = { method: operation.method, path: fillPathTemplate(operation.path, args), query: {}, headers: {}, idempotent: IDEMPOTENT_FLAGS[operation.write] };
  const body = {};
  for (const [paramName, paramSpec] of Object.entries(operation.params)) {
    if (paramSpec.in === "path" || args[paramName] === undefined) continue;
    placeParam(request, body, paramSpec, args[paramName], paramName);
  }
  applyPaginationInput(operation, args, request, body);
  attachBody(operation, request, body, args);
  if (operation.timeoutMs) request.timeoutMs = operation.timeoutMs;
  return request;
}

/**
 * Replaces `{name}` placeholders with encoded values.
 *
 * @param pathTemplate - e.g. "/repos/{owner}/{repo}" (string)
 * @param values - `{name: value}` (object)
 * @returns Path with each value encoded as one segment (string)
 * @throws PluginError kind `invalid_input` - A value is empty, "." or ".."
 */
export function fillPathTemplate(pathTemplate, values) {
  return pathTemplate.replace(/\{([^{}]+)\}/g, (placeholder, placeholderName) => pathSegment(values[placeholderName]));
}

function placeParam(request, body, paramSpec, value, paramName) {
  const wireName = paramSpec.wireName ?? paramName;
  if (paramSpec.in === "query") request.query[wireName] = value;
  if (paramSpec.in === "header") request.headers[wireName.toLowerCase()] = String(value);
  if (paramSpec.in === "body") writePath(body, wireName, value);
}

function attachBody(operation, request, body, args) {
  if (READ_METHODS.has(operation.method)) return;
  if (operation.bodyMode === "raw") {
    const rawParamName = Object.keys(operation.params).find((paramName) => operation.params[paramName].in === "body");
    if (args[rawParamName] !== undefined) request.json = args[rawParamName];
    return;
  }
  // An operation that declares a body (params or pagination) always sends one, `{}` when every field is omitted.
  const declaresBody = Object.values(operation.params).some((paramSpec) => paramSpec.in === "body") || operation.pagination?.paramsIn === "body";
  if (!declaresBody && Object.keys(body).length === 0) return;
  if (operation.bodyMode === "form") request.form = body;
  else request.json = body;
}

function applyPaginationInput(operation, args, request, body) {
  const response = operation.response;
  if (!operation.pagination) return;
  const place = (wireName, value) => {
    if (value === undefined || !wireName) return;
    if (operation.pagination.paramsIn === "body") writePath(body, wireName, value);
    else request.query[wireName] = value;
  };
  const paginationInputs = {
    cursor: () => (place(response.cursorParam, args.cursor), place(response.limitParam, args.limit)),
    link: () => applyLinkCursor(request, args, place, response),
    page: () => {
      place(response.pagePagination.pageParam, parsePageCursor(args.cursor, response.pagePagination.firstPage ?? 1));
      place(response.pagePagination.sizeParam, args.limit);
    },
    offset: () => (place(response.offsetPagination.offsetParam, parsePageCursor(args.cursor, 0)), place(response.offsetPagination.limitParam, args.limit)),
  };
  paginationInputs[operation.pagination.style]();
}

// The next link already carries every query parameter, so it replaces the path and query.
function applyLinkCursor(request, args, place, response) {
  if (args.cursor === undefined) return place(response.limitParam, args.limit);
  if (!/^https:\/\//i.test(args.cursor)) throw new PluginError("`cursor` must be the next-page URL returned as next_cursor", { kind: "invalid_input" });
  request.path = args.cursor;
  request.query = {};
}

function parsePageCursor(cursor, minimum) {
  if (cursor === undefined) return undefined;
  const pageNumber = Number(cursor);
  if (!Number.isInteger(pageNumber) || pageNumber < minimum) {
    throw new PluginError(`\`cursor\` must be a next_cursor value from an earlier call (an integer >= ${minimum})`, { kind: "invalid_input" });
  }
  return pageNumber;
}
