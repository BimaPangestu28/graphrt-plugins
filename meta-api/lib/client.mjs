/**
 * Meta Graph API client: base URL/version, Bearer auth, Graph error mapping
 * and helpers shared by the operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const DEFAULT_GRAPH_VERSION = "v26.0";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const GRAPH_VERSION_PATTERN = /^v\d+\.\d+$/;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);
const AUTH_ERROR_CODES = new Set([102, 190]);
const INVALID_INPUT_CODES = new Set([100, 506]);
const OBJECT_DOES_NOT_EXIST_SUBCODE = 33;

/**
 * Creates a Graph API client for the given token.
 *
 * @param options - `{accessToken, environment, fetchImpl}` (object)
 * @returns Shared API client (object)
 * @throws PluginError kind `invalid_input` - When META_GRAPH_VERSION is malformed
 */
export function createMetaClient({ accessToken, environment, fetchImpl }) {
  const graphVersion = environment?.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  if (!GRAPH_VERSION_PATTERN.test(graphVersion)) {
    throw new PluginError(`META_GRAPH_VERSION must look like "v26.0", got "${graphVersion}"`, { kind: "invalid_input" });
  }
  return createApiClient({
    baseUrl: `${GRAPH_ORIGIN}/${graphVersion}`,
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseMetaError,
    fetchImpl,
  });
}

/**
 * Maps a Graph API error body to a message, error kind and retry delay.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @param headers - Response headers (Headers)
 * @returns `{message, kind, retryAfterMs}` or `{}` for non-Graph bodies (object)
 */
export function parseMetaError(status, body, headers) {
  const graphError = body?.error;
  if (!graphError || typeof graphError !== "object") return {};
  const code = graphError.code === undefined ? undefined : Number(graphError.code);
  const subcode = graphError.error_subcode === undefined ? undefined : Number(graphError.error_subcode);
  const details = [code !== undefined && `code ${code}`, subcode !== undefined && `subcode ${subcode}`, graphError.fbtrace_id && `fbtrace_id ${graphError.fbtrace_id}`];
  const detailText = details.filter(Boolean).join(", ");
  const message = `${graphError.error_user_msg || graphError.message}${detailText ? ` (${detailText})` : ""}`;
  return { message, kind: kindForGraphCode(code, subcode), retryAfterMs: readRegainAccessMs(headers) };
}

function kindForGraphCode(code, subcode) {
  if (code === 100 && subcode === OBJECT_DOES_NOT_EXIST_SUBCODE) return "not_found";
  if (RATE_LIMIT_CODES.has(code) || (code >= 80001 && code <= 80014)) return "rate_limited";
  if (AUTH_ERROR_CODES.has(code)) return "auth_error";
  if (code === 10 || code === 368 || (code >= 200 && code <= 299)) return "permission_denied";
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
