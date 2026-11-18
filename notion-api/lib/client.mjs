/**
 * Notion API client: base URL, Bearer auth with the Notion-Version header, Notion error mapping and helpers
 * shared by the operation files (ids, cursors, write-outcome hints).
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";

export const NOTION_BASE_URL = "https://api.notion.com/v1";
// 2026-03-11 is the newest version (data sources since 2025-09-03; `archived` became `in_trash`).
export const NOTION_VERSION = "2026-03-11";
export const MAX_PAGE_SIZE = 100;
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";
// A 32-hex id or a dashed UUID (8-4-4-4-12), not inside a longer run of hex characters.
const NOTION_ID_IN_URL_PATTERN = /(?<![0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;
const WHOLE_NOTION_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const CODE_KINDS = {
  unauthorized: "auth_error",
  restricted_resource: "permission_denied",
  object_not_found: "not_found",
  rate_limited: "rate_limited",
  service_overload: "rate_limited",
  validation_error: "invalid_input",
  invalid_json: "invalid_input",
  invalid_request: "invalid_input",
  invalid_request_url: "invalid_input",
  missing_version: "invalid_input",
};
const NOT_FOUND_HINT = ". Share the page or database with the integration (••• menu > Connections) and check the id";

/**
 * Creates a Notion client for the run's token.
 *
 * @param options - `{accessToken, fetchImpl}` (object)
 * @returns Shared API client `{request, requestWithHeaders}` (object)
 */
export function createNotionClient({ accessToken, fetchImpl }) {
  return createApiClient({
    baseUrl: NOTION_BASE_URL,
    defaultHeaders: { "notion-version": NOTION_VERSION },
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${accessToken}`;
    },
    parseError: parseNotionError,
    fetchImpl,
  });
}

/**
 * Maps a Notion error body `{object: "error", status, code, message}` to a PluginError kind.
 * 409 conflict_error means the write did not apply (Notion says to retry), and 529 is treated like 429.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}` or `{}` for non-Notion bodies (object)
 *
 * @example
 * parseNotionError(401, { object: "error", code: "unauthorized", message: "API token is invalid." });
 * // { message: "API token is invalid. (unauthorized)", kind: "auth_error" }
 */
export function parseNotionError(status, body) {
  const errorCode = typeof body?.code === "string" ? body.code : undefined;
  if (status === 529 && !errorCode) return { kind: "rate_limited" };
  if (!errorCode) return {};
  const baseMessage = `${body.message ?? "Notion API error"} (${errorCode})`;
  if (errorCode === "conflict_error") return { message: `${baseMessage}; nothing was saved, safe to retry`, kind: "api_error", retryable: true };
  const kind = CODE_KINDS[errorCode] ?? (status === 529 ? "rate_limited" : undefined);
  const message = kind === "not_found" ? `${baseMessage}${NOT_FOUND_HINT}` : baseMessage;
  return kind ? { message, kind } : { message };
}

/**
 * Encodes a Notion id as a path segment. Accepts a UUID with or without dashes, or a notion.so / notion.site URL
 * (see extractNotionId).
 *
 * @param idOrUrl - Page, database, data source or block id, or URL (string)
 * @returns Encoded path segment (string)
 * @throws PluginError kind `invalid_input` - Malformed URL, URL without an id, or an empty id
 *
 * @example
 * notionIdSegment("https://www.notion.so/team/Roadmap-0123456789abcdef0123456789abcdef?pvs=4"); // "0123456789abcdef0123456789abcdef"
 */
export function notionIdSegment(idOrUrl) {
  return pathSegment(extractNotionId(idOrUrl));
}

/**
 * Returns the id inside a Notion URL, or the trimmed input. A peek URL (a database view with a page open,
 * `...?v=<view>&p=<page>`) names the page in `p`, so a valid `p` id wins; otherwise the last id in the path
 * (32 hex characters or a dashed UUID) is used.
 *
 * @param idOrUrl - Id or URL (string)
 * @returns Id (string)
 * @throws PluginError kind `invalid_input` - Malformed URL, or a URL without an id
 *
 * @example
 * extractNotionId("https://www.notion.so/acme/aaaa...aaaa?v=bbbb...bbbb&p=0123456789abcdef0123456789abcdef"); // "0123456789abcdef0123456789abcdef"
 */
export function extractNotionId(idOrUrl) {
  const trimmed = String(idOrUrl ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const parsedUrl = parseNotionUrl(trimmed);
  const peekedPageId = parsedUrl.searchParams.get("p")?.trim();
  if (peekedPageId && WHOLE_NOTION_ID_PATTERN.test(peekedPageId)) return peekedPageId;
  const idMatches = parsedUrl.pathname.match(NOTION_ID_IN_URL_PATTERN);
  if (!idMatches) rejectInput(`No Notion id found in URL ${JSON.stringify(trimmed)}`);
  return idMatches.at(-1);
}

function parseNotionUrl(urlText) {
  try {
    return new URL(urlText);
  } catch {
    return rejectInput(`Invalid Notion URL ${JSON.stringify(urlText)}; pass the page's URL or its id`);
  }
}

/**
 * Maps a Notion list response to `{data, next_cursor}`.
 *
 * @param listResponse - `{results, has_more, next_cursor}` (object)
 * @returns Operation result; next_cursor is null on the last page (object)
 */
export function toCursorResult(listResponse) {
  return { data: listResponse, next_cursor: listResponse?.has_more ? listResponse.next_cursor ?? null : null };
}

/**
 * Runs a write and, when its outcome is unknown, makes the failure non-retryable and says how to check.
 *
 * @param writePromise - The pending write request (Promise)
 * @param checkHint - How to verify, e.g. "search for the page title" (string)
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
