/**
 * Airtable Web API client: base URL, Bearer auth (personal access token), Airtable error mapping, id
 * validation and helpers shared by the operation files.
 *
 * Airtable answers 429 when a base gets more than 5 requests per second and then wants 30 s of quiet, so a
 * 429 is waited out once (30 s, or Retry-After when sent) and a second 429 fails `rate_limited`.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { assertToolMayUseBase, BASE_ID_ENV } from "./base-access.mjs";

export { BASE_ID_ENV } from "./base-access.mjs";
export const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";
export const MAX_RECORDS_PER_WRITE = 10;
export const RATE_LIMIT_WAIT_MS = 30000;
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";
const BASE_ID_PATTERN = /^app[A-Za-z0-9]{14}$/;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{14}$/;
const TYPE_KINDS = {
  AUTHENTICATION_REQUIRED: "auth_error",
  INVALID_PERMISSIONS: "permission_denied",
  INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: "permission_denied",
  NOT_FOUND: "not_found",
  MODEL_ID_NOT_FOUND: "not_found",
  RATE_LIMIT_REACHED: "rate_limited",
};
const MODEL_NOT_FOUND_HINT = ". Check the base id and table name, and that the token has this base and the needed scopes";

/**
 * Creates an Airtable client for the run's token.
 *
 * @param options - `{accessToken, fetchImpl}` (object)
 * @returns Shared API client `{request, requestWithHeaders}` plus `requestOnce` (no automatic retries, for
 *   callers that must know which attempt failed) (object)
 */
export function createAirtableClient({ accessToken, fetchImpl }) {
  const clientSettings = {
    baseUrl: AIRTABLE_BASE_URL,
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseAirtableError,
    // One retry: a 429 is waited out once; 5xx reads get one more try.
    maxRetries: 1,
    fetchImpl,
  };
  const singleAttemptClient = createApiClient({ ...clientSettings, maxRetries: 0 });
  return { ...createApiClient(clientSettings), requestOnce: singleAttemptClient.request };
}

/**
 * Maps an Airtable error body (`{error: {type, message}}` or `{error: "NOT_FOUND"}`) to a PluginError kind.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @param headers - Response headers (Headers, optional)
 * @returns `{message?, kind?, retryAfterMs?}` (object)
 *
 * @example
 * parseAirtableError(401, { error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } });
 * // { message: "Authentication required (AUTHENTICATION_REQUIRED)", kind: "auth_error" }
 */
export function parseAirtableError(status, body, headers) {
  if (status === 413) return { kind: "invalid_input", message: "Request too large (413): send fewer or smaller records" };
  const rateLimit = status === 429 ? { kind: "rate_limited", retryAfterMs: headers?.get?.("retry-after") ? undefined : RATE_LIMIT_WAIT_MS } : {};
  const airtableError = body?.error;
  const errorType = typeof airtableError === "string" ? airtableError : airtableError?.type;
  if (typeof errorType !== "string") return rateLimit;
  const baseMessage = `${airtableError?.message ?? errorType} (${errorType})`;
  const message = errorType === "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" ? `${baseMessage}${MODEL_NOT_FOUND_HINT}` : baseMessage;
  const kind = TYPE_KINDS[errorType];
  return { ...rateLimit, message, ...(kind ? { kind } : {}) };
}

/**
 * Picks the base id from the arguments or AIRTABLE_BASE_ID, validates it and, for tool calls, checks that the
 * base is allowed (see base-access.mjs).
 *
 * @param context - `{args, environment, source}` with optional args.base_id (object)
 * @returns Base id (string)
 * @throws PluginError kind `invalid_input` - Missing or malformed base id
 * @throws PluginError kind `permission_denied` - Tool call to a base outside the allowed set
 */
export function resolveBaseId(context) {
  const { args, environment } = context;
  const baseId = args.base_id || environment?.[BASE_ID_ENV];
  if (!baseId) rejectInput(`Pass \`base_id\` or set ${BASE_ID_ENV}`);
  if (!BASE_ID_PATTERN.test(baseId)) rejectInput(`Invalid base id ${JSON.stringify(baseId)}: expected "app" + 14 letters/digits`);
  assertToolMayUseBase(context, baseId);
  return baseId;
}

/**
 * Validates a record id ("rec" + 14 letters/digits).
 *
 * @param recordId - Record id (string)
 * @returns The id (string)
 * @throws PluginError kind `invalid_input` - Malformed id
 */
export function validateRecordId(recordId) {
  if (typeof recordId !== "string" || !RECORD_ID_PATTERN.test(recordId)) rejectInput(`Invalid record id ${JSON.stringify(recordId)}: expected "rec" + 14 letters/digits`);
  return recordId;
}

/**
 * Builds `/{baseId}/{table}`.
 *
 * @param context - `{args, environment, source}` with args.table (object)
 * @returns API path (string)
 */
export function tablePath(context) {
  return `/${resolveBaseId(context)}/${pathSegment(context.args.table)}`;
}

/**
 * Runs a write and, when its outcome is unknown, makes the failure non-retryable and says how to check.
 *
 * @param writePromise - The pending write request (Promise)
 * @param checkHint - How to verify (string)
 * @returns The write's result (Promise)
 * @throws PluginError - The original error, with the hint appended and retryable false when the outcome is unknown
 */
export async function withWriteOutcomeHint(writePromise, checkHint) {
  try {
    return await writePromise;
  } catch (writeError) {
    if (!(writeError instanceof PluginError) || !writeError.message.includes(UNKNOWN_OUTCOME_MARKER)) throw writeError;
    throw new PluginError(`${writeError.message}. To check: ${checkHint}`, { kind: writeError.kind, retryable: false });
  }
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
