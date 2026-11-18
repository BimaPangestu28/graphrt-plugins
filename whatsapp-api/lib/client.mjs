/**
 * WhatsApp Cloud API client: Graph base URL/version, Bearer auth, Graph and
 * WhatsApp (131xxx/132xxx/133xxx) error mapping, and helpers shared by the
 * operation files. The Graph error parser is adapted from meta-api; plugins
 * are installed one directory at a time, so it is copied rather than imported.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const DEFAULT_GRAPH_VERSION = "v26.0";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;
const OBJECT_DOES_NOT_EXIST_SUBCODE = 33;
const OUTSIDE_WINDOW_CODE = 131047;
const PAIR_RATE_LIMIT_CODE = 131056;
const OUTSIDE_WINDOW_HINT =
  "more than 24 h have passed since the recipient last messaged this number; free-form messages are not allowed, use send_template with an approved template";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 130429, PAIR_RATE_LIMIT_CODE]);
const AUTH_ERROR_CODES = new Set([0, 102, 190]);
// 3/10/2xx: missing permission; 368/131031/131048: account or number restricted;
// 131005: permission removed; 131042: billing; 132007/132015/132016: template blocked by policy or quality.
const PERMISSION_CODES = new Set([3, 10, 368, 131005, 131031, 131042, 131048, 132007, 132015, 132016]);
// Bad parameters, unsupported content, template/parameter mismatches, unregistered sender number.
const INVALID_INPUT_CODES = new Set([
  100, 506, 131008, 131009, 131021, OUTSIDE_WINDOW_CODE, 131051, 131053, 132000, 132001, 132005, 132012, 133010,
]);

/**
 * Creates a Graph API client for the WhatsApp Cloud API.
 *
 * @param options - `{accessToken, environment, fetchImpl, resolveHostAddresses?}` (object)
 * @returns Shared API client plus `fetchImpl` and `resolveHostAddresses` (DNS when omitted) for credential-free downloads (object)
 * @throws PluginError kind `invalid_input` - When WHATSAPP_GRAPH_VERSION is malformed
 */
export function createWhatsAppClient({ accessToken, environment, fetchImpl, resolveHostAddresses }) {
  const graphVersion = environment?.WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  if (!GRAPH_VERSION_PATTERN.test(graphVersion)) {
    throw new PluginError(`WHATSAPP_GRAPH_VERSION must look like "v26.0", got "${graphVersion}"`, { kind: "invalid_input" });
  }
  const apiClient = createApiClient({
    baseUrl: `${GRAPH_ORIGIN}/${graphVersion}`,
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseWhatsAppError,
    fetchImpl,
  });
  return { ...apiClient, fetchImpl: fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments)), resolveHostAddresses };
}

/**
 * Maps a Graph / WhatsApp error body to a message, error kind and retry hints.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @param headers - Response headers (Headers)
 * @returns `{message, kind, retryAfterMs, retryable?}` or `{}` for non-Graph bodies (object)
 */
export function parseWhatsAppError(status, body, headers) {
  const graphError = body?.error;
  if (!graphError || typeof graphError !== "object") return {};
  const code = graphError.code === undefined ? undefined : Number(graphError.code);
  const subcode = graphError.error_subcode === undefined ? undefined : Number(graphError.error_subcode);
  const parsedError = { message: describeGraphError(graphError, code, subcode), kind: kindForCode(code, subcode), retryAfterMs: readRegainAccessMs(headers) };
  // Retrying soon does not help: 131047 needs a template, 131056 needs a pause for this recipient.
  if (code === OUTSIDE_WINDOW_CODE || code === PAIR_RATE_LIMIT_CODE) parsedError.retryable = false;
  return parsedError;
}

function describeGraphError(graphError, code, subcode) {
  const details = [code !== undefined && `code ${code}`, subcode !== undefined && `subcode ${subcode}`, graphError.fbtrace_id && `fbtrace_id ${graphError.fbtrace_id}`];
  const detailText = details.filter(Boolean).join(", ");
  const errorDetails = graphError.error_data?.details;
  const baseMessage = graphError.error_user_msg || graphError.message || graphError.error_user_title || "Unknown Graph error";
  const hint = code === OUTSIDE_WINDOW_CODE ? `: ${OUTSIDE_WINDOW_HINT}` : "";
  return `${baseMessage}${errorDetails ? ` - ${errorDetails}` : ""}${hint}${detailText ? ` (${detailText})` : ""}`;
}

function kindForCode(code, subcode) {
  if (code === undefined) return undefined;
  if (code === 100 && subcode === OBJECT_DOES_NOT_EXIST_SUBCODE) return "not_found";
  if (RATE_LIMIT_CODES.has(code) || (code >= 80001 && code <= 80014)) return "rate_limited";
  if (AUTH_ERROR_CODES.has(code)) return "auth_error";
  if (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299)) return "permission_denied";
  if (INVALID_INPUT_CODES.has(code)) return "invalid_input";
  return undefined;
}

function readRegainAccessMs(headers) {
  const usageHeader = headers?.get?.("x-business-use-case-usage");
  if (!usageHeader) return undefined;
  try {
    const usageEntries = Object.values(JSON.parse(usageHeader)).flat();
    const regainMinutes = Math.max(...usageEntries.map((usageEntry) => Number(usageEntry.estimated_time_to_regain_access) || 0));
    return regainMinutes > 0 ? regainMinutes * 60000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts a Graph list response into the operation output shape.
 *
 * @param responseBody - `{data, paging}` from Graph (object)
 * @returns `{data, next_cursor}`; next_cursor only when Graph reports a next page
 */
export function toPage(responseBody) {
  const hasNextPage = Boolean(responseBody?.paging?.next);
  return { data: responseBody?.data ?? [], next_cursor: hasNextPage ? (responseBody.paging.cursors?.after ?? null) : null };
}

/**
 * Reads an id from the arguments or falls back to an environment variable.
 *
 * @param providedId - Id from the arguments (string | undefined)
 * @param environment - Environment variables (object)
 * @param environmentName - Fallback env var name (string)
 * @param argumentName - Argument name for the error message (string)
 * @returns The id (string)
 * @throws PluginError kind `invalid_input` - When neither is set
 */
export function resolveId(providedId, environment, environmentName, argumentName) {
  const resolvedId = providedId || environment?.[environmentName];
  if (!resolvedId) {
    throw new PluginError(`Pass \`${argumentName}\` or set the ${environmentName} environment variable`, { kind: "invalid_input" });
  }
  return resolvedId;
}

/**
 * Builds the shared pagination parameters for list operations.
 *
 * @param defaultLimit - Default page size (number)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties(defaultLimit = 25) {
  return {
    limit: { type: "integer", minimum: 1, maximum: 100, default: defaultLimit, description: "Page size" },
    cursor: { type: "string", description: "next_cursor from a previous call" },
  };
}

/**
 * Throws invalid_input with a message.
 *
 * @param message - What is wrong (string)
 * @throws PluginError kind `invalid_input`
 */
export function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}

/**
 * Rejects a string longer than the API allows.
 *
 * @param value - Text to check; undefined passes (string | undefined)
 * @param maxLength - Maximum characters (number)
 * @param fieldName - Name used in the error message (string)
 * @throws PluginError kind `invalid_input` - When the text is too long
 */
export function checkMaxLength(value, maxLength, fieldName) {
  if (value !== undefined && [...String(value)].length > maxLength) rejectInput(`\`${fieldName}\` must be at most ${maxLength} characters`);
}
