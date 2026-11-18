/**
 * Shapes a declarative REST response into `{data, next_cursor}`: `dataPath` selects the data and the
 * operation's pagination style (cursor, Link header, page number or offset) produces the next cursor.
 */
import { readPath } from "./object-path.mjs";

/**
 * Builds the operation result from the API response.
 *
 * @param operation - Normalized operation spec (object)
 * @param response - `{body, headers}` from client.requestWithHeaders (object)
 * @param args - Validated arguments, for the current cursor and limit (object)
 * @returns `{data, next_cursor}`; next_cursor is null on the last page (object)
 */
export function shapeRestResponse(operation, response, args) {
  const data = readPath(response.body, operation.response?.dataPath);
  return { data: data ?? null, next_cursor: operation.pagination ? findNextCursor(operation, response, data, args) : null };
}

function findNextCursor(operation, response, data, args) {
  const responseSpec = operation.response;
  const cursorFinders = {
    cursor: () => readCursorField(responseSpec, response.body),
    link: () => parseNextLink(response.headers?.get?.("link")),
    page: () => nextPage(responseSpec.pagePagination, response.body, data, args, args.limit),
    offset: () => nextOffset(responseSpec.offsetPagination, response.body, data, args, args.limit),
  };
  return cursorFinders[operation.pagination.style]() ?? null;
}

function readCursorField(responseSpec, body) {
  if (responseSpec.hasMorePath !== undefined && !readPath(body, responseSpec.hasMorePath)) return null;
  const cursorValue = readPath(body, responseSpec.cursorPath);
  return cursorValue === undefined || cursorValue === null || cursorValue === "" ? null : String(cursorValue);
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

function nextPage(pagePagination, body, data, args, limit) {
  const currentPage = args.cursor === undefined ? pagePagination.firstPage ?? 1 : Number(args.cursor);
  if (pagePagination.totalPagesPath !== undefined) {
    const totalPages = Number(readPath(body, pagePagination.totalPagesPath));
    return Number.isFinite(totalPages) && currentPage < totalPages ? String(currentPage + 1) : null;
  }
  return isFullPage(data, limit) ? String(currentPage + 1) : null;
}

function nextOffset(offsetPagination, body, data, args, limit) {
  if (!Array.isArray(data)) return null;
  const nextStart = (args.cursor === undefined ? 0 : Number(args.cursor)) + data.length;
  if (offsetPagination.totalPath !== undefined) {
    const total = Number(readPath(body, offsetPagination.totalPath));
    return Number.isFinite(total) && nextStart < total ? String(nextStart) : null;
  }
  return isFullPage(data, limit) ? String(nextStart) : null;
}

// Without a known page size, any non-empty page may have a successor; an empty page ends the listing.
function isFullPage(data, limit) {
  if (!Array.isArray(data) || data.length === 0) return false;
  return limit === undefined || data.length >= limit;
}
