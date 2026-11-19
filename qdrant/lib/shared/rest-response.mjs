/**
 * Shapes a declarative REST response into `{data, next_cursor}`: `dataPath` selects the data and the operation's
 * pagination style (cursor field, Link header, next URL in the body, last item id, page number or offset)
 * produces the next cursor. Cursors pass through the response's `redact`, so a credential echoed in a Link header
 * or next URL never reaches the caller (a query credential is set again when the cursor is followed).
 * Also truncates tool results (truncateForTool).
 */
import { readPath } from "./object-path.mjs";

export const DEFAULT_TOOL_OUTPUT = { maxChars: 100000 };

/**
 * Builds the operation result from the API response.
 *
 * @param operation - Normalized operation spec (object)
 * @param response - `{body, headers, redact}` from client.requestWithHeaders with redactResponse (object)
 * @param args - Validated arguments, for the current cursor and limit (object)
 * @returns `{data, next_cursor}`; next_cursor is null on the last page (object)
 */
export function shapeRestResponse(operation, response, args) {
  const data = readPath(response.body, operation.response?.dataPath);
  if (!operation.pagination) return { data: data ?? null, next_cursor: null };
  const nextCursor = findNextCursor(operation, response, data, args);
  const redact = response.redact ?? ((value) => value);
  return { data: data ?? null, next_cursor: nextCursor === null || nextCursor === undefined ? null : redact(String(nextCursor)) };
}

function findNextCursor(operation, response, data, args) {
  const responseSpec = operation.response;
  const cursorFinders = {
    cursor: () => readCursorField(responseSpec.cursorPath, responseSpec.hasMorePath, response.body),
    link: () => parseNextLink(response.headers?.get?.("link")),
    nextUrl: () => readCursorField(responseSpec.nextUrlPath, undefined, response.body),
    lastItem: () => readLastItemCursor(responseSpec.lastItemCursor, response.body, data),
    page: () => nextPage(responseSpec.pagePagination, response.body, data, args),
    offset: () => nextOffset(responseSpec.offsetPagination, response.body, data, args),
  };
  return cursorFinders[operation.pagination.style]();
}

function readCursorField(cursorPath, hasMorePath, body) {
  if (hasMorePath !== undefined && !readPath(body, hasMorePath)) return null;
  const cursorValue = readPath(body, cursorPath);
  return cursorValue === undefined || cursorValue === null || cursorValue === "" ? null : cursorValue;
}

function readLastItemCursor(lastItemCursor, body, data) {
  if (lastItemCursor.hasMorePath !== undefined && !readPath(body, lastItemCursor.hasMorePath)) return null;
  if (!Array.isArray(data) || data.length === 0) return null;
  return readPath(data.at(-1), lastItemCursor.itemIdPath) ?? null;
}

/**
 * Finds the rel="next" URL in an RFC 8288 Link header.
 *
 * @param linkHeader - Header value (string | null)
 * @returns Next URL or null (string | null)
 *
 * @example
 * parseNextLink('<https://api.example.com/x?page=2>; rel="next"'); // "https://api.example.com/x?page=2"
 */
export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const linkPart of linkHeader.split(/,(?=\s*<)/)) {
    const linkMatch = /^\s*<([^>]+)>(.*)$/.exec(linkPart);
    if (linkMatch && /;\s*rel="?([^";]*\s)?next(\s[^";]*)?"?(;|$)/i.test(linkMatch[2])) return linkMatch[1];
  }
  return null;
}

// Pages are numbered from firstPage, so the page index within totalPages is currentPage - firstPage.
function nextPage(pagePagination, body, data, args) {
  const firstPage = pagePagination.firstPage ?? 1;
  const currentPage = args.cursor === undefined ? firstPage : Number(args.cursor);
  if (pagePagination.totalPagesPath !== undefined) {
    const totalPages = Number(readPath(body, pagePagination.totalPagesPath));
    return Number.isFinite(totalPages) && currentPage - firstPage + 1 < totalPages ? currentPage + 1 : null;
  }
  return isFullPage(data, args.limit) ? currentPage + 1 : null;
}

function nextOffset(offsetPagination, body, data, args) {
  if (!Array.isArray(data)) return null;
  const nextStart = (args.cursor === undefined ? 0 : Number(args.cursor)) + data.length;
  if (offsetPagination.totalPath !== undefined) {
    const total = Number(readPath(body, offsetPagination.totalPath));
    return Number.isFinite(total) && nextStart < total ? nextStart : null;
  }
  return isFullPage(data, args.limit) ? nextStart : null;
}

// Without a known page size, any non-empty page may have a successor; an empty page ends the listing.
function isFullPage(data, limit) {
  if (!Array.isArray(data) || data.length === 0) return false;
  return limit === undefined || data.length >= limit;
}

/**
 * Shortens a result for an agent tool: arrays to `maxItems`, then the JSON text to `maxChars`.
 *
 * @param data - Operation data (any)
 * @param toolOutput - `{maxItems?, maxChars?}`, or false for no limit (object | false)
 * @returns The data, `{truncated, items, total_items}` or `{truncated, preview, total_chars}` (any)
 */
export function truncateForTool(data, toolOutput) {
  if (toolOutput === false || data === null || data === undefined) return data;
  let shortened = data;
  if (toolOutput.maxItems !== undefined && Array.isArray(data) && data.length > toolOutput.maxItems) {
    shortened = { truncated: true, items: data.slice(0, toolOutput.maxItems), total_items: data.length };
  }
  const jsonText = JSON.stringify(shortened);
  if (toolOutput.maxChars === undefined || jsonText.length <= toolOutput.maxChars) return shortened;
  return { truncated: true, preview: jsonText.slice(0, toolOutput.maxChars), total_chars: jsonText.length };
}
