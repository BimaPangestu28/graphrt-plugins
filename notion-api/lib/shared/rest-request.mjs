/**
 * Turns validated operation arguments into a shared-client request for a declarative REST operation:
 * path params (one encoded segment each, `{+name}` keeps slashes), query params with array styles, header params
 * (CR/LF refused), constants, the generated `limit`/`cursor` under the API's own names, and a body encoded here
 * (JSON, form, raw, text, multipart) so a custom signer sees the exact bytes.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { writePath } from "./object-path.mjs";
import { pathSegment } from "./path.mjs";
import { appendQueryString, appendQueryValue, encodeFormBody, encodeTextBody, flattenFormValue } from "./rest-encoding.mjs";
import { readFileInput } from "./rest-files.mjs";
import { READ_METHODS } from "./rest-spec-helpers.mjs";

const IDEMPOTENT_FLAGS = { read: undefined, idempotent: true, unsafe: false };
const UNSAFE_HEADER_VALUE = /[\r\n\0]/;
const JSON_TYPE = "application/json";

/**
 * Builds the request for one operation call.
 *
 * @param operation - Normalized operation spec (object)
 * @param args - Arguments validated against the operation's schema (object)
 * @param context - `{baseUrl, environment, fetchImpl, resolveHostAddresses, signal, idempotencyKey?: {header, value}}` (object)
 * @returns `{method, path, headers, body?, idempotent, timeoutMs?}` for client.requestWithHeaders (Promise<object>)
 * @throws PluginError kind `invalid_input` - Bad path value, header value or cursor; file inputs that are refused
 */
export async function buildRestRequest(operation, args, context) {
  const parts = { queryEntries: [], headers: {}, body: {} };
  for (const [paramName, paramSpec] of Object.entries(operation.params)) {
    if (paramSpec.in !== "path" && args[paramName] !== undefined) placeParam(parts, paramSpec, args[paramName], paramName);
  }
  applyConstants(operation.constants, parts);
  const cursorUrl = applyPaginationInput(operation, args, parts, context.baseUrl);
  const path = cursorUrl ?? appendQueryString(fillPathTemplate(operation.path, args), parts.queryEntries);
  const request = { method: operation.method, path, headers: parts.headers, idempotent: IDEMPOTENT_FLAGS[operation.write] };
  if (context.idempotencyKey) {
    request.headers[context.idempotencyKey.header.toLowerCase()] = context.idempotencyKey.value;
    request.idempotent = true;
  }
  await attachBody(operation, args, parts, request, context);
  if (operation.timeoutMs) request.timeoutMs = operation.timeoutMs;
  return request;
}

/**
 * Replaces `{name}` placeholders with one encoded segment and `{+name}` with slash-separated encoded segments.
 *
 * @param pathTemplate - e.g. "/repos/{owner}/contents/{+file_path}" (string)
 * @param values - `{name: value}` (object)
 * @returns Path (string)
 * @throws PluginError kind `invalid_input` - A value or segment is empty, "." or ".."
 */
export function fillPathTemplate(pathTemplate, values) {
  return pathTemplate.replace(/\{(\+?)([^{}+]+)\}/g, (placeholder, multiSegment, placeholderName) => {
    if (!multiSegment) return pathSegment(values[placeholderName]);
    return String(values[placeholderName] ?? "").split("/").map(pathSegment).join("/");
  });
}

function placeParam(parts, paramSpec, value, paramName) {
  const wireName = paramSpec.wireName ?? paramName;
  if (paramSpec.in === "query") appendQueryValue(parts.queryEntries, wireName, value, paramSpec.style);
  if (paramSpec.in === "header") parts.headers[wireName.toLowerCase()] = checkedHeaderValue(paramName, value);
  if (paramSpec.in === "body") writePath(parts.body, wireName, value);
}

function checkedHeaderValue(paramName, value) {
  const headerValue = String(value);
  if (UNSAFE_HEADER_VALUE.test(headerValue)) throw new PluginError(`\`${paramName}\` must not contain line breaks or NUL characters`, { kind: "invalid_input" });
  return headerValue;
}

function applyConstants(constants, parts) {
  if (!constants) return;
  for (const [queryName, queryValue] of Object.entries(constants.query ?? {})) appendQueryValue(parts.queryEntries, queryName, queryValue);
  for (const [bodyPath, bodyValue] of Object.entries(constants.body ?? {})) writePath(parts.body, bodyPath, bodyValue);
  for (const [headerName, headerValue] of Object.entries(constants.headers ?? {})) parts.headers[headerName.toLowerCase()] = String(headerValue);
}

// --- pagination input ------------------------------------------------------------------------------

function applyPaginationInput(operation, args, parts, baseUrl) {
  const pagination = operation.pagination;
  if (!pagination) return undefined;
  const response = operation.response;
  const place = (wireName, value) => {
    if (value === undefined || !wireName) return;
    if (pagination.paramsIn === "body") writePath(parts.body, wireName, value);
    else appendQueryValue(parts.queryEntries, wireName, value);
  };
  if (pagination.style === "link" || pagination.style === "nextUrl") {
    if (args.cursor !== undefined) return checkNextUrlCursor(args.cursor, baseUrl);
    return void place(response.limitParam, args.limit);
  }
  const placements = {
    cursor: () => [[response.cursorParam, args.cursor], [response.limitParam, args.limit]],
    lastItem: () => [[response.lastItemCursor.param, args.cursor], [response.limitParam, args.limit]],
    page: () => [[response.pagePagination.pageParam, parsePageCursor(args.cursor, response.pagePagination.firstPage ?? 1)], [response.pagePagination.sizeParam, args.limit]],
    offset: () => [[response.offsetPagination.offsetParam, parsePageCursor(args.cursor, 0)], [response.offsetPagination.limitParam, args.limit]],
  };
  for (const [wireName, value] of placements[pagination.style]()) place(wireName, value);
  return undefined;
}

/**
 * Checks that a next-page URL stays on the API: same origin and under the base path.
 *
 * @param cursor - next_cursor from an earlier call (string)
 * @param baseUrl - The client's base URL (string)
 * @returns The cursor URL, normalized (string)
 * @throws PluginError kind `invalid_input` - Not a URL, or outside the base URL
 */
export function checkNextUrlCursor(cursor, baseUrl) {
  const refuse = () => {
    throw new PluginError("`cursor` must be the next_cursor URL returned by an earlier call (on the API's own base URL)", { kind: "invalid_input" });
  };
  let cursorUrl;
  try {
    cursorUrl = new URL(cursor);
  } catch {
    return refuse();
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const isUnderBase = cursorUrl.pathname === basePath || cursorUrl.pathname.startsWith(`${basePath}/`);
  if (cursorUrl.origin !== base.origin || !isUnderBase || cursorUrl.username || cursorUrl.password) refuse();
  return cursorUrl.href;
}

function parsePageCursor(cursor, minimum) {
  if (cursor === undefined) return undefined;
  const pageNumber = Number(cursor);
  if (!Number.isInteger(pageNumber) || pageNumber < minimum) {
    throw new PluginError(`\`cursor\` must be a next_cursor value from an earlier call (an integer >= ${minimum})`, { kind: "invalid_input" });
  }
  return pageNumber;
}

// --- body ------------------------------------------------------------------------------------------

async function attachBody(operation, args, parts, request, context) {
  if (READ_METHODS.has(operation.method)) return;
  const bodyParamNames = Object.keys(operation.params).filter((paramName) => operation.params[paramName].in === "body");
  const declaresBody = bodyParamNames.length > 0 || operation.pagination?.paramsIn === "body" || operation.constants?.body;
  if (!declaresBody) return;
  const encoders = {
    json: () => setBody(request, JSON.stringify(parts.body), operation.contentType ?? JSON_TYPE),
    raw: () => args[bodyParamNames[0]] !== undefined && setBody(request, JSON.stringify(args[bodyParamNames[0]]), operation.contentType ?? JSON_TYPE),
    form: () => setBody(request, encodeFormBody(parts.body, operation.formArrays), "application/x-www-form-urlencoded"),
    text: () => args[bodyParamNames[0]] !== undefined && setBody(request, encodeTextBody(args[bodyParamNames[0]]), operation.contentType ?? "text/plain; charset=utf-8"),
    multipart: async () => (request.body = await buildMultipartBody(operation, args, parts.body, context)),
  };
  await encoders[operation.bodyMode]();
}

function setBody(request, encodedBody, contentType) {
  request.body = encodedBody;
  request.headers["content-type"] = contentType;
}

// fetch sets the multipart content type (with its boundary) itself.
async function buildMultipartBody(operation, args, body, context) {
  const formData = new FormData();
  const formEntries = [];
  for (const [paramName, paramSpec] of Object.entries(operation.params)) {
    if (paramSpec.in !== "body" || !paramSpec.file || args[paramName] === undefined) continue;
    const fileInput = await readFileInput(String(args[paramName]), { ...context, paramName, fileDirEnv: operation.multipart?.fileDirEnv, maxBytes: operation.multipart?.maxFileBytes });
    formData.append(paramSpec.wireName ?? paramName, new Blob([fileInput.bytes], { type: fileInput.contentType }), fileInput.fileName);
    delete body[paramSpec.wireName ?? paramName];
  }
  flattenFormValue(formEntries, "", body, "repeat");
  for (const [fieldName, fieldValue] of formEntries) formData.append(fieldName, fieldValue);
  return formData;
}
